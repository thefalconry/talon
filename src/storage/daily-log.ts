/**
 * Daily log system — appends brief interaction summaries to workspace/logs/YYYY-MM-DD.md.
 * Claude can reference these via the Read tool for continuity across sessions.
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { log as logInfo, logError, logWarn } from "../util/log.js";
import { dirs } from "../util/paths.js";
import { toYMD } from "../util/time.js";

const LOGS_DIR = dirs.logs;
const MAX_LOG_DAYS = 30; // Keep last 30 days of logs

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Local calendar date (YYYY-MM-DD) from a Date's local components — not
 * `toISOString`, which is UTC and disagrees with the local HH:MM entry time
 * near midnight.
 */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Append a user message entry to today's daily log.
 * Format: ## HH:MM -- [chatTitle/userName]\nmessage text\n
 * @param chatName - Display name of the sender (or "System")
 * @param text - Message content
 * @param chatContext - Optional chat context (group title, username, etc.)
 */
export function appendDailyLog(
  chatName: string,
  text: string,
  chatContext?: { chatTitle?: string; username?: string },
): void {
  try {
    ensureLogsDir();
    const now = new Date();
    const dateStr = localDateKey(now);
    const timeStr = now.toTimeString().slice(0, 5); // HH:MM
    const logFile = resolve(LOGS_DIR, `${dateStr}.md`);

    const label = formatLabel(chatName, chatContext);
    const entry = `## ${timeStr} -- [${label}]\n${text}\n\n`;
    appendFileSync(logFile, entry);
  } catch (err) {
    logError("bot", "Daily log write failed", err);
  }
}

/**
 * Append a bot response entry to today's daily log.
 * Format: ## HH:MM -- [botName] in chatTitle\nresponse text\n
 */
export function appendDailyLogResponse(
  botName: string,
  text: string,
  chatContext?: { chatTitle?: string },
): void {
  try {
    ensureLogsDir();
    const now = new Date();
    const dateStr = localDateKey(now);
    const timeStr = now.toTimeString().slice(0, 5); // HH:MM
    const logFile = resolve(LOGS_DIR, `${dateStr}.md`);

    const label = chatContext?.chatTitle
      ? `${botName} in ${chatContext.chatTitle}`
      : botName;
    const entry = `## ${timeStr} -- [${label}]\n${text}\n\n`;
    appendFileSync(logFile, entry);
  } catch (err) {
    logError("bot", "Daily log response write failed", err);
  }
}

/** Format a log label with optional chat title and username. */
function formatLabel(
  name: string,
  ctx?: { chatTitle?: string; username?: string },
): string {
  const userPart = ctx?.username ? `${name} (@${ctx.username})` : name;
  if (ctx?.chatTitle) return `${userPart} in ${ctx.chatTitle}`;
  return userPart;
}

/** Get the path to the logs directory (for system prompt reference). */
export function getLogsDir(): string {
  return LOGS_DIR;
}

/**
 * Today's log-file date key. Readers must use this (not the UTC date from
 * `toISOString`) or they look for the wrong file whenever local date ≠ UTC.
 */
export function todayLogDate(): string {
  return localDateKey(new Date());
}

/** Matches YYYY-MM-DD.md filenames strictly. */
const DAILY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/**
 * Unlink YYYY-MM-DD.md files in `dir` dated before `cutoff`. Never
 * throws; a missing dir is the normal first-run case, anything else
 * (unreadable dir, a file that won't unlink) is logged.
 */
function pruneDatedFiles(dir: string, cutoff: string, what: string): void {
  let deleted = 0;
  let failed = 0;
  let firstFailure = "";
  try {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!DAILY_FILE_RE.test(file) || file >= cutoff) continue;
      try {
        unlinkSync(resolve(dir, file));
        deleted++;
      } catch (err) {
        if (failed++ === 0) firstFailure = `${file}: ${errText(err)}`;
      }
    }
  } catch (err) {
    logWarn("workspace", `${what} cleanup failed dir=${dir}: ${errText(err)}`);
  }
  if (deleted > 0) {
    logInfo("workspace", `Cleaned up ${deleted} old ${what}(s)`);
  }
  if (failed > 0) {
    logWarn(
      "workspace",
      `Could not remove ${failed} old ${what}(s) dir=${dir}; first=${firstFailure}`,
    );
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Remove daily logs older than MAX_LOG_DAYS. Called on startup. */
export function cleanupOldLogs(): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_LOG_DAYS);
  pruneDatedFiles(LOGS_DIR, localDateKey(cutoff), "daily log");

  // Clean up old daily memory files (independent of logs dir)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_LOG_DAYS);
  pruneDatedFiles(dirs.dailyMemory, toYMD(cutoffDate), "daily memory file");
}
