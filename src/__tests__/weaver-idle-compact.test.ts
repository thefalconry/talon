/**
 * The Weaver's half of idle compaction (docs/cache-economics.md PR C): a
 * queued turn tells the compactor first (cancel the timer, abort a pass
 * that has not landed), the precompute hand-off runs right before the
 * backend on the turn's own model, the timer is armed when the turn
 * settles, compaction tasks queue on the chat's Thread behind turns, the
 * prompt is never touched, and a disabled policy builds nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryParams } from "../backend/runtime/turn/handler-types.js";
import type { ExecuteParams } from "../core/types.js";
import type { IdleCompactorDeps } from "../core/weaver/idle-compact.js";
import { stubBackend, stubResolveActiveModel } from "./helpers/stub-backend.js";

const order: string[] = [];
const built: IdleCompactorDeps[] = [];

vi.mock("../core/weaver/idle-compact.js", async (importActual) => ({
  ...(await importActual<typeof import("../core/weaver/idle-compact.js")>()),
  IdleCompactor: class {
    constructor(deps: IdleCompactorDeps) {
      built.push(deps);
    }
    onTurnQueued(chatId: string) {
      order.push(`queued:${chatId}`);
    }
    async beforeTurn(chatId: string, modelId: string) {
      order.push(`before:${chatId}:${modelId}`);
    }
    onTurnSettled(chatId: string) {
      order.push(`settled:${chatId}`);
    }
  },
}));

const { Weaver } = await import("../core/weaver/index.js");

function params(prompt = "hello"): ExecuteParams {
  return {
    chatId: "chat-ic",
    numericChatId: 1,
    prompt,
    senderName: "Ada",
    isGroup: false,
    source: "trigger",
  };
}

function makeWeaver(enabled: boolean) {
  const seen: QueryParams[] = [];
  const backend = stubBackend({
    query: vi.fn(async (q: QueryParams) => {
      order.push("turn");
      seen.push(q);
      return {
        text: "ok",
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
    resolveActiveModel: stubResolveActiveModel("claude", "opus-x"),
    context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
    sendTyping: vi.fn(async () => {}),
    idleCompact: {
      enabled,
      minContextTokens: 200_000,
      mode: "precompute",
      onTurn: "wait",
    },
  });
  return { weaver, seen, backend };
}

beforeEach(() => {
  order.length = 0;
  built.length = 0;
});

describe("Weaver idle compaction", () => {
  it("builds no compactor while the policy is disabled", async () => {
    const { weaver, seen } = makeWeaver(false);
    await weaver.runTurn(params());
    expect(built).toHaveLength(0);
    expect(order).toEqual(["turn"]);
    expect(seen[0]!.text).toBe("hello");
  });

  it("queued → hand-off on the turn's model → turn → settled; the prompt is untouched", async () => {
    const { weaver, seen } = makeWeaver(true);
    await weaver.runTurn(params());
    expect(order).toEqual([
      "queued:chat-ic",
      "before:chat-ic:opus-x",
      "turn",
      "settled:chat-ic",
    ]);
    expect(seen[0]!.text).toBe("hello");
  });

  it("resolves the next turn's model and the chat's backend for the compactor", async () => {
    const { backend } = makeWeaver(true);
    const deps = built[0]!;
    expect(await deps.resolveModelId("chat-ic")).toBe("opus-x");
    expect(deps.getBackend("chat-ic")).toBe(backend);
  });

  it("queues compaction tasks on the chat's Thread, behind a running turn", async () => {
    const { weaver } = makeWeaver(true);
    const deps = built[0]!;
    const turn = weaver.runTurn(params());
    deps.enqueue("chat-ic", async () => {
      order.push("compact");
    });
    await turn;
    await vi.waitFor(() => expect(order).toContain("compact"));
    expect(order.indexOf("compact")).toBeGreaterThan(order.indexOf("turn"));
  });
});
