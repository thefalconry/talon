/**
 * History repository — executes the statements in sql/history.sql
 * against the history tables; no SQL text lives here. The public store
 * (storage/history.ts) holds the domain API and formatting; this
 * module owns statement execution and the row↔domain mapping.
 */

import { escapeLike } from "../../native/sqlguard.js";
import { getDatabase, inTransaction } from "../db.js";
import { historySql } from "../sql/statements.generated.js";
/** One chat message as the domain sees it — the shape the rows map to. */
/**
 * A file attached to a message, persisted with it. The bridge's own
 * `ClientAttachment` is this plus a per-run `/media` URL — storage keeps only
 * what survives a restart, and the URL is minted fresh on read.
 */
export type MessageAttachment = {
  /** Absolute path on this host. */
  path: string;
  /** Original file name, for display. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Best-effort MIME type. */
  mimeType: string;
  /** True when clients render it inline as an image. */
  image: boolean;
};

export type HistoryMessage = {
  msgId: number;
  senderId: number;
  senderName: string;
  /**
   * Platform handle without `@` (Telegram username / Discord username).
   * Undefined for users who have none. Display names can't be mentioned;
   * this is the addressable form a later reader needs.
   */
  senderHandle?: string;
  text: string;
  replyToMsgId?: number;
  timestamp: number;
  mediaType?:
    "photo" | "document" | "voice" | "sticker" | "video" | "animation";
  stickerFileId?: string;
  /** Saved file path for downloaded media (the first attachment's, when
   *  a message carries several). */
  filePath?: string;
  /** Every file attached to this message, oldest row shape holds none. */
  attachments?: MessageAttachment[];
};

type Row = {
  msg_id: number;
  sender_id: number;
  sender_name: string;
  sender_handle: string | null;
  text: string;
  reply_to_msg_id: number | null;
  timestamp: number;
  media_type: string | null;
  sticker_file_id: string | null;
  file_path: string | null;
  attachments: string | null;
};

/**
 * Parse the persisted attachments column. Anything unreadable (hand-edited
 * row, a shape from a future version) degrades to "no attachments" rather
 * than failing the whole history read.
 */
function parseAttachments(raw: string | null): MessageAttachment[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const rows = parsed.filter(
      (a): a is MessageAttachment =>
        typeof a === "object" &&
        a !== null &&
        typeof (a as MessageAttachment).path === "string",
    );
    return rows.length ? rows : undefined;
  } catch {
    return undefined;
  }
}

function rowToMessage(row: Row): HistoryMessage {
  return {
    msgId: row.msg_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderHandle: row.sender_handle ?? undefined,
    text: row.text,
    replyToMsgId: row.reply_to_msg_id ?? undefined,
    timestamp: row.timestamp,
    mediaType: (row.media_type ?? undefined) as HistoryMessage["mediaType"],
    stickerFileId: row.sticker_file_id ?? undefined,
    filePath: row.file_path ?? undefined,
    attachments: parseAttachments(row.attachments),
  };
}

export function insert(chatId: string, msg: HistoryMessage): void {
  getDatabase()
    .prepare(historySql.insert)
    .run(
      chatId,
      msg.msgId,
      msg.senderId,
      msg.senderName,
      msg.senderHandle ?? null,
      msg.text,
      msg.replyToMsgId ?? null,
      msg.timestamp,
      msg.mediaType ?? null,
      msg.stickerFileId ?? null,
      msg.filePath ?? null,
      msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
    );
}

/** Bulk-insert inside one transaction (legacy JSON import). */
export function insertMany(
  entries: Array<{ chatId: string; msg: HistoryMessage }>,
): number {
  return inTransaction(() => {
    for (const { chatId, msg } of entries) insert(chatId, msg);
    return entries.length;
  });
}

/**
 * Most-recent `limit` messages, in chronological order. `floorId` is the
 * chat's context-reset marker: only rows with a larger id are returned
 * (0 = every row).
 */
export function recent(
  chatId: string,
  limit: number,
  floorId = 0,
): HistoryMessage[] {
  const rows = getDatabase()
    .prepare(historySql.recent)
    .all(chatId, floorId, limit) as Row[];
  return rows.reverse().map(rowToMessage);
}

/**
 * Scroll-back pagination: the `limit` messages strictly older than
 * `beforeMsgId`, in chronological order.
 */
export function recentBefore(
  chatId: string,
  beforeMsgId: number,
  limit: number,
  floorId = 0,
): HistoryMessage[] {
  const rows = getDatabase()
    .prepare(historySql.recentBefore)
    .all(chatId, beforeMsgId, floorId, limit) as Row[];
  return rows.reverse().map(rowToMessage);
}

export function recentBeforeTime(
  chatId: string,
  beforeTs: number,
  limit: number,
  floorId = 0,
): HistoryMessage[] {
  const rows = getDatabase()
    .prepare(historySql.recentBeforeTime)
    .all(chatId, beforeTs, floorId, limit) as Row[];
  return rows.reverse().map(rowToMessage);
}

export function setFilePath(
  chatId: string,
  msgId: number,
  filePath: string,
): void {
  getDatabase().prepare(historySql.setFilePath).run(filePath, chatId, msgId);
}

/**
 * Hard-delete a chat's rows and its state. Only the operator's explicit
 * purge reaches this (history.ts purgeChatHistory). Returns rows deleted.
 */
