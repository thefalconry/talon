/**
 * The phases every chat turn runs once its SDK stream loop has ended.
 *
 * Each backend handler owns its options build, its `for await` loop and
 * its event translation — everything that depends on the SDK's shape.
 * What comes after is the same four steps in every backend:
 *
 *   1. `accountTurn` — per-turn metrics, session id, session usage
 *      (or `accountFailedTurn` on the terminal-failure path).
 *   2. `nameSessionFromFirstMessage` — the session title.
 *   3. `enforceTrailingProse` — the tool-only delivery contract and the
 *      flow-violation re-prompt decision.
 *   4. `finishCallbackTurn` — the delivery summary log lines and the
 *      `QueryResult` (the event-stream tail is `result-events.ts`).
 *
 * The functions take the stream state and explicit config bits and return
 * explicit results; the handler decides what to do with a retry decision
 * because recursion is the handler's own entry point.
 */

import {
  getSession,
  recordUsage,
  setSessionId,
  setSessionName,
} from "../../../storage/sessions.js";
import { log } from "../../../util/log.js";
import { extractSessionName } from "../../../core/weaver/session-name.js";
import {
  recordBackendRunSuccess,
  recordBackendRunUsage,
} from "../../../core/engine/backend-router/index.js";
import { traceMessage } from "../../../util/trace.js";
import {
  FLOW_VIOLATION_MAX_RETRIES,
  detectFlowViolation,
  type FlowViolationResult,
} from "./flow-violation.js";
import type { QueryResult } from "./handler-types.js";
import {
  recordFailedTurnAccounting,
  recordFlowViolation,
  recordTurnMetrics,
} from "../metrics.js";
import type { StreamState } from "./stream-state.js";
import { summarizeUsage, type TokenUsageSnapshot } from "../usage.js";

// ── Usage snapshot ──────────────────────────────────────────────────────────

/** The slice of a stream state the post-loop phases read. */
export type TurnUsageState = Pick<
  StreamState,
  | "sdkInputTokens"
  | "sdkOutputTokens"
  | "sdkCacheRead"
  | "sdkCacheWrite"
  | "toolCalls"
  | "numApiCalls"
  | "contextTokens"
  | "contextWindow"
>;

/** The turn's token totals as the metrics + session layers consume them. */
export function turnUsageSnapshot(state: TurnUsageState): TokenUsageSnapshot {
  return {
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
  };
}

// ── Phase 1: accounting ─────────────────────────────────────────────────────

/** Context-fill fields persisted alongside the token totals. */
type TurnContextUsage = {
  contextTokens?: number;
  contextWindow?: number;
  numApiCalls?: number;
  costUsd?: number;
};

export type AccountTurnInputs = {
  chatId: string;
  /** Backend id — the `backend.<id>.*` metric dimension. */
  backend: string;
  state: TurnUsageState;
  durationMs: number;
  model: string;
  /** Provider session id to persist; skipped when absent or unchanged. */
  sessionId?: string;
  /** True when the turn ended in a delivered failure (Codex `turn.failed`). */
  failed?: boolean;
  /** Override for backends that count tool calls outside the stream state. */
  toolCalls?: number;
  /**
   * Context-fill fields for `recordUsage`. Only backends whose stream
   * reports them pass this; the others leave the session's context
   * display untouched (zeroed) as they always have.
   */
  context?: TurnContextUsage;
};

/**
 * Record the per-turn metric rollup, persist the provider session id and
 * fold the turn's usage into the session. Each write is independent, so
 * the order here is not load-bearing.
 */
export function accountTurn(inputs: AccountTurnInputs): void {
  const { chatId, state, durationMs } = inputs;
  const usage = turnUsageSnapshot(state);
  recordTurnMetrics({
    chatId,
    backend: inputs.backend,
    durationMs,
    toolCalls: inputs.toolCalls ?? state.toolCalls,
    apiCalls: state.numApiCalls,
    ...(inputs.failed !== undefined ? { failed: inputs.failed } : {}),
    usage,
  });
  persistSessionId(chatId, inputs.sessionId);
  // The plan-aware router's local ledger: every backend accumulates one, so
  // a provider with no account API still has a headroom signal. Backends
  // that DO report a plan simply outrank their own ledger.
  recordBackendRunUsage(inputs.backend, usage);
  // A chat turn that completed is proof the backend works: close its
  // breaker so background work may route there again.
  if (!inputs.failed) recordBackendRunSuccess(inputs.backend);
  recordUsage(chatId, {
    ...usage,
    durationMs,
    model: inputs.model,
    ...inputs.context,
  });
}

function persistSessionId(chatId: string, sessionId: string | undefined): void {
  if (!sessionId) return;
  if (getSession(chatId).sessionId === sessionId) return;
  setSessionId(chatId, sessionId);
}

