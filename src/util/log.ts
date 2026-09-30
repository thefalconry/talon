/**
 * Structured logging via pino — console + file output.
 *
 * Always runs at trace level (maximum verbosity) for debugging.
 * Logs to both:
 *   - stdout (pretty-printed for readability)
 *   - workspace/talon.log (JSON, append-only, for persistence)
 */

import pino from "pino";
import prettyStream from "pino-pretty";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  fstatSync,
} from "node:fs";
import { dirs, files } from "./paths.js";
import { currentTurnId } from "./logging/turn-scope.js";

export type LogComponent =
  | "bot"
  | "bridge"
  | "bus"
  | "db"
  | "journal"
  | "kv"
  | "media"
  | "notify"
  | "alert"
  | "agent"
  | "agents"
  | "tasks"
  | "pulse"
  | "userbot"
  | "users"
  | "watchdog"
  | "workspace"
  | "shutdown"
  | "file"
  | "history"
  | "sessions"
  | "settings"
  | "commands"
  | "cron"
  | "triggers"
  | "scripts"
  | "skills"
  | "dream"
  | "heartbeat"
  | "dispatcher"
  | "gateway"
  | "fusefs"
  | "plugin"
  | "teams"
  | "discord"
  | "whatsapp"
  | "native"
  | "mesh"
  | "config"
  | "access"
  | "github"
  | "mempalace"
  | "mem0"
  | "playwright"
  | "memory"
  | "stickers"
  | "backup"
  | "router"
  | "backend-controller"
  | "fetch";

const LOG_FILE = files.log;

// Ensure .talon dir exists for log file
if (!existsSync(dirs.root)) {
  try {
    mkdirSync(dirs.root, { recursive: true });
  } catch {
    /* ignore */
  }
}

// Rotate log file on startup if it exceeds 10MB
const MAX_LOG_SIZE = 10 * 1024 * 1024;

/**
 * Move `path` aside to `path.old` when it has outgrown the cap. Used at
 * import time for talon.log and at handoff time for respawn.log, so both
 * files follow the same one-generation rule. Never throws.
 */
function rotateIfLarge(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size <= MAX_LOG_SIZE) return;
    const rotated = `${path}.old`;
    try {
      unlinkSync(rotated);
    } catch {
      /* no previous generation */
    }
    renameSync(path, rotated);
  } catch {
    /* a log file we cannot rotate is still a log file we can append to */
  }
}

rotateIfLarge(LOG_FILE);

/**
 * Runtime retention for talon.log: once the live file passes the cap the
 * sink shifts it to `talon.log.1` (…`.1` → `.2`, oldest dropped), so a
 * long-running daemon keeps a bounded, numbered history instead of one
 * ever-growing file. The start-time `.old` rule above stays as it was;
 * readers treat `.old` as one more generation.
 */
const LOG_ROTATE_KEEP = 5;

/** The disk name of rotated generation `n` (1 = newest) of `path`. */
function rotatedLogPath(path: string, n: number): string {
  return `${path}.${n}`;
}

/**
 * Shift `path` into the numbered generations: drop `.keep`, move each
 * `.n` to `.n+1`, then `path` to `.1`. Every step is one rename, so a
 * crash part-way leaves a gap in the numbering, never a lost line — the
 * only file ever deleted is the oldest generation. Throws on the first
 * failure other than a missing generation.
 */
export function shiftLogGenerations(
  path: string,
  keep: number = LOG_ROTATE_KEEP,
): void {
  const skipMissing = (step: () => void): void => {
    try {
      step();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  };
  skipMissing(() => unlinkSync(rotatedLogPath(path, keep)));
  for (let n = keep - 1; n >= 1; n--) {
    skipMissing(() =>
      renameSync(rotatedLogPath(path, n), rotatedLogPath(path, n + 1)),
    );
  }
  renameSync(path, rotatedLogPath(path, 1));
}

// Suppress console output for terminal frontend (stdout belongs to the REPL)
let quiet = process.env.TALON_QUIET === "1";
if (!quiet) {
  try {
    const cfgPath = files.config;
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (cfg.frontend === "terminal") quiet = true;
    }
  } catch {
    /* ignore */
  }
}

