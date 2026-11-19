import { describe, expect, it, vi } from "vitest";
import type { QueryParams } from "../backend/runtime/turn/handler-types.js";
import { handlerToEvents } from "../backend/runtime/turn/handler-to-events.js";
import { Loom, Thread, Weaver } from "../core/weaver/index.js";
import { bus } from "../core/bus/index.js";
import { taskTable, type TaskRecord } from "../core/tasks/index.js";
import type { ExecuteParams } from "../core/types.js";
import { stubBackend, stubResolveActiveModel } from "./helpers/stub-backend.js";

function params(input: Partial<ExecuteParams> = {}): ExecuteParams {
  return {
    chatId: input.chatId ?? "chat",
    numericChatId: input.numericChatId ?? 1,
    prompt: input.prompt ?? "hello",
    senderName: input.senderName ?? "User",
    isGroup: input.isGroup ?? false,
    source: input.source ?? "message",
    onEvent: input.onEvent,
    modelOverride: input.modelOverride,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("weaver", () => {
  it("lazily creates one Thread per chat", () => {
    const loom = new Loom();

    const first = loom.thread("a");
    const second = loom.thread("a");
    const other = loom.thread("b");

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(loom.size()).toBe(2);
    expect(loom.chatIds()).toEqual(["a", "b"]);
  });

  it("evicts idle Threads and skips busy Threads", async () => {
    const loom = new Loom();
    const gate = deferred();
    const thread = loom.thread("busy");

    const run = thread.enqueue(async () => {
      await gate.promise;
      return "done";
    });

    await Promise.resolve();
    expect(loom.evict("busy")).toBe(false);

    gate.resolve();
    await run;
    await Promise.resolve();

    expect(loom.evict("busy")).toBe(true);
    expect(loom.get("busy")).toBeUndefined();
  });

  it("serializes same-chat turns FIFO through runTurn", async () => {
    const first = deferred();
    const second = deferred();
    const order: string[] = [];

    const backend = stubBackend({
      query: vi.fn(async (queryParams) => {
        order.push(`start:${queryParams.text}`);
        await (queryParams.text === "first" ? first.promise : second.promise);
        order.push(`end:${queryParams.text}`);
        return {
          text: queryParams.text,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }),
    });

    const weaver = new Weaver({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
    });

    const p1 = weaver.runTurn(params({ chatId: "same", prompt: "first" }));
    const p2 = weaver.runTurn(params({ chatId: "same", prompt: "second" }));

    await vi.waitFor(() => {
      expect(order).toEqual(["start:first"]);
    });

    first.resolve();
    await p1;
    await vi.waitFor(() => {
      expect(order).toEqual(["start:first", "end:first", "start:second"]);
    });

    second.resolve();
    await p2;
    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  it("runs different-chat turns in parallel through runTurn", async () => {
    const a = deferred();
    const b = deferred();
    const order: string[] = [];

    const backend = stubBackend({
      query: vi.fn(async (queryParams) => {
        order.push(`start:${queryParams.chatId}`);
        await (queryParams.chatId === "a" ? a.promise : b.promise);
        order.push(`end:${queryParams.chatId}`);
        return {
          text: queryParams.text,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }),
    });

    const weaver = new Weaver({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
    });

    const p1 = weaver.runTurn(params({ chatId: "a", prompt: "first" }));
    const p2 = weaver.runTurn(params({ chatId: "b", prompt: "second" }));

    await vi.waitFor(() => {
      expect(order).toEqual(["start:a", "start:b"]);
    });

    a.resolve();
    b.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start:a", "start:b", "end:a", "end:b"]);
  });
});

describe("weaver task registration", () => {
  // The weaver reports to the daemon-wide task table; tests share it, so
  // every case isolates by a chatId unique to this file.
  const turnTask = (chatId: string): TaskRecord | undefined =>
    taskTable
      .list()
      .filter((t) => t.kind === "turn" && t.chatId === chatId)
      .at(-1);

  function makeWeaver(backend = stubBackend()) {
    return new Weaver({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
    });
  }

  it("settles a completed turn as done with its warp binding and usage", async () => {
    const backend = stubBackend({
      query: async () => ({
        text: "ok",
        durationMs: 1,
        inputTokens: 11,
        outputTokens: 7,
        cacheRead: 3,
        cacheWrite: 2,
      }),
    });

    await makeWeaver(backend).runTurn(params({ chatId: "task-ok" }));

    expect(turnTask("task-ok")).toMatchObject({
      state: "done",
      label: "message",
      killable: false,
      model: "stub-model",
      backendId: "claude",
      usage: { inputTokens: 11, outputTokens: 7, cacheRead: 3, cacheWrite: 2 },
    });
  });

  it("settles a throwing turn as failed", async () => {
    const backend = stubBackend({
      query: async () => {
        throw new Error("backend exploded");
      },
    });

    await expect(
      makeWeaver(backend).runTurn(params({ chatId: "task-boom" })),
    ).rejects.toThrow("backend exploded");

    expect(turnTask("task-boom")).toMatchObject({
      state: "failed",
      error: expect.stringContaining("backend exploded"),
    });
  });

  it("settles a no-model refusal as done without a binding", async () => {
    const weaver = new Weaver({
      getBackend: () => stubBackend(),
      resolveActiveModel: async () => ({
        model: null,
        ref: null,
        backendId: "claude",
      }),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
    });

    await weaver.runTurn(params({ chatId: "task-refused" }));

    const record = turnTask("task-refused");
    expect(record).toMatchObject({ state: "done" });
    expect(record!.model).toBeUndefined();
  });

  it("shows a turn waiting in its chat's FIFO as queued", async () => {
    const gate = deferred();
    const backend = stubBackend({
      query: async (queryParams) => {
        if (queryParams.text === "first") await gate.promise;
        return {
          text: queryParams.text,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      },
    });
    const weaver = makeWeaver(backend);

    const p1 = weaver.runTurn(params({ chatId: "task-fifo", prompt: "first" }));
    const p2 = weaver.runTurn(
      params({ chatId: "task-fifo", prompt: "second" }),
    );

    await vi.waitFor(() => {
      const states = taskTable
        .list()
        .filter((t) => t.chatId === "task-fifo")
        .map((t) => t.state);
      expect(states).toEqual(["running", "queued"]);
    });

    gate.resolve();
    await Promise.all([p1, p2]);
    const states = taskTable
      .list()
      .filter((t) => t.chatId === "task-fifo")
      .map((t) => t.state);
    expect(states).toEqual(["done", "done"]);
  });

  it("kills a running turn through the backend interrupt, settling killed with usage", async () => {
    const gate = deferred();
    const query = vi.fn(async () => {
      // The turn hangs until the interrupt fires, then closes cleanly
      // with the partial result — the interruptChatTurn contract.
      await gate.promise;
      return {
        text: "partial",
        durationMs: 1,
        inputTokens: 5,
        outputTokens: 2,
        cacheRead: 1,
        cacheWrite: 0,
      };
    });
    const interruptChatTurn = vi.fn(async () => {
      gate.resolve();
      return true;
    });
    const backend = stubBackend({
      chat: {
        runChatTurn: (p) => handlerToEvents(query, p),
        interruptChatTurn,
      },
    });
    const weaver = makeWeaver(backend);

    const turn = weaver.runTurn(params({ chatId: "task-kill" }));
    await vi.waitFor(() => {
      expect(turnTask("task-kill")).toMatchObject({
        state: "running",
        killable: true,
      });
    });

    expect(taskTable.kill(turnTask("task-kill")!.id)).toEqual({ ok: true });

    const result = await turn;
    expect(result.text).toBe("partial");
    expect(interruptChatTurn).toHaveBeenCalledWith("task-kill");
    expect(turnTask("task-kill")).toMatchObject({
      state: "killed",
      error: expect.stringContaining("interrupted"),
      usage: { inputTokens: 5, outputTokens: 2, cacheRead: 1, cacheWrite: 0 },
    });
  });

  it("kills a queued turn without starting it or interrupting the running one", async () => {
    const gate = deferred();
    const query = vi.fn(async (queryParams: QueryParams) => {
      if (queryParams.text === "first") await gate.promise;
      return {
        text: queryParams.text,
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    });
    const interruptChatTurn = vi.fn(async () => true);
    const backend = stubBackend({
      chat: {
        runChatTurn: (p) => handlerToEvents(query, p),
        interruptChatTurn,
      },
    });
    const weaver = makeWeaver(backend);

    const p1 = weaver.runTurn(
      params({ chatId: "task-qkill", prompt: "first" }),
    );
    const p2 = weaver.runTurn(
      params({ chatId: "task-qkill", prompt: "second" }),
    );
    await vi.waitFor(() => {
      const states = taskTable
        .list()
        .filter((t) => t.chatId === "task-qkill")
        .map((t) => t.state);
      expect(states).toEqual(["running", "queued"]);
    });

    const queued = taskTable
      .list()
      .find((t) => t.chatId === "task-qkill" && t.state === "queued")!;
    expect(taskTable.kill(queued.id)).toEqual({ ok: true });
    // The started guard: a queued turn's kill must never signal the
    // backend — that would interrupt the chat's currently running turn.
    expect(interruptChatTurn).not.toHaveBeenCalled();

    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.text).toBe("first");
    expect(r2.text).toContain("killed before it started");
    // The killed turn never reached the backend.
    expect(query).toHaveBeenCalledTimes(1);
    const states = taskTable
      .list()
      .filter((t) => t.chatId === "task-qkill")
      .map((t) => t.state);
    expect(states).toEqual(["done", "killed"]);
  });
});

describe("weaver turn.started event", () => {
  it("publishes once per executed turn, but not on a no-model refusal", async () => {
    const started = vi.fn();
    const unsubscribe = bus.subscribe("turn.started", (event) => {
      if (event.chatId === "hooked") started(event);
    });
    const backend = stubBackend();
    let model: ReturnType<typeof stubResolveActiveModel> | null =
      stubResolveActiveModel();
    const weaver = new Weaver({
      getBackend: () => backend,
      resolveActiveModel: async () =>
        model ? model() : { model: null, ref: null, backendId: "claude" },
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
    });

    try {
      await weaver.runTurn(params({ chatId: "hooked" }));
      expect(started).toHaveBeenCalledTimes(1);
      expect(started.mock.calls[0]![0]).toMatchObject({
        model: "stub-model",
        backendId: "claude",
        source: "message",
      });

      model = null; // next resolution refuses the turn
      const refused = await weaver.runTurn(params({ chatId: "hooked" }));
      expect(refused.text).toContain("No model selected");
      expect(started).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});

describe("thread execution context", () => {
  it("brackets a turn: acquire resets the per-turn counter, release clears", () => {
    const thread = new Thread("c");
    expect(thread.contextActive).toBe(false);
    expect(thread.busy).toBe(false);

    thread.acquireContext(42);
    expect(thread.contextActive).toBe(true);
    expect(thread.busy).toBe(true);
    expect(thread.numericChatId).toBe(42);
    expect(thread.messageCount).toBe(0);

    thread.noteMessageSent();
    thread.noteMessageSent();
    expect(thread.messageCount).toBe(2);

    thread.releaseContext();
    expect(thread.contextActive).toBe(false);

    // The next turn's first acquire starts a fresh per-turn counter.
    thread.acquireContext(42);
    expect(thread.messageCount).toBe(0);
  });

  it("ref-counts re-entrant context holds", () => {
    const thread = new Thread("c");
    thread.acquireContext(1);
    thread.acquireContext(1);
    thread.releaseContext();
    expect(thread.contextActive).toBe(true);
    thread.releaseContext();
    expect(thread.contextActive).toBe(false);
  });
});

describe("loom context registry", () => {
  it("keys context on stringId, falling back to String(numeric)", () => {
    const loom = new Loom();

    // Telegram-style: no stringId — the numeric id IS the chat id.
    loom.acquireContext(123);
    expect(loom.get("123")).toBeDefined();
    expect(loom.hasActiveContext(123)).toBe(true);
    expect(loom.numericForStringId("123")).toBe(123);

    // Teams/Discord-style: an explicit non-numeric string id.
    loom.acquireContext(456, "chat:abc");
    expect(loom.get("chat:abc")?.numericChatId).toBe(456);
    expect(loom.numericForStringId("chat:abc")).toBe(456);
    expect(loom.activeContextCount()).toBe(2);
  });

  it("resolves a numeric id back to its string chat id only while a context is held", () => {
    const loom = new Loom();
    expect(loom.stringIdForNumeric(456)).toBeNull();

    loom.acquireContext(456, "d_abc");
    expect(loom.stringIdForNumeric(456)).toBe("d_abc");
    loom.acquireContext(123);
    expect(loom.stringIdForNumeric(123)).toBe("123");

    loom.releaseContext(456);
    expect(loom.stringIdForNumeric(456)).toBeNull();
  });

  it("remembers a chat's string id after its turn, without reporting it active", () => {
    const loom = new Loom();
    expect(loom.lastStringIdForNumeric(456)).toBeNull();

    loom.acquireContext(456, "d_abc");
    loom.releaseContext(456);

    expect(loom.lastStringIdForNumeric(456)).toBe("d_abc");
    expect(loom.stringIdForNumeric(456)).toBeNull();
    expect(loom.hasActiveContext(456)).toBe(false);
  });

  it("drops the oldest remembered chat id at the bound", () => {
    const loom = new Loom();
    for (let i = 1; i <= 1025; i++) {
      loom.acquireContext(i, `d_${i}`);
      loom.releaseContext(i);
    }
    expect(loom.lastStringIdForNumeric(1)).toBeNull();
    expect(loom.lastStringIdForNumeric(2)).toBe("d_2");
    expect(loom.lastStringIdForNumeric(1025)).toBe("d_1025");
  });

  it("resolves to the same Thread the Weaver serializes the turn on", () => {
    const loom = new Loom();
    const serial = loom.thread("chat:abc"); // runTurn keys here (params.chatId)
    const ctx = loom.acquireContext(456, "chat:abc"); // context keys here
    expect(ctx).toBe(serial);
  });

  it("tracks message count against the active context and resets on re-acquire", () => {
    const loom = new Loom();
    loom.acquireContext(7);
    loom.noteMessageSent(7);
    expect(loom.messageCount(7)).toBe(1);

    loom.releaseContext(7);
    expect(loom.messageCount(7)).toBe(0); // numeric index cleared
    expect(loom.hasActiveContext(7)).toBe(false);

    loom.acquireContext(7);
    expect(loom.messageCount(7)).toBe(0); // fresh per turn
  });

  it("releases context by a Teams-style non-numeric string id", () => {
    const loom = new Loom();
    loom.acquireContext(99, "19:abc");
    expect(loom.hasActiveContext(99)).toBe(true);
    loom.releaseContext("19:abc");
    expect(loom.hasActiveContext(99)).toBe(false);
  });

  it("keeps the numeric id as the refcount identity across calls", () => {
    const loom = new Loom();
    // A re-entrant acquire for a numeric that already holds a context refs the
    // same Thread even if the second call omits the string id.
    const first = loom.acquireContext(7003, "teams-thread-xyz");
    const second = loom.acquireContext(7003);
    expect(second).toBe(first);

    loom.releaseContext("teams-thread-xyz");
    expect(loom.hasActiveContext(7003)).toBe(true); // refCount 1
    loom.releaseContext(7003);
    expect(loom.hasActiveContext(7003)).toBe(false); // refCount 0
  });
});

describe("warp + snapshot", () => {
  it("bindWarp reports drift only when the model or backend changes", () => {
    const thread = new Thread("c");
    expect(
      thread.bindWarp({
        model: "m1",
        backendId: "claude",
        overridden: false,
        boundAt: 1,
      }).drifted,
    ).toBe(false);
    expect(
      thread.bindWarp({
        model: "m1",
        backendId: "claude",
        overridden: false,
        boundAt: 2,
      }).drifted,
    ).toBe(false);
    const result = thread.bindWarp({
      model: "m2",
      backendId: "claude",
      overridden: false,
      boundAt: 3,
    });
    expect(result.drifted).toBe(true);
    expect(result.previous?.model).toBe("m1");
  });

  it("reports the resolved warp + session per live Thread after a turn", async () => {
    const backend = stubBackend();
    const weaver = new Weaver({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel("claude", "stub-model"),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
    });

    await weaver.runTurn(params({ chatId: "snap", numericChatId: 5 }));

    const entry = weaver.snapshot().find((s) => s.chatId === "snap");
    expect(entry).toBeDefined();
    expect(entry?.warp?.model).toBe("stub-model");
    expect(entry?.warp?.backendId).toBe("claude");
    expect(entry?.warp?.overridden).toBe(false);
    expect(entry?.session.turns).toBe(0);
  });
});
