/**
 * Daemon log reader — one parser for talon.log shared by every surface
 * that shows it: `talon logs` filters, the proc/log + proc/errors views
 * in the namespace, and doctor's recent-errors probe.
 *
 * talon.log is pino JSON Lines (see util/log.ts). The live file rotates
 * at runtime into numbered generations (`talon.log.1` newest …) and, at
 * daemon start, into `talon.log.old`; readers walk them newest-first so
 * a question like "errors in the last hour" survives a rotation.
 *
 * Everything here is synchronous and bounded by a byte window per file:
 * callers are a CLI process, a doctor pass, or a FUSE view read — none
 * may slurp an unbounded history.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tailFile } from "../../util/tail-file.js";

type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_BY_NUM: Record<number, LogLevelName> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const LEVEL_RANK: Record<LogLevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** One parsed talon.log line. */
export type LogRecord = {
  /** Epoch ms (0 when the line carried none). */
  ts: number;
  level: LogLevelName;
  component?: string;
  msg: string;
  err?: string;
  stack?: string;
  /** Turn id — a `turn` field, or a `turn=<id>` pair in the message. */
  turn?: string;
};

export type LogFilter = {
  /** Drop records below this severity. */
  minLevel?: LogLevelName;
  /** Exact component match. */
  component?: string;
  /** Drop records older than this epoch ms. */
  since?: number;
  /** Case-insensitive substring of the message or error text. */
  grep?: string;
  /** Exact turn id match. */
  turn?: string;
};

const TURN_IN_MSG = /\bturn=([^\s,;)]+)/;

function turnOf(obj: Record<string, unknown>, msg: string): string | undefined {
  if (typeof obj.turn === "string" || typeof obj.turn === "number") {
    return String(obj.turn);
  }
  return TURN_IN_MSG.exec(msg)?.[1];
}

/** Parse one line; null for anything that is not a pino record. */
export function parseLogLine(line: string): LogRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null; // partial first line of a byte window, torn write
  }
  const msg = typeof obj.msg === "string" ? obj.msg : "";
  const turn = turnOf(obj, msg);
  return {
    ts: typeof obj.time === "number" ? obj.time : 0,
    level: LEVEL_BY_NUM[obj.level as number] ?? "info",
    ...(typeof obj.component === "string" ? { component: obj.component } : {}),
    msg,
    ...(typeof obj.err === "string" ? { err: obj.err } : {}),
    ...(typeof obj.stack === "string" ? { stack: obj.stack } : {}),
    ...(turn !== undefined ? { turn } : {}),
  };
}

