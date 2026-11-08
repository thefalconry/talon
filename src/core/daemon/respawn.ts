/**
 * Self-respawn helper for /restart and /update across frontends.
 *
 * Spawns a fresh copy of the current process — same runtime binary, same
 * `execArgv` (preserving a loader so `.ts` entrypoints still resolve),
 * same script + user args, same cwd + env. The new child is detached so
 * it survives the parent's exit; `unref()` lets the parent exit without
 * waiting on it.
 *
 * Why not call the daemon's `talon restart` CLI? That path assumed the
 * bot was started via the daemon (talon.pid managed by `daemonStart()`)
 * and broke for anything else — `npm start`, `npx tsx src/index.ts`,
 * systemd, foreman, pm2, or running under a debugger. Respawning from
 * our own `process.argv` works regardless of launch method.
 *
 * Ordering matters. `respawnSelf()` only *arms* the handoff and enters
 * graceful shutdown; the successor is spawned by `spawnSuccessor()` at
 * the tail of it, once the frontends have stopped. Spawning up-front
 * (the original behaviour) left the successor long-polling `getUpdates`
 * while the outgoing process was still draining in-flight queries — up
 * to DRAIN_TIMEOUT_MS of two live pollers. Telegram answers only one of
 * them and re-delivers the unconfirmed updates to the other, so a
 * restart mid-turn produced a 409 Conflict on the way out and duplicate
 * replies on the way in. Releasing the poll before the successor binds
 * it removes the overlap rather than relying on grammy's 409 retry to
 * paper over it.
 *
 * Two things the 2026-09-18 outage added, both about the fact that the
 * outgoing process is dying and cannot be the one responsible for the
 * outcome:
 *
 *   - The successor's stdout and stderr go to ~/.talon/respawn.log, not
 *     to "ignore". A successor that dies before its own logger exists —
 *     a broken import after a dependency install, a fatal bind, a
 *     runtime that aborts — used to leave no trace in any file, on any
 *     process. That is precisely what happened: a successor was spawned,
 *     lived ~20s, never bound its gateway, and vanished without a line.
 *   - A watcher process is spawned alongside it (./handoff.ts). It
 *     outlives us, verifies the successor over identity-checked /health
 *     within a bounded window, and starts the daemon the way `talon
 *     start` does if the successor never comes up. Nothing in the
 *     handoff depends on a process that is about to call process.exit().
 *
 * And one thing 2026-09-20 added: the shutdown is entered directly,
 * through the function app.ts registers with `setRespawnShutdown()`,
 * not by sending ourselves a SIGTERM. The signal round trip bought
 * nothing, and under Bun it lost the whole restart: by the time
 * `/restart` ran, the process had silently lost its OS-level SIGTERM
 * handler (see ./signals.ts), so the signal terminated it on the spot —
 * no shutdown, no successor, no pidfile cleanup, and nothing in any log
 * after "Respawn requested". Only a process that never registered — an
 * embedder, a test — still falls back to the signal.
 */

import { spawn } from "node:child_process";
import { log, logError, openRespawnLog } from "../../util/log.js";
import { HANDOFF_WATCH_SUBCOMMAND } from "./handoff.js";
import { PREDECESSOR_PID_ENV } from "./discovery.js";

let pendingReason: string | null = null;
let shutdown: ((reason: string) => void) | null = null;

/**
 * Register the graceful-shutdown entry a respawn should run. app.ts
 * hands over `gracefulShutdown`; `respawnSelf()` then calls it in-process
 * instead of round-tripping a SIGTERM through the OS. `null` clears it.
 */
export function setRespawnShutdown(
  fn: ((reason: string) => void) | null,
): void {
  shutdown = fn;
}

/**
 * Argv flag that makes the daemon entry resolve its whole import graph
 * and exit 0 without booting (src/app.ts acts on it before the first
 * bootstrap step). `/update` runs the freshly installed tree with this
 * flag before handing off — see core/update/self-update.ts.
 */
export const BOOT_SMOKE_FLAG = "--boot-smoke";

/** Printed by a successful smoke run; the update step matches on it. */
export const BOOT_SMOKE_OK = "talon boot-smoke ok";

