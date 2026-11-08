/**
 * Boot-time reconciliation of per-chat backend/model overrides — the loop
 * that used to run serially inside initBackendAndDispatcher. Chats are
 * independent, so it runs bounded-concurrent; the pool dedupes inits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileChatBindings } from "../bootstrap.js";
import {
  getAllChatSettings,
  getChatModelForBackend,
  loadChatSettings,
  setChatBackend,
  setChatModel,
  setChatModelForBackend,
} from "../storage/chat-settings.js";
import { getRecentHistory, pushMessage } from "../storage/history.js";
import {
  getArchivedSessions,
  getSession,
  setSessionId,
} from "../storage/sessions.js";
import { stubBackend } from "./helpers/stub-backend.js";
import type { TalonConfig } from "../core/config/index.js";

const config = {} as TalonConfig;
function message(msgId: number, text: string) {
  return {
    msgId,
    senderId: 1,
    senderName: "User",
    text,
    timestamp: Date.now(),
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deps(
  overrides: Partial<Parameters<typeof reconcileChatBindings>[1]> = {},
) {
  return {
    isBackendAvailable: vi.fn(() => true),
    releaseChat: vi.fn(async () => {}),
    rebindChat: vi.fn(async () => ({ ok: true })),
    getBackendIdForChat: vi.fn(() => "claude"),
    getBackendForChat: vi.fn(() => stubBackend()),
    isModelValidForBackend: vi.fn(async () => true),
    ...overrides,
    notify: vi.fn<(text: string) => void>(),
  };
}

beforeEach(() => {
  loadChatSettings();
  for (const cid of Object.keys(getAllChatSettings())) {
    setChatBackend(cid, undefined);
    setChatModel(cid, undefined);
  }
});

describe("reconcileChatBindings", () => {
  it("rebinds every chat with an override, several at a time", async () => {
    for (let i = 0; i < 12; i++) setChatBackend(`chat-${i}`, "claude");
    let inFlight = 0;
    let peak = 0;
    const d = deps({
      rebindChat: vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight--;
        return { ok: true };
      }),
    });
    await reconcileChatBindings(config, d);
    expect(d.rebindChat).toHaveBeenCalledTimes(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("moves a chat whose backend is gone to the default, keeping its history", async () => {
    const chat = `gone-${Date.now()}`;
    setChatBackend(chat, "vanished");
    setChatModelForBackend(chat, "claude", "sonnet");
    setSessionId(chat, "sess-vanished-1");
    pushMessage(chat, message(1, "hello"));
    const d = deps({ isBackendAvailable: vi.fn(() => false) });
    await reconcileChatBindings(config, d);
    expect(d.releaseChat).toHaveBeenCalledWith(chat);
    expect(getAllChatSettings()[chat]?.backend).toBeUndefined();
    // Per-backend picks survive; only the unreachable binding goes.
    expect(getChatModelForBackend(chat, "claude")).toBe("sonnet");
    // Fresh backend session, old id archived, history untouched.
    expect(getSession(chat).sessionId).toBeUndefined();
    expect(getArchivedSessions(chat)).toEqual([
      expect.objectContaining({
        sessionId: "sess-vanished-1",
        reason: "backend-unavailable",
      }),
    ]);
    expect(getRecentHistory(chat).map((m) => m.text)).toEqual(["hello"]);
    expect(d.notify).toHaveBeenCalledOnce();
    expect(d.notify.mock.calls[0]?.[0]).toContain(chat);
  });

  it("falls back to the default when a pinned model is invalid — history and session kept", async () => {
    const chat = `stale-${Date.now()}`;
    setChatModel(chat, "retired-model"); // legacy slot, no backend binding
    setSessionId(chat, "sess-keep-1");
    pushMessage(chat, message(1, "first"));
    pushMessage(chat, message(2, "second"));
    const d = deps({ isModelValidForBackend: vi.fn(async () => false) });
    await reconcileChatBindings(config, d);
    expect(getAllChatSettings()[chat]?.model).toBeUndefined();
    expect(getSession(chat).sessionId).toBe("sess-keep-1");
    expect(getArchivedSessions(chat)).toEqual([]);
    expect(getRecentHistory(chat).map((m) => m.text)).toEqual([
      "first",
      "second",
    ]);
    expect(d.notify).toHaveBeenCalledOnce();
    expect(d.notify.mock.calls[0]?.[0]).toMatch(
      /retired-model unavailable → backend default/,
    );
  });

  it("remaps a <model>[1m] pin the catalog no longer lists to its base model", async () => {
    const chat = `onem-${Date.now()}`;
    setChatBackend(chat, "claude");
    setChatModelForBackend(chat, "claude", "opus[1m]");
    setSessionId(chat, "sess-1m");
    pushMessage(chat, message(1, "keep me"));
    const d = deps({
      isModelValidForBackend: vi.fn(
        async (_be, model: string) => model === "opus",
      ),
    });
    await reconcileChatBindings(config, d);
    expect(getChatModelForBackend(chat, "claude")).toBe("opus");
    expect(getSession(chat).sessionId).toBe("sess-1m");
    expect(getRecentHistory(chat).map((m) => m.text)).toEqual(["keep me"]);
    expect(d.notify.mock.calls[0]?.[0]).toContain("opus[1m] → opus");
  });

  it("leaves an unmappable per-backend pick alone for the send-time resolver", async () => {
    const chat = `pick-${Date.now()}`;
    setChatBackend(chat, "claude");
    setChatModelForBackend(chat, "claude", "retired-model");
    const d = deps({ isModelValidForBackend: vi.fn(async () => false) });
    await reconcileChatBindings(config, d);
    expect(getChatModelForBackend(chat, "claude")).toBe("retired-model");
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("says nothing when every binding is still valid", async () => {
    setChatBackend("fine", "claude");
    setChatModelForBackend("fine", "claude", "sonnet");
    const d = deps();
    await reconcileChatBindings(config, d);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("keeps the setting when a rebind fails twice", async () => {
    vi.useFakeTimers();
    try {
      setChatBackend("flaky", "claude");
      const d = deps({
        rebindChat: vi.fn(async () => ({ ok: false, error: "boom" })),
      });
      const run = reconcileChatBindings(config, d);
      await vi.advanceTimersByTimeAsync(2_000);
      await run;
      expect(d.rebindChat).toHaveBeenCalledTimes(2);
      expect(getAllChatSettings().flaky?.backend).toBe("claude");
    } finally {
      vi.useRealTimers();
    }
  });
});
