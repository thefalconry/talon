/**
 * Shared SSE event processor for the remote-server backend family.
 *
 * Both OpenCode and Kilo expose the same SSE wire format on
 * `global.event()` — upstream defines it once and the Kilo fork inherits
 * it. The per-event translation into stream-state mutations is therefore
 * identical between the two backends, so the logic lives here as a
 * shared helper instead of being duplicated in each backend's events
 * module.
 *
 * Two key functions:
 *
 *   - {@link processStreamEvent} — translate one SSE event into state
 *     mutations + callback firings. Returns a tag telling the caller
 *     whether to keep iterating or stop.
 *   - {@link finalizePartsIntoState} — drain the authoritative
 *     `session.messages` parts list into stream state at end-of-turn,
 *     filling anything SSE missed.
 *
 * Both are stateless beyond their `state` argument — easy to call with
 * a hand-built event object from a vitest test.
 *
 * Backend-specific extraction logic (synthetic-error detection, parts
 * walking) is injected as `extractPartsSummary` — both backends already
 * have an identical-signature implementation in their `sessions.ts`.
 */

import {
  appendText,
  closeCurrentSegment,
  markProgressDelivered,
  recordTokens,
  recordToolUse,
  recordToolCall,
  type StreamState,
} from "../runtime/index.js";
import {
  extractAssistantUsage,
  type RemoteAssistantInfo,
} from "./session-helpers.js";
import { log, logDebug } from "../../util/log.js";
import { errMsg } from "./state.js";

// ── Streaming timing ───────────────────────────────────────────────────────

/**
 * Minimum interval (ms) between `onStreamDelta` callbacks. Throttles
 * downstream UI refreshes (e.g. Telegram `edit_message`) so the frontend
 * doesn't spam the platform during fast-token generation.
 */
export const STREAM_INTERVAL_MS = 1000;

// ── Types ──────────────────────────────────────────────────────────────────

/** Tag returned by `processStreamEvent` describing what the loop should do. */
export type ProcessEventOutcome =
  | { kind: "continue" }
  | { kind: "stop"; reason: "turn.close" | "idle" | "out_of_scope" }
  | { kind: "terminator_fired"; toolName: string };

/** Common context passed to the per-event helper. */
export interface EventProcessingContext {
  /** Chat id for session-scoped metrics. */
  chatId: string;
  /** Session id we're scoped to — events for other sessions are dropped. */
  sessionId: string;
  /** Stream state accumulator (runtime/turn/). */
  state: StreamState;
  /** Tool-call ids we've already fired callbacks for. */
  seenToolCallIds: Set<string>;
  /** Backend label used in `[<label>] terminator fired: ...` log lines. */
  backendLabel: string;
  /** Optional progress / streaming callback. */
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  /** Optional pre-tool text emitter. */
  onTextBlock?: (text: string) => Promise<void>;
  /** Optional tool-use observer. */
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
}

// ── Event processing ───────────────────────────────────────────────────────

/**
 * Process one SSE event from the remote agent server's `global.event()`
 * stream.
 *
 * Behaviour by event type:
 *
 *   - `message.part.delta` — append to state, throttle a `onStreamDelta`
 *     fire. Thinking deltas don't accumulate into the response buffer.
 *   - `message.part.updated` for a `tool` part — fire `onTextBlock` for
 *     any pre-tool segment, then `recordToolUse` (which captures
 *     delivered text + flips turnTerminated for terminators) +
 *     `onToolUse`. Returns `terminator_fired` so the caller can abort
 *     the session.
 *   - `session.turn.close` / `session.idle` — return `stop` so the
 *     subscription loop exits cleanly.
 *   - `session.error` — observed but not mutated here; caller logs.
 *
 * Events for other sessions return `out_of_scope` — caller continues.
 */