export function purgeChat(chatId: string): number {
  return inTransaction(() => {
    const db = getDatabase();
    const result = db.prepare(historySql.purgeChat).run(chatId) as {
      changes: number | bigint;
    };
    db.prepare(historySql.purgeChatState).run(chatId);
    return Number(result.changes);
  });
}

/** A chat's soft-reset / soft-delete state. */
export type ChatHistoryState = {
  /** Rows with an id at or under this predate the last context reset. */
  clearedThroughId: number;
  clearedAt?: number;
  hiddenAt?: number;
};

export function chatState(chatId: string): ChatHistoryState | undefined {
  const row = getDatabase().prepare(historySql.chatState).get(chatId) as
    | {
        cleared_through_id: number;
        cleared_at: number | null;
        hidden_at: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    clearedThroughId: row.cleared_through_id,
    clearedAt: row.cleared_at ?? undefined,
    hiddenAt: row.hidden_at ?? undefined,
  };
}

export function markCleared(chatId: string, at: number): void {
  getDatabase().prepare(historySql.markCleared).run(chatId, chatId, at);
}

export function markHidden(chatId: string, at: number): void {
  getDatabase().prepare(historySql.markHidden).run(chatId, chatId, at, at);
}

export type HiddenChat = { chatId: string; hiddenAt: number; total: number };

export function hiddenChats(): HiddenChat[] {
  const rows = getDatabase().prepare(historySql.hiddenChats).all() as Array<{
    chat_id: string;
    hidden_at: number;
    total: number;
  }>;
  return rows.map((r) => ({
    chatId: r.chat_id,
    hiddenAt: r.hidden_at,
    total: r.total,
  }));
}

/**
 * FTS5 full-text search over text + sender name; `match` must already
 * be a valid FTS expression (see history.ts ftsQuery). Chronological
 * order, most recent `limit` matches.
 */
export function searchFts(
  chatId: string,
  match: string,
  limit: number,
): HistoryMessage[] {
  const rows = getDatabase()
    .prepare(historySql.searchFts)
    .all(chatId, match, limit) as Row[];
  return rows.reverse().map(rowToMessage);
}

/** `searchFts` restricted to messages with `after <= timestamp < before`. */
export function searchFtsBetween(
  chatId: string,
  match: string,
  after: number,
  before: number,
  limit: number,
): HistoryMessage[] {
  const rows = getDatabase()
    .prepare(historySql.searchFtsBetween)
    .all(chatId, match, after, before, limit) as Row[];
  return rows.reverse().map(rowToMessage);
}

export function bySenderName(
  chatId: string,
  nameFragment: string,
  limit: number,
): HistoryMessage[] {
  const escaped = escapeLike(nameFragment);
  const rows = getDatabase()
    .prepare(historySql.bySenderName)
    .all(chatId, `%${escaped}%`, limit) as Row[];
  return rows.reverse().map(rowToMessage);
}

export function byMsgId(
  chatId: string,
  msgId: number,
): HistoryMessage | undefined {
  const row = getDatabase().prepare(historySql.byMsgId).get(chatId, msgId) as
    Row | undefined;
  return row ? rowToMessage(row) : undefined;
}

export function bySenderId(
  chatId: string,
  senderId: number,
  limit: number,
): HistoryMessage[] {
  const rows = getDatabase()
    .prepare(historySql.bySenderId)
    .all(chatId, senderId, limit) as Row[];
  return rows.reverse().map(rowToMessage);
}

export function latestMsgId(chatId: string): number | undefined {
  const row = getDatabase().prepare(historySql.latestMsgId).get(chatId) as
    { msg_id: number } | undefined;
  return row?.msg_id;
}

/**
 * Highest msg_id over every chat whose id begins with `prefix` (compared
 * literally — LIKE wildcards in the prefix are escaped). Undefined when no
 * such chat has any history.
 */
export function maxMsgIdForPrefix(prefix: string): number | undefined {
  const pattern = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`) + "%";
  const row = getDatabase()
    .prepare(historySql.maxMsgIdForPrefix)
    .get(pattern) as { max_id: number | null } | undefined;
  return row?.max_id ?? undefined;
}

export type KnownUser = {
  senderId: number;
  name: string;
  /** Latest known platform handle without `@`, if the user has one. */
  handle?: string;
  lastSeen: number;
  messageCount: number;
};

/** Distinct senders, most recently seen first, with current name. */
export function knownUsers(chatId: string): KnownUser[] {
  const rows = getDatabase()
    .prepare(historySql.knownUsers)
    .all(chatId) as Array<{
    sender_id: number;
    last_seen: number;
    message_count: number;
    name: string;
    handle: string | null;
  }>;
  return rows.map((r) => ({
    senderId: r.sender_id,
    name: r.name,
    handle: r.handle ?? undefined,
    lastSeen: r.last_seen,
    messageCount: r.message_count,
  }));
}

export type ChatStats = {
  totalMessages: number;
  uniqueUsers: number;
  oldestTimestamp: number;
  newestTimestamp: number;
};

export function statsByChat(chatId: string): ChatStats {
  const row = getDatabase().prepare(historySql.statsByChat).get(chatId) as {
    total: number;
    users: number;
    oldest: number;
    newest: number;
  };
  return {
    totalMessages: row.total,
    uniqueUsers: row.users,
    oldestTimestamp: row.oldest,
    newestTimestamp: row.newest,
  };
}

export function distinctChatCount(): number {
  const row = getDatabase().prepare(historySql.distinctChatCount).get() as {
    chats: number;
  };
  return row.chats;
}
