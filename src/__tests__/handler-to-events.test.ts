/**
 * `handlerToEvents` — callback-shaped handler adapter.
 *
 * Pins the queued-event ↔ awaited-query interleaving the shared
 * helper does for every backend that opts into native AgentEvent
 * emission. Backends call `handlerToEvents(handleMessage, params)`
 * from their factory; the assertions here cover the wire format
 * those callers depend on.
 */

import { describe, expect, it } from "vitest";
import { handlerToEvents } from "../backend/runtime/turn/handler-to-events.js";
import type {
  QueryParams,
  QueryResult,
} from "../backend/runtime/turn/handler-types.js";
import type { AgentEvent } from "../core/agent-runtime/events.js";

import { makeBareModelRef } from "../core/agent-runtime/model-ref.js";
import type { ChatRunParams } from "../core/agent-runtime/capabilities.js";

function baseParams(): ChatRunParams {
  return {
    chatId: "chat-1",
    model: makeBareModelRef("claude", "stub-model"),
    text: "ping",
    senderName: "Ada",
  };
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of stream) {
    out.push(e);
    if (e.type === "assistant_message") {
      e.deliveryAck?.resolve();
    }
  }
  return out;
}

describe("handlerToEvents — minimum-fidelity envelope", () => {
  it("emits run_started → usage → completed for a query that produces no streaming output", async () => {
    const events = await drain(
      handlerToEvents(
        async () =>
          ({
            text: "hi",
            durationMs: 5,
            inputTokens: 1,
            outputTokens: 2,
            cacheRead: 0,
            cacheWrite: 0,
          }) satisfies QueryResult,
        baseParams(),
      ),
    );

    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "usage",
      "completed",
    ]);
    const completed = events.find((e) => e.type === "completed");
    if (completed?.type !== "completed") throw new Error("not completed");
    expect(completed.result?.text).toBe("hi");
    expect(completed.result?.usage.inputTokens).toBe(1);
  });

  it("relays accumulated onStreamDelta calls as monotonic text_delta deltas", async () => {
    // The legacy `onStreamDelta(accumulated)` contract passes the
    // FULL accumulated text on each call. `text_delta.text` carries
    // just the new tail — pipe consumers (`pipeEventsToCallbacks`,
    // `streamLog`) re-accumulate. The wrapper reconstructs the
    // delta by diffing each accumulated value against the prior.
    const events = await drain(
      handlerToEvents(async (legacy: QueryParams) => {
        legacy.onStreamDelta?.("partial");
        legacy.onStreamDelta?.("partial response");
        return {
          text: "partial response",
          durationMs: 10,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }, baseParams()),
    );

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(2);
    if (deltas[0]?.type !== "text_delta") throw new Error("expected delta");
    expect(deltas[0].text).toBe("partial");
    if (deltas[1]?.type !== "text_delta") throw new Error("expected delta");
    expect(deltas[1].text).toBe(" response");
    // Concatenated, the deltas reconstruct the full accumulated text.
    expect(
      deltas.map((d) => (d.type === "text_delta" ? d.text : "")).join(""),
    ).toBe("partial response");
  });

  it("emits the full delta when onStreamDelta resets (non-monotonic accumulator)", async () => {
    // Defensive: if a backend's accumulator resets mid-turn (text
    // block boundary, redelivery), the wrapper falls back to
    // emitting the full new string and re-anchoring.
    const events = await drain(
      handlerToEvents(async (legacy: QueryParams) => {
        legacy.onStreamDelta?.("alpha");
        legacy.onStreamDelta?.("BETA");
        return {
          text: "BETA",
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }, baseParams()),
    );

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.map((d) => (d.type === "text_delta" ? d.text : ""))).toEqual([
      "alpha",
      "BETA",
    ]);
  });

  it("relays onTextBlock → assistant_message", async () => {
    const events = await drain(
      handlerToEvents(async (legacy: QueryParams) => {
        await legacy.onTextBlock?.("first block");
        await legacy.onTextBlock?.("second block");
        return {
          text: "second block",
          durationMs: 10,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }, baseParams()),
    );

    const blocks = events.filter((e) => e.type === "assistant_message");
    expect(
      blocks.map((e) => (e.type === "assistant_message" ? e.text : "")),
    ).toEqual(["first block", "second block"]);
  });

  it("relays onToolUse → tool_call with stable id + name + input", async () => {
    const events = await drain(
      handlerToEvents(async (legacy: QueryParams) => {
        legacy.onToolUse?.("send_message", { text: "hi" });
        legacy.onToolUse?.("end_turn", {});
        return {
          text: "",
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }, baseParams()),
    );

    const tools = events.filter((e) => e.type === "tool_call");
    expect(tools.map((t) => (t.type === "tool_call" ? t.name : ""))).toEqual([
      "send_message",
      "end_turn",
    ]);
    if (tools[0]?.type !== "tool_call") throw new Error("expected tool_call");
    expect(tools[0].input).toEqual({ text: "hi" });
    expect(tools[0].id).toMatch(/^send_message-\d+-[a-z0-9]+$/);
  });

  it("pairs every tool_call with an immediate tool_result (same id)", async () => {
    // Callback backends report a tool only at terminal status — the
    // wrapper resolves it right away so tool spinners never dangle.
    const events = await drain(
      handlerToEvents(async (legacy: QueryParams) => {
        legacy.onToolUse?.("read_file", { path: "x" });
        legacy.onToolUse?.("web_search", { q: "y" }, { failed: true });
        return {
          text: "",
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }, baseParams()),
    );

    const calls = events.filter((e) => e.type === "tool_call");
    const results = events.filter((e) => e.type === "tool_result");
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const result = results[i];
      if (call?.type !== "tool_call" || result?.type !== "tool_result")
        throw new Error("expected paired tool events");
      expect(result.id).toBe(call.id);
      expect(result.name).toBe(call.name);
      // The result must directly follow its call in the stream.
      expect(events.indexOf(result)).toBe(events.indexOf(call) + 1);
    }
    const failed = results[1];
    if (failed?.type !== "tool_result") throw new Error("expected result");
    expect(failed.error).toBeTruthy();
    const succeeded = results[0];
    if (succeeded?.type !== "tool_result") throw new Error("expected result");
    expect(succeeded.error).toBeUndefined();
  });

  it("classifies a rejected query as an error event and terminates", async () => {
    const events = await drain(
      handlerToEvents(async () => {
        throw new Error("context length exceeded");
      }, baseParams()),
    );

    expect(events[0]?.type).toBe("run_started");
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error("expected error terminator");
    expect(last.error.kind).toBe("context_overflow");
    expect(last.error.message).toContain("context length");
  });

  it("preserves event ordering: delta → tool → completed", async () => {
    const events = await drain(
      handlerToEvents(async (legacy: QueryParams) => {
        legacy.onStreamDelta?.("thinking…");
        legacy.onToolUse?.("read_file", { path: "x" });
        legacy.onStreamDelta?.("done");
        return {
          text: "done",
          durationMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }, baseParams()),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "run_started",
      "text_delta",
      "tool_call",
      "tool_result",
      "text_delta",
      "usage",
      "completed",
    ]);
  });

  // The caller-supplied-callback test is gone with the legacy
  // surface — `ChatRunParams` no longer carries `onStreamDelta` /
  // `onTextBlock` / `onToolUse`, so there's nothing to smuggle.
  // `handlerToEvents` owns the streaming surface end-to-end now.
});
