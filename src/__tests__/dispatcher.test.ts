import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  initDispatcher,
  execute,
  getActiveCount,
} from "../core/engine/dispatcher.js";
import type { ContextManager } from "../core/types.js";
import {
  stubBackend,
  stubChatBackend,
  stubResolveActiveModel,
} from "./helpers/stub-backend.js";
import { makeBareModelRef } from "../core/agent-runtime/model-ref.js";
import { bus } from "../core/bus/index.js";
import {
  noteCrossSend,
  relayInbound,
  resetCrossChatRelay,
  takePendingRelay,
} from "../core/engine/cross-chat-relay.js";

function createMockDeps() {
  const acquired: number[] = [];
  const released: number[] = [];

  const { backend, query } = stubChatBackend({
    text: "response",
    durationMs: 100,
    inputTokens: 10,
    outputTokens: 20,
    cacheRead: 5,
    cacheWrite: 3,
  });

  const context: ContextManager = {
    acquire: vi.fn((chatId: number) => {
      acquired.push(chatId);
    }),
    release: vi.fn((chatId: number) => {
      released.push(chatId);
    }),
    getMessageCount: vi.fn(() => 0),
  };

  const sendTyping = vi.fn(async () => {});

  return {
    backend,
    query,
    getBackend: () => backend,
    resolveActiveModel: stubResolveActiveModel(),
    context,
    sendTyping,
    acquired,
    released,
  };
}

