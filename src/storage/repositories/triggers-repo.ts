/**
 * Triggers repository — executes the statements in sql/triggers.sql
 * against the `triggers` table; no SQL text lives here. The public
 * store (storage/triggers.ts) holds the domain API, validation
 * and the on-disk script/log handling; this module owns statement
 * execution and the row↔domain mapping.
 */

import { getDatabase } from "../db.js";
import { triggersSql } from "../sql/statements.generated.js";
export type TriggerLanguage = "bash" | "python" | "node" | "lua";

/**
 * Where a trigger's wake-ups run.
 *   - "chat"     — resume the chat session (default; sees full history).
 *   - "isolated" — a fresh one-shot job per wake (cron `query` executor):
 *                  own session, no chat history, optional brief/provider.
 */
type TriggerWakeMode = "chat" | "isolated";

export type TriggerStatus =
  | "pending" // created, not yet spawned (transient)
  | "running" // child process alive
  | "fired" // exited 0 — fired final wake message
  | "errored" // exited non-zero — fired error wake message
  | "cancelled" // killed by user (trigger_cancel)
  | "timed_out" // killed by hard timeout
  | "terminated"; // killed by Talon shutdown / restart

export type Trigger = {
  id: string;
  chatId: string;
  numericChatId: number;
  name: string;
  language: TriggerLanguage;
  /** Absolute path to the script body on disk. */
  scriptPath: string;
  /** Absolute path to the run log (interleaved stdout+stderr). */
  logPath: string;
  description?: string;
  status: TriggerStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** PID of the child process while running (cleared on exit). */
  pid?: number;
  /** Linux /proc/<pid>/stat field 22 (start time in jiffies) captured at
   *  spawn. Used by killOrphan to defend against PID reuse — start time is
   *  monotonic per boot and unchanged by exec(), so a match guarantees the
   *  current owner of the PID is the same process we spawned. Undefined on
   *  non-Linux platforms. */
  pidStarttime?: number;
  /** Hard timeout in seconds. Default 24h, max 7d. */
  timeoutSeconds: number;
  /** Exit code on terminal status. */
  exitCode?: number;
  /** Total wake-ups fired for this trigger — sum of mid-run TALON_FIRE: lines
   *  plus the terminal exit fire. Incremented every time fireWake() runs. */
  fireCount: number;
  lastFireAt?: number;
  /** Truncated tail of the most recent fire payload (for diagnostics). */
  lastFirePayload?: string;
  lastError?: string;
  /** If true, the trigger is respawned on Talon startup if it was still
   *  active when Talon went down. Triggers in any terminal state
   *  (fired/errored/cancelled) are NOT respawned — only ones interrupted
   *  by Talon shutdown or crash. (Persistent triggers have no hard timeout,
   *  so timed_out is unreachable for them — see spawnTrigger.) */
  persistent?: boolean;
  /**
   * Optional model override for the wake-up turn — a model id valid on the
   * chat's own backend. Unset = inherit the chat's model (preferred). When set,
   * the fired wake-up runs on this (typically cheaper) model instead, while
   * still resuming the chat session (restricted to the same backend so
   * continuity is preserved).
   */
  model?: string;
  /** Wake routing; unset = "chat". See {@link TriggerWakeMode}. */
  wakeMode?: TriggerWakeMode;
  /** Isolated mode: system brief for each wake run (e.g. "follow skill X"). */
  instructions?: string;
  /** Isolated mode: backend/provider override (requires `model`). */
  provider?: string;
  /** Isolated mode: hard limit per wake run, in ms. Unset = 10 min. */
  wakeTimeoutMs?: number;
};

type Row = {
  id: string;
  chat_id: string;
  numeric_chat_id: number;
  name: string;
  language: string;
  script_path: string;
  log_path: string;
  description: string | null;
  status: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  pid: number | null;
  pid_starttime: number | null;
  timeout_seconds: number;
  exit_code: number | null;
  fire_count: number;
  last_fire_at: number | null;
  last_fire_payload: string | null;
  last_error: string | null;
  persistent: number;
  model: string | null;
  wake_mode: string | null;
  wake_instructions: string | null;
  wake_provider: string | null;
  wake_timeout_ms: number | null;
};