export function matchesLogFilter(rec: LogRecord, filter: LogFilter): boolean {
  if (filter.minLevel && LEVEL_RANK[rec.level] < LEVEL_RANK[filter.minLevel])
    return false;
  if (filter.component && rec.component !== filter.component) return false;
  if (filter.since !== undefined && rec.ts < filter.since) return false;
  if (filter.turn && rec.turn !== filter.turn) return false;
  if (filter.grep) {
    const needle = filter.grep.toLowerCase();
    const hay = `${rec.msg}\n${rec.err ?? ""}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/** Parse + filter a raw chunk of the log, oldest first. */
function parseLogChunk(raw: string, filter: LogFilter): LogRecord[] {
  const out: LogRecord[] = [];
  // pino writes `"component":"<c>"` verbatim — a substring test skips the
  // JSON.parse for every other component's line (most of a trace log).
  const tag = filter.component
    ? `"component":${JSON.stringify(filter.component)}`
    : null;
  for (const line of raw.split("\n")) {
    if (tag !== null && !line.includes(tag)) continue;
    const rec = parseLogLine(line);
    if (rec && matchesLogFilter(rec, filter)) out.push(rec);
  }
  return out;
}

/**
 * The live file and its rotated generations that exist, newest first:
 * the live file, then every `<name>.<n>` (util/log.ts's runtime shift)
 * and the start-time `<name>.old`, ordered by mtime — the two schemes
 * interleave in time. Found by listing the directory, so the reader
 * needs no knowledge of how many generations the writer keeps.
 */
export function logGenerations(path: string): string[] {
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  const isGeneration = (name: string): boolean =>
    name.startsWith(prefix) && /^(\d+|old)$/.test(name.slice(prefix.length));
  let names: string[];
  try {
    names = readdirSync(dir).filter(isGeneration);
  } catch {
    names = [];
  }
  const rotated: Array<{ path: string; mtime: number }> = [];
  for (const name of names) {
    try {
      const full = join(dir, name);
      rotated.push({ path: full, mtime: statSync(full).mtimeMs });
    } catch {
      /* rotated away between the listing and the stat */
    }
  }
  rotated.sort((a, b) => b.mtime - a.mtime);
  return [...(existsSync(path) ? [path] : []), ...rotated.map((r) => r.path)];
}

export type ReadLogOptions = {
  /** Max records returned (the newest ones, oldest first). */
  limit: number;
  filter?: LogFilter;
  /** Trailing byte window read from each file (default 2 MB). */
  maxBytesPerFile?: number;
  /** Generations consulted at most (default: all). */
  maxFiles?: number;
};

/**
 * The newest `limit` records matching `filter`, oldest first, walking
 * back through rotated generations until the limit is met, the `since`
 * cutoff is passed, or `maxFiles` is spent. Missing files read as empty.
 */
export function readLogRecords(
  path: string,
  opts: ReadLogOptions,
): LogRecord[] {
  const filter = opts.filter ?? {};
  const maxBytes = opts.maxBytesPerFile ?? 2 * 1024 * 1024;
  const files = logGenerations(path).slice(0, opts.maxFiles);
  let collected: LogRecord[] = [];
  for (const file of files) {
    let raw: string;
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
      if (filter.since !== undefined && mtime < filter.since) break;
      raw = tailFile(file, Number.MAX_SAFE_INTEGER, maxBytes);
    } catch {
      continue;
    }
    collected = [...parseLogChunk(raw, filter), ...collected];
    if (collected.length >= opts.limit) break;
  }
  return collected.slice(-opts.limit);
}

const LEVEL_TAG: Record<LogLevelName, string> = {
  trace: "TRC",
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
  fatal: "FTL",
};

/**
 * One human line: ISO time, level, component, message, turn id (when
 * it came as a field rather than in the message), error — the
 * shape an agent or operator reads without a JSON parser. `stackLines`
 * appends that many stack frames, indented, under error records.
 */
export function formatLogRecord(
  rec: LogRecord,
  opts: { stackLines?: number; maxMsgChars?: number } = {},
): string {
  const time = rec.ts > 0 ? new Date(rec.ts).toISOString() : "-";
  const comp = (rec.component ?? "?").padEnd(10);
  const max = opts.maxMsgChars ?? 1000;
  const msg = rec.msg.length > max ? `${rec.msg.slice(0, max)}…` : rec.msg;
  let line = `${time} ${LEVEL_TAG[rec.level]} ${comp} ${msg}`;
  if (rec.turn && !TURN_IN_MSG.test(rec.msg)) line += ` turn=${rec.turn}`;
  if (rec.err) line += ` (${rec.err})`;
  const frames = opts.stackLines ?? 0;
  if (frames > 0 && rec.stack) {
    const stack = rec.stack
      .split("\n")
      .slice(1, frames + 1)
      .map((f) => `    ${f.trim()}`);
    if (stack.length > 0) line += `\n${stack.join("\n")}`;
  }
  return line;
}

const DURATION_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** "90s" / "15m" / "2h" / "1d" → ms; a bare number is minutes. */
export function parseLogDuration(input: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(input.trim().toLowerCase());
  if (!match) return null;
  const ms = Number(match[1]) * DURATION_UNITS[match[2] || "m"];
  return ms > 0 ? ms : null;
}

export type LoggedAlert = {
  key: string;
  severity: string;
  message: string;
  since: number;
};

// The shapes alerts.ts logs: raiseAlert → `[<severity>] <key>: <message>`,
// resolveAlert → `resolved <key> after <n> min`, both as component "alert".
const ALERT_RAISED = /^\[(\w+)\] (\S+): ([\s\S]*)$/;
const ALERT_RESOLVED = /^resolved (\S+) after /;
/** The daemon's first boot line — in-memory alert state starts empty. */
const DAEMON_START = "Starting Talon...";

/**
 * Replay alert raise/resolve lines to the set still open at the end of
 * `records` (oldest first). For a process that cannot see the daemon's
 * in-memory alert table — `talon doctor` runs standalone. A daemon
 * restart clears the table, so a boot line clears the replay too.
 */
export function replayAlerts(records: readonly LogRecord[]): LoggedAlert[] {
  const open = new Map<string, LoggedAlert>();
  for (const rec of records) {
    if (rec.component === "bot" && rec.msg === DAEMON_START) {
      open.clear();
      continue;
    }
    if (rec.component !== "alert") continue;
    const raised = ALERT_RAISED.exec(rec.msg);
    if (raised) {
      const [, severity, key, message] = raised;
      const prior = open.get(key);
      open.set(key, { key, severity, message, since: prior?.since ?? rec.ts });
      continue;
    }
    const resolved = ALERT_RESOLVED.exec(rec.msg);
    if (resolved) open.delete(resolved[1]);
  }
  return [...open.values()];
}
