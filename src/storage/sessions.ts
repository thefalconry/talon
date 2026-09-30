/**
 * Session manager — maps chat IDs to backend session IDs plus per-chat
 * usage accounting. The backend handles actual conversation storage
 * (JSONL); we track the mapping and the counters so conversations and
 * stats persist across messages.
 *
 * Backed by SQLite (see repositories/sessions-repo.ts for the
 * statements; this module holds the domain API — no SQL here) with an
 * in-memory write-through cache: getSession() returns a live
 * SessionState reference (the historical contract — in-module mutators
 * and tests mutate it in place), and every mutator commits the chat's
 * whole row immediately. Compared to the JsonStore this replaces,
 * there is no dirty flag and no 10s autosave timer — SQLite commits
 * per write.
 *
 * The legacy ~/.talon/data/sessions.json (JsonStore envelope or bare
 * pre-envelope shape) is imported once on first load, then renamed to
 * sessions.json.imported.
 */

import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { files } from "../util/paths.js";
import { importLegacyJson } from "./legacy-import.js";
import { dbErrorFields } from "./db.js";
import { kvGet, kvSet } from "./kv.js";
import * as repo from "./repositories/sessions-repo.js";

export type {
  MetricsCounterSet,
  MetricsGrain,
  MetricsLatencyAgg,
  SessionState,
} from "./session-record.js";
import {
  emptyCounters,
  emptyGrain,
  emptyLatency,
  emptyMetrics,
  emptyUsage,
  type MetricsCounterSet,
  type MetricsGrain,
  type MetricsLatencyAgg,
  type SessionMetrics,
  type SessionState,
  type SessionUsage,
  TURN_PHASES,
  type TurnPhase,
} from "./session-record.js";
// In-memory cache over the sessions table. Reads serve live references
// from here; writes go through persist() so each mutation commits.
const cache = new Map<string, SessionState>();

// ── Live-turn overlay ───────────────────────────────────────────────────────
//
// Mid-turn usage snapshot for the chat's IN-PROGRESS turn. Backends push
// updates here as their stream produces usage signals (per-API-call usage
// events, rollout polls, SSE summaries), so /status reflects reality while
// a long agentic turn is still running instead of showing the previous
// turn's numbers. Never persisted — recordUsage() commits the final turn
// totals and clears the overlay; clearLiveTurn() in the backends' finally
// blocks covers error/abort exits.
//
// All token fields are ABSOLUTE this-turn-so-far values (not deltas):
// each update replaces the fields it carries, and getSessionInfo() adds
// them on top of the persisted cumulative totals at read time.

export type LiveTurnUsage = {
  /** Effective input tokens consumed so far this turn. */
  inputTokens: number;
  /** Output tokens generated so far this turn. */
  outputTokens: number;
  /** Cache-read tokens so far this turn. */
  cacheRead: number;
  /** Cache-write tokens so far this turn. */
  cacheWrite: number;
  /** Latest known context fill (last API call's prompt size). */
  contextTokens: number;
  /** Model context window, if the stream reported it. */
  contextWindow: number;
  /** API round-trips observed so far this turn. */
  numApiCalls: number;
  /** When the turn started (first update). */
  startedAt: number;
  /** Last update timestamp. */
  updatedAt: number;
};

const liveTurns = new Map<string, LiveTurnUsage>();

/**
 * Merge a partial mid-turn usage snapshot into the chat's live overlay.
 * Fields not provided keep their previous value; numeric fields are
 * absolute this-turn-so-far values, clamped to ≥ 0.
 */
