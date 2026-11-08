/**
 * Codex live tool lifecycle — `item.started` opens the tool window via
 * `onToolStart`, `item.completed` closes it via `onToolEnd` with the SAME
 * item id, and calls whose start was never observed fall back to the
 * collapsed one-shot `onToolUse`. This is what gives the companion app
 * real tool durations for Codex turns instead of 0ms (call and result
 * used to be emitted back-to-back at terminal status).
 *
 * Also pins the safety invariants around the split:
 *   - side effects (metrics / terminator / recordToolUse) stay strictly
 *     on `item.completed` — `item.started` must NOT flip the terminator
 *     (the PR-fixed in_progress abort race);
 *   - duplicate started events report once;
 *   - `handlerToEvents` pairs onToolStart/onToolEnd into tool_call /
 *     tool_result with a shared id, and flushes an error result for
 *     tools left open when the handler settles.
 */

import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import {
  handleEvent,
  type HandleEventContext,
} from "../backend/codex/handler/events.js";
import { createStreamState } from "../backend/runtime/index.js";
import { handlerToEvents } from "../backend/runtime/turn/handler-to-events.js";
import type { QueryParams } from "../backend/runtime/turn/handler-types.js";
import type { AgentEvent } from "../core/agent-runtime/events.js";
import { makeBareModelRef } from "../core/agent-runtime/model-ref.js";

type Call = { kind: string; id?: string; name: string; failed?: boolean };

function makeCtx(): { ctx: HandleEventContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: HandleEventContext = {
    state: createStreamState("chat-1"),
    seenToolCallIds: new Set<string>(),
    startedToolIds: new Set<string>(),
    codexToolMetrics: { count: 0 },
    chatId: "chat-1",
    onToolUse: (name, _input, meta) =>
      calls.push({ kind: "use", name, failed: meta?.failed }),
    onToolStart: (id, name) => calls.push({ kind: "start", id, name }),
    onToolEnd: (id, name, meta) =>
      calls.push({ kind: "end", id, name, failed: meta?.failed }),
  };
  return { ctx, calls };
}

const mcpItem = (status: string) =>
  ({
    type: "item.completed",
    item: {
      id: "call-1",
      type: "mcp_tool_call",
      server: "brave-search",
      tool: "mcp__brave-search__brave_web_search",
      arguments: { query: "kerry weather" },
      status,
    },
  }) as unknown as ThreadEvent;

const mcpStarted = {
  type: "item.started",
  item: {
    id: "call-1",
    type: "mcp_tool_call",
    server: "brave-search",
    tool: "mcp__brave-search__brave_web_search",
    arguments: { query: "kerry weather" },
    status: "in_progress",
  },
} as unknown as ThreadEvent;

