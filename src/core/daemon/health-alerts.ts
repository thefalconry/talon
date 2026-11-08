/**
 * Daemon health alerts — the system-level producers for
 * core/frontend-runtime/alerts.ts. Per-subsystem faults (a frontend that
 * lost its connection, a backend that lost its login) are raised by their
 * owners; what lives here is what no single subsystem can see:
 *
 *   - `disk.low` — free space under the Talon root. On 2026-09-18 the disk
 *     filled and every subsystem failed on its own, silently: the log sink
 *     paused, SQLite and the session stores threw ENOSPC, the crash
 *     handler died inside itself. One probe that says so is worth more
 *     than any of their errors.
 *   - `errors.spike` — a burst of `logError` calls, whatever the source.
 *   - `daemon.unhandled` — repeated unhandled promise rejections (logged,
 *     never fatal, so otherwise invisible).
 *   - `daemon.crash` — the previous process died; announced from the
 *     marker it left (./crash-marker.ts) once this one can talk.
 *
 * Started by app.ts once the frontends are up, stopped in its shutdown.
 */

import { statfs } from "node:fs/promises";
import { dirs } from "../../util/paths.js";
import {
  log,
  logDebug,
  logWarn,
  onLogError,
  type LogComponent,
} from "../../util/log.js";
import {
  raiseAlert,
  resolveAlert,
  type AlertSeverity,
} from "../frontend-runtime/alerts.js";
import {
  claimCrashAnnouncement,
  takeCrashMarker,
  type CrashMarker,
} from "./crash-marker.js";

const MIN = 60_000;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// ── Rate alarms ──────────────────────────────────────────────────────────────

type RateAlarmOptions<T> = {
  key: string;
  severity: AlertSeverity;
  /** Raise at this many samples inside `windowMs`. */
  threshold: number;
  windowMs: number;
  /** Resolve once the rate has stayed under threshold this long. */
  quietMs: number;
  describe: (samples: readonly T[]) => string;
  recovered: string;
};

/** Hard cap on retained samples, so an error storm can't grow memory. */
const MAX_SAMPLES = 500;
const QUIET_CHECK_MS = MIN;

/**
 * "N of these within a window" → one alert, resolved after a quiet spell.
 * Raises once per episode: repeats while hot only move the quiet clock.
 */
class RateAlarm<T> {
  private samples: { at: number; value: T }[] = [];
  private lastHotAt = 0;
  private quietTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: RateAlarmOptions<T>) {}

  record(value: T): void {
    const now = Date.now();
    const cutoff = now - this.opts.windowMs;
    this.samples.push({ at: now, value });
    const firstLive = this.samples.findIndex((s) => s.at > cutoff);
    const drop = Math.max(firstLive, this.samples.length - MAX_SAMPLES);
    if (drop > 0) this.samples.splice(0, drop);
    if (this.samples.length < this.opts.threshold) return;
    this.lastHotAt = now;
    if (this.quietTimer) return;
    raiseAlert(
      this.opts.key,
      this.opts.describe(this.samples.map((s) => s.value)),
      { severity: this.opts.severity },
    );
    this.quietTimer = setInterval(() => this.checkQuiet(), QUIET_CHECK_MS);
    this.quietTimer.unref();
  }

  private checkQuiet(): void {
    if (Date.now() - this.lastHotAt < this.opts.quietMs) return;
    this.stop();
    resolveAlert(this.opts.key, this.opts.recovered);
  }

  stop(): void {
    if (this.quietTimer) clearInterval(this.quietTimer);
    this.quietTimer = null;
    this.samples = [];
  }
}

type LoggedError = { component: LogComponent; text: string };

function errorText(message: string, err: unknown): string {
  if (err === undefined) return message;
  const detail = err instanceof Error ? err.message : String(err);
  return `${message}: ${detail}`;
}

function describeErrorSpike(samples: readonly LoggedError[]): string {
  const counts = new Map<string, number>();
  for (const s of samples)
    counts.set(s.component, (counts.get(s.component) ?? 0) + 1);
  const top = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([component, n]) => `${component} ×${n}`)
    .join(", ");
  const latest = samples[samples.length - 1];
  const latestText = latest
    ? `${latest.component}: ${latest.text}`.slice(0, 200)
    : "";
  return (
    `Talon logged ${samples.length} errors in 5 min (${top}). ` +
    `Latest: ${latestText}`
  );
}

const errorSpike = new RateAlarm<LoggedError>({
  key: "errors.spike",
  severity: "warn",
  threshold: 20,
  windowMs: 5 * MIN,
  quietMs: 15 * MIN,
  describe: describeErrorSpike,
  recovered: "Error rate is back to normal.",
});

const unhandled = new RateAlarm<string>({
  key: "daemon.unhandled",
  severity: "error",
  threshold: 3,
  windowMs: 10 * MIN,
  quietMs: 10 * MIN,
  describe: (samples) =>
    `Talon hit ${samples.length} unhandled promise rejections in 10 min — ` +
    `an error some code path never caught. Latest: ` +
    `${samples[samples.length - 1]?.slice(0, 200) ?? ""}`,
  recovered: "No unhandled promise rejections for 10 min.",
});

/** Feed one unhandled rejection to the alarm (core/daemon/crash.ts). */
export function noteUnhandledRejection(reason: unknown): void {
  unhandled.record(
    reason instanceof Error ? reason.message : String(reason ?? "unknown"),
  );
}

