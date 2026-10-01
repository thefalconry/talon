/**
 * Media-index repository — executes the statements in
 * sql/media-index.sql against the `media_index` table; no SQL text
 * lives here. The public store (storage/media-index.ts) holds the
 * domain API, formatting and the expiry sweep's file deletion; this
 * module owns statement execution and the row↔domain mapping.
 *
 * (chat_id, msg_id) is the primary key — the legacy store's "id"
 * string was `chatId:msgId`, reconstructed here on read. Indexes back
 * each real lookup pattern: recent-by-chat, by-chat-and-type, and the
 * timestamp-only scan the expiry sweep does (see
 * sql/schema.sql).
 */

import { getDatabase, inTransaction } from "../db.js";
import { mediaIndexSql } from "../sql/statements.generated.js";
/** One indexed media file as the domain sees it. */
export type MediaEntry = {
  id: string; // unique key: chatId:msgId
  chatId: string;
  msgId: number;
  senderName: string;
  type:
    | "photo"
    | "document"
    | "voice"
    | "video"
    | "animation"
    | "audio"
    | "sticker";
  filePath: string;
  caption?: string;
  timestamp: number;
  /**
   * BLAKE3 hex digest of the file contents (native/blake3-wasm).
   * Filled in by addMedia before it resolves; undefined until hashed.
   */
  contentHash?: string;
};

type Row = {
  chat_id: string;
  msg_id: number;
  sender_name: string;
  type: string;
  file_path: string;
  caption: string | null;
  timestamp: number;
  content_hash: string | null;
};

function rowToEntry(row: Row): MediaEntry {
  return {
    id: `${row.chat_id}:${row.msg_id}`,
    chatId: row.chat_id,
    msgId: row.msg_id,
    senderName: row.sender_name,
    type: row.type as MediaEntry["type"],
    filePath: row.file_path,
    caption: row.caption ?? undefined,
    timestamp: row.timestamp,
    contentHash: row.content_hash ?? undefined,
  };
}

/** Insert-or-replace keyed by (chat_id, msg_id) — re-downloads dedupe. */
export function upsert(entry: Omit<MediaEntry, "id">): void {
  getDatabase()
    .prepare(mediaIndexSql.upsert)
    .run(
      entry.chatId,
      entry.msgId,
      entry.senderName,
      entry.type,
      entry.filePath,
      entry.caption ?? null,
      entry.timestamp,
      entry.contentHash ?? null,
    );
}

/** Record the BLAKE3 content hash once the async hash completes. */
export function setContentHash(
  chatId: string,
  msgId: number,
  hash: string,
): void {
  getDatabase().prepare(mediaIndexSql.setContentHash).run(hash, chatId, msgId);
}

/** Repoint an entry at another file (content dedupe). */
export function setFilePath(
  chatId: string,
  msgId: number,
  filePath: string,
): void {
  getDatabase().prepare(mediaIndexSql.setFilePath).run(filePath, chatId, msgId);
}

/**
 * Oldest entry with this content hash other than the given row — the
 * canonical copy a duplicate download is deduped against.
 */
export function firstByContentHash(
  hash: string,
  excludeChatId: string,
  excludeMsgId: number,
): MediaEntry | undefined {
  const row = getDatabase()
    .prepare(mediaIndexSql.firstByContentHash)
    .get(hash, excludeChatId, excludeMsgId) as Row | undefined;
  return row ? rowToEntry(row) : undefined;
}

/** The entry for one message, if indexed. */
export function byMessage(
  chatId: string,
  msgId: number,
): MediaEntry | undefined {
  const row = getDatabase()
    .prepare(mediaIndexSql.byMessage)
    .get(chatId, msgId) as Row | undefined;
  return row ? rowToEntry(row) : undefined;
}

/** Entries currently pointing at a file — dedupe makes this > 1. */
export function countByFilePath(filePath: string): number {
  const row = getDatabase()
    .prepare(mediaIndexSql.countByFilePath)
    .get(filePath) as { n: number };
  return row.n;
}

/** Bulk-upsert inside one transaction (legacy JSON import). */
export function upsertMany(entries: Array<Omit<MediaEntry, "id">>): number {
  return inTransaction(() => {
    for (const entry of entries) upsert(entry);
    return entries.length;
  });
}

/**
 * Most-recent media for a chat, newest first. Ties on timestamp keep
 * insertion order (rowid ASC) to match the legacy stable sort.
 */
export function recentByChat(chatId: string, limit: number): MediaEntry[] {
  const rows = getDatabase()
    .prepare(mediaIndexSql.recentByChat)
    .all(chatId, limit) as Row[];
  return rows.map(rowToEntry);
}

export function byType(
  chatId: string,
  type: MediaEntry["type"],
  limit: number,
): MediaEntry[] {
  const rows = getDatabase()
    .prepare(mediaIndexSql.byType)
    .all(chatId, type, limit) as Row[];
  return rows.map(rowToEntry);
}

/** Entries older than `cutoff` — selected so the sweep can unlink files. */
export function olderThan(cutoff: number): MediaEntry[] {
  const rows = getDatabase()
    .prepare(mediaIndexSql.olderThan)
    .all(cutoff) as Row[];
  return rows.map(rowToEntry);
}

/** Delete entries older than `cutoff`; returns the number removed. */
export function deleteOlderThan(cutoff: number): number {
  const result = getDatabase()
    .prepare(mediaIndexSql.deleteOlderThan)
    .run(cutoff) as {
    changes: number | bigint;
  };
  return Number(result.changes);
}
