/**
 * Cron repository — executes the statements in sql/cron.sql against
 * the `cron_jobs` table; no SQL text lives here. The public store
 * (storage/cron.ts) holds the domain API and validation; this
 * module owns statement execution and the row↔domain mapping.
 */

import { getDatabase } from "../db.js";
import { cronSql } from "../sql/statements.generated.js";
import type { CatchupPolicy } from "../../native/scheduler-core.js";

export type CronJobType = "message" | "query";

/** Outcome of the most recent execution — surfaced in list_cron_jobs. */
export type CronRunStatus = "ok" | "error";

export type CronJob = {
  id: string;
  chatId: string;
  /**
   * Cron expression (5-field: minute hour day month weekday). Optional — a job
   * carries EITHER `schedule` (cron mode) OR `everyMs` (interval mode), never
   * both. The store validator (`isCronJob`) enforces exactly one.
   */
  schedule?: string;
  /**
   * Fixed interval in milliseconds (interval mode). Mutually exclusive with
   * `schedule`. The job fires roughly every `everyMs` after its anchor
   * (`lastRunAt`, else `startAt`, else `createdAt`). Wires the native
   * scheduler-core interval math (next-due + missed-run catch-up) directly.
   */
  everyMs?: number;
  /** "message" sends content as text; "query" runs content as a Claude prompt with tools */
  type: CronJobType;
  /** The message text or query prompt */
  content: string;
  /** Human-readable name for the job */
  name: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  runCount: number;
  /** IANA timezone (e.g. "America/New_York"). Defaults to system timezone. */
  timezone?: string;
  /**
   * Optional model override for `query` jobs. Unset = the chat's model. `query`
   * cron jobs run as an isolated one-shot (no chat session), so unlike triggers
   * the model may be on a different provider — see `provider`.
   */
  model?: string;
  /**
   * Optional provider/backend id for the override (e.g. a cheaper provider than
   * the chat). Requires `model`. Unset = the chat's backend. Since cron runs
   * isolated, a different provider is fine here.
   */
  provider?: string;
  /**
   * Optional short brief that becomes the isolated agent's system prompt — what
   * the job is and how to do it. Useful to orient a cheaper override model.
   */
  instructions?: string;
  /**
   * Don't fire before this epoch-ms instant (a delayed start / "not before").
   * Unset = eligible immediately.
   */
  startAt?: number;
  /**
   * Don't fire after this epoch-ms instant; the job auto-disables once now
   * passes it (a natural expiry / "until"). Unset = no end.
   */
  endAt?: number;
  /**
   * Auto-disable after this many total runs (`runCount >= maxRuns`). A value of
   * 1 makes the job one-shot. Unset = unbounded.
   */
  maxRuns?: number;
  /**
   * Missed-run policy for runs that were due while Talon was down:
   *   "skip" (default) — drop them, resume on the next due tick
   *   "once"           — collapse any number of missed runs into a single catch-up
   *   "all"            — replay every missed run, capped by CATCHUP_MAX
   * Decided by the native scheduler-core `catchupRunCount`.
   */
  catchup?: CatchupPolicy;
  /** Status of the most recent execution. */
  lastStatus?: CronRunStatus;
  /** Error message from the most recent failed execution (cleared on success). */
  lastError?: string;
  /** Wall-clock duration of the most recent execution, in ms. */
  lastDurationMs?: number;
  /**
   * Hard timeout for one run of a `query` job, in ms. Unset = the scheduler
   * default (10 minutes). Long-running jobs (e.g. waiting on CI before a
   * merge) set this so they aren't aborted mid-task.
   */
  timeoutMs?: number;
};

type Row = {
  id: string;
  chat_id: string;
  name: string;
  type: string;
  content: string;
  enabled: number;
  schedule: string | null;
  every_ms: number | null;
  timezone: string | null;
  model: string | null;
  provider: string | null;
  instructions: string | null;
  start_at: number | null;
  end_at: number | null;
  max_runs: number | null;
  catchup: string | null;
  created_at: number;
  last_run_at: number | null;
  run_count: number;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  timeout_ms: number | null;
};

function rowToJob(row: Row): CronJob {
  return {
    id: row.id,
    chatId: row.chat_id,
    name: row.name,
    type: row.type as CronJobType,
    content: row.content,
    enabled: row.enabled === 1,
    schedule: row.schedule ?? undefined,
    everyMs: row.every_ms ?? undefined,
    timezone: row.timezone ?? undefined,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    instructions: row.instructions ?? undefined,
    startAt: row.start_at ?? undefined,
    endAt: row.end_at ?? undefined,
    maxRuns: row.max_runs ?? undefined,
    catchup: (row.catchup as CatchupPolicy | null) ?? undefined,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at ?? undefined,
    runCount: row.run_count,
    lastStatus: (row.last_status as CronRunStatus | null) ?? undefined,
    lastError: row.last_error ?? undefined,
    lastDurationMs: row.last_duration_ms ?? undefined,
    timeoutMs: row.timeout_ms ?? undefined,
  };
}

export function upsert(job: CronJob): void {
  getDatabase()
    .prepare(cronSql.upsert)
    .run(
      job.id,
      job.chatId,
      job.name,
      job.type,
      job.content,
      job.enabled ? 1 : 0,
      job.schedule ?? null,
      job.everyMs ?? null,
      job.timezone ?? null,
      job.model ?? null,
      job.provider ?? null,
      job.instructions ?? null,
      job.startAt ?? null,
      job.endAt ?? null,
      job.maxRuns ?? null,
      job.catchup ?? null,
      job.createdAt,
      job.lastRunAt ?? null,
      job.runCount || 0,
      job.lastStatus ?? null,
      job.lastError ?? null,
      job.lastDurationMs ?? null,
      job.timeoutMs ?? null,
    );
}

export function get(id: string): CronJob | undefined {
  const row = getDatabase().prepare(cronSql.get).get(id) as Row | undefined;
  return row ? rowToJob(row) : undefined;
}

export function listByChat(chatId: string): CronJob[] {
  const rows = getDatabase().prepare(cronSql.listByChat).all(chatId) as Row[];
  return rows.map(rowToJob);
}

export function listAll(): CronJob[] {
  const rows = getDatabase().prepare(cronSql.listAll).all() as Row[];
  return rows.map(rowToJob);
}

export function remove(id: string): boolean {
  const result = getDatabase().prepare(cronSql.remove).run(id) as {
    changes?: number;
  };
  return (result.changes ?? 0) > 0;
}

export function count(): number {
  const row = getDatabase().prepare(cronSql.count).get() as { n: number };
  return row.n;
}

/** Test-only: wipe the table between suites sharing a worker DB. */
export function removeAll(): void {
  getDatabase().prepare(cronSql.removeAll).run();
}