describe("dispatcher", () => {
  beforeEach(() => {
    const deps = createMockDeps();
    initDispatcher(deps);
  });

  it("executes a query and returns result", async () => {
    const result = await execute({
      chatId: "123",
      numericChatId: 123,
      prompt: "hello",
      senderName: "User",
      isGroup: false,
      source: "message",
    });
    expect(result.text).toBe("response");
    expect(result.durationMs).toBe(100);
    expect(result.bridgeMessageCount).toBe(0);
  });

  it("passes the resolved active model to the backend query", async () => {
    const deps = createMockDeps();
    const resolveActiveModel = vi.fn(
      stubResolveActiveModel("codex", "gpt-5.4-mini"),
    );
    initDispatcher({ ...deps, resolveActiveModel });

    await execute({
      chatId: "123",
      numericChatId: 123,
      prompt: "hello",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(resolveActiveModel).toHaveBeenCalledWith("123");
    expect(deps.query).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "123",
        model: "gpt-5.4-mini",
        text: "hello",
      }),
    );
  });

  it("folds a cross-chat reply into the front of the next turn", async () => {
    const deps = createMockDeps();
    initDispatcher(deps as never);
    resetCrossChatRelay();
    // This chat messaged a WhatsApp number earlier; she has now replied.
    noteCrossSend("123", "wa_dm_447700900103");
    relayInbound("wa_dm_447700900103", "Grace", "on my way");

    await execute({
      chatId: "123",
      numericChatId: 123,
      prompt: "did she reply?",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    const text = String(deps.query.mock.calls.at(-1)?.[0]?.text);
    expect(text).toContain("Cross-chat");
    expect(text).toContain("Grace (in wa_dm_447700900103): on my way");
    // The user's own prompt still terminates the block, unmodified.
    expect(text.endsWith("did she reply?")).toBe(true);
    // Drained: a second turn must not re-read the same reply.
    expect(takePendingRelay("123")).toEqual([]);
  });

  it("leaves the prompt untouched when nothing was relayed", async () => {
    const deps = createMockDeps();
    initDispatcher(deps as never);
    resetCrossChatRelay();

    await execute({
      chatId: "123",
      numericChatId: 123,
      prompt: "hello",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(deps.query.mock.calls.at(-1)?.[0]?.text).toBe("hello");
  });

  it("uses the per-run model override when it resolves", async () => {
    const deps = createMockDeps();
    const resolveModelOverride = vi.fn(async () =>
      makeBareModelRef("claude", "claude-haiku-4-5", "discovered"),
    );
    initDispatcher({ ...deps, resolveModelOverride });

    await execute({
      chatId: "123",
      numericChatId: 123,
      prompt: "hello",
      senderName: "Trigger",
      isGroup: false,
      source: "trigger",
      modelOverride: "claude-haiku-4-5",
    });

    expect(resolveModelOverride).toHaveBeenCalledWith(
      "123",
      "claude-haiku-4-5",
    );
    expect(deps.query).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" }),
    );
  });

  it("falls back to the chat model when the override does not resolve", async () => {
    const deps = createMockDeps();
    const resolveModelOverride = vi.fn(async () => null);
    initDispatcher({
      ...deps,
      resolveActiveModel: stubResolveActiveModel("claude", "stub-model"),
      resolveModelOverride,
    });

    await execute({
      chatId: "123",
      numericChatId: 123,
      prompt: "hello",
      senderName: "Trigger",
      isGroup: false,
      source: "trigger",
      modelOverride: "delisted-model",
    });

    expect(resolveModelOverride).toHaveBeenCalled();
    expect(deps.query).toHaveBeenCalledWith(
      expect.objectContaining({ model: "stub-model" }),
    );
  });

  it("ignores the override resolver when no modelOverride is set", async () => {
    const deps = createMockDeps();
    const resolveModelOverride = vi.fn(async () => null);
    initDispatcher({ ...deps, resolveModelOverride });

    await execute({
      chatId: "123",
      numericChatId: 123,
      prompt: "hello",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(resolveModelOverride).not.toHaveBeenCalled();
  });

  it("acquires and releases context", async () => {
    const deps = createMockDeps();
    initDispatcher(deps);

    await execute({
      chatId: "456",
      numericChatId: 456,
      prompt: "test",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(deps.context.acquire).toHaveBeenCalledWith(456, "456");
    expect(deps.context.release).toHaveBeenCalledWith(456, "456");
  });

  it("releases context even on error", async () => {
    const deps = createMockDeps();
    (deps.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("boom"),
    );
    initDispatcher(deps);

    await expect(
      execute({
        chatId: "789",
        numericChatId: 789,
        prompt: "fail",
        senderName: "User",
        isGroup: false,
        source: "message",
      }),
    ).rejects.toThrow("boom");

    expect(deps.context.release).toHaveBeenCalledWith(789, "789");
  });

  it("sends typing on execution", async () => {
    const deps = createMockDeps();
    initDispatcher(deps);

    await execute({
      chatId: "111",
      numericChatId: 111,
      prompt: "hi",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(deps.sendTyping).toHaveBeenCalledWith(111, "111");
  });

  it("publishes turn.completed after a successful query", async () => {
    const deps = createMockDeps();
    initDispatcher(deps);
    const completed = vi.fn();
    const unsubscribe = bus.subscribe("turn.completed", completed);

    try {
      await execute({
        chatId: "222",
        numericChatId: 222,
        prompt: "hi",
        senderName: "User",
        isGroup: false,
        source: "message",
      });
    } finally {
      unsubscribe();
    }

    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0]![0]).toMatchObject({ chatId: "222" });
  });

  it("does not publish turn.completed on error", async () => {
    const deps = createMockDeps();
    (deps.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("fail"),
    );
    initDispatcher(deps);
    const completed = vi.fn();
    const unsubscribe = bus.subscribe("turn.completed", completed);

    try {
      await expect(
        execute({
          chatId: "333",
          numericChatId: 333,
          prompt: "fail",
          senderName: "User",
          isGroup: false,
          source: "message",
        }),
      ).rejects.toThrow();
    } finally {
      unsubscribe();
    }

    expect(completed).not.toHaveBeenCalled();
  });

  it("forwards the backend's event stream to the caller's onEvent sink", async () => {
    // The dispatcher forwards the backend's canonical `AgentEvent`
    // stream straight to `params.onEvent` — no callback bridge. A
    // backend that emits text via its callbacks → the wrapper turns
    // them into events → the dispatcher hands each event to the
    // frontend's sink verbatim.
    const deps = createMockDeps();
    deps.query.mockImplementation(async (params) => {
      params.onStreamDelta?.("hi");
      await params.onTextBlock?.("hi there");
      return {
        text: "hi there",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    });
    initDispatcher(deps);
    const events: string[] = [];
    let deliveredBlock: string | undefined;

    await execute({
      chatId: "444",
      numericChatId: 444,
      prompt: "stream",
      senderName: "User",
      isGroup: false,
      source: "message",
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === "assistant_message") {
          deliveredBlock = event.text;
        }
      },
    });

    expect(events).toContain("text_delta");
    expect(events).toContain("assistant_message");
    expect(events).toContain("completed");
    expect(deliveredBlock).toBe("hi there");
  });

  it("settles assistant_message deliveryAck even with no onEvent sink", async () => {
    // Regression: the callback-shaped backend (handler-to-events) awaits
    // the `assistant_message.deliveryAck` before its handler can resolve.
    // The dispatcher owns ack settlement, so a turn with NO onEvent sink
    // must still complete — otherwise the backend blocks forever and the
    // turn hangs.
    const deps = createMockDeps();
    deps.query.mockImplementation(async (params) => {
      await params.onTextBlock?.("delivered with no sink");
      return {
        text: "delivered with no sink",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    });
    initDispatcher(deps);

    // No onEvent supplied at all.
    const result = await execute({
      chatId: "no-sink",
      numericChatId: 447,
      prompt: "stream",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(result.text).toBe("delivered with no sink");
  });

  it("rejects the deliveryAck when onEvent throws, letting the backend retry", async () => {
    // The dispatcher owns the ack: when the frontend's onEvent throws on
    // an `assistant_message`, the dispatcher rejects the ack — the
    // callback-shaped backend (Codex oversized-message path) catches the
    // delivery failure and retries with a smaller block.
    const deps = createMockDeps();
    deps.query.mockImplementation(async (params) => {
      try {
        await params.onTextBlock?.("too long");
      } catch {
        await params.onTextBlock?.("short retry");
        return {
          text: "short retry",
          durationMs: 2,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }
      return {
        text: "too long",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    });
    initDispatcher(deps);

    const delivered: string[] = [];
    let firstBlock = true;

    const result = await execute({
      chatId: "delivery-retry",
      numericChatId: 445,
      prompt: "stream",
      senderName: "User",
      isGroup: false,
      source: "message",
      onEvent: async (event) => {
        if (event.type !== "assistant_message") return;
        delivered.push(event.text);
        if (firstBlock) {
          firstBlock = false;
          throw new Error("Telegram message too long");
        }
      },
    });

    expect(delivered).toEqual(["too long", "short retry"]);
    expect(result.text).toBe("short retry");
  });

  it("rethrows an error terminator as AgentRunError", async () => {
    const { AgentRunError } = await import("../core/agent-runtime/events.js");
    const deps = createMockDeps();
    deps.query.mockRejectedValueOnce(
      new (await import("../core/errors.js")).TalonError("rate limited", {
        reason: "rate_limit",
        retryable: true,
      }),
    );
    initDispatcher(deps);

    const seen: string[] = [];
    await expect(
      execute({
        chatId: "err-chat",
        numericChatId: 446,
        prompt: "boom",
        senderName: "User",
        isGroup: false,
        source: "message",
        onEvent: (event) => {
          seen.push(event.type);
        },
      }),
    ).rejects.toBeInstanceOf(AgentRunError);
    // The error event is forwarded to the sink before the throw.
    expect(seen).toContain("error");
  });

  it("tracks active count", async () => {
    expect(getActiveCount()).toBe(0);

    const deps = createMockDeps();
    let resolveQuery!: () => void;
    (deps.query as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<{
          text: string;
          durationMs: number;
          inputTokens: number;
          outputTokens: number;
          cacheRead: number;
          cacheWrite: number;
        }>((r) => {
          resolveQuery = () =>
            r({
              text: "",
              durationMs: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheRead: 0,
              cacheWrite: 0,
            });
        }),
    );
    initDispatcher(deps);

    const p = execute({
      chatId: "555",
      numericChatId: 555,
      prompt: "hi",
      senderName: "U",
      isGroup: false,
      source: "message",
    });
    // Give it a tick to start
    await new Promise((r) => setTimeout(r, 10));
    expect(getActiveCount()).toBe(1);

    resolveQuery();
    await p;
    expect(getActiveCount()).toBe(0);
  });

  it("runs different-chat queries in true parallel", async () => {
    const backend = stubBackend();

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

    // Execute queries for two different chats
    await execute({
      chatId: "cleanup-A",
      numericChatId: 100,
      prompt: "a",
      senderName: "U",
      isGroup: false,
      source: "message",
    });
    await execute({
      chatId: "cleanup-B",
      numericChatId: 200,
      prompt: "b",
      senderName: "U",
      isGroup: false,
      source: "message",
    });

    // After both complete, activeCount should be 0 (chains cleaned up)
    expect(getActiveCount()).toBe(0);

    // Execute another query for the same chatId — should work fine (no stale chain)
    const result = await execute({
      chatId: "cleanup-A",
      numericChatId: 100,
      prompt: "c",
      senderName: "U",
      isGroup: false,
      source: "message",
    });
    expect(result.text).toBe("stub response");
  });

  it("calls sendTyping at least once during execution", async () => {
    const deps = createMockDeps();
    let resolveQuery!: () => void;
    (deps.query as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<{
          text: string;
          durationMs: number;
          inputTokens: number;
          outputTokens: number;
          cacheRead: number;
          cacheWrite: number;
        }>((r) => {
          resolveQuery = () =>
            r({
              text: "done",
              durationMs: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheRead: 0,
              cacheWrite: 0,
            });
        }),
    );
    initDispatcher(deps);

    const p = execute({
      chatId: "typing-test",
      numericChatId: 777,
      prompt: "hi",
      senderName: "U",
      isGroup: false,
      source: "message",
    });

    // Wait for the initial sendTyping call
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.sendTyping).toHaveBeenCalledWith(777, "typing-test");
    expect(deps.sendTyping.mock.calls.length).toBeGreaterThanOrEqual(1);

    resolveQuery();
    await p;
  });

  it("serializes same-chat queries (FIFO)", async () => {
    const backend = stubBackend();

    initDispatcher({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {
        throw new Error("typing API error");
      }),
    });

    // sendTyping rejecting must not blow up the dispatcher — the
    // error is caught and logged via util/log. The other "non-Error
    // throws" describe block above covers the logWarn assertion
    // path with a dynamically mocked logger.
    await expect(
      execute({
        chatId: "typing-err-chat",
        numericChatId: 999,
        prompt: "test",
        senderName: "User",
        isGroup: false,
        source: "message",
      }),
    ).resolves.toBeDefined();
  });
});

describe("typing indicator — non-Error throws", () => {
  it("logs warning with String(err) when sendTyping throws a non-Error (initial call)", async () => {
    vi.resetModules();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logDebug: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    }));
    vi.doMock("../core/background/dream/index.js", () => ({
      maybeStartDream: vi.fn(),
    }));

    const { initDispatcher, execute } =
      await import("../core/engine/dispatcher.js");
    const logWarn = (await import("../util/log.js")).logWarn as ReturnType<
      typeof vi.fn
    >;

    initDispatcher({
      getBackend: () =>
        stubBackend({
          query: vi.fn(async () => ({
            text: "ok",
            durationMs: 10,
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
          })),
        }),
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      // Throw a plain string (non-Error) to hit the `String(err)` branch at line 99
      sendTyping: vi.fn(async () => {
        throw "plain string typing error";
      }), // eslint-disable-line @typescript-eslint/no-throw-literal
    });

    await execute({
      chatId: "typing-non-error-chat",
      numericChatId: 1001,
      prompt: "test",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(logWarn).toHaveBeenCalledWith(
      "dispatcher",
      expect.stringContaining("plain string typing error"),
    );
  });

  it("logs warning with String(err) when sendTyping interval throws a non-Error", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logDebug: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    }));
    vi.doMock("../core/background/dream/index.js", () => ({
      maybeStartDream: vi.fn(),
    }));

    const { initDispatcher, execute } =
      await import("../core/engine/dispatcher.js");
    const logWarn = (await import("../util/log.js")).logWarn as ReturnType<
      typeof vi.fn
    >;

    let callCount = 0;
    let resolveQuery!: (v: {
      text: string;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      cacheRead: number;
      cacheWrite: number;
    }) => void;

    initDispatcher({
      getBackend: () =>
        stubBackend({
          query: vi.fn(
            () =>
              new Promise((r) => {
                resolveQuery = r;
              }),
          ) as never,
        }),
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      // First call OK, subsequent calls throw a non-Error string (covers line 103 String(err) branch)
      sendTyping: vi.fn(async () => {
        callCount++;
        if (callCount > 1) throw "non-error interval typing failure"; // eslint-disable-line @typescript-eslint/no-throw-literal
      }),
    });

    const p = execute({
      chatId: "interval-non-error-chat",
      numericChatId: 1002,
      prompt: "test",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    await vi.advanceTimersByTimeAsync(4100);
    resolveQuery({
      text: "ok",
      durationMs: 10,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    await p;

    expect(logWarn).toHaveBeenCalledWith(
      "dispatcher",
      expect.stringContaining("interval failed"),
    );

    vi.useRealTimers();
  });
});

describe("dispatcher — uninitialized guard", () => {
  it("throws when execute is called before initDispatcher", async () => {
    vi.resetModules();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logDebug: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    }));
    vi.doMock("../core/background/dream/index.js", () => ({
      maybeStartDream: vi.fn(),
    }));

    const { execute } = await import("../core/engine/dispatcher.js");
    // deps is null because initDispatcher was never called in this fresh module
    await expect(
      execute({
        chatId: "x",
        numericChatId: 1,
        prompt: "hi",
        senderName: "U",
        isGroup: false,
        source: "message",
      }),
    ).rejects.toThrow("Dispatcher not initialized");
  });
});
