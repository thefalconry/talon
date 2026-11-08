/**
 * Child process management for Kimi Code CLI.
 *
 * Each turn is spawned via `kimi -p <prompt> --output-format stream-json`.
 * Session continuity across turns is maintained via `-S <session_id>` or `--session <session_id>`.
 *
 * When a turn is active, `KimiChild` holds the process handle and buffers output.
 * If the turn is terminated (e.g. by `end_turn` or user interrupt), `kill(reason)`
 * stops the process cleanly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { log, logError } from "../../../util/log.js";
import {
  parseKimiLine,
  type KimiEvent,
  type KimiTurnTokens,
  kimiUsageToTokens,
} from "../events.js";
import {
  KIMI_BASE_ARGS,
  KIMI_KILL_GRACE_MS,
  KIMI_RUN_LABEL_ENV,
} from "../constants.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { kimiHome } from "../auth.js";

const STDERR_TAIL_CHARS = 4000;

export interface KimiSpawnSpec {
  binary: string;
  cwd: string;
  model: string;
  addDirs?: readonly string[];
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface KimiTurnHandlers {
  onEvent?: (event: KimiEvent) => void;
  onStep?: (event: KimiEvent) => void;
}

export class KimiTurnAborted extends Error {
  constructor(reason: string) {
    super(`kimi turn aborted (${reason})`);
    this.name = "KimiTurnAborted";
  }
}

class KimiProcessExited extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "KimiProcessExited";
  }
}

function buildKimiArgs(spec: KimiSpawnSpec, prompt: string): string[] {
  const args = [...KIMI_BASE_ARGS, "-p", prompt, "-m", spec.model];
  if (spec.sessionId) {
    args.push("-S", spec.sessionId);
  }
  for (const dir of spec.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  return args;
}

/**
 * Render argv for the log with the prompt replaced by its size. The
 * prompt is the user's message (plus the whole system prompt on a first
 * turn) and must not be copied into the daemon log.
 */
export function describeKimiArgs(args: readonly string[]): string {
  return args
    .map((arg, i) =>
      i > 0 && args[i - 1] === "-p"
        ? `<prompt: ${Buffer.byteLength(arg, "utf-8")} bytes>`
        : arg,
    )
    .join(" ");
}

/**
 * Linux caps a single argv string at MAX_ARG_STRLEN (32 pages = 128 KiB).
 * `kimi` takes the prompt only as `-p <prompt>` (it reads nothing from
 * stdin in prompt mode), so a bigger prompt cannot be passed at all, and
 * spawn would fail with a bare E2BIG. A small margin covers the NUL.
 */
export const KIMI_MAX_PROMPT_BYTES = 128 * 1024 - 64;

/** A clear error for a prompt `kimi -p` cannot take, else undefined. */
export function kimiPromptTooLarge(prompt: string): Error | undefined {
  if (process.platform !== "linux") return undefined;
  const bytes = Buffer.byteLength(prompt, "utf-8");
  if (bytes <= KIMI_MAX_PROMPT_BYTES) return undefined;
  return new Error(
    `kimi: the prompt is ${Math.ceil(bytes / 1024)} KiB, over the ` +
      `${KIMI_MAX_PROMPT_BYTES >> 10} KiB a single command-line argument ` +
      "can hold on Linux, and kimi only takes the prompt as `-p <prompt>`. " +
      "Shorten the message or the system prompt.",
  );
}

/** Look for usage recorded in <kimi home>/sessions/.../wire.jsonl */
export async function readKimiSessionUsage(
  sessionId: string,
): Promise<KimiTurnTokens | undefined> {
  try {
    const baseDir = join(kimiHome(), "sessions");
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wirePath = join(
        baseDir,
        entry.name,
        sessionId,
        "agents",
        "main",
        "wire.jsonl",
      );
      let content: string;
      try {
        content = await readFile(wirePath, "utf-8");
      } catch {
        continue;
      }
      const lines = content.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"usage.record"')) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "usage.record" && parsed.usage) {
            return kimiUsageToTokens(parsed.usage);
          }
        } catch {
          // continue searching
        }
      }
    }
  } catch {
    // best-effort
  }
  return undefined;
}

export interface KimiTurnResult {
  sessionId?: string;
  usage?: KimiTurnTokens;
}

export class KimiChild {
  spec: KimiSpawnSpec;
  readonly label: string;
  private proc: ChildProcess | null = null;
  private stdoutBuf = "";
  private stderrTail = "";
  private inFlightReject: ((err: unknown) => void) | null = null;
  private exited = false;
  sessionId: string | undefined;

  constructor(label: string, spec: KimiSpawnSpec) {
    this.label = label;
    this.spec = spec;
    this.sessionId = spec.sessionId;
  }

  get alive(): boolean {
    return this.proc !== null && !this.exited;
  }

  get stderrSnapshot(): string {
    return this.stderrTail;
  }