export async function processStreamEvent(
  event: { type?: string; properties?: Record<string, unknown> },
  ctx: EventProcessingContext,
): Promise<ProcessEventOutcome> {
  if (!event || typeof event !== "object") return { kind: "continue" };
  const props = event.properties ?? {};
  // Scope to our session only. OpenCode/Kilo use three wire shapes:
  // session events put sessionID on properties, part events put it inside
  // properties.part, and message events put it inside properties.info.
  // Missing the nested part shape lets a concurrent heartbeat/dream tool
  // event terminate the active chat turn.
  const part = props.part as Record<string, unknown> | undefined;
  const info = props.info as Record<string, unknown> | undefined;
  const evtSessionID =
    typeof props.sessionID === "string"
      ? props.sessionID
      : typeof part?.sessionID === "string"
        ? part.sessionID
        : typeof info?.sessionID === "string"
          ? info.sessionID
          : undefined;
  if (evtSessionID && evtSessionID !== ctx.sessionId) {
    return { kind: "stop", reason: "out_of_scope" };
  }

  // Count this event for the per-turn diagnostic summary the handler logs
  // at end-of-turn. Helps debug "stuck" turns by showing which event types
  // actually fired (e.g. `delta×42 part.updated×1` vs zero events).
  if (typeof event.type === "string") {
    ctx.state.eventCounts[event.type] =
      (ctx.state.eventCounts[event.type] ?? 0) + 1;
  }

  switch (event.type) {
    case "message.part.delta": {
      return processPartDelta(props, ctx);
    }
    case "message.part.updated": {
      return processPartUpdate(props, ctx);
    }
    case "message.updated": {
      return processMessageUpdate(props, ctx);
    }
    case "session.turn.close": {
      return { kind: "stop", reason: "turn.close" };
    }
    case "session.idle": {
      return { kind: "stop", reason: "idle" };
    }
    default:
      return { kind: "continue" };
  }
}

/**
 * `message.updated` — the server PATCHes the assistant message as the
 * turn progresses, and once a model call completes the `info.tokens`
 * block carries that message's usage. Pull it into stream state as it
 * lands so token/context stats are live mid-turn instead of appearing
 * only at the post-loop accounting. `recordTokens` also mirrors the
 * counts into the chat's live-turn overlay when the state is bound to a
 * chat (see `runtime/turn/stream-state.ts: pushLiveUsage`).
 *
 * Values are the message's totals (not deltas), matching what the
 * post-loop `extractAssistantUsage(lastAssistant.info)` reads — so the
 * end-of-turn numbers are identical, just earlier.
 */
function processMessageUpdate(
  props: Record<string, unknown>,
  ctx: EventProcessingContext,
): ProcessEventOutcome {
  const info = props.info as
    (RemoteAssistantInfo & { sessionID?: string }) | undefined;
  if (!info || typeof info !== "object" || info.role !== "assistant") {
    return { kind: "continue" };
  }
  // `message.updated` carries its session id INSIDE `info`, not at the
  // properties level the generic scope filter checks — the SSE stream is
  // global, so without this a busy sibling chat's usage would bleed into
  // this turn's stats.
  if (typeof info.sessionID === "string" && info.sessionID !== ctx.sessionId) {
    return { kind: "continue" };
  }
  const usage = extractAssistantUsage(info);
  if (
    usage.inputTokens ||
    usage.outputTokens ||
    usage.cacheRead ||
    usage.cacheWrite
  ) {
    // Context fill = everything that entered the model's window on the
    // call: fresh input plus cache reads/writes.
    ctx.state.contextTokens =
      usage.inputTokens + usage.cacheRead + usage.cacheWrite;
    recordTokens(ctx.state, usage);
  }
  return { kind: "continue" };
}

function processPartDelta(
  props: Record<string, unknown>,
  ctx: EventProcessingContext,
): ProcessEventOutcome {
  const field = typeof props.field === "string" ? props.field : "";
  const delta = typeof props.delta === "string" ? props.delta : "";
  const partID = typeof props.partID === "string" ? props.partID : "";
  if (!delta) return { kind: "continue" };

  // `field: "text"` deltas can fire for either a TextPart (user-facing
  // reply) OR a ReasoningPart (private scratchpad — both part types use
  // a `text` field). The delta event itself doesn't say which one. We
  // accumulate optimistically here for streaming UX continuity, then
  // `finalizePartsIntoState` rewrites `state.allResponseText` from the
  // authoritative parts list (text-parts only) at end-of-turn — so any
  // reasoning content that leaked in during the stream gets cleaned up
  // before the handler reads it. The exception: when we already know
  // the partID belongs to a reasoning/thinking part (from a prior
  // message.part.updated), don't pollute allResponseText now either.
  if (field === "text") {
    const partType = partID ? ctx.state.partTypes.get(partID) : undefined;
    if (partType === "reasoning" || partType === "thinking") {
      maybeFireStreamDelta(ctx.state, ctx.onStreamDelta, "thinking");
    } else {
      appendText(ctx.state, delta);
      maybeFireStreamDelta(ctx.state, ctx.onStreamDelta, "text");
    }
  } else if (field === "thinking" || field === "reasoning") {
    // Explicit reasoning/thinking field — never accumulate.
    maybeFireStreamDelta(ctx.state, ctx.onStreamDelta, "thinking");
  }
  return { kind: "continue" };
}