// ── Disk space ───────────────────────────────────────────────────────────────

const DISK_PROBE_MS = 5 * MIN;
const DISK_LOW_BYTES = GIB;
const DISK_LOW_PERCENT = 5;
const DISK_CRITICAL_BYTES = 256 * MIB;
// Hysteresis: a disk hovering at the line must not flap raise/resolve.
const DISK_CLEAR_BYTES = 1.5 * GIB;
const DISK_CLEAR_PERCENT = 7.5;

type StatFs = (path: string) => Promise<{
  bavail: number;
  bsize: number;
  blocks: number;
}>;

function formatBytes(bytes: number): string {
  return bytes >= GIB
    ? `${(bytes / GIB).toFixed(1)} GiB`
    : `${Math.round(bytes / MIB)} MiB`;
}

/** One statfs of `path` → raise, resolve, or (in the hysteresis band) hold. */
async function probeDisk(path: string, stat: StatFs = statfs): Promise<void> {
  let free: number;
  let percent: number;
  try {
    const s = await stat(path);
    free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    percent = total > 0 ? (free / total) * 100 : 100;
  } catch (err) {
    logDebug(
      "watchdog",
      `disk.probe path=${path} failed: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }
  const pct = percent.toFixed(1);
  logDebug("watchdog", `disk.probe path=${path} free=${free} pct=${pct}`);
  if (free < DISK_LOW_BYTES || percent < DISK_LOW_PERCENT) {
    raiseAlert(
      "disk.low",
      `Disk almost full: ${formatBytes(free)} free (${pct}%) on ${path}. ` +
        `Talon fails when it runs out — logs, sessions and the database stop saving.`,
      { severity: free < DISK_CRITICAL_BYTES ? "critical" : "error" },
    );
  } else if (free >= DISK_CLEAR_BYTES && percent >= DISK_CLEAR_PERCENT) {
    resolveAlert(
      "disk.low",
      `Disk space recovered: ${formatBytes(free)} free on ${path}.`,
    );
  }
}

// ── Crash announcement ───────────────────────────────────────────────────────

/** A crash loop alerts once per this, across restarts. */
const CRASH_ALERT_COOLDOWN_MS = 30 * MIN;
/** Up this long after a crash restart → the crash alert resolves. */
const CRASH_STABLE_MS = 30 * MIN;

function crashMessage(marker: CrashMarker, held: number): string {
  const when = `${marker.at.slice(0, 16).replace("T", " ")} UTC`;
  const frame = marker.stack[0] ? ` (${marker.stack[0]})` : "";
  const more = held > 0 ? ` ${held} more crash(es) since the last alert.` : "";
  switch (marker.kind) {
    case "startup":
      return `Talon failed to start at ${when}: ${marker.message}${frame}. It is running again now.${more}`;
    case "handoff":
      return `A Talon restart at ${when} didn't come up (${marker.message}); it was started again.${more}`;
    case "watchdog":
      return `Talon was found down at ${when} (${marker.message}) and the watchdog started it again. Check \`talon logs\` for how it went down.${more}`;
    default:
      return `Talon restarted after a crash at ${when}: ${marker.message}${frame}${more}`;
  }
}

let crashStableTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Turn the previous process's crash marker, if any, into a `daemon.crash`
 * alert. Call once the admin notifier and frontends are up.
 */
export function announceLastCrash(
  markerPath?: string,
  ledgerPath?: string,
): void {
  const marker = takeCrashMarker(markerPath);
  if (!marker) return;
  log(
    "bot",
    `crash.marker kind=${marker.kind} at=${marker.at} pid=${marker.pid} ` +
      `error=${marker.message.slice(0, 200)}`,
  );
  const held = claimCrashAnnouncement(CRASH_ALERT_COOLDOWN_MS, ledgerPath);
  if (held === null) {
    logWarn("bot", "crash.marker held back — crash loop inside the cooldown");
    return;
  }
  raiseAlert("daemon.crash", crashMessage(marker, held), { severity: "error" });
  crashStableTimer = setTimeout(() => {
    crashStableTimer = null;
    resolveAlert("daemon.crash", "Talon has stayed up since the crash restart");
  }, CRASH_STABLE_MS);
  crashStableTimer.unref();
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let diskTimer: ReturnType<typeof setInterval> | null = null;

/** Start the probes and the error-rate listener. Idempotent. */
export function startHealthAlerts(
  opts: { dataDir?: string; statfs?: StatFs } = {},
): void {
  if (diskTimer) return;
  const dir = opts.dataDir ?? dirs.root;
  const probe = (): void => void probeDisk(dir, opts.statfs);
  probe();
  diskTimer = setInterval(probe, DISK_PROBE_MS);
  diskTimer.unref();
  onLogError((component, message, err) =>
    errorSpike.record({ component, text: errorText(message, err) }),
  );
}

/** Stop every timer and detach the listener. Safe to call twice. */
export function stopHealthAlerts(): void {
  if (diskTimer) clearInterval(diskTimer);
  diskTimer = null;
  if (crashStableTimer) clearTimeout(crashStableTimer);
  crashStableTimer = null;
  onLogError(null);
  errorSpike.stop();
  unhandled.stop();
}
