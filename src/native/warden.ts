/**
 * talon-warden — TypeScript boundary over the Rust supervision harness.
 *
 * The warden is a real per-arch binary (native/talon-warden), not an
 * embedded wasm artifact: supervising a process tree needs fork/exec,
 * process groups, and signals — none of which exist inside a wasm
 * sandbox. It is shipped by the native-binary channels beside the
 * launcher and built locally with `npm run build:warden`; npm installs
 * run without it (resolution returns null and the trigger supervisor
 * falls back to its in-process TS path).
 *
 * Protocol: the warden emits NDJSON events on stdout — `start` (child
 * pid + /proc starttime), `line` (byte-capped, UTF-8-safe framed
 * stdout/stderr), and exactly one terminal `exit` or `error`. This
 * module turns that stream into typed callbacks and guarantees the
 * terminal callback fires exactly once even if the warden itself is
 * killed mid-run. See native/talon-warden/README.md for the full
 * contract.
 */

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type IOType,
} from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { logDebug, logWarn } from "../util/log.js";

interface WardenStartEvent {
  pid: number;
  /** Linux /proc/<pid>/stat field 22 (jiffies since boot); null off-Linux. */
  pidStarttime: number | null;
}

interface WardenLineEvent {
  stream: "stdout" | "stderr";
  text: string;
  /** True when the line exceeded the byte cap and its tail was dropped. */
  truncated: boolean;
}

export interface WardenExitEvent {
  code: number | null;
  /** Name of the signal that terminated the child ("SIGTERM"), if any. */
  signal: string | null;
  /** True when the warden's own deadline killed the child. */
  timedOut: boolean;
  /**
   * Why supervision ended: the child's own exit, the warden's deadline,
   * a forwarded parent signal, parent (Talon) death — or "warden-lost",
   * synthesized here when the warden died without a terminal event.
   */
  reason: "exited" | "timeout" | "signal" | "parent-exit" | "warden-lost";
  durationMs: number;
}

export interface WardenSpawnOptions {
  command: string;
  args: string[];
  /** Hard deadline for the child, 0 = none (persistent triggers). */
  timeoutMs: number;
  /** TERM → KILL escalation window, for deadlines and forwarded signals. */
  graceMs: number;
  env?: NodeJS.ProcessEnv;
  onStart: (event: WardenStartEvent) => void;
  onLine: (event: WardenLineEvent) => void;
  /** Exactly one of onExit / onSpawnError fires, exactly once. */
  onExit: (event: WardenExitEvent) => void;
  onSpawnError: (message: string) => void;
}

// ── Binary resolution ────────────────────────────────────────────────────────

let cachedPath: string | null | undefined;

/**
 * Resolve the warden binary, or null when supervision must fall back to
 * the TS path: TALON_NO_WARDEN=1 (operator escape hatch) or no
 * executable found. The warden is cross-platform — a process-group
 * harness on Unix, a kill-on-close Job Object harness on Windows (where
 * the binary is `talon-warden.exe`). TALON_WARDEN overrides the default
 * `bin/talon-warden` location (used by tests and packaging layouts that
 * install the binary elsewhere).
 */
export function wardenBinaryPath(): string | null {
  if (cachedPath === undefined) cachedPath = resolveWardenPath();
  return cachedPath;
}

