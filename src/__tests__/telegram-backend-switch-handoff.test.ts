/**
 * Backend-switch session handoff.
 *
 * Switching a chat's backend from the `/model` menu cleared Talon's own
 * stores (session row, history, pulse checkpoint) but never touched the
 * backend capability slots that `performSessionReset` drives. Two things
 * fell through:
 *
 *   - the OUTGOING backend's in-process per-chat state survived. Clearing
 *     Talon's stores does nothing to a backend that keeps its own map —
 *     openai-agents holds a `MemorySession` keyed by chat id — so
 *     switching away and back resurrected the conversation the operator
 *     had just dropped.
 *   - the INCOMING backend was never warmed, so the first turn after a
 *     switch paid the whole cold start. On OpenCode/Kilo that is session
 *     creation plus a per-plugin MCP registration sweep.
 *
 * Same contract `performSessionReset` already implements; this covers the
 * switch path, for both an explicit pick and a revert to the default.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import type { Backend } from "../core/agent-runtime/capabilities.js";
import type { UnifiedModelInfo } from "../core/types.js";
import { stubBackend } from "./helpers/stub-backend.js";
import {
  initBackendPool,
  resetBackendPoolForTest,
} from "../core/engine/backend-controller/index.js";
import {
  registerBackend,
  clearBackends,
  type BackendFactory,
} from "../core/agent-runtime/backend-registry.js";
import { handleModelCallback } from "../frontend/telegram/callbacks/model.js";
import type { TalonConfig } from "../core/config/index.js";
import {
  getChatHistoryState,
  getRecentHistory,
  pushMessage,
} from "../storage/history.js";

let nextChatId = 7000;
function freshChat(): string {
  nextChatId += 1;
  return `bsw-${nextChatId}`;
}

const resetChatA = vi.fn();
const warmSessionA = vi.fn(async () => {});
const resetChatB = vi.fn();
const warmSessionB = vi.fn(async () => {});

function makeBackend(
  label: string,
  hooks: { resetChat: () => void; warmSession: () => Promise<void> },
): Backend {
  const model: UnifiedModelInfo = {
    id: "active-id",
    displayName: "Active",
    provider: label,
    providerName: label,
    selectable: true,
    reasoning: false,
  };
  return stubBackend({
    label,
    query: vi.fn(),
    resetChat: hooks.resetChat,
    warmSession: hooks.warmSession,
    getModelInfo: vi.fn().mockResolvedValue(model),
    resolveModel: vi.fn().mockResolvedValue({
      kind: "exact" as const,
      storedValue: model.id,
      model,
    }),
    getSettingsPresentation: vi.fn().mockResolvedValue({
      modelButtons: [],
      page: 1,
      totalPages: 1,
      filter: "all",
      freeCount: 0,
      totalCount: 0,
      modelDetails: [],
      view: "models",
    }),
  });
}

function makeFactory(id: string, label: string, backend: Backend) {
  return {
    id,
    label,
    async init() {
      return { backend };
    },
  } satisfies BackendFactory;
}

const baseConfig = {
  model: "model-a",
  workspace: "/tmp/test",
  backend: "be-a",
  enabledBackends: ["be-a", "be-b"],
} as unknown as TalonConfig;

/** Minimal grammy callback-query ctx. */
function makeCtx(cid: string) {
  return {
    chat: { id: cid },
    callbackQuery: { id: "cbq-1", data: "" },
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageText: vi.fn(async () => {}),
  } as never;
}

beforeEach(async () => {
  resetChatA.mockClear();
  warmSessionA.mockClear();
  resetChatB.mockClear();
  warmSessionB.mockClear();
  resetBackendPoolForTest();
  clearBackends();
  registerBackend(
    makeFactory(
      "be-a",
      "Backend A",
      makeBackend("Backend A", {
        resetChat: resetChatA,
        warmSession: warmSessionA,
      }),
    ),
  );
  registerBackend(
    makeFactory(
      "be-b",
      "Backend B",
      makeBackend("Backend B", {
        resetChat: resetChatB,
        warmSession: warmSessionB,
      }),
    ),
  );
  await initBackendPool(baseConfig, {
    getBridgePort: () => 0,
    frontendName: "telegram",
  });
});

afterEach(() => {
  resetBackendPoolForTest();
  clearBackends();
});

describe("backend switch hands the session over", () => {
  it("resets the outgoing backend and warms the incoming one", async () => {
    const cid = freshChat();
    await handleModelCallback(makeCtx(cid), "model:backend:be-b", cid, {
      config: baseConfig,
      gateway: {} as never,
    } as never);

    // Outgoing backend must drop its in-process state for this chat.
    expect(resetChatA).toHaveBeenCalledWith(cid);
    // Incoming backend gets warmed so the first turn isn't a cold start.
    // The warm is fire-and-forget, so let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(warmSessionB).toHaveBeenCalledWith(cid);
    // The incoming backend is not the one being reset.
    expect(resetChatB).not.toHaveBeenCalled();
  });

  it("hands off when reverting to the default backend too", async () => {
    const cid = freshChat();
    await handleModelCallback(makeCtx(cid), "model:backend:be-b", cid, {
      config: baseConfig,
      gateway: {} as never,
    } as never);
    resetChatA.mockClear();
    resetChatB.mockClear();
    warmSessionA.mockClear();
    warmSessionB.mockClear();

    await handleModelCallback(makeCtx(cid), "model:backend-default", cid, {
      config: baseConfig,
      gateway: {} as never,
    } as never);

    // Reverting drops the override — B was live, so B is the one reset.
    expect(resetChatB).toHaveBeenCalledWith(cid);
    await new Promise((r) => setTimeout(r, 0));
    expect(warmSessionA).toHaveBeenCalledWith(cid);
  });

  it("survives a backend whose warm rejects", async () => {
    warmSessionB.mockRejectedValueOnce(new Error("server down"));
    const cid = freshChat();

    // A failed warm must not surface as a failed switch — the switch has
    // already been committed by the time the warm runs.
    await expect(
      handleModelCallback(makeCtx(cid), "model:backend:be-b", cid, {
        config: baseConfig,
        gateway: {} as never,
      } as never),
    ).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(resetChatA).toHaveBeenCalledWith(cid);
  });

  it("never touches chat history — on a switch or a revert", async () => {
    const cid = freshChat();
    pushMessage(cid, {
      msgId: 1,
      senderId: 1,
      senderName: "Ada",
      text: "weeks of history",
      timestamp: Date.now(),
    });
    await handleModelCallback(makeCtx(cid), "model:backend:be-b", cid, {
      config: baseConfig,
      gateway: {} as never,
    } as never);
    expect(getRecentHistory(cid).map((m) => m.text)).toEqual([
      "weeks of history",
    ]);
    await handleModelCallback(makeCtx(cid), "model:backend-default", cid, {
      config: baseConfig,
      gateway: {} as never,
    } as never);
    expect(getRecentHistory(cid).map((m) => m.text)).toEqual([
      "weeks of history",
    ]);
    // Not even a soft reset: the new backend sees the same conversation.
    expect(getChatHistoryState(cid)).toBeUndefined();
  });
});