// Under vitest, skip the file transport entirely. Its worker thread
// flushes asynchronously, so a log call near the end of a test races
// the suite's tmp-HOME cleanup (unhandled ENOENT — observed via
// codex-one-shot on macOS) — and suites that don't mock HOME would
// pollute the real ~/.talon/talon.log. Console output still flows for
// suites that don't mock this module.
const IS_VITEST = process.env.VITEST === "true";

// In-process streams (pino.multistream), NOT worker-thread transports.
// `transport: { targets }` spawns a thread-stream worker that resolves the
// target module ("pino-pretty", "pino/file") by name at runtime — which
// fails in a `bun build --compile` standalone binary (no node_modules on
// disk: "unable to determine transport target for pino-pretty"). Wiring
// the same destinations as direct streams keeps formatting identical and
// runs everywhere, with no worker.
const streams: pino.StreamEntry[] = [];

// Console output (disabled in quiet mode), pretty-printed.
if (!quiet) {
  const consoleStream = prettyStream({
    colorize: true,
    ignore: "pid,hostname",
    translateTime: "HH:MM:ss",
  });
  // pino-pretty writes through a SonicBoom on fd 1 whose own error
  // handler removes itself after the first non-EPIPE failure
  // (pino-pretty/lib/utils/build-safe-sonic-boom.js). With stdout
  // redirected to a file on a full disk that leaves the pipeline's next
  // error unhandled — i.e. an uncaught exception raised from inside a
  // log call. One permanent listener closes that door; a dead console
  // is not worth a dead daemon.
  consoleStream.on("error", () => {});
  streams.push({ level: "trace", stream: consoleStream });
}

/** How long to wait before the first attempt to reopen a failed log file. */
const SINK_RETRY_MS = 30_000;
/** Ceiling for the doubling backoff between reopen attempts. */
const SINK_MAX_RETRY_MS = 5 * 60_000;

/**
 * Where a {@link ResilientFileSink} puts its lines. Writing is
 * synchronous by contract: a line that `write()` returned from is on the
 * fd, not in a userspace queue. See the class doc for why that matters.
 */
export type SyncLogTarget = {
  /** Append one already-serialized line. Throws on failure. */
  write(line: string): void;
  /** Bytes already in the file when it was opened, when known. */
  readonly initialSize?: number;
  /** Release the underlying handle. Never throws. */
  close(): void;
};

export type ResilientFileSinkOptions = {
  /** Opens the underlying file. Injection seam for tests. */
  open?: (path: string) => SyncLogTarget;
  /** Where the pause/resume notices go. Defaults to the console sink. */
  notify?: (level: "warn" | "info", message: string) => void;
  /** First backoff step (default 30s). */
  retryMs?: number;
  /** Backoff ceiling (default 5 min). */
  maxRetryMs?: number;
  /**
   * Rotate the file once it passes this many bytes (default 10 MB);
   * 0 disables runtime rotation.
   */
  rotateAtBytes?: number;
  /** Numbered generations kept by a rotation (default 5). */
  keep?: number;
};