export function updateLiveTurn(
  chatId: string,
  partial: Partial<Omit<LiveTurnUsage, "startedAt" | "updatedAt">>,
): void {
  const now = Date.now();
  const prev = liveTurns.get(chatId);
  const next: LiveTurnUsage = prev ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextTokens: 0,
    contextWindow: 0,
    numApiCalls: 0,
    startedAt: now,
    updatedAt: now,
  };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheRead",
    "cacheWrite",
    "contextTokens",
    "contextWindow",
    "numApiCalls",
  ] as const) {
    const v = partial[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      next[key] = Math.max(0, v);
    }
  }
  next.updatedAt = now;
  liveTurns.set(chatId, next);
}

/** Drop the chat's live-turn overlay (turn finished, failed, or aborted). */
export function clearLiveTurn(chatId: string): void {
  liveTurns.delete(chatId);
}

/** Read the chat's live-turn overlay, if a turn is in progress. */
export function getLiveTurn(chatId: string): LiveTurnUsage | undefined {
  return liveTurns.get(chatId);
}

/**
 * Project the persisted cumulative usage through the live overlay: token
 * totals gain the in-progress turn's so-far counts; context fill, window
 * and API-call count show the freshest known values. Returns the stored
 * usage object untouched when no turn is live.
 */
function withLiveTurn(chatId: string, usage: SessionUsage): SessionUsage {
  const live = liveTurns.get(chatId);
  if (!live) return usage;
  return {
    ...usage,
    totalInputTokens: usage.totalInputTokens + live.inputTokens,
    totalOutputTokens: usage.totalOutputTokens + live.outputTokens,
    totalCacheRead: usage.totalCacheRead + live.cacheRead,
    totalCacheWrite: usage.totalCacheWrite + live.cacheWrite,
    contextTokens: live.contextTokens || usage.contextTokens,
    contextWindow: live.contextWindow || usage.contextWindow,
    numApiCalls: live.numApiCalls || usage.numApiCalls,
  };
}

// ── Persistence lifecycle ───────────────────────────────────────────────────

/**
 * Run the one-time import of the legacy JSON store, then prime the
 * cache from SQLite. Idempotent; called once at boot.
 */
export function loadSessions(): void {
  cache.clear();
  try {
    importLegacySessions();
    for (const { chatId, session } of repo.all()) {
      cache.set(chatId, session);
    }
  } catch (err) {
    logError("sessions", "Session load failed", err);
  }
}

/**
 * Legacy shape: Record<chatId, SessionState>. Partially-shaped legacy
 * records are tolerated — normaliseSession() backfills missing fields
 * on read, exactly as it did against the JSON store.
 */
function importLegacySessions(): void {
  importLegacyJson({
    path: files.sessions,
    category: "sessions",
    what: "session(s)",
    ingest: (data) => {
      const entries: Array<{ chatId: string; session: SessionState }> = [];
      for (const [chatId, session] of Object.entries(
        (data ?? {}) as Record<string, SessionState>,
      )) {
        if (!session || typeof session !== "object" || Array.isArray(session))
          continue;
        entries.push({ chatId, session });
      }
      return repo.upsertMany(entries);
    },
  });
}

