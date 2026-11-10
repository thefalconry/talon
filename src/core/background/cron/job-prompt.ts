/**
 * Pure helpers for decoupled-job one-shot runs — system prompt, log path,
 * and the context label. Kept separate from the runner so they're trivially
 * unit-testable with no side effects.
 */

import { resolve } from "node:path";
import { dirs } from "../../../util/paths.js";

export type JobKind = "trigger" | "cron";

/** Where job run logs live. */
const JOB_LOGS_DIR = resolve(dirs.logs, "jobs");

/**
 * The one context label every backend wires for the full outbound frontend tool
 * surface, so an isolated job agent can deliver to the chat. (Reused from
 * heartbeat; note the shared orphan-eviction namespace — jobs therefore do NOT
 * trigger eviction by this label.)
 */
export const JOB_CONTEXT_LABEL = "heartbeat";

/** Filesystem-safe slug for a job label. */
export function jobSlug(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "job";
}

/** Absolute path for a job run log. */
export function jobLogPath(
  kind: JobKind,
  label: string,
  at = Date.now(),
): string {
  return resolve(JOB_LOGS_DIR, `${kind}-${jobSlug(label)}-${at}.md`);
}

/**
 * System prompt for an isolated job agent: it has no chat history, only the
 * task + tools, and delivers to the chat via an explicit chat_id. The
 * Opus-authored `instructions` are appended verbatim.
 */
export function buildJobSystemPrompt(
  chatId: string,
  kind: JobKind,
  instructions?: string,
): string {
  const base =
    `You are Talon running an isolated ${kind} job for chat ${chatId}. ` +
    `You have NO conversation history — only the task below and your tools. ` +
    `Investigate and act using your tools. If you need to message the user, ` +
    `call the messaging tool with chat_id="${chatId}". You have no ambient ` +
    `chat, so also pass chat_id="${chatId}" to spawn_agent and any other tool ` +
    `that fails with "No active chat context". If a tool you needed still ` +
    `fails, say so in your message instead of ending quietly. Be concise and ` +
    `action-oriented; if there is nothing to report, do nothing.`;
  return instructions ? `${base}\n\n${instructions}` : base;
}
