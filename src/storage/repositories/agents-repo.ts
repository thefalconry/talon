/**
 * Agents repository — executes the statements in sql/agents.sql against
 * the `agents` table; no SQL text lives here. The domain side (what gets
 * written when, and the boot-time resume) is core/agents/persistence.ts.
 */

import { getDatabase } from "../db.js";
import { agentsSql } from "../sql/statements.generated.js";

/** One persisted message waiting in an agent's mailbox. */
type PersistedAgentMessage = {
  from: string;
  text: string;
  at: number;
};

/** A sub-agent as stored — everything a restart needs to bring it back. */
export type PersistedAgent = {
  id: string;
  label: string;
  brief: string;
  parentKind: "chat" | "agent";
  /** Chat key (chat parent) or agent id (agent parent). */
  parentId: string;
  /** Frontend numeric chat id — chat parents only. */
  parentNumericChatId?: number;
  backendId: string;
  model?: string;
  requestedModel?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  depth: number;
  cwd?: string;
  state: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
  sessionId?: string;
  inbox: PersistedAgentMessage[];
  reported: boolean;
  resultSummary?: string;
  resultDetails?: string;
  error?: string;
  elapsedMs: number;
  resumeCount: number;
  interruptedAt?: number;
  /** The spawn asked for the pre-flight lane instruction. */
  preflight?: boolean;
};

type Row = {
  id: string;
  label: string;
  brief: string;
  parent_kind: string;
  parent_id: string;
  parent_numeric: number | null;
  backend_id: string;
  model: string | null;
  requested_model: string | null;
  effort: string | null;
  timeout_ms: number | null;
  depth: number;
  cwd: string | null;
  state: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number;
  session_id: string | null;
  inbox_json: string;
  reported: number;
  result_summary: string | null;
  result_details: string | null;
  error: string | null;
  elapsed_ms: number;
  resume_count: number;
  interrupted_at: number | null;
  preflight: number;
};

function parseInbox(raw: string): PersistedAgentMessage[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is PersistedAgentMessage =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as { from?: unknown }).from === "string" &&
        typeof (m as { text?: unknown }).text === "string" &&
        typeof (m as { at?: unknown }).at === "number",
    );
  } catch {
    return [];
  }
}

function rowToAgent(row: Row): PersistedAgent {
  const agent: PersistedAgent = {
    id: row.id,
    label: row.label,
    brief: row.brief,
    parentKind: row.parent_kind === "agent" ? "agent" : "chat",
    parentId: row.parent_id,
    backendId: row.backend_id,
    depth: row.depth,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    inbox: parseInbox(row.inbox_json),
    reported: row.reported === 1,
    elapsedMs: row.elapsed_ms,
    resumeCount: row.resume_count,
  };
  if (row.parent_numeric !== null)
    agent.parentNumericChatId = row.parent_numeric;
  if (row.model !== null) agent.model = row.model;
  if (row.requested_model !== null) agent.requestedModel = row.requested_model;
  if (row.effort !== null) agent.reasoningEffort = row.effort;
  if (row.timeout_ms !== null) agent.timeoutMs = row.timeout_ms;
  if (row.cwd !== null) agent.cwd = row.cwd;
  if (row.started_at !== null) agent.startedAt = row.started_at;
  if (row.ended_at !== null) agent.endedAt = row.ended_at;
  if (row.session_id !== null) agent.sessionId = row.session_id;
  if (row.result_summary !== null) agent.resultSummary = row.result_summary;
  if (row.result_details !== null) agent.resultDetails = row.result_details;
  if (row.error !== null) agent.error = row.error;
  if (row.interrupted_at !== null) agent.interruptedAt = row.interrupted_at;
  if (row.preflight === 1) agent.preflight = true;
  return agent;
}

export function upsert(a: PersistedAgent): void {
  getDatabase()
    .prepare(agentsSql.upsert)
    .run(
      a.id,
      a.label,
      a.brief,
      a.parentKind,
      a.parentId,
      a.parentNumericChatId ?? null,
      a.backendId,
      a.model ?? null,
      a.requestedModel ?? null,
      a.reasoningEffort ?? null,
      a.timeoutMs ?? null,
      a.depth,
      a.cwd ?? null,
      a.state,
      a.createdAt,
      a.startedAt ?? null,
      a.endedAt ?? null,
      a.updatedAt,
      a.sessionId ?? null,
      JSON.stringify(a.inbox),
      a.reported ? 1 : 0,
      a.resultSummary ?? null,
      a.resultDetails ?? null,
      a.error ?? null,
      a.elapsedMs,
      a.resumeCount,
      a.interruptedAt ?? null,
      a.preflight ? 1 : 0,
    );
}

export function get(id: string): PersistedAgent | undefined {
  const row = getDatabase().prepare(agentsSql.get).get(id) as Row | undefined;
  return row ? rowToAgent(row) : undefined;
}

/** Rows still queued/running — interrupted by the last restart. */
export function listInterrupted(): PersistedAgent[] {
  const rows = getDatabase().prepare(agentsSql.listInterrupted).all() as Row[];
  return rows.map(rowToAgent);
}

export function remove(id: string): boolean {
  const result = getDatabase().prepare(agentsSql.remove).run(id) as {
    changes?: number;
  };
  return (result.changes ?? 0) > 0;
}

/** Delete settled rows last touched before `cutoff`. Returns how many. */
export function pruneSettled(cutoff: number): number {
  const result = getDatabase().prepare(agentsSql.pruneSettled).run(cutoff) as {
    changes?: number;
  };
  return result.changes ?? 0;
}

/** Test-only: wipe the table between suites sharing a worker DB. */
export function removeAll(): void {
  getDatabase().prepare(agentsSql.removeAll).run();
}