/** Commit one chat's row; storage failure must never break a turn. */
function persist(chatId: string, session: SessionState): void {
  try {
    repo.upsert(chatId, session);
  } catch (err) {
    logError(
      "sessions",
      `Failed to persist sessions chat=${chatId}${dbErrorFields(err)}`,
      err,
    );
    recordError(
      `Session save failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ── Core operations ─────────────────────────────────────────────────────────

function addLatency(agg: MetricsLatencyAgg, value: number): void {
  if (!Number.isFinite(value)) return;
  agg.count += 1;
  agg.sumMs += value;
  agg.minMs = Math.min(agg.minMs, value);
  agg.maxMs = Math.max(agg.maxMs, value);
}

function addCounters(
  target: MetricsCounterSet,
  delta: Partial<MetricsCounterSet>,
): void {
  for (const [key, value] of Object.entries(delta) as Array<
    [keyof MetricsCounterSet, number | undefined]
  >) {
    if (typeof value === "number" && Number.isFinite(value))
      target[key] += value;
  }
}

/** UTC day key (`YYYY-MM-DD`) used for daily metric buckets. */
export function todayUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function metricBucket(metrics: SessionMetrics, day: string): MetricsGrain {
  metrics.buckets[day] ??= emptyGrain();
  const days = Object.keys(metrics.buckets).sort();
  while (days.length > 30) {
    const oldest = days.shift();
    if (oldest) delete metrics.buckets[oldest];
  }
  return metrics.buckets[day]!;
}

/**
 * Normalise a session state object in-place. Migrates fields that
 * pre-date later schema additions (response timing, context fill,
 * etc.) without rewriting the persisted record.
 */
function normaliseSession(session: SessionState): SessionState {
  if (!session.usage) session.usage = emptyUsage();
  // Metrics blobs are normalised once when rows are hydrated
  // (sessions-repo parseMetrics); here only backfill pre-metrics records.
  if (!session.metrics) session.metrics = emptyMetrics();
  if (!session.createdAt) session.createdAt = session.lastActive;
  if (session.usage.totalResponseMs === undefined)
    session.usage.totalResponseMs = 0;
  if (session.usage.lastResponseMs === undefined)
    session.usage.lastResponseMs = 0;
  if (
    session.usage.fastestResponseMs === undefined ||
    session.usage.fastestResponseMs === null ||
    session.usage.fastestResponseMs === 0
  )
    session.usage.fastestResponseMs = Infinity;
  if (session.usage.contextTokens === undefined)
    session.usage.contextTokens = 0;
  if (session.usage.contextWindow === undefined)
    session.usage.contextWindow = 0;
  if (session.usage.numApiCalls === undefined) session.usage.numApiCalls = 0;
  return session;
}

export function getSession(chatId: string): SessionState {
  let session = cache.get(chatId);
  if (!session) {
    const now = Date.now();
    session = {
      sessionId: undefined,
      turns: 0,
      lastActive: now,
      createdAt: now,
      usage: emptyUsage(),
      metrics: emptyMetrics(),
    };
    cache.set(chatId, session);
    persist(chatId, session);
  }
  return normaliseSession(session);
}

export type SessionMetricTurn = {
  backend: string;
  durationMs: number;
  toolCalls?: number;
  toolCallsByName?: Record<string, number>;
  apiCalls?: number;
  failed?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

function foldMetricTurn(grain: MetricsGrain, turn: SessionMetricTurn): void {
  addCounters(grain.counters, {
    queries: 1,
    turnsWithTools: turn.toolCalls && turn.toolCalls > 0 ? 1 : 0,
    apiCalls: turn.apiCalls ?? 0,
    failedTurns: turn.failed ? 1 : 0,
    inputTokens: turn.usage?.inputTokens ?? 0,
    outputTokens: turn.usage?.outputTokens ?? 0,
    cacheReadTokens: turn.usage?.cacheRead ?? 0,
    cacheWriteTokens: turn.usage?.cacheWrite ?? 0,
  });
  addLatency(grain.latency, turn.durationMs);
  if (turn.toolCalls !== undefined)
    addLatency(grain.toolCallsPerTurn, turn.toolCalls);
  if (turn.apiCalls !== undefined && turn.apiCalls > 0)
    addLatency(grain.apiCallsPerTurn, turn.apiCalls);
  if (turn.usage && turn.usage.inputTokens + turn.usage.cacheRead > 0) {
    addLatency(
      grain.cacheHitPercent,
      Math.round(
        (turn.usage.cacheRead /
          (turn.usage.inputTokens + turn.usage.cacheRead)) *
          100,
      ),
    );
  }
  for (const [name, count] of Object.entries(turn.toolCallsByName ?? {})) {
    if (Number.isFinite(count))
      grain.toolCallsByName[name] = (grain.toolCallsByName[name] ?? 0) + count;
  }
  const backend = (grain.backend[turn.backend] ??= {
    ...emptyCounters(),
    latency: emptyLatency(),
  });
  addCounters(backend, {
    queries: 1,
    apiCalls: turn.apiCalls ?? 0,
    failedTurns: turn.failed ? 1 : 0,
    inputTokens: turn.usage?.inputTokens ?? 0,
    outputTokens: turn.usage?.outputTokens ?? 0,
    cacheReadTokens: turn.usage?.cacheRead ?? 0,
    cacheWriteTokens: turn.usage?.cacheWrite ?? 0,
  });
  addLatency(backend.latency, turn.durationMs);
}

export function recordSessionMetrics(
  chatId: string,
  turn: SessionMetricTurn,
  day = todayUtc(),
): void {
  const session = getSession(chatId);
  foldMetricTurn(session.metrics.lifetime, turn);
  foldMetricTurn(metricBucket(session.metrics, day), turn);
  persist(chatId, session);
}

/**
 * Fold one turn's phase timings (ms) into the session's lifetime grain and
 * today's bucket. Phases the caller could not measure are simply absent.
 */
export function recordSessionTurnPhases(
  chatId: string,
  phases: Partial<Record<TurnPhase, number>>,
  day = todayUtc(),
): void {
  const session = getSession(chatId);
  for (const grain of [
    session.metrics.lifetime,
    metricBucket(session.metrics, day),
  ]) {
    for (const phase of TURN_PHASES) {
      const value = phases[phase];
      if (value !== undefined) addLatency(grain.phases[phase], value);
    }
  }
  persist(chatId, session);
}

export function recordSessionMetricEvent(
  chatId: string,
  event: Partial<MetricsCounterSet> & {
    toolName?: string;
    backend?: string;
  },
  day = todayUtc(),
): void {
  const session = getSession(chatId);
  for (const grain of [
    session.metrics.lifetime,
    metricBucket(session.metrics, day),
  ]) {
    addCounters(grain.counters, event);
    if (event.toolName && event.toolCalls) {
      grain.toolCallsByName[event.toolName] =
        (grain.toolCallsByName[event.toolName] ?? 0) + event.toolCalls;
    }
    if (event.backend) {
      const backend = (grain.backend[event.backend] ??= {
        ...emptyCounters(),
        latency: emptyLatency(),
      });
      addCounters(backend, event);
    }
  }
  persist(chatId, session);
}

export function resetAllSessionMetrics(): void {
  for (const [chatId, session] of cache.entries()) {
    session.metrics = emptyMetrics();
    persist(chatId, session);
  }
}

export function setSessionId(chatId: string, sessionId: string): void {
  const session = getSession(chatId);
  session.sessionId = sessionId;
  persist(chatId, session);
}

export function incrementTurns(chatId: string): void {
  const session = getSession(chatId);
  session.turns += 1;
  session.lastActive = Date.now();
  persist(chatId, session);
}

export function recordUsage(
  chatId: string,
  turn: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    durationMs?: number;
    model?: string;
    /** Actual context fill from the last API call (last iteration's prompt tokens). */
    contextTokens?: number;
    /** Model context window size from SDK modelUsage. */
    contextWindow?: number;
    /** Number of agentic turns / API round-trips in this turn. */
    numApiCalls?: number;
    costUsd?: number;
  },
): void {
  // The turn is finalizing — the overlay's job is done. Clear it BEFORE
  // mutating the totals so a concurrent /status never sees the turn
  // counted twice (overlay + committed totals).
  clearLiveTurn(chatId);
  const session = getSession(chatId);
  session.usage.totalInputTokens += turn.inputTokens;
  session.usage.totalOutputTokens += turn.outputTokens;
  session.usage.totalCacheRead += turn.cacheRead;
  session.usage.totalCacheWrite += turn.cacheWrite;
  session.usage.lastPromptTokens =
    turn.inputTokens + turn.cacheRead + turn.cacheWrite;
  session.usage.contextTokens = turn.contextTokens ?? 0;
  if (
    turn.contextWindow !== undefined &&
    Number.isFinite(turn.contextWindow) &&
    turn.contextWindow > 0
  ) {
    session.usage.contextWindow = turn.contextWindow;
  }
  session.usage.numApiCalls = turn.numApiCalls ?? 0;
  if (typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd)) {
    session.usage.estimatedCostUsd += turn.costUsd;
  }
  if (turn.model) session.lastModel = turn.model;
  // A turn just ended — this is the timestamp the prompt cache ages
  // against (docs/cache-economics.md). Set on the one seam every backend
  // funnels a finished turn through, failed-but-billed turns included.
  session.lastTurnEndedAt = Date.now();
  if (turn.durationMs && turn.durationMs > 0) {
    session.usage.totalResponseMs =
      (session.usage.totalResponseMs || 0) + turn.durationMs;
    session.usage.lastResponseMs = turn.durationMs;
    const current = session.usage.fastestResponseMs;
    if (turn.durationMs < current) {
      session.usage.fastestResponseMs = turn.durationMs;
    }
  }
  persist(chatId, session);
}

export function setSessionName(chatId: string, name: string): void {
  const session = getSession(chatId);
  session.sessionName = name;
  persist(chatId, session);
}

export function setLastBotMessageId(chatId: string, messageId: number): void {
  const session = getSession(chatId);
  session.lastBotMessageId = messageId;
  persist(chatId, session);
}

export function getLastBotMessageId(chatId: string): number | undefined {
  return cache.get(chatId)?.lastBotMessageId;
}

function removeSessionRow(chatId: string): void {
  cache.delete(chatId);
  clearLiveTurn(chatId);
  try {
    repo.remove(chatId);
  } catch (err) {
    logError(
      "sessions",
      `Failed to delete session row chat=${chatId}${dbErrorFields(err)}`,
      err,
    );
    recordError(
      `Session delete failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ── Replaced-session archive ───────────────────────────────────────────────

/** A backend session id a reset replaced — kept so it can be re-linked. */
export type ArchivedSession = {
  chatId: string;
  sessionId: string;
  /** Why the session was replaced ("reset", "backend-unavailable", …). */
  reason: string;
  /** When it was replaced (ms epoch). */
  at: number;
  turns: number;
  lastModel?: string;
  sessionName?: string;
};

const SESSION_ARCHIVE_KEY = "sessions.archive";
/** Newest entries kept; the transcripts themselves stay on disk regardless. */
const SESSION_ARCHIVE_MAX = 500;

/**
 * Remember a session id that is about to be dropped. A reset used to
 * forget it outright, leaving the backend transcript on disk with nothing
 * pointing at it; with the id kept, a chat reset by mistake (or by a boot
 * reconcile) can be re-linked to its old conversation. Never throws.
 */
function archiveSessionId(entry: ArchivedSession): void {
  try {
    const prior = kvGet<ArchivedSession[]>(SESSION_ARCHIVE_KEY);
    const list = Array.isArray(prior) ? prior : [];
    list.push(entry);
    kvSet(SESSION_ARCHIVE_KEY, list.slice(-SESSION_ARCHIVE_MAX));
  } catch (err) {
    logError("sessions", `Failed to archive session chat=${entry.chatId}`, err);
  }
}

/** Archived (replaced) session ids, oldest first; one chat's when given. */
export function getArchivedSessions(chatId?: string): ArchivedSession[] {
  const list = kvGet<ArchivedSession[]>(SESSION_ARCHIVE_KEY);
  if (!Array.isArray(list)) return [];
  return chatId ? list.filter((e) => e.chatId === chatId) : list;
}

/**
 * Reset the chat's conversation state (backend session id, turns, usage)
 * while carrying its metrics forward. Resets fire on /new, model switches
 * and error recovery — none of which should erase the chat's accounting
 * history (that's what makes per-session metrics survive anything short
 * of deleting the chat). Use deleteSession() to drop the chat entirely.
 *
 * The replaced backend session id is archived (see getArchivedSessions),
 * never just discarded. Talon's own chat history is untouched: clearing
 * it is a separate, explicit call.
 */
export function resetSession(chatId: string, reason = "reset"): void {
  const session = cache.get(chatId);
  const turns = session?.turns ?? 0;
  const name = session?.sessionName;
  const metrics = session?.metrics;
  if (session?.sessionId) {
    archiveSessionId({
      chatId,
      sessionId: session.sessionId,
      reason,
      at: Date.now(),
      turns,
      ...(session.lastModel ? { lastModel: session.lastModel } : {}),
      ...(name ? { sessionName: name } : {}),
    });
  }
  removeSessionRow(chatId);
  const hasHistory =
    metrics &&
    (metrics.lifetime.counters.queries > 0 ||
      metrics.lifetime.counters.toolCalls > 0);
  if (hasHistory) {
    const now = Date.now();
    const fresh: SessionState = {
      sessionId: undefined,
      turns: 0,
      lastActive: now,
      createdAt: now,
      usage: emptyUsage(),
      metrics,
    };
    cache.set(chatId, fresh);
    persist(chatId, fresh);
  }
  log(
    "sessions",
    `[${chatId}] Reset${name ? ` "${name}"` : ""} (${turns} turns)`,
  );
}

/** Drop the chat entirely — row, cache, live overlay and metrics. */
export function deleteSession(chatId: string): void {
  const session = cache.get(chatId);
  const turns = session?.turns ?? 0;
  const name = session?.sessionName;
  removeSessionRow(chatId);
  log(
    "sessions",
    `[${chatId}] Deleted${name ? ` "${name}"` : ""} (${turns} turns)`,
  );
}

export type SessionInfo = {
  sessionId: string | undefined;
  turns: number;
  lastActive: number;
  createdAt: number;
  usage: SessionUsage;
  metrics: SessionMetrics;
  sessionName?: string;
  lastModel?: string;
  /** True when a turn is currently streaming and `usage` includes its live so-far counts. */
  turnInProgress?: boolean;
  /**
   * When this chat's last turn finished (ms epoch), or undefined when none
   * has. `/status` reports the idle gap from it; `lastActive` can't stand in
   * because any session write moves that.
   */
  lastTurnEndedAt?: number;
};

export function getSessionInfo(chatId: string): SessionInfo {
  const session = cache.get(chatId);
  return {
    sessionId: session?.sessionId,
    turns: session?.turns ?? 0,
    lastActive: session?.lastActive ?? 0,
    createdAt: session?.createdAt ?? 0,
    usage: withLiveTurn(chatId, session?.usage ?? emptyUsage()),
    metrics: session?.metrics ?? emptyMetrics(),
    sessionName: session?.sessionName,
    lastModel: session?.lastModel,
    turnInProgress: liveTurns.has(chatId),
    lastTurnEndedAt: session?.lastTurnEndedAt,
  };
}

export function getActiveSessionCount(): number {
  return cache.size;
}

/** Get all chat IDs with active sessions and their info. */
export function getAllSessions(): Array<{ chatId: string; info: SessionInfo }> {
  return [...cache.entries()].map(([chatId, session]) => ({
    chatId,
    info: {
      sessionId: session.sessionId,
      turns: session.turns,
      lastActive: session.lastActive,
      createdAt: session.createdAt,
      usage: withLiveTurn(chatId, session.usage ?? emptyUsage()),
      metrics: session.metrics ?? emptyMetrics(),
      sessionName: session.sessionName,
      lastModel: session.lastModel,
      turnInProgress: liveTurns.has(chatId),
      lastTurnEndedAt: session.lastTurnEndedAt,
    },
  }));
}
