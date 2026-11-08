/**
 * Diagnostic proc views — "what went wrong" without knowing a path:
 *
 *   proc/log      the last lines of talon.log, one human line each
 *   proc/errors   recent warn/error/fatal entries, with stack frames
 *   proc/alerts   the operator alerts currently raised
 *
 * Rendered text, not pino JSON, so `cat` answers the question directly.
 * The log views read a bounded tail of talon.log (plus its newest
 * rotated generation when the live file is young) — a regular file
 * outside ~/.talon/ns, so the FUSE deadlock rule is not in play — and
 * memoize for a second: FUSE stats a node before reading it, and both
 * should see the same text without reading the log twice.
 */

import {
  formatLogRecord,
  readLogRecords,
  type LogRecord,
} from "../../daemon/log-reader.js";

export type AlertView = {
  key: string;
  severity: string;
  message: string;
  since: number;
};

export interface DiagnosticViewDeps {
  /** talon.log. */
  logPath: string;
  /** The live alert table (`activeAlerts`). */
  alerts: () => ReadonlyArray<AlertView>;
  now?: () => number;
}

const LOG_LINES = 200;
const ERROR_ENTRIES = 100;
const MEMO_MS = 1_000;
/** Two generations: the live file and the one it rotated from. */
const READ_OPTS = { maxFiles: 2, maxBytesPerFile: 1024 * 1024 } as const;

function memo(render: () => string, now: () => number): () => string {
  let cached: { at: number; text: string } | null = null;
  return () => {
    const t = now();
    if (cached && t - cached.at < MEMO_MS) return cached.text;
    cached = { at: t, text: render() };
    return cached.text;
  };
}

function body(records: LogRecord[], stackLines: number, max: number): string {
  return records
    .map((r) => formatLogRecord(r, { stackLines, maxMsgChars: max }))
    .join("\n");
}

function renderLogView(logPath: string): string {
  const records = readLogRecords(logPath, { limit: LOG_LINES, ...READ_OPTS });
  if (records.length === 0) return `# ${logPath} is empty or missing\n`;
  return (
    `# last ${records.length} lines of ${logPath}, newest last ` +
    `(older: ${logPath}.1…, or \`talon logs --since 1h\`)\n` +
    `${body(records, 0, 400)}\n`
  );
}

function renderErrorsView(logPath: string): string {
  const records = readLogRecords(logPath, {
    limit: ERROR_ENTRIES,
    filter: { minLevel: "warn" },
    ...READ_OPTS,
  });
  if (records.length === 0) {
    return `# no warnings or errors in the recent ${logPath}\n`;
  }
  return (
    `# last ${records.length} warn/error entries from ${logPath}, newest last\n` +
    `${body(records, 5, 500)}\n`
  );
}

export function renderAlertsView(
  alerts: ReadonlyArray<AlertView>,
  now: number,
): string {
  if (alerts.length === 0) return "# no active alerts\n";
  const lines = alerts.map((a) => {
    const mins = Math.max(0, Math.round((now - a.since) / 60_000));
    return (
      `[${a.severity}] ${a.key} since ${new Date(a.since).toISOString()} ` +
      `(${mins} min)\n    ${a.message}`
    );
  });
  return `# ${alerts.length} active alert(s)\n${lines.join("\n")}\n`;
}

/** The proc views, keyed by file name — wired by the vfs index. */
export function createDiagnosticViews(
  deps: DiagnosticViewDeps,
): Record<string, () => string> {
  const now = deps.now ?? Date.now;
  return {
    log: memo(() => renderLogView(deps.logPath), now),
    errors: memo(() => renderErrorsView(deps.logPath), now),
    alerts: () => renderAlertsView(deps.alerts(), now()),
  };
}