async function processPartUpdate(
  props: Record<string, unknown>,
  ctx: EventProcessingContext,
): Promise<ProcessEventOutcome> {
  const part = props.part as Record<string, unknown> | undefined;
  if (!part) return { kind: "continue" };

  // Track every part's type by id so processPartDelta can distinguish
  // text-part text content from reasoning-part text content (upstream
  // uses the same `text` field name in both).
  const partType = typeof part.type === "string" ? part.type : "";
  const partID = typeof part.id === "string" ? part.id : "";
  if (partID && partType) {
    ctx.state.partTypes.set(partID, partType);
  }

  if (part.type !== "tool") return { kind: "continue" };

  const callID = typeof part.callID === "string" ? part.callID : "";
  const toolName = typeof part.tool === "string" ? part.tool : "tool";
  const stateObj = part.state as
    { status?: string; input?: Record<string, unknown> } | undefined;

  // Record a tool only after the upstream reports successful completion.
  // Treating `running` as delivery made failed MCP calls flip end_turn and
  // suppress fallback text even though nothing reached the user.
  if (
    !stateObj ||
    stateObj.status !== "completed" ||
    !callID ||
    ctx.seenToolCallIds.has(callID)
  ) {
    return { kind: "continue" };
  }

  ctx.seenToolCallIds.add(callID);
  const input = stateObj.input ?? {};

  // Emit pre-tool progress text BEFORE recording the tool — so the user
  // sees "let me check..." land before the tool's typing indicator.
  const progress = closeCurrentSegment(ctx.state);
  if (progress && ctx.onTextBlock) {
    try {
      await ctx.onTextBlock(progress);
      // Only now is this text actually with the user. `closeCurrentSegment`
      // folded it into `allResponseText`, so without this the end-of-turn
      // delivery would ship it a second time inside the full transcript.
      markProgressDelivered(ctx.state);
    } catch (err) {
      // Non-fatal — never break the stream loop on a UI callback. Logged
      // at debug level so a repeatedly-failing frontend is visible to
      // anyone tailing with LOG_LEVEL=debug, without polluting the
      // default operator log.
      logDebug(
        "agent",
        `[${ctx.backendLabel}] onTextBlock (progress) threw: ${errMsg(err)}`,
      );
    }
  }
  // Count every tool the model calls — shared vocabulary across
  // backends (prefix-stripped name + backend dimension).
  recordToolCall(ctx.chatId, toolName, ctx.backendLabel.toLowerCase());
  recordToolUse(ctx.state, toolName, input);
  if (ctx.onToolUse) {
    try {
      ctx.onToolUse(toolName, input);
    } catch (err) {
      logDebug(
        "agent",
        `[${ctx.backendLabel}] onToolUse(${toolName}) threw: ${errMsg(err)}`,
      );
    }
  }
  if (ctx.state.turnTerminated) {
    log(
      "agent",
      `[${ctx.backendLabel}] terminator fired: ${describeToolCall(toolName, input)}`,
    );
    return { kind: "terminator_fired", toolName };
  }
  return { kind: "continue" };
}

/**
 * One-line summary of a tool call for diagnostic logs. Shows the args
 * operators care about (text length, type, emoji) without dumping the
 * whole JSON payload. Long text inputs are summarised by character count.
 */
function describeToolCall(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const parts: string[] = [toolName];
  if (typeof input.type === "string") parts.push(`type=${input.type}`);
  if (typeof input.text === "string") {
    parts.push(`text=${input.text.length}chars`);
  }
  if (typeof input.emoji === "string") parts.push(`emoji=${input.emoji}`);
  if (typeof input.end_turn === "boolean") {
    parts.push(`end_turn=${input.end_turn}`);
  }
  return parts.join(" ");
}

/**
 * Fire `onStreamDelta` if at least `STREAM_INTERVAL_MS` has elapsed since
 * the last call. Throttles the callback to keep downstream UI happy.
 *
 * Mutates `state.lastStreamUpdate` on every successful fire.
 */
export function maybeFireStreamDelta(
  state: StreamState,
  onStreamDelta: EventProcessingContext["onStreamDelta"],
  phase: "thinking" | "text",
): void {
  if (!onStreamDelta) return;
  const now = Date.now();
  if (now - state.lastStreamUpdate < STREAM_INTERVAL_MS) return;
  state.lastStreamUpdate = now;
  try {
    onStreamDelta(state.currentBlockText, phase);
  } catch (err) {
    logDebug("agent", `onStreamDelta threw: ${errMsg(err)}`);
  }
}

