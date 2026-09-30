/**
 * MCP child guard — orphan protection for hub children without a
 * supervisor process per child.
 *
 * The hub used to spawn every MCP child through its own `_mcp-launch`
 * supervisor (a full Talon runtime re-invocation, ~20 MB private memory
 * each). With one child per plugin per chat that was dozens of idle
 * supervisors whose only jobs were stdout filtering and killing the child
 * if Talon died. The hub now does the filtering in-process
 * (child-transport.ts) and spawns children directly; the kill-on-death
 * guarantee moves to ONE reaper process per daemon:
 *
 *   daemon ──stdin pipe──▶ reaper (`_mcp-reaper`)
 *     "+<pid>\n"  a child was spawned — kill it if the daemon dies
 *     "-<pid>\n"  that child exited (or was closed) — forget it
 *
 * When the reaper's stdin closes — the daemon exited, INCLUDING SIGKILL,
 * because the kernel closes the pipe — or the bridge watchdog trips, it
 * SIGTERMs every registered pid, SIGKILLs survivors after a grace period,
 * and exits. Same shutdown signals, same SIGTERM→SIGKILL escalation and
 * same tolerant BridgeWatchdog as the per-child supervisor (launcher.ts);
 * pipe EOF and `process.kill` behave identically on Linux, macOS and
 * Windows, so no platform-specific mechanism is involved. The reaper is
 * launched through `selfInvocation`, the same re-invocation path the
 * supervisor uses, so it works for tsx/node and bun source runs,
 * bun-compiled binaries and npm installs alike.
 *
 * Fallback: if the reaper cannot be started, or keeps dying right after
 * start, the guard switches to "supervisor" mode and new children are
 * wrapped in the per-child supervisor exactly as before.
 * `TALON_MCP_SUPERVISOR=per-child` forces that mode.
 *
 * The guard is off until the daemon enables it (initHub). Embedders and
 * unit tests that drive the hub directly spawn children unguarded rather
 * than re-invoking an entrypoint that does not dispatch `_mcp-reaper`.
 */

import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { logWarn } from "../../util/log.js";
import { selfInvocation, wrapMcpServer } from "./launcher.js";
import { MCP_REAPER_SUBCOMMAND } from "./reaper.js";

/** Opt-out env var: `per-child` restores one supervisor per MCP child. */
const SUPERVISOR_MODE_ENV = "TALON_MCP_SUPERVISOR";

// ── Daemon side ─────────────────────────────────────────────────────────────

/**
 * - off: children spawn unguarded (guard never enabled — tests, embedders).
 * - reaper: children spawn directly and are registered with the reaper.
 * - supervisor: children are wrapped in the per-child supervisor.
 */
export type ChildGuardMode = "off" | "reaper" | "supervisor";

let mode: ChildGuardMode = "off";
let reaper: ChildProcess | null = null;
let reaperStartedAt = 0;
let reaperBridgeUrl: string | undefined;
let stopping = false;
/** Consecutive reapers that died within REAPER_EARLY_DEATH_MS of start. */
let earlyDeaths = 0;
/** Children currently registered — replayed into a respawned reaper. */
const guarded = new Set<number>();

const REAPER_EARLY_DEATH_MS = 5_000;
const REAPER_EARLY_DEATHS_BEFORE_FALLBACK = 3;

/** Turn the guard on (daemon bootstrap). Idempotent. */
export function enableChildGuard(): void {
  stopping = false;
  if (mode !== "off") return;
  mode =
    process.env[SUPERVISOR_MODE_ENV] === "per-child" ? "supervisor" : "reaper";
}

export function childGuardMode(): ChildGuardMode {
  return mode;
}

function fallBackToSupervisor(reason: string): void {
  if (mode !== "reaper") return;
  mode = "supervisor";
  logWarn(
    "gateway",
    `mcp reaper unavailable (${reason}); new MCP children fall back to one supervisor each`,
  );
}

function writeLine(line: string): void {
  const stdin = reaper?.stdin;
  if (!stdin || stdin.destroyed) return;
  try {
    stdin.write(`${line}\n`);
  } catch {
    /* reaper gone — its exit handler respawns and replays */
  }
}