describe("codex handleEvent — live tool lifecycle", () => {
  it("pairs item.started → item.completed as onToolStart/onToolEnd with the item id", () => {
    const { ctx, calls } = makeCtx();
    handleEvent(mcpStarted, ctx);
    handleEvent(mcpItem("completed"), ctx);

    expect(calls).toEqual([
      {
        kind: "start",
        id: "call-1",
        name: "mcp__brave-search__brave_web_search",
      },
      {
        kind: "end",
        id: "call-1",
        name: "mcp__brave-search__brave_web_search",
        failed: undefined,
      },
    ]);
    // Side effects landed on completion.
    expect(ctx.state.toolCalls).toBe(1);
    expect(ctx.codexToolMetrics.count).toBe(1);
  });

  it("reports a duplicate item.started only once", () => {
    const { ctx, calls } = makeCtx();
    handleEvent(mcpStarted, ctx);
    handleEvent(mcpStarted, ctx);
    expect(calls.filter((c) => c.kind === "start")).toHaveLength(1);
  });

  it("falls back to the collapsed onToolUse when no start was observed", () => {
    const { ctx, calls } = makeCtx();
    handleEvent(mcpItem("completed"), ctx);
    expect(calls).toEqual([
      {
        kind: "use",
        name: "mcp__brave-search__brave_web_search",
        failed: undefined,
      },
    ]);
  });

  it("closes a started call as failed on a failed terminal status", () => {
    const { ctx, calls } = makeCtx();
    handleEvent(mcpStarted, ctx);
    handleEvent(mcpItem("failed"), ctx);
    expect(calls[1]).toEqual({
      kind: "end",
      id: "call-1",
      name: "mcp__brave-search__brave_web_search",
      failed: true,
    });
    // Failed calls count as calls (metrics) but never terminate the turn.
    expect(ctx.codexToolMetrics.count).toBe(1);
    expect(ctx.state.turnTerminated).toBe(false);
  });

  it("item.started must not flip the terminator (in_progress abort race)", () => {
    const { ctx } = makeCtx();
    const started = {
      type: "item.started",
      item: {
        id: "t-1",
        type: "mcp_tool_call",
        server: "telegram-tools",
        tool: "end_turn",
        arguments: { text: "done" },
        status: "in_progress",
      },
    } as unknown as ThreadEvent;
    handleEvent(started, ctx);
    expect(ctx.state.turnTerminated).toBe(false);

    handleEvent(
      {
        type: "item.completed",
        item: {
          id: "t-1",
          type: "mcp_tool_call",
          server: "telegram-tools",
          tool: "end_turn",
          arguments: { text: "done" },
          status: "completed",
        },
      } as unknown as ThreadEvent,
      ctx,
    );
    expect(ctx.state.turnTerminated).toBe(true);
  });

  it("pairs native command_execution items under the fleet vocabulary", () => {
    const { ctx, calls } = makeCtx();
    handleEvent(
      {
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "ls -la",
          status: "in_progress",
        },
      } as unknown as ThreadEvent,
      ctx,
    );
    handleEvent(
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "ls -la",
          exit_code: 0,
          status: "completed",
        },
      } as unknown as ThreadEvent,
      ctx,
    );
    expect(calls).toEqual([
      { kind: "start", id: "cmd-1", name: "Bash" },
      { kind: "end", id: "cmd-1", name: "Bash", failed: undefined },
    ]);
  });

  it("never reports non-tool items (reasoning / agent_message)", () => {
    const { ctx, calls } = makeCtx();
    handleEvent(
      {
        type: "item.started",
        item: { id: "r1", type: "reasoning", text: "thinking…" },
      } as unknown as ThreadEvent,
      ctx,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("handlerToEvents — live tool lifecycle wiring", () => {
  function baseParams() {
    return {
      chatId: "chat-1",
      model: makeBareModelRef("codex", "stub-model"),
      text: "ping",
      senderName: "Ada",
    };
  }

  async function drain(stream: AsyncIterable<AgentEvent>) {
    const out: AgentEvent[] = [];
    for await (const e of stream) {
      out.push(e);
      if (e.type === "assistant_message") e.deliveryAck?.resolve();
    }
    return out;
  }

  const result = {
    text: "done",
    durationMs: 5,
    inputTokens: 1,
    outputTokens: 1,
    cacheRead: 0,
    cacheWrite: 0,
  };

  it("maps onToolStart/onToolEnd to tool_call/tool_result sharing the call id", async () => {
    const events = await drain(
      handlerToEvents(async (p: QueryParams) => {
        p.onToolStart?.("id-9", "Bash", { command: "sleep 2" });
        p.onToolEnd?.("id-9", "Bash");
        return result;
      }, baseParams()),
    );
    const call = events.find((e) => e.type === "tool_call");
    const res = events.find((e) => e.type === "tool_result");
    expect(call).toMatchObject({ id: "id-9", name: "Bash" });
    expect(res).toMatchObject({ id: "id-9", name: "Bash" });
    expect("error" in (res as object) ? undefined : null).toBeNull();
  });

  it("flushes an error tool_result for calls still open when the handler settles", async () => {
    const events = await drain(
      handlerToEvents(async (p: QueryParams) => {
        p.onToolStart?.("id-open", "Bash", { command: "sleep 999" });
        return result; // never reports onToolEnd — e.g. abort mid-tool
      }, baseParams()),
    );
    const res = events.filter((e) => e.type === "tool_result");
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      id: "id-open",
      name: "Bash",
      error: "tool did not complete",
    });
  });

  it("ignores onToolEnd for ids it never saw start", async () => {
    const events = await drain(
      handlerToEvents(async (p: QueryParams) => {
        p.onToolEnd?.("ghost", "Bash");
        return result;
      }, baseParams()),
    );
    expect(events.some((e) => e.type === "tool_result")).toBe(false);
  });
});
