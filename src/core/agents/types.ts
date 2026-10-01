/**
 * Sub-agent vocabulary — the shapes the registry, runner and delivery share.
 *
 * A **sub-agent** is one isolated one-shot run that some other agent work
 * started: a chat turn delegating a job, or another sub-agent fanning out.
 * Talon owns the mechanism (not the Claude SDK's own sub-agents) so it works
 * on every backend — the run is an ordinary `runOneShotAgent` with its own
 * backend, model, workspace and tool surface.
 */

import type { ReasoningEffortLevel } from "../types.js";
import type { TaskUsage } from "../tasks/types.js";

/**
 * Lifecycle. `done` / `failed` / `killed` / `timed_out` are terminal.
 *
 * Wider than `TaskState` on purpose: a task that ran out of wall-clock is
 * indistinguishable from any other abort in the task table, but the parent
 * reading a report needs to know whether its agent was cut off.
 */
export type AgentState =
  "queued" | "running" | "done" | "failed" | "killed" | "timed_out";

/**
 * Who spawned this agent, and therefore where its report goes.
 *
 * A chat parent is woken with a synthetic turn (`source: "agent"`), exactly
 * as a trigger fires; an agent parent gets the report pushed into its
 * mailbox, which it drains with `check_inbox`.
 */
export type AgentParent =
  | {
      readonly kind: "chat";
      /** Canonical string chat id — what every store is keyed on. */
      readonly chatId: string;
      /** The frontend's numeric id, needed by the dispatcher. */
      readonly numericChatId: number;
    }
  | { readonly kind: "agent"; readonly agentId: string };

/** What an agent reports back when it finishes. */
export interface AgentResult {
  readonly summary: string;
  readonly details?: string;
}

/** One message waiting in an agent's mailbox. */
export interface AgentMessage {
  /** Chat key or agent id of the sender. */
  readonly from: string;
  readonly text: string;
  readonly at: number;
}

/** Immutable snapshot of one agent, as returned by the registry. */
export interface AgentRecord {
  readonly id: string;
  /** Short content-free name — safe for task labels, events and `talon ps`. */
  readonly label: string;
  /**
   * The brief the agent was spawned with. Kept for the run log and the
   * agent's own system prompt only — never in a task label or a bus event,
   * which are content-free by contract.
   */
  readonly brief: string;
  readonly parent: AgentParent;
  readonly backendId: string;
  /**
   * Absent only in the moment between registration and the run starting —
   * the model is whatever the backend's catalog resolved, which is an async
   * answer, while the concurrency slot must be claimed synchronously.
   */
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffortLevel;
  readonly state: AgentState;
  /** 0 for an agent spawned by a chat, +1 per generation below that. */
  readonly depth: number;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** Report tool result, else the run's last assistant text, else null. */
  readonly result: AgentResult | null;
  readonly error?: string;
  readonly usage?: TaskUsage;
  readonly taskId?: number;
  /** Ids of the agents this one spawned. */
  readonly children: readonly string[];
  /** Messages waiting to be drained by `check_inbox`. */
  readonly inboxDepth: number;
  /**
   * What the run had been doing when it settled — set on every settlement
   * the runner makes, shown to the parent when the run did not end `done`.
   */
  readonly trail?: AgentTrail;
}

/** A settled run's last interim messages, progress notes and changed files. */
export interface AgentTrail {
  /** Last `message_parent` notes, oldest first. */
  readonly messages: readonly string[];
  /** Last assistant texts, oldest first. */
  readonly notes: readonly string[];
  /** Files it wrote or edited (best-effort, from the run log). */
  readonly files: readonly string[];
}

/** What `spawnAgent` is asked for. */
export interface AgentSpawnSpec {
  readonly brief: string;
  readonly label: string;
  readonly parent: AgentParent;
  /**
   * Unset: a child of another agent inherits its parent's backend (and,
   * with no model either, its model); a top-level spawn starts from the
   * chat's backend and may be routed.
   */
  readonly backendId?: string;
  /**
   * Defaults to the parent agent's model when the backend is inherited from
   * one, else the resolved backend's own default model.
   */
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffortLevel;
  /**
   * Hard wall-clock cap. Unset = `agents.defaultTimeoutMs`, and with that
   * unset too, no cap at all — the no-progress watchdog is what ends a run
   * that has gone quiet.
   */
  readonly timeoutMs?: number;
  /**
   * Append the pre-flight lane instruction (run `npm run preflight` before
   * every push) to the brief. Resolved by the spawn tool: explicit value,
   * else on when the brief mentions a PR.
   */
  readonly preflight?: boolean;
}

/** `spawnAgent`'s answer — an error here is a tool error, never a throw. */
export type AgentSpawnOutcome =
  | {
      readonly ok: true;
      readonly agentId: string;
      readonly backendId: string;
      readonly model: string;
      /**
       * Why the router chose this backend, when it did. Absent when the
       * caller pinned one — there was no decision to explain.
       */
      readonly routing?: string;
    }
  | { readonly ok: false; readonly error: string };

/** The caps a deployment puts on sub-agent fan-out (config `agents`). */
export interface AgentCaps {
  /** Live (queued + running) agents allowed per daemon. */
  readonly maxConcurrent: number;
  /** Deepest `depth` an agent may have — 2 means chat → A → B. */
  readonly maxDepth: number;
  /** Hard timeout for a spawn that sets none. Unset = no hard timeout. */
  readonly defaultTimeoutMs?: number;
  /** Ceiling on any run's hard timeout, requested or not. Unset = none. */
  readonly maxTimeoutMs?: number;
  /**
   * No-progress watchdog step N: ping the agent after N ms of silence, warn
   * its parent after 2N, kill it after 3N. 0 disables the watchdog.
   */
  readonly stallTimeoutMs: number;
  /**
   * Backends a sub-agent may run on. Unset or empty = any backend with a
   * background capability. Enforced by `spawnAgent` on the final choice.
   */
  readonly allowedBackends?: readonly string[];
}
