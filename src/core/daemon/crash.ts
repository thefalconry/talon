/**
 * Crash-path cleanup — what has to happen when the daemon goes down
 * abnormally: an uncaught exception, the forced exit after a shutdown
 * timeout, or a fatal startup error.
 *
 * Ordering is the whole point. The old handler logged first and cleaned
 * up afterwards, which works right up until logging is the thing that
 * broke. On 2026-09-18 the root disk filled; the log file's write stream
 * emitted ENOSPC with nobody listening, the uncaught-exception handler
 * called `logError` as its first act, threw inside itself, and Node
 * aborted the process — no database checkpoint, a stale pidfile left
 * behind, and (the expensive part) an armed `/update` handoff that never
 * spawned its successor. The daemon simply vanished.
 *
 * So: the essentials first, each in its own try/catch, logging last and
 * strictly best-effort. `src/util/log.ts` now keeps a broken log file
 * from throwing at all — this is the second line of defence, for every
 * other way logging can fail while the machine is sick.
 */

import { logError, logWarn } from "../../util/log.js";
import { writeCrashMarker } from "./crash-marker.js";
import { noteUnhandledRejection } from "./health-alerts.js";
import { removePidRecordIfOwnedBy } from "./pidfile.js";
import { spawnSuccessor } from "./respawn.js";

/**
 * Steps the crash path can only get from the composition root.
 * `flushDatabase` is injected because the SQLite handle stays inside
 * `storage/` (.dependency-cruiser: db-handle-stays-in-storage).
 */
export type CrashHooks = {
  flushDatabase: () => void;
};

/**
 * Run one crash-path step. Never throws, and never uses the logger —
 * a broken logger is precisely the case this path exists for, so the
 * console is the fallback of last resort.
 */
export function crashStep(name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    try {
      console.error(`[talon] crash cleanup: ${name} failed`, err);
    } catch {
      /* stdio is gone too — nothing left to try */
    }
  }
}

/**
 * The non-logging essentials, in the order that matters:
 *   1. drop the pid record, so `talon status` stops chasing a dead pid
 *      (before the successor writes its own — the guarded removal then
 *      cannot possibly orphan it),
 *   2. hand off to the successor if `/restart` or `/update` armed one
 *      (a no-op otherwise, see respawn.ts),
 *   3. checkpoint the database.
 */
export function crashCleanup(hooks: CrashHooks): void {
  crashStep("pid record removal", () => removePidRecordIfOwnedBy(process.pid));
  crashStep("respawn handoff", () => spawnSuccessor());
  crashStep("database flush", hooks.flushDatabase);
}

/**
 * `process.on("uncaughtException")` body. Cleanup happens before the
 * crash is reported, never after. The crash marker sits between the two:
 * it is how the operator hears about this crash (the next boot announces
 * it), but it is not worth a pidfile or a successor.
 */
export function handleUncaughtException(err: Error, hooks: CrashHooks): void {
  // EPIPE errors from network sockets (e.g. Telegram MTProto) are transient —
  // gramjs will reconnect; crashing the process here is wrong.
  if ((err as NodeJS.ErrnoException).code === "EPIPE") {
    crashStep("EPIPE notice", () =>
      logWarn("bot", `Suppressed transient EPIPE error: ${err.message}`),
    );
    return;
  }
  crashCleanup(hooks);
  crashStep("crash marker", () => writeCrashMarker("uncaught", err));
  crashStep("crash report", () => logError("bot", "Uncaught exception", err));
  process.exit(1);
}

/**
 * `process.on("unhandledRejection")` body. Report — never crash — but keep
 * the stack: a bare "Unhandled rejection: ENOSPC: no space left on device,
 * write" says nothing about which code path forgot its `.catch()`. Async fs
 * errors carry `path`/`syscall` rather than useful frames, so those ride
 * along in the message too. Repeats raise `daemon.unhandled`
 * (./health-alerts.ts).
 */
export function handleUnhandledRejection(reason: unknown): void {
  crashStep("rejection report", () => {
    if (!(reason instanceof Error)) {
      logError("bot", `Unhandled rejection: ${String(reason)}`);
      return;
    }
    const { syscall, path } = reason as NodeJS.ErrnoException;
    const where = [syscall, path].filter(Boolean).join(" ");
    logError(
      "bot",
      `Unhandled rejection: ${reason.message}${where ? ` (${where})` : ""}`,
      reason,
    );
  });
  crashStep("rejection alarm", () => noteUnhandledRejection(reason));
}