/**
 * A log file destination that cannot take the process down, and cannot
 * lose the last thing the process said.
 *
 * Two failures shaped this class, both on 2026-09-18.
 *
 * First, a bare `createWriteStream` handed to `pino.multistream` is a
 * loaded gun: when the disk fills (ENOSPC), or the file is unlinked
 * under a rotation (EBADF), or the fd goes bad (EIO), the stream emits
 * `error`. With no listener that is an uncaught exception — raised from
 * inside a log call, so the crash handler's own `logError` runs on a
 * logger that is already broken. A full disk killed the daemon that
 * way: no shutdown, no pidfile cleanup, no successor.
 *
 * Second — and this is why the writes below are synchronous — a
 * `createWriteStream` buffers in userspace and drains on later ticks,
 * while every terminal log line Talon writes is immediately followed by
 * `process.exit()`: "State saved", "Respawn child started", "Timeout
 * exceeded, forcing exit", "Fatal startup error". `process.exit()`
 * discards whatever is still queued, so precisely the lines that explain
 * a failed handoff were the ones that never reached the file. Measured
 * under Bun 1.3.9: three lines logged and then `process.exit(0)` produced
 * an empty (not even created) log file. A sink that writes with
 * `writeSync` has nothing to flush and nothing to lose — no flush step to
 * remember at any exit site, which is the only version of this that stays
 * fixed.
 *
 * pino only ever sees this object, which never throws and never blocks:
 *   - write failures pause file logging and close the broken handle,
 *   - lines written while paused are DROPPED and counted (never
 *     buffered — the failure mode here is "no space", so growing a
 *     buffer is the last thing to do),
 *   - an unref'd timer retries the open on a 30s → 5min backoff,
 *   - the first write to land again resumes logging and reports how
 *     many lines were lost.
 * The console sink keeps working throughout, and carries the two
 * notices.
 *
 * It also owns retention: after a write carries the file past
 * `rotateAtBytes` it shifts the generations (see
 * {@link shiftLogGenerations}) and reopens a fresh file, all inside the
 * same synchronous write — a few renames every 10 MB, no queue, no lost
 * line. The size is re-read from disk before rotating, so a file another
 * process already rotated is not rotated twice; a rotation that fails
 * keeps appending to the current file and tries again one cap later.
 */
export class ResilientFileSink {
  private readonly path: string;
  private readonly openTarget: (path: string) => SyncLogTarget;
  private readonly notify: (level: "warn" | "info", message: string) => void;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private target: SyncLogTarget | null = null;
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private droppedWhileDown = 0;
  private down = false;
  private readonly rotateAtBytes: number;
  private readonly keep: number;
  /** Bytes in the current file, as far as this process has seen. */
  private bytes = 0;
  /** Size at which the next rotation check runs. */
  private rotateCheckAt: number;

  constructor(path: string, opts: ResilientFileSinkOptions = {}) {
    this.path = path;
    this.openTarget = opts.open ?? openSyncLogFile;
    this.notify = opts.notify ?? notifyViaConsoleSink;
    this.baseRetryMs = opts.retryMs ?? SINK_RETRY_MS;
    this.maxRetryMs = opts.maxRetryMs ?? SINK_MAX_RETRY_MS;
    this.retryMs = this.baseRetryMs;
    this.rotateAtBytes = opts.rotateAtBytes ?? MAX_LOG_SIZE;
    this.keep = opts.keep ?? LOG_ROTATE_KEEP;
    this.rotateCheckAt = this.rotateAtBytes;
    this.openInner();
  }

  /** Lines discarded since the sink went down; cleared on recovery. */
  get dropped(): number {
    return this.droppedWhileDown;
  }

  /** True while file logging is paused (the console sink still runs). */
  get isDown(): boolean {
    return this.down;
  }

  /** pino.multistream's entire contract: one serialized line in. */
  write(line: string): void {
    const target = this.target;
    if (target === null) {
      this.droppedWhileDown++;
      return;
    }
    try {
      target.write(line);
    } catch (err) {
      this.droppedWhileDown++;
      this.fail(err);
      return;
    }
    this.markHealthy();
    this.bytes += Buffer.byteLength(line, "utf-8");
    if (this.rotateAtBytes > 0 && this.bytes > this.rotateCheckAt) {
      this.rotate();
    }
  }

  /** No-op: every write already reached the fd. Part of pino's shape. */
  flushSync(): void {}

  /** Close the file and stop retrying. Part of pino's shape. */
  end(): void {
    this.clearRetry();
    this.detachInner();
  }

