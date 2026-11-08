/**
 * Typed stream processing helpers for SDK messages.
 *
 * Each function operates on a properly narrowed SDK message type —
 * no Record<string, unknown> casts. StreamState is the turn's single
 * accumulator.
 */

import type {
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
  ModelUsage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BetaRawContentBlockDeltaEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import { STREAM_INTERVAL } from "./constants.js";
import { log } from "../../util/log.js";
import { checkModelDrift } from "./model-drift.js";
import {
  turnCacheStats,
  type TurnCacheStats,
} from "../runtime/cache/cache-telemetry.js";
import { recordCompactBoundary } from "../runtime/cache/cache-metrics.js";

// ── Stream state accumulator ────────────────────────────────────────────────

/** Mutable state accumulated while iterating the SDK message stream. */
export type StreamState = {
  currentBlockText: string;
  allResponseText: string;
  newSessionId: string | undefined;
  toolCalls: number;
  contextTokens: number;
  contextWindow: number | undefined;
  numApiCalls: number;
  sdkInputTokens: number;
  sdkOutputTokens: number;
  sdkCacheRead: number;
  sdkCacheWrite: number;
  /** Cost of this turn in USD, as reported by the result message. */
  costUsd: number;
  /**
   * Per-turn cache behaviour derived from the result message's per-request
   * `usage.iterations`. Undefined when the provider reported none — the
   * aggregate totals above cannot distinguish a turn that read the previous
   * turn's prefix from one that re-wrote it, and that distinction is the
   * whole cost signal (see runtime/cache/cache-telemetry.ts).
   */
  cacheStats: TurnCacheStats | undefined;
  lastStreamUpdate: number;
  /**
   * Trailing text from the most recent assistant message — text after all
   * tool_use blocks (or the full text when no tools were called). NOT
   * delivered to the user (the output stream is private scratchpad by
   * contract). Tracked so the handler can log a diagnostic when the model
   * wrote prose without routing it through `end_turn` / `send` — surfaces
   * missed end_turn calls in metrics rather than silently dropping content.
   */
  lastTrailingText: string;
  /**
   * Normalized text args observed on `end_turn` / `send(type="text")` tool
   * calls during this turn. Cross-tool dedup: if both fire with similar
   * content (e.g. model calls both with the same text mid-turn), the
   * second one can be matched against this list to avoid the user seeing
   * the same message twice. Also used to silence the trailing-prose
   * diagnostic when the prose just duplicates what was already delivered.
   */
  deliveredTextNorms: string[];
  /**
   * Set when a tool with `endsTurn: true` (e.g. `end_turn`) was observed
   * in this turn. Once true, the handler invokes `qi.interrupt()` to abort
   * the SDK loop cleanly — the model can't produce more trailing scratchpad
   * after this point. Also gates the flow-violation re-prompt: if the model
   * explicitly ended its turn, we don't re-prompt for trailing prose that
   * may have appeared in the same assistant message before the terminator.
   */
  turnTerminated: boolean;
  /**
   * Per-token text chunks accumulated since the last throttled flush.
   * Drained into a `text_delta` event when `processStreamDelta` decides
   * the throttle interval has elapsed.
   */
  unflushedTextDelta: string;
  /**
   * Same as `unflushedTextDelta` but for thinking-phase tokens — drained
   * into a `reasoning` event. Tracked separately so a thinking burst
   * doesn't poison the visible-text delta buffer.
   */
  unflushedThinkingDelta: string;
  /**
   * Set when the SDK's final result message reported a failed turn —
   * either an error subtype (`error_during_execution`, `error_max_turns`,
   * …) or `is_error: true` on a `success` result. The latter is how API
   * errors surface: the SDK converts them (usage limits, 429s, auth
   * failures) into a synthetic assistant message and finishes the turn
   * "successfully" with the error text in `result` — it never throws.
   * Carries the best error text available so the handler can fail the
   * turn with the REAL message instead of treating it as a normal reply.
   */
  resultErrorText: string | undefined;
};

export function createStreamState(): StreamState {
  return {
    currentBlockText: "",
    allResponseText: "",
    newSessionId: undefined,
    toolCalls: 0,
    contextTokens: 0,
    contextWindow: undefined,
    numApiCalls: 0,
    sdkInputTokens: 0,
    sdkOutputTokens: 0,
    sdkCacheRead: 0,
    sdkCacheWrite: 0,
    costUsd: 0,
    cacheStats: undefined,
    lastStreamUpdate: 0,
    lastTrailingText: "",
    deliveredTextNorms: [],
    turnTerminated: false,
    unflushedTextDelta: "",
    unflushedThinkingDelta: "",
    resultErrorText: undefined,
  };
}

// ── Type guards ─────────────────────────────────────────────────────────────

export function isSystemInit(msg: SDKMessage): msg is SDKSystemMessage {
  return msg.type === "system" && msg.subtype === "init";
}

export function isStreamEvent(
  msg: SDKMessage,
): msg is SDKPartialAssistantMessage {
  return msg.type === "stream_event";
}

export function isAssistant(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === "assistant";
}

export function isUserMessage(msg: SDKMessage): msg is SDKUserMessage {
  return msg.type === "user" && "message" in msg;
}

export function isResult(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === "result";
}

/** Emitted when the subscription's rate-limit state changes mid-turn. */
export function isRateLimitEvent(msg: SDKMessage): boolean {
  return msg.type === "rate_limit_event";
}

/**
 * Emitted when the SDK compacts the session — the transcript before the
 * boundary is replaced by a summary, so every cached block after the system
 * prompt is gone and the next turn re-writes it. Shares `type: 'system'`
 * with the init message, so the subtype is what tells them apart.
 */
export function isCompactBoundary(
  msg: SDKMessage,
): msg is SDKCompactBoundaryMessage {
  return msg.type === "system" && msg.subtype === "compact_boundary";
}

// ── Message processors ──────────────────────────────────────────────────────

/** Output of `processStreamDelta` when the throttle interval has elapsed. */
export type StreamDeltaEmit =
  { phase: "text"; text: string } | { phase: "thinking"; text: string };

/**
 * Process a streaming delta event — accumulates per-token chunks
 * into `state.currentBlockText` (text) / unflushed buffers, and
 * returns the chunk to emit when the throttle interval has elapsed.
 *
 * Returns `null` when nothing should be emitted yet (either the delta
 * wasn't a content-block-delta, or the throttle window is still open).
 * Callers yield a `text_delta` / `reasoning` event with the returned
 * `text`. The throttle keeps the event volume bounded — Telegram /
 * terminal renderers re-accumulate, but at human-readable cadence.
 */
export function processStreamDelta(
  msg: SDKPartialAssistantMessage,
  state: StreamState,
): StreamDeltaEmit | null {
  const event = msg.event;
  if (event.type !== "content_block_delta") return null;

  const deltaEvent = event as BetaRawContentBlockDeltaEvent;
  const delta = deltaEvent.delta;

  if (delta.type === "thinking_delta") {
    // The SDK's typed thinking_delta carries `.thinking`; treat
    // missing/non-string defensively so a schema drift can't crash
    // the loop.
    const chunk =
      typeof (delta as { thinking?: unknown }).thinking === "string"
        ? (delta as { thinking: string }).thinking
        : "";
    if (chunk) state.unflushedThinkingDelta += chunk;
    const now = Date.now();
    if (now - state.lastStreamUpdate >= STREAM_INTERVAL) {
      state.lastStreamUpdate = now;
      const out = state.unflushedThinkingDelta;
      state.unflushedThinkingDelta = "";
      if (out.length > 0) return { phase: "thinking", text: out };
    }
  } else if (delta.type === "text_delta") {
    state.currentBlockText += delta.text;
    state.unflushedTextDelta += delta.text;
    const now = Date.now();
    if (now - state.lastStreamUpdate >= STREAM_INTERVAL) {
      state.lastStreamUpdate = now;
      const out = state.unflushedTextDelta;
      state.unflushedTextDelta = "";
      if (out.length > 0) return { phase: "text", text: out };
    }
  }
  return null;
}

/** A tool call extracted from an assistant message. */
type ToolCall = {
  /** The SDK's tool_use block id — matches the later tool_result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/** Result of processing an assistant message. */
export type AssistantResult = {
  /** Text segments accumulated before tool calls, each to be sent as a progress message. */
  progressTexts: string[];
  /** Tool calls found in the message. */
  tools: ToolCall[];
  /** Trailing text after all tool calls (or the full text if no tool calls). */
  trailingText: string;
};

/**
 * Process a complete assistant message — extracts text blocks and tool calls.
 * Uses the typed BetaContentBlock discriminated union.
 *
 * When multiple tool_use blocks appear in the same message with text before
 * each, every text segment is captured in progressTexts so the handler can
 * emit them all in order.
 */
export function processAssistantMessage(
  msg: SDKAssistantMessage,
  state: StreamState,
): AssistantResult {
  const content = msg.message.content;
  const tools: ToolCall[] = [];
  const progressTexts: string[] = [];
  let blockText = "";

  for (const block of content) {
    if (block.type === "text") {
      blockText += block.text;
    }
    if (block.type === "tool_use") {
      state.toolCalls++;
      const input =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      tools.push({ id: block.id, name: block.name, input });
      // Text before this tool call is a progress message
      if (blockText.trim()) {
        progressTexts.push(blockText.trim());
        state.allResponseText += blockText;
        blockText = "";
        state.currentBlockText = "";
      }
    }
  }

  // Remaining text after all tool calls (or if no tool calls)
  const trailingText = blockText.trim() ? blockText : "";
  if (trailingText) {
    state.currentBlockText = blockText;
  }

  return { progressTexts, tools, trailingText };
}

/** One completed tool execution, extracted from an SDK user message. */
export type ToolResultInfo = {
  toolUseId: string;
  /** Present when the tool failed — first ~500 chars of the error text. */
  error?: string;
};

/**
 * Extract tool results from an SDK user message. Tool executions come
 * back as `tool_result` content blocks (keyed by `tool_use_id`) on
 * synthetic user messages — the missing half of the tool lifecycle:
 * without these, a UI that shows a spinner on `tool_call` never gets
 * the event that stops it.
 */
export function extractToolResults(msg: SDKUserMessage): ToolResultInfo[] {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];
  const results: ToolResultInfo[] = [];
  for (const block of content) {
    if (
      !block ||
      typeof block !== "object" ||
      (block as { type?: string }).type !== "tool_result"
    ) {
      continue;
    }
    const b = block as {
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    };
    if (typeof b.tool_use_id !== "string") continue;
    let error: string | undefined;
    if (b.is_error) {
      const text =
        typeof b.content === "string"
          ? b.content
          : Array.isArray(b.content)
            ? b.content
                .filter(
                  (c): c is { type: "text"; text: string } =>
                    !!c &&
                    typeof c === "object" &&
                    (c as { type?: string }).type === "text" &&
                    typeof (c as { text?: unknown }).text === "string",
                )
                .map((c) => c.text)
                .join("\n")
            : "";
      error = (text || "tool failed").slice(0, 500);
    }
    results.push({ toolUseId: b.tool_use_id, error });
  }
  return results;
}

/**
 * Record a compaction boundary. Observational only: the turn proceeds
 * exactly as it did before this message was recognised — what changes is
 * that `session.compacted.*` now says how often the SDK compacts and how
 * much it reclaims (docs/cache-economics.md, PR A step 3).
 */
export function processCompactBoundary(
  msg: SDKCompactBoundaryMessage,
  chatId: string,
): void {
  recordCompactBoundary(chatId, msg.compact_metadata);
}

/** Context fill of the last API iteration + whether the turn's first request hit the cache. */
function readContextFill(
  state: StreamState,
  usage: SDKResultMessage["usage"],
): void {
  if (
    !usage ||
    !Array.isArray(usage.iterations) ||
    usage.iterations.length === 0
  )
    return;
  const last = usage.iterations[usage.iterations.length - 1];
  state.contextTokens =
    (last.input_tokens ?? 0) +
    (last.cache_read_input_tokens ?? 0) +
    (last.cache_creation_input_tokens ?? 0);
  // The same array answers a question the per-turn totals can't: whether
  // the FIRST request of this turn read a cache or paid to write one.
  state.cacheStats = turnCacheStats(usage.iterations);
}

/**
 * Token counts from the ACTIVE model's usage only. modelUsage is keyed by
 * the exact SDK model string (e.g. "sonnet[1m]") and holds cumulative
 * session totals per model — summing all entries double-counts when
 * switching models mid-session.
 */
function readModelUsage(
  state: StreamState,
  modelUsage: Record<string, ModelUsage>,
  sdkModel: string,
): void {
  // Drift check: modelUsage is keyed by the model that ACTUALLY served
  // the turn. If none of the keys is (an alias of) the model we asked
  // for, the API substituted — warn instead of burying it in the
  // accounting line.
  checkModelDrift(sdkModel, Object.keys(modelUsage ?? {}));
  const mu = modelUsage[sdkModel] ?? Object.values(modelUsage).at(-1);
  if (!mu) return;
  state.sdkInputTokens = mu.inputTokens ?? 0;
  state.sdkOutputTokens = mu.outputTokens ?? 0;
  state.sdkCacheRead = mu.cacheReadInputTokens ?? 0;
  state.sdkCacheWrite = mu.cacheCreationInputTokens ?? 0;
  if (mu.contextWindow > 0) {
    state.contextWindow = mu.contextWindow;
  }
}

/**
 * Failed turn. Two shapes (see StreamState.resultErrorText):
 *  - error subtype: no `result` field, but `errors[]` carries diagnostics.
 *  - success subtype with is_error: `result` (and the trailing assistant
 *    text) IS the API error message, e.g. "You've hit your weekly limit
 *    · resets Jul 10, 9am". Prefer that text — it's the user-facing one.
 */
function readResultError(msg: SDKResultMessage, state: StreamState): void {
  if (msg.subtype !== "success") {
    const diagnostics = (msg.errors ?? [])
      .filter((e) => typeof e === "string" && !e.startsWith("[ede_diagnostic]"))
      .join("; ")
      .slice(0, 500);
    // A known startup failure (SDK ≥ 0.3.274) names its cause — the CLI
    // never ran a turn, so nothing else in the result says why. Lead with
    // it; the diagnostics text is the same line stderr carried.
    if (msg.startup_failure_reason) {
      state.resultErrorText =
        `Claude Code failed to start (${msg.startup_failure_reason})` +
        (diagnostics ? `: ${diagnostics}` : "");
      return;
    }
    state.resultErrorText =
      state.lastTrailingText.trim() ||
      diagnostics ||
      `Claude SDK turn failed (${msg.subtype})`;
  } else if (msg.is_error) {
    state.resultErrorText =
      (typeof msg.result === "string" && msg.result.trim()) ||
      state.lastTrailingText.trim() ||
      "Claude SDK turn failed (API error)";
  }
}

/**
 * Process the final result message — extracts token counts, context info,
 * and API call counts from the typed SDK result.
 */
export function processResultMessage(
  msg: SDKResultMessage,
  state: StreamState,
  sdkModel: string,
): void {
  state.numApiCalls = msg.num_turns ?? 0;

  // Per-turn, not cumulative across a resumed session — safe to add up.
  if (typeof msg.total_cost_usd === "number" && msg.total_cost_usd > 0) {
    state.costUsd = msg.total_cost_usd;
  }

  readContextFill(state, msg.usage);
  readModelUsage(state, msg.modelUsage, sdkModel);

  log(
    "agent",
    `SDK result: sdkModel=${sdkModel}, contextWindow=${state.contextWindow}, contextTokens=${state.contextTokens}, numApiCalls=${state.numApiCalls}`,
  );

  // Fallback: if no text was captured via streaming or assistant messages,
  // pull from the result string (available on success results).
  if (
    !state.allResponseText &&
    !state.currentBlockText &&
    "result" in msg &&
    typeof msg.result === "string"
  ) {
    state.currentBlockText = msg.result;
  }

  readResultError(msg, state);
}

// ── Trailing-text fallback dedup ────────────────────────────────────────────
// Re-export from shared so legacy imports do not grow a second implementation.
export {
  normalizeForDedupe,
  isDuplicateOfDelivered,
} from "../runtime/turn/delivered-text.js";
