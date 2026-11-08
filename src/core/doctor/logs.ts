/**
 * Doctor's "what went wrong lately" probes: the last hour of talon.log
 * summarised by component, and the operator alerts still open — so
 * `talon doctor` points at the failing subsystem instead of only at the
 * environment.
 *
 * Alerts come from the daemon's in-memory table when doctor runs inside
 * the daemon (the chat /doctor command). `talon doctor` is its own
 * process and sees an empty table, so it replays the alert lines in the
 * log instead; those are reported as warnings without counting toward
 * the issue total — the log can only say what was last announced.
 */

import {
  readLogRecords,
  replayAlerts,
  type LogRecord,
} from "../daemon/log-reader.js";
import { activeAlerts } from "../frontend-runtime/alerts.js";
import { files } from "../../util/paths.js";
import type { DoctorCheck } from "./types.js";

const HOUR_MS = 3_600_000;
/** How far back the alert replay looks for a raise still unresolved. */
const ALERT_WINDOW_MS = 24 * HOUR_MS;
const READ = { limit: Number.MAX_SAFE_INTEGER, maxBytesPerFile: 16 << 20 };
const DETAIL_CHARS = 160;

export type RecentLogOptions = {
  logPath?: string;
  now?: number;
  /** The live alert table; defaults to this process's `activeAlerts()`. */
  liveAlerts?: ReturnType<typeof activeAlerts>;
};

function clip(text: string): string {
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…` : text;
}

function byComponent(records: readonly LogRecord[]): string {
  const counts = new Map<string, number>();
  for (const r of records) {
    const c = r.component ?? "?";
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c} ${n}`)
    .join(", ");
}

/** The last hour's warn/error lines, as one doctor check. */
export function checkRecentErrors(opts: RecentLogOptions = {}): DoctorCheck {
  const logPath = opts.logPath ?? files.log;
  const now = opts.now ?? Date.now();
  const recent = readLogRecords(logPath, {
    ...READ,
    filter: { since: now - HOUR_MS, minLevel: "warn" },
  });
  const errors = recent.filter(
    (r) => r.level === "error" || r.level === "fatal",
  );
  const warnings = recent.length - errors.length;
  if (errors.length === 0) {
    return warnings === 0
      ? { label: "Log: no errors or warnings in the last hour", status: "ok" }
      : {
          label: `Log: ${warnings} warning(s) in the last hour`,
          status: "info",
          detail: byComponent(recent),
        };
  }
  const last = errors.at(-1)!;
  const at = new Date(last.ts).toTimeString().slice(0, 5);
  const what = clip(`${last.msg}${last.err ? ` (${last.err})` : ""}`);
  return {
    label: `Log: ${errors.length} error(s) in the last hour — ${byComponent(errors)}`,
    status: "warn",
    detail:
      `latest ${at} ${last.component ?? "?"}: ${what} — ` +
      `talon logs --errors --since 1h, or ~/.talon/ns/proc/errors`,
  };
}

/** Open alerts, one check each (or one "none" line). */
export function checkOpenAlerts(opts: RecentLogOptions = {}): DoctorCheck[] {
  const now = opts.now ?? Date.now();
  const live = opts.liveAlerts ?? activeAlerts();
  const fromLog = live.length === 0;
  const alerts = fromLog ? loggedAlerts(opts.logPath ?? files.log, now) : live;
  if (alerts.length === 0)
    return [{ label: "Alerts: none open", status: "ok" }];
  return alerts.map((a) => {
    const mins = Math.max(0, Math.round((now - a.since) / 60_000));
    const label = `Alert ${a.key} (${a.severity}, ${mins} min)`;
    if (fromLog) {
      return {
        label,
        status: "warn",
        detail: `last logged: ${clip(a.message)}`,
      };
    }
    return {
      label,
      status: a.severity === "warn" ? "warn" : "fail",
      detail: clip(a.message),
      issue: true,
    };
  });
}

/** Replay the last day's alert lines (plus boot lines, which reset them). */
function loggedAlerts(logPath: string, now: number) {
  const since = now - ALERT_WINDOW_MS;
  const alertLines = readLogRecords(logPath, {
    ...READ,
    filter: { since, component: "alert" },
  });
  const boots = readLogRecords(logPath, {
    ...READ,
    filter: { since, component: "bot", grep: "Starting Talon" },
  });
  return replayAlerts([...alertLines, ...boots].sort((a, b) => a.ts - b.ts));
}