  runTurn(
    prompt: string,
    handlers: KimiTurnHandlers = {},
  ): Promise<KimiTurnResult> {
    if (this.alive) {
      return Promise.reject(
        new Error(
          `kimi: a turn is already in flight for ${this.label} — ` +
            "the dispatcher is expected to serialise per chat",
        ),
      );
    }

    const tooLarge = kimiPromptTooLarge(prompt);
    if (tooLarge) return Promise.reject(tooLarge);

    const args = buildKimiArgs(this.spec, prompt);
    log(
      "agent",
      `[${this.label}] kimi spawn: ${this.spec.binary} ${describeKimiArgs(args)}`,
    );

    const proc = spawn(this.spec.binary, args, {
      cwd: this.spec.cwd,
      env: {
        ...(this.spec.env ?? process.env),
        [KIMI_RUN_LABEL_ENV]: this.label,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc = proc;
    this.exited = false;
    this.stdoutBuf = "";
    this.stderrTail = "";

    proc.stdout.setEncoding("utf-8");
    proc.stderr.setEncoding("utf-8");

    return new Promise<KimiTurnResult>((resolve, reject) => {
      this.inFlightReject = reject;
      // Set once a line handler throws: the turn is failed with that error
      // and the process is torn down, so later output is ignored.
      let lineError: unknown;
      const handleLine = (line: string): void => {
        if (lineError !== undefined) return;
        try {
          this.onLine(line, handlers);
        } catch (err) {
          lineError = err ?? new Error("kimi stream handler failed");
          this.failTurn(lineError);
        }
      };

      proc.stdout.on("data", (chunk: string) => {
        this.stdoutBuf += chunk;
        let nl = this.stdoutBuf.indexOf("\n");
        while (nl >= 0) {
          const line = this.stdoutBuf.slice(0, nl);
          this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
          handleLine(line);
          nl = this.stdoutBuf.indexOf("\n");
        }
      });

      proc.stderr.on("data", (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
      });

      proc.on("error", (err) => {
        this.exited = true;
        this.proc = null;
        this.inFlightReject = null;
        reject(err);
      });

      proc.on("close", async (code) => {
        this.exited = true;
        this.proc = null;
        this.inFlightReject = null;

        // Flush remaining line in buffer
        if (this.stdoutBuf.trim()) {
          const last = this.stdoutBuf;
          this.stdoutBuf = "";
          handleLine(last);
        }
        if (lineError !== undefined) {
          // failTurn already rejected; this keeps the flush path settled
          // too when the throwing line was the unterminated last one.
          reject(lineError);
          return;
        }

        if (code === 0) {
          let usage: KimiTurnTokens | undefined;
          if (this.sessionId) {
            usage = await readKimiSessionUsage(this.sessionId);
          }
          resolve({ sessionId: this.sessionId, usage });
        } else {
          const detail = this.stderrTail
            .trim()
            .split("\n")
            .slice(-4)
            .join("\n");
          reject(
            new KimiProcessExited(
              `kimi exited (code ${code ?? "n/a"})${detail ? `: ${detail}` : ""}`,
              code,
              this.stderrTail,
            ),
          );
        }
      });
    });
  }

  private onLine(line: string, handlers: KimiTurnHandlers): void {
    const event = parseKimiLine(line);
    if (!event) return;
    if (
      event.role === "meta" &&
      event.type === "session.resume_hint" &&
      event.session_id
    ) {
      this.sessionId = event.session_id;
    }
    handlers.onStep?.(event);
    handlers.onEvent?.(event);
  }

  /**
   * A stream handler threw. Fail the turn with that error rather than let
   * it escape the stdout listener, where it would be an uncaught exception
   * and take the whole daemon down with it.
   */
  private failTurn(err: unknown): void {
    logError(
      "agent",
      `[${this.label}] kimi stream handler failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    const reject = this.inFlightReject;
    this.inFlightReject = null;
    reject?.(err);
    this.kill("stream handler error");
  }

  kill(reason: string): void {
    const proc = this.proc;
    if (this.inFlightReject) {
      const reject = this.inFlightReject;
      this.inFlightReject = null;
      reject(new KimiTurnAborted(reason));
    }
    if (!proc || this.exited) {
      this.proc = null;
      return;
    }
    log("agent", `[${this.label}] kimi child kill (${reason})`);
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        if (!this.exited) proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, KIMI_KILL_GRACE_MS);
    timer.unref();
    this.proc = null;
  }
}

// ── Pool ────────────────────────────────────────────────────────────────────

const children = new Map<string, KimiChild>();

export function ensureChild(chatId: string, spec: KimiSpawnSpec): KimiChild {
  const existing = children.get(chatId);
  if (existing) {
    existing.spec = spec;
    // Track the spec's session exactly: a pooled child must not carry the
    // id of a session the chat has since dropped (reset, expired) into a
    // turn that starts a fresh one.
    existing.sessionId = spec.sessionId;
    return existing;
  }
  const child = new KimiChild(chatId, spec);
  children.set(chatId, child);
  return child;
}

export function getChild(chatId: string): KimiChild | undefined {
  return children.get(chatId);
}

export function killChild(chatId: string, reason: string): boolean {
  const child = children.get(chatId);
  if (!child) return false;
  child.kill(reason);
  children.delete(chatId);
  return true;
}

export function killAllChildren(reason: string): void {
  const ids = childChatIds();
  for (const chatId of ids) killChild(chatId, reason);
}

export function childChatIds(): string[] {
  return [...children.keys()];
}