function rowToTrigger(row: Row): Trigger {
  return {
    id: row.id,
    chatId: row.chat_id,
    numericChatId: row.numeric_chat_id,
    name: row.name,
    language: row.language as TriggerLanguage,
    scriptPath: row.script_path,
    logPath: row.log_path,
    description: row.description ?? undefined,
    status: row.status as TriggerStatus,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    pid: row.pid ?? undefined,
    pidStarttime: row.pid_starttime ?? undefined,
    timeoutSeconds: row.timeout_seconds,
    exitCode: row.exit_code ?? undefined,
    fireCount: row.fire_count,
    lastFireAt: row.last_fire_at ?? undefined,
    lastFirePayload: row.last_fire_payload ?? undefined,
    lastError: row.last_error ?? undefined,
    persistent: row.persistent === 1 ? true : undefined,
    model: row.model ?? undefined,
    wakeMode: row.wake_mode === "isolated" ? "isolated" : undefined,
    instructions: row.wake_instructions ?? undefined,
    provider: row.wake_provider ?? undefined,
    wakeTimeoutMs: row.wake_timeout_ms ?? undefined,
  };
}

export function upsert(t: Trigger): void {
  getDatabase()
    .prepare(triggersSql.upsert)
    .run(
      t.id,
      t.chatId,
      t.numericChatId,
      t.name,
      t.language,
      t.scriptPath,
      t.logPath,
      t.description ?? null,
      t.status,
      t.createdAt,
      t.startedAt ?? null,
      t.endedAt ?? null,
      t.pid ?? null,
      t.pidStarttime ?? null,
      t.timeoutSeconds,
      t.exitCode ?? null,
      t.fireCount || 0,
      t.lastFireAt ?? null,
      t.lastFirePayload ?? null,
      t.lastError ?? null,
      t.persistent ? 1 : 0,
      t.model ?? null,
      t.wakeMode === "isolated" ? "isolated" : null,
      t.instructions ?? null,
      t.provider ?? null,
      t.wakeTimeoutMs ?? null,
    );
}

export function get(id: string): Trigger | undefined {
  const row = getDatabase().prepare(triggersSql.get).get(id) as Row | undefined;
  return row ? rowToTrigger(row) : undefined;
}

export function getByName(chatId: string, name: string): Trigger | undefined {
  const row = getDatabase().prepare(triggersSql.getByName).get(chatId, name) as
    Row | undefined;
  return row ? rowToTrigger(row) : undefined;
}

export function listByChat(chatId: string): Trigger[] {
  const rows = getDatabase()
    .prepare(triggersSql.listByChat)
    .all(chatId) as Row[];
  return rows.map(rowToTrigger);
}

export function listAll(): Trigger[] {
  const rows = getDatabase().prepare(triggersSql.listAll).all() as Row[];
  return rows.map(rowToTrigger);
}

export function remove(id: string): boolean {
  const result = getDatabase().prepare(triggersSql.remove).run(id) as {
    changes?: number;
  };
  return (result.changes ?? 0) > 0;
}

/**
 * Restart recovery, both halves (see loadTriggers): returns how many
 * non-persistent triggers were terminated and how many persistent ones
 * were parked in 'pending' for resumeAfterRestart to respawn.
 */
export function recoverInterrupted(now: number): {
  terminated: number;
  parked: number;
} {
  const db = getDatabase();
  const terminated = db.prepare(triggersSql.terminateInterrupted).run(now) as {
    changes?: number;
  };
  const parked = db.prepare(triggersSql.parkInterruptedPersistent).run() as {
    changes?: number;
  };
  return {
    terminated: terminated.changes ?? 0,
    parked: parked.changes ?? 0,
  };
}

export function count(): number {
  const row = getDatabase().prepare(triggersSql.count).get() as { n: number };
  return row.n;
}

/** Test-only: wipe the table between suites sharing a worker DB. */
export function removeAll(): void {
  getDatabase().prepare(triggersSql.removeAll).run();
}
