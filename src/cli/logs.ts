/**
 * `talon logs` — pretty-print the last lines of the JSON log file and then
 * tail it live.
 *
 * Filters (`--errors`, `--component`, `--since`, `--grep`, `--turn`)
 * switch to the shared log reader (core/daemon/log-reader.ts — the same
 * parser behind proc/log, proc/errors and doctor): the backlog is read
 * across rotated generations, and the live tail applies the same filter.
 * `--no-follow` prints the backlog and exits, for scripts and agents.
 */

import pc from "picocolors";
import { existsSync, readFileSync, watchFile } from "node:fs";
import type { LogFilter, LogRecord } from "../core/daemon/log-reader.js";
import { printBanner } from "./config.js";
import { LOG_FILE } from "./context.js";

export type LogsOptions = {
  filter: LogFilter;
  /** Keep tailing after the backlog (default true). */
  follow: boolean;
  /** Backlog size; undefined = 30, or 1000 under `--since`. */
  lines?: number;
};

const LOGS_USAGE =
  "talon logs [--errors] [--component <c>] [--since <30m|2h|1d>] " +
  "[--grep <text>] [--turn <id>] [-n <lines>] [--no-follow]";

/** Parse `talon logs` argv; a string is a usage error to print. */
export async function parseLogsArgs(
  args: string[],
  now: number = Date.now(),
): Promise<LogsOptions | string> {
  const { parseLogDuration } = await import("../core/daemon/log-reader.js");
  const opts: LogsOptions = { filter: {}, follow: true };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = (): string | undefined => args[++i];
    if (flag === "--errors") opts.filter.minLevel = "warn";
    else if (flag === "--no-follow") opts.follow = false;
    else if (flag === "--component") opts.filter.component = value();
    else if (flag === "--grep") opts.filter.grep = value();
    else if (flag === "--turn") opts.filter.turn = value();
    else if (flag === "--since") {
      const ms = parseLogDuration(value() ?? "");
      if (ms === null) return `--since needs a duration like 30m, 2h, 1d`;
      opts.filter.since = now - ms;
    } else if (flag === "-n" || flag === "--lines") {
      const n = Number(value());
      if (!Number.isInteger(n) || n <= 0) return `${flag} needs a count`;
      opts.lines = n;
    } else return `unknown option: ${flag}\n  usage: ${LOGS_USAGE}`;
    if (i >= args.length) return `${flag} needs a value`;
  }
  return opts;
}

/** `parseLogsArgs` then run; usage errors exit non-zero. */
export async function runLogsCommand(args: string[]): Promise<void> {
  const opts = await parseLogsArgs(args);
  if (typeof opts === "string") {
    console.error(`  ${pc.red("✖")} ${opts}`);
    process.exitCode = 1;
    return;
  }
  await tailLogs(opts);
}

const LEVEL_LABELS: Record<number, string> = {
  10: pc.dim("TRC"),
  20: pc.dim("DBG"),
  30: pc.blue("INF"),
  40: pc.yellow("WRN"),
  50: pc.red("ERR"),
  60: pc.bgRed(pc.white("FTL")),
};

const LEVEL_NAME_LABELS: Record<LogRecord["level"], string> = {
  trace: LEVEL_LABELS[10],
  debug: LEVEL_LABELS[20],
  info: LEVEL_LABELS[30],
  warn: LEVEL_LABELS[40],
  error: LEVEL_LABELS[50],
  fatal: LEVEL_LABELS[60],
};

/** A parsed record in the same shape as {@link formatLogLine}. */
function formatRecord(rec: LogRecord): string {
  const time = pc.dim(new Date(rec.ts).toTimeString().slice(0, 8));
  const comp = pc.cyan((rec.component ?? "?").padEnd(10));
  const turn =
    rec.turn && !rec.msg.includes("turn=") ? ` turn=${rec.turn}` : "";
  const err = rec.err ? pc.red(` (${rec.err})`) : "";
  return `  ${time} ${LEVEL_NAME_LABELS[rec.level]} ${comp} ${rec.msg}${turn}${err}`;
}