  private openInner(): void {
    try {
      this.target = this.openTarget(this.path);
      this.bytes = this.target.initialSize ?? 0;
      this.rotateCheckAt = this.rotateAtBytes;
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * The current file passed the cap: shift the generations and reopen.
   * Never throws — a failed rename reopens the same file and appends
   * on, a failed reopen goes through the ordinary pause/retry path.
   */
  private rotate(): void {
    let onDisk: number;
    try {
      onDisk = statSync(this.path).size;
    } catch {
      // Unlinked under us: nothing to shift, just start a fresh file.
      this.detachInner();
      this.openInner();
      return;
    }
    if (onDisk <= this.rotateAtBytes) {
      // Someone else (another Talon process) already rotated it.
      this.bytes = onDisk;
      return;
    }
    // Close before renaming: a platform that refuses to rename an open
    // file (Windows) then fails the shift cleanly instead of half-way.
    this.detachInner();
    let failure: unknown = null;
    try {
      shiftLogGenerations(this.path, this.keep);
    } catch (err) {
      failure = err;
    }
    this.openInner();
    if (failure !== null) {
      this.rotateCheckAt = this.bytes + this.rotateAtBytes;
      const code = (failure as NodeJS.ErrnoException).code ?? String(failure);
      this.emitNotice(
        "warn",
        `log.rotate failed file=${this.path} code=${code} — still appending`,
      );
      return;
    }
    this.emitNotice(
      "info",
      `log.rotate file=${this.path} bytes=${onDisk} keep=${this.keep} ` +
        `previous=${rotatedLogPath(this.path, 1)}`,
    );
  }

  /** Give up on the current handle and arm a reopen. Never throws. */
  private fail(err: unknown): void {
    const firstFailure = !this.down;
    this.detachInner();
    this.down = true;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
    this.scheduleRetry(delay);
    if (!firstFailure) return; // a failed reopen is not news
    const code =
      (err as NodeJS.ErrnoException | undefined)?.code ??
      (err instanceof Error ? err.message : String(err));
    this.emitNotice(
      "warn",
      `Log file sink failed (${code}) — file logging paused, ` +
        `retrying in ${Math.round(delay / 1000)}s`,
    );
  }

  /** A write landed: the file is usable again. */
  private markHealthy(): void {
    if (!this.down) return;
    this.down = false;
    this.retryMs = this.baseRetryMs;
    const dropped = this.droppedWhileDown;
    this.droppedWhileDown = 0;
    this.emitNotice(
      "info",
      `Log file sink recovered — file logging resumed ` +
        `(${dropped} line(s) dropped while it was down)`,
    );
  }

  private detachInner(): void {
    const target = this.target;
    this.target = null;
    if (target === null) return;
    try {
      target.close();
    } catch {
      /* best effort */
    }
  }

  private scheduleRetry(delay: number): void {
    this.clearRetry();
    const timer = setTimeout(() => {
      this.retryTimer = null;
      this.openInner();
    }, delay);
    // A paused log sink must not hold the event loop open.
    timer.unref();
    this.retryTimer = timer;
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Notices are deferred: `fail()` can run inside pino's multistream
   * write loop, and logging re-entrantly from there would scramble the
   * metadata pino hangs off the stream for the rest of that loop.
   */
  private emitNotice(level: "warn" | "info", message: string): void {
    queueMicrotask(() => {
      try {
        this.notify(level, message);
      } catch {
        /* the notice is the least important thing here */
      }
    });
  }
}

/** Append `line` to `fd`, looping over a short write. Throws on failure. */
function appendLine(fd: number, line: string): void {
  const buf = Buffer.from(line, "utf-8");
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset);
  }
}

/** The production {@link SyncLogTarget}: an appended fd, written with writeSync. */
export function openSyncLogFile(path: string): SyncLogTarget {
  // 0600: turns and tool output land here — same sensitivity as history.
  const fd = openSync(path, "a", 0o600);
  let initialSize = 0;
  try {
    initialSize = fstatSync(fd).size;
  } catch {
    /* unknown size: rotation counts from zero */
  }
  return {
    initialSize,
    write: (line) => appendLine(fd, line),
    close: () => {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Open ~/.talon/respawn.log for a successor's stdout+stderr.
 *
 * A `/restart` or `/update` handoff spawns the next daemon detached; with
 * `stdio: "ignore"` a successor that dies before its logger exists — a
 * broken import after a dependency install, a fatal bind, a runtime that
 * aborts — leaves no trace anywhere, which is exactly how the 2026-09-18
 * handoff vanished. Handing the child this fd makes that visible. Same
 * one-generation rotation as talon.log.
 *
 * Returns null when the file cannot be opened; the caller falls back to
 * nothing, never to a failed handoff.
 */
export function openRespawnLog(path: string = files.respawnLog): number | null {
  try {
    rotateIfLarge(path);
    return openSync(path, "a", 0o600);
  } catch {
    return null;
  }
}

function notifyViaConsoleSink(level: "warn" | "info", message: string): void {
  if (level === "warn") logWarn("file", message);
  else log("file", message);
}

// JSON file output (always active outside test runs).
if (!IS_VITEST) {
  streams.push({ level: "trace", stream: new ResilientFileSink(LOG_FILE) });
}

const logger =
  streams.length > 0
    ? pino({ level: "trace" }, pino.multistream(streams))
    : pino({ level: "silent" });

/**
 * Emit one record. A logger that throws is worse than a silent one: the
 * throw lands on whoever called log(), which at shutdown is a signal
 * handler or a crash handler, and a throw there takes the daemon down —
 * pino-pretty's SonicBoom, for one, throws "SonicBoom destroyed"
 * synchronously on every write once a failure has destroyed it. Nothing
 * a sink does may escape this module.
 */
function emit(write: () => void): void {
  try {
    write();
  } catch {
    /* a broken logger must never become a broken daemon */
  }
}

/**
 * Append `turn=<id>` when the line is written from inside a running
 * turn (see logging/turn-scope.ts), unless the caller already named it. The
 * id goes in the message text, not a field, so a plain `grep` over
 * talon.log and the pretty console both show it.
 */
function tagTurn(message: string): string {
  const turnId = currentTurnId();
  if (!turnId) return message;
  const tag = `turn=${turnId}`;
  return message.includes(tag) ? message : `${message} ${tag}`;
}

export function log(component: LogComponent, message: string): void {
  emit(() => logger.info({ component }, tagTurn(message)));
}

type LogErrorListener = (
  component: LogComponent,
  message: string,
  err?: unknown,
) => void;

let errorListener: LogErrorListener | null = null;
let inErrorListener = false;

/**
 * Register (or clear, with null) the one listener every `logError` call
 * reaches — core's error-rate alarm (core/daemon/health-alerts.ts). util
 * cannot import core, so core registers itself here. The listener runs
 * synchronously and must be cheap; it cannot throw into the caller, and
 * a `logError` it makes itself is not fed back to it.
 */
export function onLogError(fn: LogErrorListener | null): void {
  errorListener = fn;
}

function notifyErrorListener(
  component: LogComponent,
  message: string,
  err: unknown,
): void {
  if (!errorListener || inErrorListener) return;
  inErrorListener = true;
  try {
    errorListener(component, message, err);
  } catch {
    /* an alarm must never break the error path it watches */
  } finally {
    inErrorListener = false;
  }
}

export function logError(
  component: LogComponent,
  message: string,
  err?: unknown,
): void {
  notifyErrorListener(component, message, err);
  if (err instanceof Error) {
    // Capture both the concise message (for log consumers that look at `err`)
    // and the full stack (for diagnostics). pino-pretty renders the `stack`
    // field on its own line; JSON consumers can read either field.
    emit(() =>
      logger.error(
        { component, err: err.message, stack: err.stack },
        tagTurn(message),
      ),
    );
  } else if (err !== undefined) {
    emit(() => logger.error({ component, err: String(err) }, tagTurn(message)));
  } else {
    emit(() => logger.error({ component }, tagTurn(message)));
  }
}

export function logWarn(component: LogComponent, message: string): void {
  emit(() => logger.warn({ component }, tagTurn(message)));
}

export function logDebug(component: LogComponent, message: string): void {
  emit(() => logger.debug({ component }, tagTurn(message)));
}

// Expose logger to plugins running in the same process
(globalThis as Record<string, unknown>).__talonLog = log;
(globalThis as Record<string, unknown>).__talonLogError = logError;
(globalThis as Record<string, unknown>).__talonLogWarn = logWarn;