export type AccountFailedTurnInputs = {
  chatId: string;
  backend: string;
  state: TurnUsageState;
  durationMs: number;
  model: string;
  /** Overrides for backends that count outside the stream state. */
  toolCalls?: number;
  apiCalls?: number;
  usage?: TokenUsageSnapshot;
};

/**
 * Terminal-failure accounting from the stream state — the tokens a
 * failed turn burned still count. Not for retry paths: the recursive
 * attempt accounts for itself.
 */
export function accountFailedTurn(inputs: AccountFailedTurnInputs): void {
  const { state } = inputs;
  recordFailedTurnAccounting({
    backend: inputs.backend,
    chatId: inputs.chatId,
    durationMs: inputs.durationMs,
    toolCalls: inputs.toolCalls ?? state.toolCalls,
    apiCalls: inputs.apiCalls ?? state.numApiCalls,
    model: inputs.model,
    usage: inputs.usage ?? turnUsageSnapshot(state),
    contextTokens: state.contextTokens,
    contextWindow: state.contextWindow,
  });
}

// ── Phase 2: session name ───────────────────────────────────────────────────

/**
 * Title the session from the user's first message. Skipped on retries,
 * whose `text` is a synthetic reminder rather than what the user said.
 */
export function nameSessionFromFirstMessage(inputs: {
  chatId: string;
  text: string;
  previousTurns: number;
  isRetry?: boolean;
}): void {
  if (inputs.previousTurns !== 0 || inputs.isRetry) return;
  const name = extractSessionName(inputs.text);
  if (name) setSessionName(inputs.chatId, name);
}

// ── Phase 3: trailing-prose contract ────────────────────────────────────────

export type TrailingProseInputs = {
  chatId: string;
  state: Pick<
    StreamState,
    "lastTrailingText" | "turnTerminated" | "deliveredTextNorms" | "toolCalls"
  >;
  /** Synthetic flow-violation retries already spent on this message. */
  flowRetries: number;
  /** Frontend-aware reminder; omit for the default telegram-shaped text. */
  reminder?: string;
};

/**
 * Apply the tool-only delivery contract to a finished turn: detect a
 * flow violation, count it, log it, and say whether the handler should
 * re-prompt with `reminder`. Callers gate this on the contract actually
 * being in force (a messaging frontend with delivery tools registered).
 */
export function enforceTrailingProse(
  inputs: TrailingProseInputs,
): FlowViolationResult {
  const { chatId, state, flowRetries } = inputs;
  const violation = detectFlowViolation({
    trailingText: state.lastTrailingText,
    turnTerminated: state.turnTerminated,
    deliveredTextNorms: state.deliveredTextNorms,
    toolCalls: state.toolCalls,
    retried: flowRetries > 0,
    retryCount: flowRetries,
    maxRetries: FLOW_VIOLATION_MAX_RETRIES,
    ...(inputs.reminder !== undefined ? { reminder: inputs.reminder } : {}),
  });
  if (!violation.violated) return violation;

  recordFlowViolation(
    chatId,
    violation.shouldRetry ? "retried" : "cap_exhausted",
  );
  log(
    "agent",
    `[${chatId}] flow violation: ${violation.reason}. ${
      violation.shouldRetry
        ? "Re-prompting with reminder."
        : `Retry cap (${FLOW_VIOLATION_MAX_RETRIES}) exhausted — accepting silent drop.`
    }`,
  );
  return violation;
}

// ── Phase 4: result ─────────────────────────────────────────────────────────

export type FinishCallbackTurnInputs = {
  chatId: string;
  state: TurnUsageState &
    Pick<StreamState, "turnTerminated" | "deliveredTextNorms">;
  responseText: string;
  durationMs: number;
  setupMs: number;
  turnMs: number;
  /** `routeDelivery`'s decision, or a backend's own route (`silent`). */
  delivery: { route: string; chars: number };
  /** Extra `key=value` diagnostics appended to the summary line. */
  detail?: string;
};

/**
 * The end-of-turn log lines and trace for a callback-shaped handler, and
 * the `QueryResult` it returns.
 */
export function finishCallbackTurn(
  inputs: FinishCallbackTurnInputs,
): QueryResult {
  const { chatId, state, responseText, durationMs, delivery } = inputs;
  const usage = turnUsageSnapshot(state);
  log(
    "agent",
    `[${chatId}] delivery: ${delivery.route} (${delivery.chars} chars)`,
  );
  log(
    "agent",
    `[${chatId}] -> (${summarizeUsage(usage, {
      durationMs,
      toolCalls: state.toolCalls,
    })} terminator=${state.turnTerminated ? "yes" : "no"} ` +
      `delivered=${state.deliveredTextNorms.length} ` +
      `respLen=${responseText.length} ` +
      `setup=${inputs.setupMs}ms turn=${inputs.turnMs}ms` +
      `${inputs.detail ? ` ${inputs.detail}` : ""})`,
  );
  traceMessage(chatId, "out", responseText, {
    durationMs,
    toolCalls: state.toolCalls,
  });
  return { text: responseText, durationMs, ...usage };
}
