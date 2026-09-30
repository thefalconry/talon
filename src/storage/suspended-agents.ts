/**
 * Suspended sub-agents — the hand-over between a daemon that is shutting
 * down with agents still running and the successor that resumes them.
 *
 * Written once, at the start of a graceful shutdown (core/agents/runner.ts
 * `suspendAgents`); claimed once, at boot (`resumeSuspendedAgents`). The
 * claim reads and deletes in one transaction, so a row is resumed at most
 * once per restart generation — a successor that crashes mid-boot cannot
 * replay it into a loop.
 *
 * The run spec is stored as one JSON document: it is only ever read back
 * whole, by the module that wrote it. A row that no longer parses is
 * logged and skipped rather than thrown into the boot path.
 */

import * as repo from "./repositories/suspended-agents-repo.js";
import { dbErrorFields } from "./db.js";
import { logError } from "../util/log.js";

/** Where a suspended agent's report goes — mirrors `AgentParent`. */
export type SuspendedAgentParent =
  | {
      readonly kind: "chat";
      readonly chatId: string;
      readonly numericChatId: number;
    }
  | { readonly kind: "agent"; readonly agentId: string };

/** Everything a successor needs to put an interrupted agent back to work. */
export interface SuspendedAgent {
  readonly id: string;
  readonly label: string;
  readonly brief: string;
  readonly parent: SuspendedAgentParent;
  readonly backendId: string;
  /** The model the interrupted run resolved to, when it got that far. */
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** The run's full wall-clock cap. */
  readonly timeoutMs: number;
  /** Wall-clock the interrupted run had already spent against that cap. */
  readonly elapsedMs: number;
  readonly preflight: boolean;
  readonly depth: number;
  readonly suspendedAt: number;
  /** How many times this agent has already been resumed. */
  readonly resumes: number;
  /** Undrained mailbox messages, oldest first. */
  readonly inbox: readonly { from: string; text: string; at: number }[];
}

/**
 * Persist the agents a shutdown is about to abort. Returns whether the
 * write landed — a failure logs (with the SQLite result code) and never
 * throws, because shutdown must go on regardless.
 */
export function saveSuspendedAgents(
  agents: readonly SuspendedAgent[],
): boolean {
  if (agents.length === 0) return true;
  try {
    repo.upsertAll(
      agents.map((agent) => ({
        id: agent.id,
        depth: agent.depth,
        suspended_at: agent.suspendedAt,
        spec: JSON.stringify(agent),
      })),
    );
    return true;
  } catch (err) {
    logError(
      "agents",
      `Failed to persist ${agents.length} suspended agent(s)${dbErrorFields(err)}`,
      err,
    );
    return false;
  }
}

/**
 * Take every suspended agent, parents before children, removing them in
 * the same transaction. Empty on a storage failure.
 */
export function claimSuspendedAgents(): SuspendedAgent[] {
  let rows: repo.SuspendedAgentRow[];
  try {
    rows = repo.takeAll();
  } catch (err) {
    logError(
      "agents",
      `Failed to claim suspended agents${dbErrorFields(err)}`,
      err,
    );
    return [];
  }
  const agents: SuspendedAgent[] = [];
  for (const row of rows) {
    try {
      agents.push(JSON.parse(row.spec) as SuspendedAgent);
    } catch (err) {
      logError("agents", `Corrupt suspended agent ${row.id} — skipped`, err);
    }
  }
  return agents;
}
