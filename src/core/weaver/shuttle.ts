/**
 * Shuttle — carries the weft across the warp: consumes a backend's
 * canonical `AgentEvent` stream and forwards every event to the
 * frontend's `onEvent` sink (no callback bridge, no back-translation).
 *
 * The Shuttle owns the three stream-consumption invariants so no caller
 * can get them subtly wrong:
 *
 *   - **ordering** — events are awaited in stream order, so a consumer
 *     that needs serial delivery gets it;
 *   - **ack settlement** — `assistant_message.deliveryAck` is ALWAYS
 *     settled, even when no `onEvent` sink is supplied or the sink
 *     ignores the event. Otherwise the callback-shaped backend
 *     (handler-to-events) blocks forever awaiting delivery
 *     confirmation. The frontend's job is just to deliver and throw on
 *     failure; the Shuttle maps that onto the ack (resolve on success →
 *     block delivered; reject on throw → backend retries, e.g. Codex
 *     oversized-message path);
 *   - **terminators** — the `completed` event's `AgentResult` is
 *     captured for the return value, and an `error` terminator is
 *     rethrown as `AgentRunError` so callers' catch paths keep working.
 */

import {
  AgentRunError,
  type AgentEvent,
  type AgentResult,
} from "../agent-runtime/events.js";
import { recordTurnActivity } from "../../util/watchdog.js";
import type { TurnToolLog } from "./turn-log.js";

export type EventSink = (event: AgentEvent) => void | Promise<void>;

/**
 * Wall-clock the shuttle observes while carrying one stream: when the
 * first event arrived (`undefined` if the stream ended empty) and how many
 * ms were spent awaiting the frontend's sink in total.
 */
export type ShuttleTiming = {
  firstEventAt?: number;
  deliveryMs: number;
};

export const startShuttleTiming = (): ShuttleTiming => ({ deliveryMs: 0 });

/**
 * Pump the stream to completion. Returns the `completed` event's
 * result (if the backend emitted one); throws `AgentRunError` when the
 * stream terminates with an `error` event. `tools`, when given, sees
 * every tool call/result pair for the turn's `tool.call` log lines.
 */
export async function carryTurnEvents(
  stream: AsyncIterable<AgentEvent>,
  onEvent?: EventSink,
  timing?: ShuttleTiming,
  tools?: TurnToolLog,
): Promise<AgentResult | undefined> {
  let agentResult: AgentResult | undefined;
  const sink: EventSink | undefined =
    onEvent && timing
      ? async (event) => {
          const t0 = Date.now();
          try {
            await onEvent(event);
          } finally {
            timing.deliveryMs += Date.now() - t0;
          }
        }
      : onEvent;
  for await (const event of stream) {
    // Every backend's events cross this loop exactly once, so this is the
    // one place the watchdog learns a turn is alive (vs. wedged).
    recordTurnActivity();
    if (timing && timing.firstEventAt === undefined) {
      timing.firstEventAt = Date.now();
    }
    if (event.type === "completed") {
      agentResult = event.result;
    } else if (event.type === "tool_call") {
      tools?.onCall(event);
    } else if (event.type === "tool_result") {
      tools?.onResult(event);
    }

    if (event.type === "assistant_message" && event.deliveryAck) {
      try {
        await sink?.(event);
        event.deliveryAck.resolve();
      } catch (err) {
        event.deliveryAck.reject(err);
      }
      continue;
    }

    await sink?.(event);
    if (event.type === "error") {
      throw new AgentRunError(event.error);
    }
  }
  return agentResult;
}