function formatLogLine(line: string): string {
  try {
    const obj = JSON.parse(line);
    const level = LEVEL_LABELS[obj.level as number] ?? pc.dim("???");
    const time = pc.dim(
      new Date(obj.time as number).toTimeString().slice(0, 8),
    );
    const comp = pc.cyan(((obj.component as string) ?? "?").padEnd(10));
    return `  ${time} ${level} ${comp} ${obj.msg}${obj.err ? pc.red(` (${obj.err})`) : ""}`;
  } catch {
    return `  ${line}`;
  }
}

function hasFilter(filter: LogFilter): boolean {
  return Object.values(filter).some((v) => v !== undefined);
}

export async function tailLogs(
  opts: LogsOptions = { filter: {}, follow: true },
): Promise<void> {
  printBanner();
  if (!existsSync(LOG_FILE)) {
    console.log(
      `  No log file. Start the bot first: ${pc.cyan("talon start")}\n`,
    );
    return;
  }
  if (hasFilter(opts.filter)) return tailFiltered(opts);
  if (opts.follow) {
    console.log(
      `  ${pc.dim("Tailing")} ${pc.dim(LOG_FILE)}\n  ${pc.dim("Press Ctrl+C to stop")}\n`,
    );
  }
  const content = readFileSync(LOG_FILE, "utf-8");
  const lines = content.trim().split("\n");
  for (const line of lines.slice(-(opts.lines ?? 30)))
    console.log(formatLogLine(line));
  if (!opts.follow) return;
  await followLog(lines.length, (line) => console.log(formatLogLine(line)));
}

/** The filtered path: backlog across generations, then a filtered tail. */
async function tailFiltered(opts: LogsOptions): Promise<void> {
  const { readLogRecords, parseLogLine, matchesLogFilter } =
    await import("../core/daemon/log-reader.js");
  const limit = opts.lines ?? (opts.filter.since !== undefined ? 1000 : 30);
  const backlog = readLogRecords(LOG_FILE, {
    limit,
    filter: opts.filter,
    // The CLI owns its process: read whole generations, not a window.
    maxBytesPerFile: 64 * 1024 * 1024,
  });
  const desc = describeFilter(opts.filter);
  console.log(
    `  ${pc.dim(`${backlog.length} matching entr${backlog.length === 1 ? "y" : "ies"} (${desc})`)}` +
      (opts.follow ? `\n  ${pc.dim("Following — Ctrl+C to stop")}` : "") +
      "\n",
  );
  for (const rec of backlog) console.log(formatRecord(rec));
  if (!opts.follow) return;
  const start = readFileSync(LOG_FILE, "utf-8").trim().split("\n").length;
  await followLog(start, (line) => {
    const rec = parseLogLine(line);
    if (rec && matchesLogFilter(rec, opts.filter))
      console.log(formatRecord(rec));
  });
}

function describeFilter(filter: LogFilter): string {
  const parts: string[] = [];
  if (filter.minLevel) parts.push(`>=${filter.minLevel}`);
  if (filter.component) parts.push(`component=${filter.component}`);
  if (filter.since !== undefined)
    parts.push(`since ${new Date(filter.since).toTimeString().slice(0, 8)}`);
  if (filter.grep) parts.push(`grep "${filter.grep}"`);
  if (filter.turn) parts.push(`turn=${filter.turn}`);
  return parts.join(", ");
}

/** Print each line appended to the log from line `from` on, forever. */
async function followLog(
  from: number,
  onLine: (line: string) => void,
): Promise<void> {
  let lastSize = from;
  watchFile(LOG_FILE, { interval: 500 }, (curr, prev) => {
    // A rotation (daemon start → talon.log.old, or the sink's runtime
    // shift to talon.log.1) leaves a new file under the name, and counting
    // its lines against the old one's would stay silent until it outgrew
    // the file it replaced.
    if (curr.ino !== prev.ino || curr.size < prev.size) lastSize = 0;
    try {
      const nl = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
      for (let i = lastSize; i < nl.length; i++) onLine(nl[i]);
      lastSize = nl.length;
    } catch {
      /* ignore */
    }
  });
  await new Promise(() => {});
}
