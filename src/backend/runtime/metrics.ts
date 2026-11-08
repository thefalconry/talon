/**
 * Backend metric piping — one vocabulary for every backend.
 *
 * Before this module each backend hand-rolled its own counters:
 * claude-sdk and the remote-server family stripped MCP prefixes off
 * tool names, codex didn't (so `tool_calls.mcp__…` and
 * `tool_calls.send` counted the same tool twice under different
 * keys); only codex recorded per-turn tool/API histograms; and
 * openai-agents never counted flow-violation cap exhaustion. Cross-
 * backend comparisons were impossible because the names didn't line
 * up.
 *
 * ## Metric vocabulary
 *
 * Shared (no backend dimension — comparable across the fleet):
 *   - `queries_total`                      counter, one per user-visible turn
 *   - `response_latency_ms`                histogram
 *   - `tool_calls.<bare-name>`             counter, MCP prefix stripped
 *   - `tool_calls_per_turn`                histogram
 *   - `turns_with_tools_total`             counter
 *   - `api_calls_total` / `api_calls_per_turn`
 *   - `tokens.input_total` / `tokens.output_total`
 *     / `tokens.cache_read_total` / `tokens.cache_write_total`
 *   - `cache_hit_percent`                  histogram, per turn
 *   - `scratchpad.trailing_text_dropped` / `.flow_violation_retried`
 *     / `.flow_violation_cap_exhausted`
 *
 * Per-backend dimension (`backend.<id>.…`, id = BackendId):
 *   - `backend.<id>.queries`
 *   - `backend.<id>.response_latency_ms`   histogram
 *   - `backend.<id>.tool_calls`
 *   - `backend.<id>.turn_failed`
 *   - `backend.<id>.tokens.input` / `.output` / `.cache_read` / `.cache_write`
 *   - `backend.<id>.cache_hit_percent`     histogram
 *
 * Keep names LOW-CARDINALITY: the metrics store caps total keys at
 * 500. Tool names are bounded by the tool catalog; backend ids by the
 * registry. Never interpolate chat ids, model ids, or user input.
 */

import { stripMcpPrefix } from "../../core/tools/index.js";
import type { TokenUsageSnapshot } from "./usage.js";
import {
  clearLiveTurn,
  recordSessionMetricEvent,
  recordSessionMetrics,
  recordUsage,
} from "../../storage/sessions.js";

/**
 * Count one tool call. `toolName` may be raw from any backend —
 * MCP-prefixed (`mcp__telegram-tools__send`), server-prefixed
 * (`talon-tools-123_send`), or bare — it is normalised so every
 * backend lands on the same `tool_calls.<bare>` key.
 */
export function recordToolCall(
  chatId: string,
  toolName: string,
  backend?: string,
): void {
  recordSessionMetricEvent(chatId, {
    toolCalls: 1,
    toolName: stripMcpPrefix(toolName),
    backend,
  });
}

/** Per-turn rollup recorded once at the end of every chat turn. */
export type TurnMetricInputs = {
  chatId: string;
  /** Backend id, e.g. "claude", "codex", "kilo", "openai-agents", "opencode". */
  backend: string;
  durationMs: number;
  /** Tool calls observed this turn (omit when the backend can't count them). */
  toolCalls?: number;
  /** Upstream API calls this turn (omit when unknown). */
  apiCalls?: number;
  /** True when the turn ended in a delivered failure. */
  failed?: boolean;
  /**
   * Token usage for the turn — the same snapshot handlers persist via
   * `recordUsage()`. Omit when the backend can't report usage.
   */
  usage?: TokenUsageSnapshot;
};

/** Record the uniform per-turn metric set. */
export function recordTurnMetrics(inputs: TurnMetricInputs): void {
  recordSessionMetrics(inputs.chatId, inputs);
}

/**
 * Terminal-failure accounting — call right before re-throwing a turn
 * that exhausted its retries.
 *
 * A failed turn still burned tokens. Without this, they vanish from
 * /status and /metrics, latency histograms sample only successes, and
 * the live-turn overlay leaks until the next turn. One call covers all
 * three:
 *
 *   - per-turn metrics with `failed: true` (also feeds
 *     `backend.<id>.turn_failed`)
 *   - session usage, but only when the stream actually reported tokens —
 *     an all-zero recordUsage would wipe the context display for no
 *     benefit
 *   - the live-turn overlay is always cleared
 *
 * NOT for retry paths: when a turn is retried, the recursive attempt
 * does its own accounting and this helper must not run for the outer
 * attempt (it would double-count the query).
 */
export function recordFailedTurnAccounting(inputs: {
  backend: string;
  chatId: string;
  durationMs: number;
  toolCalls?: number;
  apiCalls?: number;
  model?: string;
  usage: TokenUsageSnapshot;
  contextTokens?: number;
  contextWindow?: number;
}): void {
  recordTurnMetrics({
    chatId: inputs.chatId,
    backend: inputs.backend,
    durationMs: inputs.durationMs,
    toolCalls: inputs.toolCalls,
    apiCalls: inputs.apiCalls,
    failed: true,
    usage: inputs.usage,
  });
  const u = inputs.usage;
  const sawUsage =
    u.inputTokens + u.outputTokens + u.cacheRead + u.cacheWrite > 0;
  if (sawUsage) {
    recordUsage(inputs.chatId, {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      durationMs: inputs.durationMs,
      model: inputs.model,
      contextTokens: inputs.contextTokens || undefined,
      contextWindow: inputs.contextWindow,
      numApiCalls: inputs.apiCalls || undefined,
    });
  } else {
    // recordUsage clears the overlay itself; cover the zero-usage path.
    clearLiveTurn(inputs.chatId);
  }
}

/**
 * Record a flow violation (prose written without a delivery tool).
 * Always counts the dropped text; the outcome picks the second
 * counter. Centralised so every backend counts cap exhaustion — "how
 * often do models ignore the reminder" needs both halves.
 */
export function recordFlowViolation(
  chatId: string,
  outcome: "retried" | "cap_exhausted",
): void {
  recordSessionMetricEvent(chatId, {
    trailingTextDropped: 1,
    flowViolationRetries: outcome === "retried" ? 1 : 0,
    flowViolationCapExhausted: outcome === "cap_exhausted" ? 1 : 0,
  });
}
