/**
 * Group message history. Stores messages from all users so the agent
 * has full conversation context even for messages that didn't trigger
 * the bot.
 *
 * Backed by SQLite with an FTS5 full-text index (see
 * repositories/history-repo.ts for the statements; this module holds
 * the domain API and formatting — no SQL here). Compared to the JSON
 * buffer this replaces:
 *   - retention is unbounded — no 500-message cap, because nothing is
 *     held in process memory and reads are indexed
 *   - searchHistory is real full-text search (FTS5), not a linear
 *     `includes()` scan over the tail
 *   - writes are transactional rows, not rewrite-the-file-on-flush
 *
 * Rows are never deleted by normal operation. A /reset (or admin kill,
 * or a native chat reset) records a per-chat context floor
 * ({@link markContextCleared}); a native chat delete hides the chat
 * ({@link hideChatHistory}). Readers that build the bot's context —
 * getRecentHistory, the read_history tool, the pulse, the native
 * transcript — start after the floor; explicit search sees every row,
 * labelling the ones from before the reset. {@link purgeChatHistory},
 * reached only from the operator's `talon history purge`, is the one
 * path that deletes rows.
 *
 * The legacy ~/.talon/data/history.json (JsonStore envelope or bare
 * pre-envelope shape) is imported once on first load, then renamed to
 * history.json.imported.
 */

import { ftsQuote } from "../native/sqlguard.js";
import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { files } from "../util/paths.js";
import { formatSmartTimestamp, formatRelativeAge } from "../util/time.js";
import { importLegacyJson } from "./legacy-import.js";
import { dbErrorFields } from "./db.js";
import * as repo from "./repositories/history-repo.js";

export type {
  HistoryMessage,
  MessageAttachment,
} from "./repositories/history-repo.js";
import type { HistoryMessage } from "./repositories/history-repo.js";

// ── Persistence lifecycle ───────────────────────────────────────────────────

/**
 * Run the one-time import of the legacy JSON buffer and report
 * readiness. Idempotent; called once at boot.
 */
export function loadHistory(): void {
  try {
    importLegacyHistory();
    const chats = repo.distinctChatCount();
    if (chats > 0) log("history", `History ready (${chats} chat(s))`);
  } catch (err) {
    logError("history", "History load failed", err);
  }
}

/** Legacy shape: Record<chatId, HistoryMessage[]>. */
function importLegacyHistory(): void {
  importLegacyJson({
    path: files.history,
    category: "history",
    what: "message(s)",
    ingest: (data) => {
      const entries: Array<{ chatId: string; msg: HistoryMessage }> = [];
      for (const [chatId, messages] of Object.entries(
        (data ?? {}) as Record<string, HistoryMessage[]>,
      )) {
        if (!Array.isArray(messages)) continue;
        for (const msg of messages) {
          if (typeof msg?.msgId !== "number" || typeof msg?.text !== "string")
            continue;
          entries.push({ chatId, msg });
        }
      }
      return repo.insertMany(entries);
    },
  });
}

// ── Core operations ─────────────────────────────────────────────────────────

