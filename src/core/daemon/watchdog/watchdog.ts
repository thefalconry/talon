/**
 * Daemon watchdog — `talon watchdog`, one check per run.
 *
 * Nothing supervised a daemon started with `talon start`: a crash, an OOM
 * kill or a reboot left Talon down until a human noticed. The `talon run`
 * systemd unit (packaging/systemd/talon.service) supervises, but it fights
 * the self-respawning `/restart` handoff (../respawn.ts), whose successor is
 * spawned detached by a process that then exits. So this is a supervisor
 * that only ever *starts*, run on a timer (packaging/systemd/
 * talon-watchdog.timer, or cron), and leaves the handoff alone.
 *
 * It must never produce a second daemon (two daemons poll Telegram, get
 * 409 on every getUpdates, and both run the cron jobs). Every layer below
 * is there for that:
 *
 *   1. It never kills and never restarts: it only starts, and only when
 *      discovery (../discovery.ts) finds no daemon at all — no identity-
 *      checked /health answer AND no live pid in the pidfile. A daemon
 *      that is booting, hung, or mid-handoff has a live pid and is left
 *      alone.
 *   2. It starts only after `minMisses` consecutive runs found nothing,
 *      spanning at least `minDownMs` (default 3 runs over ≥ 2 min). That
 *      outlasts the `/restart` handoff window (90 s, ../handoff.ts, whose
 *      own watcher repairs a failed handoff) and `talon start`'s 30 s boot
 *      wait, so a transient gap is never mistaken for an outage.
 *   3. The start itself is `startDaemon()` (../control.ts), the same path
 *      as `talon start`: it re-runs discovery immediately before spawning,
 *      and the daemon's own single-instance guard (checkSingleInstance)
 *      refuses to boot next to a live one.
 *   4. Runs are serialised by an O_EXCL lock file, so a timer run and a
 *      manual run can't both decide to start.
 *   5. `talon stop` leaves a stop marker (./stop-marker.ts); while it
 *      exists the watchdog does nothing. Any start clears it.
 *
 * One exception to (1): a pidfile pid that is alive but whose record
 * predates this boot of the machine is a recycled pid, not our daemon, so
 * it doesn't count. Without that, a hard reset that left the pidfile
 * behind could keep Talon down forever.
 *
 * When it does start the daemon, it leaves a `watchdog` crash marker
 * (unless the dead daemon left a more specific one), so the new daemon
 * tells the operator it was found down.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { dirs } from "../../../util/paths.js";
import { log, logError, logWarn } from "../../../util/log.js";
import { startDaemon, type StartOutcome } from "../control.js";
import { writeCrashMarker } from "../crash-marker.js";
import { findRunningInstance, type RunningInstance } from "../discovery.js";
import { isProcessAlive, readPidRecord } from "../pidfile.js";
import { readStopMarker } from "./stop-marker.js";

export type WatchdogOutcome =
  | { action: "none"; reason: "running"; pid: number }
  | { action: "none"; reason: "stopped-on-purpose"; at: string; by: string }
  /** Another watchdog run holds the lock. */
  | { action: "none"; reason: "busy" }
  /** Down, but not for long enough yet. */
  | { action: "none"; reason: "waiting"; misses: number; downForMs: number }
  | { action: "started"; pid: number; port?: number }
  | { action: "start-failed"; detail: string };

export type WatchdogOptions = {
  pkgRoot: string;
  /** Consecutive empty checks before a start. Default 3. */
  minMisses?: number;
  /** And the first of them at least this long ago. Default 120 s. */
  minDownMs?: number;
  pidfilePath?: string;
  statePath?: string;
  lockPath?: string;
  stopMarkerPath?: string;
  /** Injection seams for tests. */
  find?: typeof findRunningInstance;
  start?: typeof startDaemon;
  alive?: (pid: number) => boolean;
  now?: () => number;
  /** When this boot of the machine began (epoch ms), or null if unknown. */
  bootTime?: () => number | null;
  markCrash?: (why: string) => void;
};

const DEFAULT_MIN_MISSES = 3;
/** Past the 90 s handoff window and `startDaemon`'s 30 s boot wait. */
const DEFAULT_MIN_DOWN_MS = 120_000;
/** A lock older than this is from a run that died; take it over. */
const LOCK_STALE_MS = 10 * 60_000;

type MissState = { misses: number; firstMissAt: number };

function defaultStatePath(): string {
  return resolve(dirs.data, "watchdog.json");
}

function defaultLockPath(): string {
  return resolve(dirs.data, "watchdog.lock");
}

/** Boot time from /proc/stat's `btime` line; null off Linux. */
function linuxBootTime(): number | null {
  try {
    const line = readFileSync("/proc/stat", "utf-8")
      .split("\n")
      .find((l) => l.startsWith("btime "));
    const secs = Number(line?.split(/\s+/)[1]);
    return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
  } catch {
    return null;
  }
}

function readState(path: string): MissState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as MissState;
    return Number.isInteger(parsed.misses) &&
      Number.isFinite(parsed.firstMissAt)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeState(path: string, state: MissState | null): void {
  try {
    if (state === null) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state) + "\n", { mode: 0o600 });
  } catch {
    /* best-effort: losing the count only delays a start */
  }
}

