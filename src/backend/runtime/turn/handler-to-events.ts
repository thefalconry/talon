/**
 * Adapter helper for backends whose SDKs deliver chat-turn events via
 * callbacks (Codex, OpenCode, Kilo, OpenAI Agents). The backend's
 * `handler.ts` keeps its internal callback-driven loop, and its
 * `runChatTurn.ts` calls this helper to expose the native
 * `AsyncIterable<AgentEvent>` surface that `ChatBackend.runChatTurn`
 * requires.
 *
 * Backends with native event emission (Claude SDK, post-conversion)
 * skip this entirely and yield events directly — `runChatTurn` lives
 * in the backend module and owns its own stream surface.
 *
 * This is not a legacy adapter: it is the canonical bridge between an
 * SDK that emits via callbacks and the `AgentEvent` contract every
 * consumer reads.
 */

import {
  type AgentEvent,
  classifiedToAgentError,
} from "../../../core/agent-runtime/events.js";
import { classify } from "../../../core/errors.js";
import type { ChatRunParams } from "../../../core/agent-runtime/capabilities.js";
import type { QueryParams, QueryResult } from "./handler-types.js";
import { buildResultEvents } from "./result-events.js";

const SENTINEL = Symbol("handler-to-events:sentinel");

/**
 * The DATA half of `QueryParams`, carried verbatim from the canonical
 * `ChatRunParams` (only `ModelRef` flattens to `model.id`). The
 * callback half is the queue's and is built per run below. Keeping the
 * carry in one place is what stops a field — `retrievedMemory` being
 * the one #639 lost — from reaching some handlers and not others.
 */
function turnFields(params: ChatRunParams) {
  return {
    chatId: params.chatId,
    model: params.model.id,
    text: params.text,
    senderName: params.senderName,
    senderHandle: params.senderHandle,
    isGroup: params.isGroup,
    messageId: params.messageId,
    retrievedMemory: params.retrievedMemory,
  };
}

type QueueEvent = AgentEvent | typeof SENTINEL;

/**
 * Drive a callback-shaped `handleMessage(QueryParams) => Promise<QueryResult>`
 * and yield its events as `AgentEvent`s. The generator interleaves
 * callback-driven streaming events with the awaited query result:
 *
 *   run_started → text_delta* → assistant_message* → tool_call* →
 *     usage → completed
 *
 * On error: `run_started → error`.
 *
 * The wrapper builds the backend-internal `QueryParams` shape from
 * the canonical `ChatRunParams` (`ModelRef` flattens to `model.id`;
 * the queue owns the streaming surface — no callbacks come from
 * the caller). Each backend's `runChatTurn.ts` invokes this once
 * per chat turn.
 */
export async function* handlerToEvents(
  handler: (params: QueryParams) => Promise<QueryResult>,
  params: ChatRunParams,
): AsyncIterable<AgentEvent> {
  yield { type: "run_started" };

  const queue: QueueEvent[] = [];
  let resolveAvailable: (() => void) | null = null;
  const wait = () =>
    new Promise<void>((resolve) => {
      resolveAvailable = resolve;
    });
  const emit = (event: QueueEvent): void => {
    queue.push(event);
    const r = resolveAvailable;
    resolveAvailable = null;
    r?.();
  };

  // Tool calls announced via `onToolStart` that have not yet reported an
  // `onToolEnd` — flushed with an error result if the handler settles with
  // any still open (abort/crash mid-tool), preserving the call→result
  // pairing contract for every consumer.
  const openToolCalls = new Map<string, string>();

  // Handler `onStreamDelta` delivers the FULL accumulated text so far,
  // not the new chunk. `AgentEvent.text_delta.text` carries the delta —
  // event-native consumers (the frontends, via the dispatcher's
  // `onEvent` sink) re-accumulate if they need the running total. The
  // wrapper tracks the prior accumulated value and emits only the
  // trailing slice.
  let lastAccumulated = "";

  const handlerParams: QueryParams = {
    ...turnFields(params),
    onStreamDelta: (accumulated) => {
      if (typeof accumulated !== "string" || accumulated.length === 0) {
        return;
      }
      let chunk = accumulated;
      if (accumulated.startsWith(lastAccumulated)) {
        chunk = accumulated.slice(lastAccumulated.length);
      }
      lastAccumulated = accumulated;
      if (chunk.length > 0) {
        emit({ type: "text_delta", text: chunk });
      }
    },
    onTextBlock: async (text) => {
      await new Promise<void>((resolve, reject) => {
        emit({
          type: "assistant_message",
          text,
          deliveryAck: { resolve, reject },
        });
      });
      // A block delivery anchors the accumulator — subsequent streaming
      // deltas restart from empty.
      lastAccumulated = "";
    },
    onToolUse: (toolName, input, meta) => {
      const id = `${toolName}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      emit({ type: "tool_call", id, name: toolName, input });
      // Callback backends (OpenCode, Kilo, OpenAI Agents) surface a
      // tool call only at terminal status — by the time onToolUse fires,
      // the tool has already finished. Emit the matching `tool_result`
      // immediately so consumers see the same call→result contract the
      // Claude SDK backend emits. Without it, tool spinners opened on
      // `tool_call` hang until the end-of-turn flush — on a long Codex
      // grind that reads as "running forever" in the companion app.
      emit({
        type: "tool_result",
        id,
        name: toolName,
        ...(meta?.failed ? { error: "tool call failed" } : {}),
      });
    },
    // Live tool lifecycle (Codex `item.started` → `item.completed`):
    // `tool_call` goes out the moment the SDK dispatches the tool and the
    // matching `tool_result` when it settles, so consumers see a real
    // running window instead of the collapsed 0ms call+result above.
    onToolStart: (callId, toolName, input) => {
      openToolCalls.set(callId, toolName);
      emit({ type: "tool_call", id: callId, name: toolName, input });
    },
    onToolEnd: (callId, toolName, meta) => {
      if (!openToolCalls.delete(callId)) return; // unknown/duplicate id
      emit({
        type: "tool_result",
        id: callId,
        name: toolName,
        ...(meta?.failed ? { error: "tool call failed" } : {}),
      });
    },
  };

  let result: QueryResult | undefined;
  let error: unknown;

  const handlerPromise = handler(handlerParams)
    .then((r) => {
      result = r;
    })
    .catch((err) => {
      error = err;
    })
    .finally(() => {
      emit(SENTINEL);
    });

  // Drain the queue until the handler settles AND no more events are
  // buffered. The sentinel only signals "handler settled" — we still
  // flush any final text/tool events emitted just before resolution.
  let settled = false;
  while (!settled || queue.length > 0) {
    while (queue.length > 0) {
      const ev = queue.shift()!;
      if (ev === SENTINEL) {
        settled = true;
        continue;
      }
      yield ev;
    }
    if (!settled) {
      await wait();
    }
  }
  await handlerPromise;

  // Resolve any tool that started but never settled (abort or crash killed
  // the subprocess mid-call) so spinners close instead of hanging forever.
  for (const [id, name] of openToolCalls) {
    yield { type: "tool_result", id, name, error: "tool did not complete" };
  }
  openToolCalls.clear();

  if (error) {
    yield { type: "error", error: classifiedToAgentError(classify(error)) };
    return;
  }

  if (!result) {
    yield {
      type: "error",
      error: {
        kind: "unknown",
        message: "handler resolved without a result.",
        retryable: false,
      },
    };
    return;
  }

  yield* buildResultEvents({
    text: result.text,
    durationMs: result.durationMs,
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheRead: result.cacheRead,
      cacheWrite: result.cacheWrite,
    },
    modelId: params.model.id,
  });
}
