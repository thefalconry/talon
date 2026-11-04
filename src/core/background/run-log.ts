/**
 * Per-run markdown log files for unattended agent runs.
 *
 * Every background one-shot writes a transcript nobody is watching live:
 * heartbeat, dream, isolated cron/trigger jobs, and sub-agents. They all
 * want the same three things — create the directory, stamp a header, hand
 * back an appender that can never throw into the run — so they share one.
 *
 * Appends are best-effort by design: a full disk must slow nothing down and
 * must never fail a run whose only remaining job is to report a result.
 *
 * Transcripts quote tool calls verbatim, so every append is redacted first: a
 * token in a curl command or git remote URL must not reach the file. Each
 * append is redacted on its own, so a value split across two appends is missed.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redactCredentials } from "../secrets/redact.js";

/** An `OneShotAgentParams.appendLog` bound to one file. */
export type RunLogAppender = (text: string) => Promise<void>;

/**
 * Open (creating the directory) a run log at `file`, write `header`, and
 * return the appender for it.
 */
export async function openRunLog(
  file: string,
  header: string,
): Promise<RunLogAppender> {
  await mkdir(dirname(file), { recursive: true }).catch(() => {});
  const appendLog: RunLogAppender = async (text) => {
    await appendFile(file, redactCredentials(text)).catch(() => {});
  };
  await appendLog(header);
  return appendLog;
}
