/**
 * Memory reads for the client bridge — the read-only half of the typed
 * memory store (`storage/memory.ts`), projected onto the wire shapes in
 * protocol.ts.
 *
 * Read-only on purpose: a bridge client can ask what Talon remembers and
 * why, and nothing more. Asserting, superseding and dropping stay with
 * the write path, so a paired phone can never quietly
 * rewrite the operator's memory.
 *
 * The one piece of policy here is the limit cap: whatever a client asks
 * for, a single response carries at most `MAX_LIMIT` rows, so a stray
 * `?limit=1000000` cannot turn a listing into a full-table dump.
 */

import {
  getMemory,
  isMemoryKind,
  listMemories,
  memoryHistory,
  searchMemories,
  MEMORY_KINDS,
  type MemoryHistoryRow,
  type MemoryKind,
  type MemoryRow,
} from "../../../storage/memory.js";
import type {
  MemoryHistoryWire,
  MemoryRowWire,
  MemoryWhyWire,
} from "../protocol.js";

/** Hard ceiling on one listing, whatever the client asks for. */
const MAX_LIMIT = 100;

/** What `GET /memory` accepts, already coerced from the query string. */
export type MemoryListQuery = {
  /** Full-text query; when present the listing becomes a search. */
  q?: string;
  kind?: string;
  limit?: number;
};

/** An ok listing, or the reason the request was rejected (a 400). */
export type MemoryListResult =
  { ok: true; rows: MemoryRowWire[] } | { ok: false; error: string };

/** Project a stored row onto the wire — internals stay daemon-side. */
function toWire(row: MemoryRow): MemoryRowWire {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    ...(row.key !== undefined ? { key: row.key } : {}),
    text: row.text,
    trust: row.trust,
    confidence: row.confidence,
    pinned: row.pinned,
    hitCount: row.hitCount,
    salience: row.salience,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}

/**
 * Live rows: a bm25 search when `q` is given, otherwise the ranked
 * listing (pinned, then salience, then recency). An unknown `kind` is
 * a client error rather than an empty result — silently returning
 * nothing for a typo is how a client ends up "showing" an empty memory.
 */
export function listMemory(query: MemoryListQuery = {}): MemoryListResult {
  const raw = query.kind?.trim();
  let kind: MemoryKind | undefined;
  if (raw) {
    if (!isMemoryKind(raw))
      return {
        ok: false,
        error: `Unknown kind "${raw}" (expected one of ${MEMORY_KINDS.join(", ")})`,
      };
    kind = raw;
  }
  const limit = Math.min(query.limit ?? MAX_LIMIT, MAX_LIMIT);
  const q = query.q?.trim();
  const rows = q
    ? searchMemories(q, { ...(kind ? { kind } : {}), limit })
    : listMemories({ ...(kind ? { kind } : {}), limit });
  return { ok: true, rows: rows.map(toWire) };
}

/**
 * One row plus its audit trail, or null when no such id. Reads by id
 * rather than from the live listing, so a superseded or dropped row
 * still explains itself — that is the whole point of "why".
 */
export function memoryWhy(id: number): MemoryWhyWire | null {
  const row = getMemory(id);
  if (!row) return null;
  return {
    row: toWire(row),
    history: memoryHistory(row.id).map(toHistoryWire),
  };
}

/** One audit entry on the wire — before/after text stays daemon-side. */
function toHistoryWire(entry: MemoryHistoryRow): MemoryHistoryWire {
  return {
    op: entry.op,
    at: entry.at,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  };
}