function resolveWardenPath(): string | null {
  if (process.env.TALON_NO_WARDEN === "1") return null;

  const binName =
    process.platform === "win32" ? "talon-warden.exe" : "talon-warden";

  const candidates: string[] = [];
  if (process.env.TALON_WARDEN) {
    candidates.push(process.env.TALON_WARDEN);
  } else {
    try {
      // Beside bin/talon.js — where build:warden and packaging put it.
      // Throws under bun single-binary builds (no real fs URL): the
      // compiled binary ships through channels that install the warden
      // and set TALON_WARDEN, or it just falls back.
      candidates.push(
        fileURLToPath(new URL(`../../bin/${binName}`, import.meta.url)),
      );
    } catch {
      /* no resolvable location */
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch (err) {
      // Keep looking. An absent default binary is the normal npm install;
      // an explicit TALON_WARDEN that isn't executable is config silently
      // not taking effect.
      if (process.env.TALON_WARDEN) {
        logWarn(
          "native",
          `TALON_WARDEN not executable, spawning without warden path=${candidate}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return null;
}

/** `talon-warden --version` output, or null when unavailable. Doctor only. */
export function wardenVersion(): string | null {
  const bin = wardenBinaryPath();
  if (!bin) return null;
  const probe = spawnSync(bin, ["--version"], { encoding: "utf-8" });
  if (probe.status !== 0) return null;
  return probe.stdout.trim() || null;
}

/** Tests swap binaries via TALON_WARDEN and need the memo dropped. */
export function _resetWardenCacheForTesting(): void {
  cachedPath = undefined;
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/**
 * Spawn a child under the warden. Returns the warden's ChildProcess —
 * the handle Talon signals for cancel/shutdown (the warden forwards to
 * the child's whole process group) — or null when the warden is
 * unavailable or failed to spawn synchronously, in which case the
 * caller uses its direct-spawn path and no callback ever fires.
 */
export function spawnWarden(opts: WardenSpawnOptions): ChildProcess | null {
  const bin = wardenBinaryPath();
  if (!bin) return null;

  let warden: ChildProcess;
  try {
    warden = spawn(
      bin,
      [
        `--timeout-ms=${Math.max(0, Math.floor(opts.timeoutMs))}`,
        `--grace-ms=${Math.max(0, Math.floor(opts.graceMs))}`,
        "--",
        opts.command,
        ...opts.args,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"] as IOType[],
        env: opts.env,
      },
    );
  } catch (err) {
    return warnUnsupervised(opts.command, bin, err);
  }

  let started = false;
  let terminal = false;
  const finishExit = (event: WardenExitEvent) => {
    if (terminal) return;
    terminal = true;
    opts.onExit(event);
  };
  const failSpawn = (message: string) => {
    if (terminal) return;
    terminal = true;
    opts.onSpawnError(message);
  };

  // The warden writes nothing to stderr in normal operation — only
  // usage errors land there. Keep the last line for diagnostics.
  let lastStderr = "";
  if (warden.stderr) {
    const rlErr = createInterface({
      input: warden.stderr,
      crlfDelay: Infinity,
    });
    rlErr.on("line", (line) => {
      lastStderr = line;
    });
    rlErr.on("error", () => {});
  }

  if (warden.stdout) {
    const rl = createInterface({ input: warden.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return debugMangledEvent(line); // never take down the supervisor
      }
      switch (event.event) {
        case "start":
          started = true;
          opts.onStart({
            pid: Number(event.pid),
            pidStarttime:
              typeof event.pidStarttime === "number"
                ? event.pidStarttime
                : null,
          });
          break;
        case "line":
          opts.onLine({
            stream: event.stream === "stderr" ? "stderr" : "stdout",
            text: String(event.text ?? ""),
            truncated: event.truncated === true,
          });
          break;
        case "exit":
          finishExit({
            code: typeof event.code === "number" ? event.code : null,
            signal: typeof event.signal === "string" ? event.signal : null,
            timedOut: event.timedOut === true,
            reason:
              event.reason === "timeout" ||
              event.reason === "signal" ||
              event.reason === "parent-exit"
                ? event.reason
                : "exited",
            durationMs:
              typeof event.durationMs === "number" ? event.durationMs : 0,
          });
          break;
        case "error":
          failSpawn(String(event.message ?? "warden error"));
          break;
      }
    });
    rl.on("error", () => {});
  }

  warden.on("error", (err) => {
    // No pid → the warden never spawned (ENOENT and kin): terminal.
    // Anything after a successful spawn (signal-delivery failures and
    // the like) is non-terminal — matching the direct path, which logs
    // and keeps supervising. If the warden actually died, "close"
    // settles things.
    if (warden.pid === undefined) {
      failSpawn(
        `warden spawn failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  });

  // "close" (stdio drained), not "exit": the terminal protocol event may
  // still be buffered in the readline when "exit" fires. If the warden
  // died without one (SIGKILL, crash), synthesize so the trigger always
  // reaches a terminal state. The warden's pdeathsig/group-kill design
  // means the child is dead or dying by the time this happens.
  warden.on("close", (code, signal) => {
    if (terminal) return;
    if (!started) {
      failSpawn(
        `warden exited before starting child (code=${code} signal=${signal}` +
          (lastStderr ? `, stderr: ${lastStderr}` : "") +
          `)`,
      );
      return;
    }
    finishExit({
      code: null,
      signal: signal ?? null,
      timedOut: false,
      reason: "warden-lost",
      durationMs: 0,
    });
  });

  return warden;
}

/**
 * The caller falls back to a direct spawn, which loses the warden's
 * process-group cleanup, so say why. Returns spawnWarden's "no warden".
 */
function warnUnsupervised(command: string, bin: string, err: unknown): null {
  logWarn(
    "native",
    `warden spawn failed, running ${command} unsupervised bin=${bin}: ${err instanceof Error ? err.message : String(err)}`,
  );
  return null;
}

function debugMangledEvent(line: string): void {
  logDebug(
    "native",
    `warden: unparseable event line ${JSON.stringify(line.slice(0, 80))}`,
  );
}
