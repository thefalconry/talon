/**
 * Daemon PID file — records which process is the Talon daemon.
 *
 * The file lives at ~/.talon/talon.pid and holds a small JSON record
 * (`{ pid, port, startedAt }`). Legacy bare-integer files written by
 * older versions are still readable.
 *
 * Ownership rules:
 *   - The daemon itself is the only writer: it records its own pid at
 *     boot and adds the gateway port once the gateway has bound (the
 *     gateway may fall back to a different port on EADDRINUSE, so the
 *     port is only known at runtime).
 *   - Removal is guarded by pid. During a `/restart` handoff
 *     (./respawn.ts) the successor overwrites the file with its own
 *     pid *before* the dying parent finishes its graceful shutdown — an
 *     unconditional unlink there would orphan the new daemon, making
 *     `talon stop`/`talon restart` report "not running" and spawn
 *     duplicates that fight over Telegram's getUpdates.
 */

import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { files as pathFiles } from "../../util/paths.js";

export type PidRecord = {
  pid: number;
  /** Gateway HTTP port — present once the gateway has bound. */
  port?: number;
  /** ISO timestamp of daemon boot. */
  startedAt?: string;
};

export function readPidRecord(file: string = pathFiles.pid): PidRecord | null {
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf-8").trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      // Legacy format: bare integer pid.
      const pid = parseInt(raw, 10);
      return pid > 0 ? { pid } : null;
    }
    const parsed = JSON.parse(raw) as Partial<PidRecord>;
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0)
      return null;
    return {
      pid: parsed.pid as number,
      port: Number.isInteger(parsed.port) ? (parsed.port as number) : undefined,
      startedAt:
        typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
    };
  } catch {
    return null; // unreadable or corrupt — treated as absent
  }
}

export function writePidRecord(
  record: PidRecord,
  file: string = pathFiles.pid,
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic.sync(file, JSON.stringify(record) + "\n");
  } catch {
    /* best-effort — the daemon must not die over a pidfile */
  }
}

/**
 * Remove the pidfile only if it still belongs to `ownPid`. Returns
 * whether the file was removed. See the ownership rules above for why
 * an unconditional unlink is wrong.
 */
export function removePidRecordIfOwnedBy(
  ownPid: number,
  file: string = pathFiles.pid,
): boolean {
  const current = readPidRecord(file);
  if (!current || current.pid !== ownPid) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Signal-0 liveness probe — works on Linux, macOS, and Windows. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ── Child ownership ─────────────────────────────────────────────────────────

/**
 * Daemon ownership of child processes.
 *
 * Every process the daemon spawns (backend CLIs, MCP children, trigger
 * scripts) inherits its environment. At boot the daemon stamps two
 * variables into that environment: its own pid and its /proc start time.
 * Any orphan sweep can then tell a child whose daemon is gone (safe to
 * reap) from a child of a daemon that is still running.
 *
 * The distinction matters because "orphan" used to mean "alive and
 * tagged with our chat or trigger id". On 2026-09-27 two daemons ran at
 * once for 13 minutes. Each one's sweeps saw the other's live children as
 * leftovers from a previous run, and the newcomer's trigger resume
 * SIGKILLed the running daemon's watchers.
 *
 * Linux-only in practice: the reads go through /proc. Where /proc is
 * absent, {@link childBelongsToLiveDaemon} answers false and the sweeps
 * behave exactly as before.
 */

/** Pid of the daemon that spawned this process (inherited env). */
export const DAEMON_PID_ENV = "TALON_DAEMON_PID";
/** That daemon's /proc start time, so a recycled pid cannot pass for it. */
export const DAEMON_STARTTIME_ENV = "TALON_DAEMON_STARTTIME";

/**
 * Field 22 of /proc/<pid>/stat: start time in jiffies since boot.
 * Monotonic per boot and unchanged by exec(), so it pins a pid to one
 * process. `undefined` without /proc or when the read fails.
 *
 * The `comm` field (2nd) is wrapped in parens and may itself contain ')'
 * — split after the LAST ')'; index 19 of the rest is field 22.
 */
export function readPidStarttimeSync(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const lastParen = stat.lastIndexOf(")");
    if (lastParen < 0) return undefined;
    const tail = stat.slice(lastParen + 2).split(" ");
    const starttime = Number(tail[19]);
    return Number.isFinite(starttime) ? starttime : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stamp this process as the daemon in `env` (default: our own), so every
 * child spawned from here on names us. Overwrites any inherited stamp: a
 * `/restart` successor inherits its predecessor's environment.
 */
export function stampDaemonOwner(env: NodeJS.ProcessEnv = process.env): void {
  env[DAEMON_PID_ENV] = String(process.pid);
  const starttime = readPidStarttimeSync(process.pid);
  if (starttime !== undefined) env[DAEMON_STARTTIME_ENV] = String(starttime);
  else delete env[DAEMON_STARTTIME_ENV];
}

export interface DaemonOwner {
  pid: number;
  starttime?: number;
}

/** The owner stamp carried in a NUL-split `/proc/<pid>/environ`. */
export function ownerFromEnviron(entries: string[]): DaemonOwner | undefined {
  const value = (key: string): string | undefined => {
    const prefix = `${key}=`;
    return entries.find((e) => e.startsWith(prefix))?.slice(prefix.length);
  };
  const pid = Number(value(DAEMON_PID_ENV));
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const starttime = Number(value(DAEMON_STARTTIME_ENV));
  return Number.isFinite(starttime) && value(DAEMON_STARTTIME_ENV)
    ? { pid, starttime }
    : { pid };
}

/**
 * Whether `owner` is a daemon other than this one that is still running.
 * A matching pid with a different start time is a recycled pid, so the
 * owner is dead.
 */
export function isOtherLiveDaemon(owner: DaemonOwner | undefined): boolean {
  if (!owner || owner.pid === process.pid) return false;
  if (!isProcessAlive(owner.pid)) return false;
  if (owner.starttime === undefined) return true;
  const current = readPidStarttimeSync(owner.pid);
  return current === undefined || current === owner.starttime;
}

/**
 * Whether process `pid` was spawned by a daemon other than this one that
 * is still alive. Orphan sweeps must leave such a process alone. Reads
 * `/proc/<pid>/environ`; false when it can't be read.
 */
export function childBelongsToLiveDaemon(pid: number): boolean {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/environ`, "utf-8");
  } catch {
    return false;
  }
  return isOtherLiveDaemon(ownerFromEnviron(raw.split("\0")));
}
