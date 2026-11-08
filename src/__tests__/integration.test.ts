/**
 * Integration test: dispatcher → backend (mocked) → result.
 * Tests the full query lifecycle without spawning actual SDK processes.
 */

import { describe, it, expect, vi } from "vitest";
import { initDispatcher, execute } from "../core/engine/dispatcher.js";
import { bus } from "../core/bus/index.js";
import type { ContextManager } from "../core/types.js";
import { stubBackend, stubResolveActiveModel } from "./helpers/stub-backend.js";
import { TalonError } from "../core/errors.js";

// Successful turns announce themselves on the bus (turn.completed) instead
// of an onActivity callback — one file-wide subscription, reset per setup.
let activityCount = 0;
bus.subscribe("turn.completed", () => {
  activityCount++;
});

function setup(
  overrides: { queryResult?: Record<string, unknown>; queryError?: Error } = {},
) {
  const acquired: number[] = [];
  const released: number[] = [];
  const typingCalls: number[] = [];
  activityCount = 0;

  const query = vi.fn(async () => {
    if (overrides.queryError) throw overrides.queryError;
    return {
      text: "test response",
      durationMs: 50,
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 5,
      cacheWrite: 3,
      ...overrides.queryResult,
    };
  });
  const backend = stubBackend({ query });

  const context: ContextManager = {
    acquire: vi.fn((id: number) => acquired.push(id)),
    release: vi.fn((id: number) => released.push(id)),
    getMessageCount: vi.fn(() => 0),
  };

  initDispatcher({
    getBackend: () => backend,
    resolveActiveModel: stubResolveActiveModel(),
    context,
    sendTyping: vi.fn(async (id: number) => {
      typingCalls.push(id);
    }),
  });

  return {
    backend,
    query,
    context,
    acquired,
    released,
    typingCalls,
    getActivityCount: () => activityCount,
  };
}

describe("integration: dispatcher lifecycle", () => {
  it("full happy path: acquire → type → query → activity → release", async () => {
    const { query, acquired, released, typingCalls, getActivityCount } =
      setup();

    const result = await execute({
      chatId: "123",
      numericChatId: 123,
      prompt: "hello world",
      senderName: "TestUser",
      isGroup: false,
      source: "message",
    });

    expect(result.text).toBe("test response");
    expect(result.durationMs).toBe(50);
    expect(result.bridgeMessageCount).toBe(0);

    // Context lifecycle
    expect(acquired).toEqual([123]);
    expect(released).toEqual([123]);

    // Typing was sent
    expect(typingCalls).toEqual([123]);

    // Activity callback fired
    expect(getActivityCount()).toBe(1);

    // Backend was called with correct params
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "123",
        text: "hello world",
        senderName: "TestUser",
        isGroup: false,
      }),
    );
  });

  it("error path: context released even on failure", async () => {
    const { released } = setup({ queryError: new Error("SDK crashed") });

    await expect(
      execute({
        chatId: "456",
        numericChatId: 456,
        prompt: "will fail",
        senderName: "User",
        isGroup: false,
        source: "message",
      }),
    ).rejects.toThrow("SDK crashed");

    expect(released).toEqual([456]);
  });

  it("classified error path: TalonError propagated", async () => {
    const { released } = setup({
      queryError: new TalonError("rate limited", {
        reason: "rate_limit",
        retryable: true,
        retryAfterMs: 5000,
      }),
    });

    try {
      await execute({
        chatId: "789",
        numericChatId: 789,
        prompt: "will rate limit",
        senderName: "User",
        isGroup: false,
        source: "message",
      });
      expect.unreachable();
    } catch (err) {
      // The dispatcher consumes the backend's `AgentEvent` stream
      // directly and rethrows the `error` terminator as `AgentRunError`,
      // carrying the canonical `AgentError`. The classification is
      // preserved.
      const { AgentRunError } = await import("../core/agent-runtime/events.js");
      expect(err).toBeInstanceOf(AgentRunError);
      const bridged = err as InstanceType<typeof AgentRunError>;
      expect(bridged.kind).toBe("rate_limit");
      expect(bridged.retryable).toBe(true);
    }

    expect(released).toEqual([789]);
  });

  it("cross-chat parallel execution", async () => {
    const order: string[] = [];
    const backend = stubBackend({
      query: vi.fn(async (params) => {
        order.push(`start:${params.chatId}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end:${params.chatId}`);
        return {
          text: "",
          durationMs: 20,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }),
    });

    initDispatcher({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context: {
        acquire: () => {},
        release: () => {},
        getMessageCount: () => 0,
      },
      sendTyping: async () => {},
    });

    // Fire two queries simultaneously
    await Promise.all([
      execute({
        chatId: "A",
        numericChatId: 1,
        prompt: "a",
        senderName: "U",
        isGroup: false,
        source: "message",
      }),
      execute({
        chatId: "B",
        numericChatId: 2,
        prompt: "b",
        senderName: "U",
        isGroup: false,
        source: "message",
      }),
    ]);

    // True concurrency — both start before either ends
    expect(order[0]).toBe("start:A");
    expect(order[1]).toBe("start:B");
  });

  it("events are forwarded from the backend's stream to the caller's onEvent sink", async () => {
    // The dispatcher consumes `backend.chat.runChatTurn` and forwards
    // every `AgentEvent` straight to the caller's `onEvent` sink — no
    // callback bridge. This test verifies a backend's `text_delta` /
    // `assistant_message` events reach the frontend verbatim.
    const { backend } = setup();
    const deltas: string[] = [];
    let block: string | undefined;
    // Override the backend's chat slot with one that emits text via
    // the wrapped legacy callbacks (handlerToEvents relays them as
    // text_delta events).
    backend.chat!.runChatTurn = (params) =>
      (async function* () {
        yield { type: "run_started" };
        yield { type: "text_delta", text: "hello" };
        yield { type: "assistant_message", text: "hello world" };
        yield {
          type: "usage",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
            modelId: params.model.id,
          },
        };
        yield {
          type: "completed",
          result: {
            text: "hello world",
            durationMs: 1,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            modelId: params.model.id,
          },
        };
      })();

    await execute({
      chatId: "999",
      numericChatId: 999,
      prompt: "stream test",
      senderName: "User",
      isGroup: true,
      source: "cron",
      onEvent: (event) => {
        if (event.type === "text_delta") deltas.push(event.text);
        if (event.type === "assistant_message") {
          block = event.text;
        }
      },
    });

    expect(deltas).toContain("hello");
    expect(block).toBe("hello world");
  });
});
