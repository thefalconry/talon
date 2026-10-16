/**
 * Blackboard repository — executes the statements in sql/board.sql against
 * the `agent_board` table; no SQL text lives here. Policy (caps, rate limit,
 * lease semantics) is core/agents/board.ts.
 */

import { getDatabase } from "../db.js";
import { boardSql } from "../sql/statements.generated.js";

export type BoardKind =
  "finding" | "claim" | "correction" | "question" | "lease";

export type BoardEntry = {
  id: number;
  chatId: string;
  /** Agent id, or "parent". */
  author: string;
  authorLabel: string;
  topic: string;
  kind: BoardKind;
  text: string;
  createdAt: number;
  /** Leases only. */
  expiresAt?: number;
};

type Row = {
  id: number;
  chat_id: string;
  author_id: string;
  author_label: string;
  topic: string;
  kind: string;
  text: string;
  created_at: number;
  expires_at: number | null;
};

function rowToEntry(row: Row): BoardEntry {
  const entry: BoardEntry = {
    id: row.id,
    chatId: row.chat_id,
    author: row.author_id,
    authorLabel: row.author_label,
    topic: row.topic,
    kind: row.kind as BoardKind,
    text: row.text,
    createdAt: row.created_at,
  };
  if (row.expires_at !== null) entry.expiresAt = row.expires_at;
  return entry;
}

function changes(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0;
}

export function insert(entry: Omit<BoardEntry, "id">): number {
  const result = getDatabase()
    .prepare(boardSql.insert)
    .run(
      entry.chatId,
      entry.author,
      entry.authorLabel,
      entry.topic,
      entry.kind,
      entry.text,
      entry.createdAt,
      entry.expiresAt ?? null,
    ) as { lastInsertRowid?: number | bigint };
  return Number(result.lastInsertRowid ?? 0);
}

export function listLive(
  chatId: string,
  now: number,
  sinceId: number,
  topic: string | undefined,
): BoardEntry[] {
  const t = topic ?? null;
  const rows = getDatabase()
    .prepare(boardSql.listLive)
    .all(chatId, sinceId, now, t, t) as Row[];
  return rows.map(rowToEntry);
}

export function findLiveLease(
  chatId: string,
  resource: string,
  now: number,
): BoardEntry | undefined {
  const row = getDatabase()
    .prepare(boardSql.findLiveLease)
    .get(chatId, resource, now) as Row | undefined;
  return row ? rowToEntry(row) : undefined;
}

export function renewLease(id: number, expiresAt: number, text: string): void {
  getDatabase().prepare(boardSql.renewLease).run(expiresAt, text, id);
}

/** Release one holder's live lease on a resource. Returns whether one was. */
export function releaseLease(
  chatId: string,
  resource: string,
  author: string,
  now: number,
): boolean {
  return (
    changes(
      getDatabase()
        .prepare(boardSql.releaseLease)
        .run(now, chatId, resource, author, now),
    ) > 0
  );
}

/** Release every live lease an agent holds. Returns how many. */
export function releaseAllFor(author: string, now: number): number {
  return changes(
    getDatabase().prepare(boardSql.releaseAllFor).run(now, author),
  );
}

/** Drop dead leases, then the oldest non-lease rows beyond `cap`. */
export function enforceCap(chatId: string, now: number, cap: number): void {
  const db = getDatabase();
  db.prepare(boardSql.pruneDeadLeases).run(chatId, now);
  const row = db.prepare(boardSql.countLive).get(chatId) as { n: number };
  if (row.n > cap) {
    db.prepare(boardSql.dropOldestNonLease).run(chatId, row.n - cap);
  }
}

/** Test-only: wipe the table between suites sharing a worker DB. */
export function removeAll(): void {
  getDatabase().prepare(boardSql.removeAll).run();
}
