/**
 * Recent outbound text, keyed by chat and message id.
 *
 * Rich Messages (Bot API 10.2) are a message type the MTProto user client
 * cannot render: `telegram` (gramjs) negotiates an older layer, so Telegram
 * downgrades every one of them to `messageMediaUnsupported` with empty text.
 * The practical effect is that the agent reading its own chat history sees
 * `[MessageMediaUnsupported]: (media)` in place of everything it just said —
 * it cannot quote, correct, or reason about its own messages.
 *
 * The daemon already knows the text: it wrote it. This keeps a small bounded
 * record of what was sent so the history readers can splice it back in.
 * In-memory on purpose — it serves the live session, and a restart losing the
 * backlog is not worth a schema.
 */

/** Messages remembered per chat. Well past any single history read. */
const MAX_PER_CHAT = 400;

/** chatId -> (messageId -> text), insertion-ordered so the oldest evicts first. */
const byChat = new Map<number, Map<number, string>>();

/** Remember the text of a message this bot just sent. */
export function recordOutgoingText(
  chatId: number,
  messageId: number,
  text: string,
): void {
  if (!Number.isFinite(messageId) || messageId <= 0) return;
  if (!text) return;
  let chat = byChat.get(chatId);
  if (!chat) {
    chat = new Map();
    byChat.set(chatId, chat);
  }
  // Re-inserting moves the entry to the end, keeping eviction age-ordered.
  chat.delete(messageId);
  chat.set(messageId, text);
  while (chat.size > MAX_PER_CHAT) {
    const oldest = chat.keys().next();
    if (oldest.done) break;
    chat.delete(oldest.value);
  }
}

/**
 * The text this bot sent as `messageId`, if still remembered. `chatId` is
 * optional: history readers work in one chat at a time, but message ids are
 * unique enough within a session that a lookup across chats is a useful
 * fallback when the caller does not have the id in the same form.
 */
export function outgoingText(
  messageId: number,
  chatId?: number,
): string | undefined {
  if (chatId !== undefined) {
    const hit = byChat.get(chatId)?.get(messageId);
    if (hit) return hit;
  }
  for (const chat of byChat.values()) {
    const hit = chat.get(messageId);
    if (hit) return hit;
  }
  return undefined;
}

/** Test seam: drop everything remembered. */
export function resetOutgoingLog(): void {
  byChat.clear();
}