// ── Sync-response parts backfill ───────────────────────────────────────────

/** Shape returned by a backend's parts-summary extractor. */
interface PartsSummary {
  text: string;
  toolCalls: number;
  syntheticErrorText?: string;
}

/** Inputs for `finalizePartsIntoState`. */
export interface FinalizePartsInputs {
  parts: Array<Record<string, unknown>>;
  state: StreamState;
  seenToolCallIds: Set<string>;
  /**
   * Backend-specific parts walker. Both `kilo/sessions.ts` and
   * `opencode/sessions.ts` export an `extractPartsSummary` function with
   * this signature. Injecting it (instead of importing concretely)
   * keeps this module backend-agnostic.
   */
  extractPartsSummary: (parts: Array<Record<string, unknown>>) => PartsSummary;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
}

/**
 * Drain the authoritative `session.messages` response into the stream state.
 *
 * The `parts` list returned by `session.messages` is the authoritative
 * snapshot of what the model produced this turn. Upstream emits parts
 * in three categories that map to Talon's delivery model:
 *
 *   - `text` — user-facing reply. Most non-Anthropic models emit text
 *     parts as their natural delivery; they don't call `end_turn` the
 *     way Claude does. We accumulate text-part content into
 *     `state.allResponseText` so the handler ships it via `onTextBlock`
 *     after the turn closes.
 *   - `tool` — side-effect tool call (end_turn for explicit close,
 *     send for rich content, react for emoji, plus arbitrary plugin
 *     tools). Goes through `recordToolUse` which sets `turnTerminated`
 *     for end_turn and captures delivered-text norms for dedup.
 *   - `reasoning` / `step-start` / `step-finish` / etc. — internal
 *     plumbing or scratchpad. Ignored.
 *
 * Why we re-extract text here even when SSE captured deltas: SSE
 * deltas can arrive before the matching `message.part.updated` (so we
 * don't yet know the part type) or after the connection blips —
 * walking the final parts list is the safe source of truth. We
 * replace any partial SSE-accumulated text with the part-walk text to
 * avoid double-counting or partial-fragment leaks.
 *
 * Returns the number of tool calls processed this pass (mostly for tests).
 */
export function finalizePartsIntoState(inputs: FinalizePartsInputs): {
  toolsProcessed: number;
  syntheticErrorText?: string;
} {
  const { parts, state, seenToolCallIds, extractPartsSummary, onToolUse } =
    inputs;
  let toolsProcessed = 0;

  // Authoritative text from text parts only — the backend's
  // `extractPartsSummary` filters to text-only parts so reasoning content
  // can't leak in even if a delta classifier missed it earlier in the
  // turn. The Kilo extractor also peels off `synthetic: true` parts
  // (internal failure messages) and surfaces them via
  // `syntheticErrorText` so the caller can show a Talon error instead of
  // shipping the raw upstream string as a chat reply.
  const summary = extractPartsSummary(parts);
  if (summary.text) {
    state.allResponseText = summary.text;
    state.lastTrailingText = summary.text;
    state.currentBlockText = "";
  } else if (summary.syntheticErrorText) {
    // No real text part — make sure SSE-accumulated speculative text
    // doesn't leak through as if it were the reply.
    state.allResponseText = "";
    state.lastTrailingText = "";
    state.currentBlockText = "";
  }
  if (summary.syntheticErrorText) {
    state.syntheticError = summary.syntheticErrorText;
  }

  // Process tool parts — recordToolUse handles the toolCalls increment,
  // delivered-text capture, and the turnTerminated flag for end_turn.
  for (const part of parts) {
    if (part.type !== "tool") continue;
    const stateObj = part.state as
      { status?: string; input?: Record<string, unknown> } | undefined;
    const callID = typeof part.callID === "string" ? part.callID : "";
    const toolName = typeof part.tool === "string" ? part.tool : "tool";
    if (callID && seenToolCallIds.has(callID)) continue;
    if (stateObj?.status === "completed" && stateObj.input) {
      if (callID) seenToolCallIds.add(callID);
      recordToolUse(state, toolName, stateObj.input);
      toolsProcessed++;
      if (onToolUse) {
        try {
          onToolUse(toolName, stateObj.input);
        } catch (err) {
          logDebug(
            "agent",
            `onToolUse(${toolName}) (parts backfill) threw: ${errMsg(err)}`,
          );
        }
      }
    }
  }

  return {
    toolsProcessed,
    ...(summary.syntheticErrorText
      ? { syntheticErrorText: summary.syntheticErrorText }
      : {}),
  };
}