/**
 * A bun-compiled binary embeds its source tree: `process.argv[1]` points
 * into the virtual FS ($bunfs / ~BUN) and has no path on disk, so the
 * binary is re-invoked with no script argument at all.
 */
function isEmbeddedEntry(entry: string): boolean {
  return entry.includes("$bunfs") || entry.includes("~BUN");
}

/** The exact command that re-runs this process. */
export function successorCommand(): { cmd: string; args: string[] } {
  return {
    cmd: process.argv[0],
    args: [...process.execArgv, ...process.argv.slice(1)],
  };
}

/** The same runtime + entry, re-invoked with one of our own subcommands. */
function selfInvocation(extra: string[]): { cmd: string; args: string[] } {
  const entry = process.argv[1] ?? "";
  const prefix = isEmbeddedEntry(entry) ? [] : [...process.execArgv, entry];
  return { cmd: process.argv[0], args: [...prefix, ...extra] };
}

/**
 * Arm a respawn and enter graceful shutdown, which stops the frontends,
 * flushes state, and hands off via `spawnSuccessor()`.
 *
 * `reason` is logged for operator visibility (e.g. "telegram
 * /restart"). The function returns immediately; the successor starts
 * only after shutdown has released the Telegram long-poll.
 */
export function respawnSelf(reason: string): void {
  log("shutdown", `Respawn requested (${reason})`);
  pendingReason = reason;
  // Don't exit here directly — that would skip the flush and leave the
  // PID file dangling. The registered shutdown is the same path a
  // SIGTERM takes, entered without the signal.
  if (shutdown) {
    shutdown(reason);
    return;
  }
  process.kill(process.pid, "SIGTERM");
}

/** True when a `/restart` or `/update` armed a handoff. */
export function respawnRequested(): boolean {
  return pendingReason !== null;
}

export type SpawnFn = typeof spawn;

/**
 * Start the watcher that outlives this process and answers the only
 * question that matters: did the successor actually come up? Never
 * throws — a missing watcher must not cost us the successor itself.
 */
function spawnHandoffWatcher(
  childPid: number,
  fd: number | null,
  spawnFn: SpawnFn,
): void {
  try {
    const { cmd, args } = selfInvocation([
      HANDOFF_WATCH_SUBCOMMAND,
      String(childPid),
    ]);
    const watcher = spawnFn(cmd, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"],
      env: { ...process.env },
    });
    watcher.once("error", (err) => {
      logError("shutdown", "Handoff watcher failed to start", err);
    });
    watcher.unref();
    log("shutdown", `Handoff watcher started (pid ${watcher.pid})`);
  } catch (err) {
    logError("shutdown", "Handoff watcher failed to start", err);
  }
}

/**
 * Spawn the successor process. Called at the end of graceful shutdown,
 * after the frontends have stopped — so the incoming process binds
 * Telegram's long-poll only once this one has let go of it. No-op unless
 * `respawnSelf()` armed a handoff.
 *
 * Never throws: a failed handoff must not prevent this process from
 * exiting. The watcher is the safety net, not an external supervisor.
 */
export function spawnSuccessor(spawnFn: SpawnFn = spawn): void {
  if (pendingReason === null) return;
  const reason = pendingReason;
  pendingReason = null;

  // One fd for both streams, shared with the watcher: the successor's
  // boot output and the watcher's verdict land in the same file, in
  // order, even when the successor never gets far enough to log.
  const fd = openRespawnLog();
  try {
    const child = spawnFn(process.argv[0], successorCommand().args, {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"],
      // Tells the successor's single-instance guard that the daemon it
      // can still see is us, on our way out — wait, don't refuse.
      env: { ...process.env, [PREDECESSOR_PID_ENV]: String(process.pid) },
    });
    child.once("error", (err) => {
      logError("shutdown", `Respawn failed (${reason}) — see respawn.log`, err);
    });
    child.unref();
    log("shutdown", `Respawn child started (pid ${child.pid}) — ${reason}`);
    if (child.pid) spawnHandoffWatcher(child.pid, fd, spawnFn);
  } catch (err) {
    logError("shutdown", `Respawn failed (${reason}) — see respawn.log`, err);
  }
}
