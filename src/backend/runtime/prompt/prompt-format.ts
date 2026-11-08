/**
 * User-prompt formatting for backends.
 *
 * Every backend formats incoming user messages the same way before handing
 * them to its underlying SDK: optional `[YYYY-MM-DD HH:MM:SS]` time tag,
 * optional `[Name]` sender label for group chats, optional `[msg_id:N]`
 * reference for tool-use targeting, then the user text.
 *
 * Centralising this prevents the "Claude SDK adds the time tag, Kilo
 * doesn't" drift that motivated the shared-framework refactor.
 *
 * Examples:
 *   group:  "[2026-05-15 11:01:23] [Ada (@ada)] [msg_id:2485]: actual text"
 *   DM:     "[2026-05-15 11:01:23] [msg_id:2485] actual text"
 *   DM (no msg_id): "[2026-05-15 11:01:23] actual text"
 */

import { formatFullDatetime } from "../../../util/time.js";

// ── Public API ──────────────────────────────────────────────────────────────

/** Inputs for `formatUserPrompt`. */
export type PromptFormatInputs = {
  /** Raw user text — passed through verbatim. */
  text: string;
  /** Display name of the sender (e.g. "Ada"). */
  senderName: string;
  /**
   * Platform handle of the sender WITHOUT the leading `@` (e.g. `ada`).
   * Rendered next to the display name in group chats so the model can address
   * or mention someone correctly — display names are not addressable, handles
   * are. Absent for users who have no handle set.
   */
  senderHandle?: string;
  /** True when the chat is a group; influences whether the `[Name]` label is included. */
  isGroup?: boolean;
  /** Provider message id (Telegram numeric, Discord snowflake string). */
  messageId?: number | string;
  /** When true, omit the leading `[YYYY-MM-DD HH:MM:SS]` tag. */
  omitTimeTag?: boolean;
  /**
   * Memory retrieved for THIS turn (`core/memory/turn-retrieval.ts`),
   * already ranked, trust-filtered and budgeted. Appended after the
   * message text under a verify-first header.
   *
   * This is the **only** place retrieved memory enters a prompt, and
   * every backend reaches it through this one helper — which is what
   * keeps #639's divergence (two backends reading the field, four
   * silently dropping it) from coming back. It belongs to the user
   * turn: it must never reach `prepareSystemPrompt()`, a prompt
   * addition, or a backend `system` field, or it would break the
   * per-session frozen prompt (plan §3.6).
   *
   * Absent or blank → the returned prompt is BYTE-IDENTICAL to what
   * this helper produced before the field existed.
   */
  retrievedMemory?: string;
};

/**
 * Header on the injected block. "Verify before relying on it" is
 * deliberate: retrieval is a bm25 guess, not a fact, and the model
 * should treat a recalled line as a lead rather than as truth.
 */
export const RECALLED_MEMORY_HEADER =
  "[Recalled from memory — verify before relying on it]";

/**
 * Format a user prompt for the AI backend.
 *
 * The shape matches what the Claude SDK backend has shipped since the
 * v1.10.x window — all later backends should consume this helper so the
 * model receives a consistent input contract regardless of which provider
 * is on the other end.
 */
export function formatUserPrompt(inputs: PromptFormatInputs): string {
  return withRecalledMemory(formatMessageLine(inputs), inputs.retrievedMemory);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The message line itself — time tag, sender label, `msg_id`, text. */
function formatMessageLine(inputs: PromptFormatInputs): string {
  const timeTag = inputs.omitTimeTag ? "" : `[${formatFullDatetime()}]`;
  const msgIdHint =
    inputs.messageId !== undefined ? ` [msg_id:${inputs.messageId}]` : "";

  if (inputs.isGroup) {
    const handle = inputs.senderHandle?.trim().replace(/^@+/, "");
    const who = handle
      ? `${inputs.senderName} (@${handle})`
      : inputs.senderName;
    return joinNonEmpty(timeTag, `[${who}]${msgIdHint}:`, inputs.text);
  }

  // DM: no [Name] label needed (Telegram already shows sender)
  if (msgIdHint) {
    return joinNonEmpty(`${timeTag}${msgIdHint}`.trim(), inputs.text);
  }
  return joinNonEmpty(timeTag, inputs.text);
}

/**
 * Append the retrieved-memory block AFTER the message, never before:
 * the user's own words stay the first thing the model reads, and the
 * recalled lines read as an annotation on them.
 */
function withRecalledMemory(
  prompt: string,
  memory: string | undefined,
): string {
  const block = memory?.trim();
  if (!block) return prompt;
  return `${prompt}\n\n${RECALLED_MEMORY_HEADER}\n${block}`;
}

function joinNonEmpty(...parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(" ");
}
