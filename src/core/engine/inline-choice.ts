/**
 * Inline-button questions asked by the core, outside any turn — e.g. idle
 * compaction's "wait or abort?" (core/weaver/idle-compact.ts).
 *
 * The message goes out through a frontend's own action handler
 * (`send_message_with_buttons`, then `edit_message` for the outcome), the
 * same broker `send_via` uses, so core never imports a frontend. A click
 * comes back as callback data `ichoice:<token>:<choice>`; a frontend that
 * routes that prefix to `resolveInlineChoice` (today: Telegram's callback
 * dispatcher) supports these questions, and only those are asked.
 * Elsewhere `sendInlineChoice` answers undefined and the caller falls back
 * to its default.
 *
 * In-memory: a restart drops pending questions, and a late click on one
 * is answered as stale.
 */

import { randomBytes } from "node:crypto";
import type { FrontendActionHandler } from "../types.js";
import { crossSendTarget } from "./gateway-actions/cross-send.js";

/** Callback-data prefix a supporting frontend routes here. */
export const INLINE_CHOICE_PREFIX = "ichoice:";

/** Frontends whose callback dispatch routes `INLINE_CHOICE_PREFIX`. */
const INLINE_CHOICE_FRONTENDS: ReadonlySet<string> = new Set(["telegram"]);

const pending = new Map<string, (choice: string) => void>();

/** A question that was sent: its answer, and a way to rewrite it. */
export type InlineChoiceHandle = {
  /** The clicked choice id, or undefined once `signal` aborted first. */
  choice: Promise<string | undefined>;
  /** Replace the message text (and drop its buttons). Never throws. */
  update: (text: string) => Promise<void>;
};

/**
 * Send `text` with one row of buttons to `chatId` through `handler`.
 * Undefined when the send failed. `signal` ends the wait (timeout, or the
 * question became moot); the caller then updates the message itself.
 */
export async function sendInlineChoice(
  handler: FrontendActionHandler,
  chatId: number,
  question: {
    text: string;
    buttons: ReadonlyArray<{ id: string; label: string }>;
    signal: AbortSignal;
  },
): Promise<InlineChoiceHandle | undefined> {
  if (question.signal.aborted) return undefined;
  const token = randomBytes(6).toString("hex");
  let sent: Awaited<ReturnType<FrontendActionHandler>>;
  try {
    sent = await handler(
      {
        action: "send_message_with_buttons",
        text: question.text,
        rows: [
          question.buttons.map((b) => ({
            text: b.label,
            callback_data: `${INLINE_CHOICE_PREFIX}${token}:${b.id}`,
          })),
        ],
      },
      chatId,
    );
  } catch {
    return undefined;
  }
  if (!sent?.ok) return undefined;
  const messageId = sent.message_id;
  const choice = new Promise<string | undefined>((resolve) => {
    if (question.signal.aborted) return resolve(undefined);
    pending.set(token, resolve);
    question.signal.addEventListener("abort", () => resolve(undefined), {
      once: true,
    });
  }).finally(() => pending.delete(token));
  return {
    choice,
    update: async (text) => {
      if (messageId === undefined) return;
      try {
        await handler(
          { action: "edit_message", message_id: messageId, text },
          chatId,
        );
      } catch {
        // Best-effort: a stale button message is cosmetic.
      }
    },
  };
}

/**
 * `sendInlineChoice` through the named frontend's registered action
 * handler — undefined (ask nothing) when that frontend does not route
 * the clicks back here, or is not enabled.
 */
export function askInlineChoice(
  frontend: string,
  chatId: number,
  question: Parameters<typeof sendInlineChoice>[2],
): Promise<InlineChoiceHandle | undefined> {
  const handler = INLINE_CHOICE_FRONTENDS.has(frontend)
    ? crossSendTarget(frontend)
    : undefined;
  return handler
    ? sendInlineChoice(handler, chatId, question)
    : Promise.resolve(undefined);
}

/**
 * A click on an `INLINE_CHOICE_PREFIX` button. True when it answered a
 * pending question; false for a stale or malformed one.
 */
export function resolveInlineChoice(data: string): boolean {
  if (!data.startsWith(INLINE_CHOICE_PREFIX)) return false;
  const rest = data.slice(INLINE_CHOICE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return false;
  const resolve = pending.get(rest.slice(0, sep));
  if (!resolve) return false;
  resolve(rest.slice(sep + 1));
  return true;
}