export function pushMessage(chatId: string, msg: HistoryMessage): void {
  try {
    repo.insert(chatId, msg);
  } catch (err) {
    logError(
      "history",
      `Failed to persist message chat=${chatId} msg=${msg.msgId}${dbErrorFields(err)}`,
      err,
    );
    recordError(
      `History write failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** See repositories/history-repo.ts `maxMsgIdForPrefix`. */
export function maxMsgIdForChatPrefix(prefix: string): number | undefined {
  return repo.maxMsgIdForPrefix(prefix);
}

// ── Soft reset / soft delete ────────────────────────────────────────────────

/** Reader options: `includeCleared` also returns rows from before a reset. */
export type HistoryReadOptions = { includeCleared?: boolean };

/** The chat's reset/hidden state, or undefined when it has none. */
export function getChatHistoryState(
  chatId: string,
): repo.ChatHistoryState | undefined {
  try {
    return repo.chatState(chatId);
  } catch (err) {
    logError("history", `Failed to read history state chat=${chatId}`, err);
    return undefined;
  }
}

/** Row-id floor for context readers: 0 when the chat was never reset. */
function contextFloor(chatId: string, opts: HistoryReadOptions = {}): number {
  if (opts.includeCleared) return 0;
  return getChatHistoryState(chatId)?.clearedThroughId ?? 0;
}

/**
 * Soft reset: the chat's context starts fresh from here. Every stored row
 * stays — searchable, recoverable — but context readers skip rows stored
 * before this call. Replaces the old hard delete on /reset, /new and
 * admin kill. Never throws.
 */
export function markContextCleared(chatId: string, at = Date.now()): void {
  try {
    repo.markCleared(chatId, at);
  } catch (err) {
    logError("history", `Failed to mark context reset chat=${chatId}`, err);
  }
}

/**
 * Soft delete: the user deleted this chat in a client. The rows stay (the
 * operator can still recover or purge them); the chat is flagged hidden
 * and its context floor moves, so it no longer restores and a chat that
 * reappears under the same id starts fresh. Never throws.
 */
export function hideChatHistory(chatId: string, at = Date.now()): void {
  try {
    repo.markHidden(chatId, at);
  } catch (err) {
    logError("history", `Failed to hide chat history chat=${chatId}`, err);
  }
}

/** True when the chat was deleted in a client (its rows are kept). */
export function isChatHistoryHidden(chatId: string): boolean {
  return getChatHistoryState(chatId)?.hiddenAt !== undefined;
}

/** Chats deleted in a client, newest first, with their kept row counts. */
export function listHiddenChats(): repo.HiddenChat[] {
  return repo.hiddenChats();
}

/**
 * Permanently delete a chat's history rows and state. The ONLY hard delete
 * of history: reached solely from the operator's `talon history purge`
 * (which confirms first). Returns the number of rows deleted.
 */
export function purgeChatHistory(chatId: string): number {
  const deleted = repo.purgeChat(chatId);
  log("history", `Purged ${deleted} history row(s) for chat=${chatId}`);
  return deleted;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The chat's current conversation: its most recent `limit` messages after
 * the last context reset, chronological. `includeCleared` reads across it.
 */
export function getRecentHistory(
  chatId: string,
  limit = 50,
  opts: HistoryReadOptions = {},
): HistoryMessage[] {
  return repo.recent(chatId, limit, contextFloor(chatId, opts));
}

/**
 * Scroll-back pagination: the `limit` messages strictly older than
 * `beforeMsgId`, chronological. Used by the bridge's /history endpoint so
 * clients can walk long histories page by page instead of one giant fetch.
 * Stops at the context-reset floor unless `includeCleared`.
 */
export function getHistoryBefore(
  chatId: string,
  beforeMsgId: number,
  limit = 50,
  opts: HistoryReadOptions = {},
): HistoryMessage[] {
  return repo.recentBefore(
    chatId,
    beforeMsgId,
    limit,
    contextFloor(chatId, opts),
  );
}

/**
 * A note for the read_history tool when the chat's context was reset: the
 * older rows are kept, only out of the default view. Empty when there is
 * nothing hidden behind the floor.
 */
function clearedNote(chatId: string): string {
  const state = getChatHistoryState(chatId);
  if (!state || state.clearedThroughId <= 0) return "";
  const when = state.clearedAt
    ? ` on ${new Date(state.clearedAt).toISOString()}`
    : "";
  return (
    `[Context was reset${when}. Messages from before the reset are kept ` +
    "but not shown here; search_history can still find them.]"
  );
}

function withClearedNote(chatId: string, body: string, empty: string): string {
  const note = clearedNote(chatId);
  if (!note) return body || empty;
  return body ? `${note}\n${body}` : `${empty}\n${note}`;
}

/** Formatted page of the messages strictly older than `beforeMsgId`. */
export function getFormattedBefore(
  chatId: string,
  beforeMsgId: number,
  limit = 30,
): string {
  const floor = contextFloor(chatId);
  const messages = repo.recentBefore(chatId, beforeMsgId, limit, floor);
  const body = messages.map(formatMessage).join("\n");
  if (floor > 0 && messages.length < limit) {
    return withClearedNote(chatId, body, "No messages before that point.");
  }
  return body || "No messages before that point.";
}

/** Formatted page of the messages strictly older than a timestamp (ms). */
export function getFormattedBeforeTime(
  chatId: string,
  beforeTs: number,
  limit = 30,
): string {
  const floor = contextFloor(chatId);
  const messages = repo.recentBeforeTime(chatId, beforeTs, limit, floor);
  const body = messages.map(formatMessage).join("\n");
  if (floor > 0 && messages.length < limit) {
    return withClearedNote(chatId, body, "No messages before that date.");
  }
  return body || "No messages before that date.";
}

/**
 * Raw (wire-friendly) full-text search over a chat's history. Unlike
 * [searchHistory] — which formats a string for the agent's tool — this
 * returns the matching rows for the bridge's /search endpoint to map into
 * protocol messages. Empty on FTS failure rather than throwing.
 */
export function searchHistoryMessages(
  chatId: string,
  query: string,
  limit = 20,
): HistoryMessage[] {
  const match = ftsQuery(query);
  if (!match) return [];
  try {
    return repo.searchFts(chatId, match, limit);
  } catch (err) {
    logError("history", `FTS search failed for ${JSON.stringify(query)}`, err);
    return [];
  }
}

/** Update a message's file path after media download. */
export function setMessageFilePath(
  chatId: string,
  msgId: number,
  filePath: string,
): void {
  repo.setFilePath(chatId, msgId, filePath);
}

// ── Formatted queries ───────────────────────────────────────────────────────

function formatMessage(m: HistoryMessage): string {
  const replyTag = m.replyToMsgId ? ` (replying to msg:${m.replyToMsgId})` : "";
  const mediaTag = m.mediaType ? ` [${m.mediaType}]` : "";
  const stickerTag = m.stickerFileId
    ? ` (sticker_file_id: ${m.stickerFileId})`
    : "";
  const fileTag = m.filePath ? ` (file: ${m.filePath})` : "";
  const time = formatSmartTimestamp(m.timestamp);
  // The handle rides along with the name: a reader deciding to mention
  // someone (a scheduled message, a heartbeat-composed reply) has no other
  // way to learn it, and a display name notifies nobody.
  const who = m.senderHandle
    ? `${m.senderName} (@${m.senderHandle})`
    : m.senderName;
  return `[msg:${m.msgId} ${time}] ${who}${replyTag}${mediaTag}${stickerTag}${fileTag}: ${m.text}`;
}

/**
 * The read_history tool's default view: the conversation since the last
 * context reset, with a note saying older rows exist when the page reaches
 * the reset.
 */
export function getRecentFormatted(chatId: string, limit = 20): string {
  const messages = getRecentHistory(chatId, limit);
  const body = messages.map(formatMessage).join("\n");
  if (messages.length < limit) {
    return withClearedNote(chatId, body, "No messages in history.");
  }
  return body || "No messages in history.";
}

/**
 * Formatter for explicit lookups that read across a context reset (search,
 * by-user): rows from before the reset carry a label so the reader knows
 * they are no longer part of the current conversation. The label is by
 * timestamp — rows have no id on the domain type — so a message stamped
 * just before the reset but stored after it reads as older.
 */
function labelledFormatter(chatId: string): (m: HistoryMessage) => string {
  const clearedAt = getChatHistoryState(chatId)?.clearedAt;
  if (clearedAt === undefined) return formatMessage;
  return (m) =>
    m.timestamp <= clearedAt
      ? `[before context reset] ${formatMessage(m)}`
      : formatMessage(m);
}

/**
 * Build an FTS5 MATCH expression from free-form user input. Every
 * token is double-quoted so FTS operators (AND, NEAR, *, ^) in user
 * text are treated as literals, not syntax. Delegates to the C core
 * (native/sqlguard-wasm) for byte-identical output.
 */
function ftsQuery(query: string): string {
  return ftsQuote(query);
}

/** Legacy contract: empty chats answer "No messages in history." */
function chatIsEmpty(chatId: string): boolean {
  return repo.latestMsgId(chatId) === undefined;
}

/** Optional time window for `searchHistory`, in epoch ms. */
export type HistoryDateRange = { after?: number; before?: number };

export function searchHistory(
  chatId: string,
  query: string,
  limit = 20,
  range: HistoryDateRange = {},
): string {
  if (chatIsEmpty(chatId)) return "No messages in history.";
  const match = ftsQuery(query);
  if (!match) return `No messages matching "${query}".`;
  let messages: HistoryMessage[];
  try {
    messages =
      range.after === undefined && range.before === undefined
        ? repo.searchFts(chatId, match, limit)
        : repo.searchFtsBetween(
            chatId,
            match,
            range.after ?? 0,
            range.before ?? Number.MAX_SAFE_INTEGER,
            limit,
          );
  } catch (err) {
    logError("history", `FTS search failed for ${JSON.stringify(query)}`, err);
    return `No messages matching "${query}".`;
  }
  if (messages.length === 0) return `No messages matching "${query}".`;
  return messages.map(labelledFormatter(chatId)).join("\n");
}

export function getMessagesByUser(
  chatId: string,
  userName: string,
  limit = 20,
): string {
  if (chatIsEmpty(chatId)) return "No messages in history.";
  const messages = repo.bySenderName(chatId, userName, limit);
  if (messages.length === 0) return `No messages from "${userName}".`;
  return messages.map(labelledFormatter(chatId)).join("\n");
}

/** The stored row for one message, or undefined. */
export function getHistoryMessage(
  chatId: string,
  msgId: number,
): HistoryMessage | undefined {
  return repo.byMsgId(chatId, msgId);
}

export function getMessageById(chatId: string, msgId: number): string {
  if (chatIsEmpty(chatId)) return "No messages in history.";
  const msg = repo.byMsgId(chatId, msgId);
  if (!msg) return `Message ${msgId} not found in recent history.`;
  return formatMessage(msg);
}

export function getKnownUsers(chatId: string): string {
  const users = repo.knownUsers(chatId);
  if (users.length === 0) return "No users seen yet.";
  return users
    .map(
      (u) =>
        `${u.name}${u.handle ? ` (@${u.handle})` : ""} (user_id: ${u.senderId}) — ${u.messageCount} msgs, last seen ${formatRelativeAge(u.lastSeen)}`,
    )
    .join("\n");
}

export function getRecentBySenderId(
  chatId: string,
  senderId: number,
  limit = 5,
): HistoryMessage[] {
  return repo.bySenderId(chatId, senderId, limit);
}

export function getLatestMessageId(chatId: string): number | undefined {
  return repo.latestMsgId(chatId);
}

export function getHistoryStats(chatId: string): repo.ChatStats {
  return repo.statsByChat(chatId);
}