/**
 * Take the run lock, or return false when a live run holds it. A lock
 * whose pid is dead, or that is older than LOCK_STALE_MS, is taken over.
 */
function acquireLock(
  path: string,
  alive: (pid: number) => boolean,
  now: number,
): boolean {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now }));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let holder: { pid?: number; at?: number } = {};
    try {
      holder = JSON.parse(readFileSync(path, "utf-8")) as typeof holder;
    } catch {
      /* half-written or corrupt: treat as stale */
    }
    const live =
      typeof holder.pid === "number" &&
      alive(holder.pid) &&
      typeof holder.at === "number" &&
      now - holder.at < LOCK_STALE_MS;
    if (live) return false;
    rmSync(path, { force: true });
  }
  return false;
}

function releaseLock(path: string): void {
  try {
    const holder = JSON.parse(readFileSync(path, "utf-8")) as { pid?: number };
    if (holder.pid === process.pid) rmSync(path, { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Whether discovery's answer is a daemon. A pidfile-only answer (live pid,
 * no /health) counts, unless its record predates this machine boot.
 */
function isDaemon(
  instance: RunningInstance | null,
  pidfilePath: string | undefined,
  bootTime: number | null,
): instance is RunningInstance {
  if (!instance) return false;
  if (instance.source !== "pidfile-unverified" || bootTime === null) {
    return true;
  }
  const startedAt = Date.parse(readPidRecord(pidfilePath)?.startedAt ?? "");
  return !(Number.isFinite(startedAt) && startedAt < bootTime);
}

function describeStart(outcome: StartOutcome): WatchdogOutcome {
  if (outcome.ok) {
    return { action: "started", pid: outcome.pid, port: outcome.port };
  }
  switch (outcome.reason) {
    case "already-running":
      return { action: "none", reason: "running", pid: outcome.instance.pid };
    case "boot-timeout":
      // Spawned and still booting; discovery will see its pid next run.
      return { action: "start-failed", detail: "spawned, not healthy yet" };
    case "exited-early":
      return { action: "start-failed", detail: outcome.detail };
    case "spawn-failed":
      return {
        action: "start-failed",
        detail: `spawn failed${outcome.detail ? `: ${outcome.detail}` : ""}`,
      };
  }
}

function markFoundDown(why: string): void {
  try {
    writeCrashMarker("watchdog", why, { keepExisting: true });
  } catch {
    /* EEXIST (the dead daemon's own marker) or a full disk */
  }
}

/** One watchdog check. Never throws. */
export async function runWatchdogOnce(
  opts: WatchdogOptions,
): Promise<WatchdogOutcome> {
  const now = opts.now ?? Date.now;
  const alive = opts.alive ?? isProcessAlive;
  const statePath = opts.statePath ?? defaultStatePath();
  const lockPath = opts.lockPath ?? defaultLockPath();

  const stopped = readStopMarker(opts.stopMarkerPath);
  if (stopped) {
    writeState(statePath, null);
    return { action: "none", reason: "stopped-on-purpose", ...stopped };
  }

  try {
    if (!acquireLock(lockPath, alive, now())) {
      return { action: "none", reason: "busy" };
    }
  } catch (err) {
    return {
      action: "start-failed",
      detail: `lock: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    return await checkAndMaybeStart(opts, statePath, now);
  } catch (err) {
    return {
      action: "start-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    releaseLock(lockPath);
  }
}

async function checkAndMaybeStart(
  opts: WatchdogOptions,
  statePath: string,
  now: () => number,
): Promise<WatchdogOutcome> {
  const find = opts.find ?? findRunningInstance;
  const bootTime = (opts.bootTime ?? linuxBootTime)();
  const instance = await find(opts.pidfilePath);
  if (isDaemon(instance, opts.pidfilePath, bootTime)) {
    writeState(statePath, null);
    return { action: "none", reason: "running", pid: instance.pid };
  }

  const t = now();
  const prior = readState(statePath);
  const state: MissState = prior
    ? { misses: prior.misses + 1, firstMissAt: prior.firstMissAt }
    : { misses: 1, firstMissAt: t };
  const downForMs = t - state.firstMissAt;
  const minMisses = opts.minMisses ?? DEFAULT_MIN_MISSES;
  const minDownMs = opts.minDownMs ?? DEFAULT_MIN_DOWN_MS;
  if (state.misses < minMisses || downForMs < minDownMs) {
    writeState(statePath, state);
    return {
      action: "none",
      reason: "waiting",
      misses: state.misses,
      downForMs,
    };
  }

  // Start once per outage window: whatever happens, count afresh after.
  writeState(statePath, null);
  const why = `no daemon answered for ${Math.round(downForMs / 1000)}s (${state.misses} checks)`;
  logWarn("watchdog", `Talon is down — ${why}; starting it`);
  (opts.markCrash ?? markFoundDown)(why);
  const start = opts.start ?? startDaemon;
  const outcome = describeStart(
    await start({ pkgRoot: opts.pkgRoot, pidfilePath: opts.pidfilePath }),
  );
  if (outcome.action === "started") {
    log(
      "watchdog",
      `Talon started by the watchdog (pid ${outcome.pid}, gateway :${outcome.port ?? "?"})`,
    );
  } else if (outcome.action === "start-failed") {
    logError("watchdog", `Watchdog could not start Talon: ${outcome.detail}`);
  }
  return outcome;
}