function onReaperExit(proc: ChildProcess): void {
  if (reaper !== proc) return;
  reaper = null;
  if (stopping || mode !== "reaper") return;
  const early = Date.now() - reaperStartedAt < REAPER_EARLY_DEATH_MS;
  earlyDeaths = early ? earlyDeaths + 1 : 0;
  if (earlyDeaths >= REAPER_EARLY_DEATHS_BEFORE_FALLBACK) {
    fallBackToSupervisor(`exited ${earlyDeaths} times right after start`);
    return;
  }
  logWarn(
    "gateway",
    `mcp reaper exited (code=${proc.exitCode} signal=${proc.signalCode}); restarting`,
  );
  // Live children must not go unguarded until the next spawn.
  if (guarded.size > 0) ensureReaper();
}

function ensureReaper(): void {
  if (reaper || mode !== "reaper") return;
  let proc: ChildProcess;
  try {
    const inv = selfInvocation(MCP_REAPER_SUBCOMMAND);
    const env: Record<string, string | undefined> = { ...process.env };
    if (reaperBridgeUrl) env.TALON_BRIDGE_URL = reaperBridgeUrl;
    else delete env.TALON_BRIDGE_URL;
    proc = crossSpawn(inv.command, inv.args, {
      stdio: ["pipe", "ignore", "pipe"],
      env,
      windowsHide: true,
    });
  } catch (err) {
    fallBackToSupervisor(err instanceof Error ? err.message : String(err));
    return;
  }
  reaper = proc;
  reaperStartedAt = Date.now();
  proc.stdin?.on("error", () => {});
  proc.stderr?.setEncoding("utf-8");
  proc.stderr?.on("data", (chunk: string) => {
    const text = chunk.trim();
    if (text) logWarn("gateway", `mcp reaper: ${text}`);
  });
  proc.once("error", (err) => {
    // Spawn failure (ENOENT/EACCES): no reaper can ever start this way.
    fallBackToSupervisor(err.message);
    onReaperExit(proc);
  });
  proc.once("exit", () => onReaperExit(proc));
  // Don't keep the daemon's event loop alive just for the reaper.
  proc.unref();
  (proc.stdin as { unref?: () => void } | null)?.unref?.();
  (proc.stderr as { unref?: () => void } | null)?.unref?.();
  for (const pid of guarded) writeLine(`+${pid}`);
}

/**
 * The spawn spec to actually run for `spec`: unchanged when the reaper
 * guards children (or the guard is off), supervisor-wrapped in
 * supervisor mode.
 */
export function guardedSpec<
  T extends { command: string; args: string[]; env?: Record<string, string> },
>(spec: T): T {
  return mode === "supervisor" ? wrapMcpServer(spec) : spec;
}

/**
 * Register a freshly spawned child with the reaper. `bridgeUrl` arms the
 * reaper's bridge watchdog (first one seen wins; it is the daemon's own
 * gateway, identical for every child).
 */
export function guardChild(pid: number, bridgeUrl?: string): void {
  if (mode !== "reaper") return;
  reaperBridgeUrl ??= bridgeUrl;
  guarded.add(pid);
  if (reaper) writeLine(`+${pid}`);
  else ensureReaper(); // replays `guarded`, including this pid
}

/** Forget a child that has exited or been closed. */
export function releaseChild(pid: number): void {
  if (!guarded.delete(pid)) return;
  writeLine(`-${pid}`);
}

/**
 * Daemon shutdown, after the hub closed its children: close the reaper's
 * stdin so it reaps anything still registered and exits.
 */
export function stopChildGuard(): void {
  stopping = true;
  const proc = reaper;
  reaper = null;
  proc?.stdin?.end();
}

/** Test-only: reset module state. */
export function _resetChildGuardForTesting(): void {
  stopChildGuard();
  guarded.clear();
  mode = "off";
  earlyDeaths = 0;
  reaperBridgeUrl = undefined;
  stopping = false;
}

/**
 * Diagnostic: pid of the live reaper, if any.
 *
 * @public — read by the reaper functional test's harness (a separate
 * process knip can't see), not by Talon's own graph.
 */
export function reaperPid(): number | null {
  return reaper?.pid ?? null;
}
