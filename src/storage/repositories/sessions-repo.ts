/**
 * Sessions repository — executes the statements in sql/sessions.sql
 * against the `sessions` table; no SQL text lives here. The public
 * store (storage/sessions.ts) holds the domain API and the in-memory
 * write-through cache; this module owns statement execution and the
 * row↔domain mapping.
 *
 * One row per chat, real columns for the hot fields (see
 * sql/schema.sql for the rationale).
 * `fastest_response_ms` is NULL when no timed turn has been recorded —
 * the domain value is Infinity, which neither JSON nor a sensible
 * column default can hold.
 */

import { logWarn } from "../../util/log.js";
import { getDatabase, inTransaction } from "../db.js";
import { sessionsSql } from "../sql/statements.generated.js";
import {
  emptyMetrics,
  normaliseMetrics,
  type SessionMetrics,
  type SessionState,
} from "../session-record.js";

type Row = {
  chat_id: string;
  session_id: string | null;
  session_name: string | null;
  last_model: string | null;
  turns: number;
  last_active: number;
  created_at: number;
  last_bot_message_id: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_write: number;
  last_prompt_tokens: number;
  context_tokens: number;
  context_window: number;
  num_api_calls: number;
  estimated_cost_usd: number;
  total_response_ms: number;
  last_response_ms: number;
  fastest_response_ms: number | null;
  last_turn_ended_at: number | null;
  metrics: string | null;
};

function parseMetrics(raw: string | null, chatId: string): SessionMetrics {
  if (!raw) return emptyMetrics();
  try {
    // Normalise at the load boundary: backfills partial blobs and restores
    // the Infinity minMs sentinel that JSON round-trips as null.
    return normaliseMetrics(JSON.parse(raw));
  } catch (err) {
    // Degrade to empty — and say so, since the next upsert overwrites
    // the corrupt blob and the chat's lifetime counters restart at zero.
    logWarn(
      "sessions",
      `Corrupt session metrics chat=${chatId} bytes=${raw.length} — resetting: ${err instanceof Error ? err.message : String(err)}`,
    );
    return emptyMetrics();
  }
}

function rowToSession(row: Row): SessionState {
  return {
    sessionId: row.session_id ?? undefined,
    turns: row.turns,
    lastActive: row.last_active,
    createdAt: row.created_at,
    usage: {
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalCacheRead: row.total_cache_read,
      totalCacheWrite: row.total_cache_write,
      lastPromptTokens: row.last_prompt_tokens,
      contextTokens: row.context_tokens,
      contextWindow: row.context_window,
      numApiCalls: row.num_api_calls,
      estimatedCostUsd: row.estimated_cost_usd,
      totalResponseMs: row.total_response_ms,
      lastResponseMs: row.last_response_ms,
      // NULL = no timed turn yet — the domain sentinel is Infinity.
      fastestResponseMs: row.fastest_response_ms ?? Infinity,
    },
    metrics: parseMetrics(row.metrics, row.chat_id),
    lastBotMessageId: row.last_bot_message_id ?? undefined,
    sessionName: row.session_name ?? undefined,
    lastModel: row.last_model ?? undefined,
    lastTurnEndedAt: row.last_turn_ended_at ?? undefined,
  };
}

/** Coerce a possibly-absent legacy number into a finite value. */
function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Whole-row write. Tolerates partially-shaped legacy sessions (missing
 * usage object, missing createdAt) by defaulting numerics to 0 — the
 * store's normaliseSession() re-derives the domain values on read.
 */
export function upsert(chatId: string, session: SessionState): void {
  const usage = session.usage;
  const fastest = usage?.fastestResponseMs;
  getDatabase()
    .prepare(sessionsSql.upsert)
    .run(
      chatId,
      session.sessionId ?? null,
      session.sessionName ?? null,
      session.lastModel ?? null,
      num(session.turns),
      num(session.lastActive),
      num(session.createdAt),
      session.lastBotMessageId ?? null,
      num(usage?.totalInputTokens),
      num(usage?.totalOutputTokens),
      num(usage?.totalCacheRead),
      num(usage?.totalCacheWrite),
      num(usage?.lastPromptTokens),
      num(usage?.contextTokens),
      num(usage?.contextWindow),
      num(usage?.numApiCalls),
      num(usage?.estimatedCostUsd),
      num(usage?.totalResponseMs),
      num(usage?.lastResponseMs),
      typeof fastest === "number" && Number.isFinite(fastest) ? fastest : null,
      typeof session.lastTurnEndedAt === "number" &&
        Number.isFinite(session.lastTurnEndedAt)
        ? session.lastTurnEndedAt
        : null,
      JSON.stringify(session.metrics ?? emptyMetrics()),
    );
}

/** Bulk-upsert inside one transaction (legacy JSON import). */
export function upsertMany(
  entries: Array<{ chatId: string; session: SessionState }>,
): number {
  return inTransaction(() => {
    for (const { chatId, session } of entries) upsert(chatId, session);
    return entries.length;
  });
}

/** Every persisted session — used to prime the in-memory cache. */
export function all(): Array<{ chatId: string; session: SessionState }> {
  const rows = getDatabase().prepare(sessionsSql.all).all() as Row[];
  return rows.map((row) => ({
    chatId: row.chat_id,
    session: rowToSession(row),
  }));
}

export function remove(chatId: string): void {
  getDatabase().prepare(sessionsSql.remove).run(chatId);
}
