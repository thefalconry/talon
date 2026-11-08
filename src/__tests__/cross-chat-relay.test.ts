/**
 * Cross-chat relay — a session that messages another chat via send_via
 * hears about the replies.
 *
 * The behaviour that matters: subscribe on send, queue on inbound,
 * drain exactly once into the next turn, and stay silent for the
 * overwhelming majority of chats nobody ever cross-sent into.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  RELAY_MAX_PENDING,
  RELAY_MAX_TEXT,
  RELAY_TTL_MS,
  formatRelayBlock,
  noteCrossSend,
  relayInbound,
  resetCrossChatRelay,
  takePendingRelay,
} from "../core/engine/cross-chat-relay.js";
import { handleChatFreeAction } from "../core/engine/gateway-actions/index.js";
import { registerCrossSendTarget } from "../core/engine/gateway-actions/cross-send.js";

describe("cross-chat relay", () => {
  beforeEach(() => resetCrossChatRelay());

  it("queues a reply for the chat that messaged in", () => {
    noteCrossSend("tg_123", "wa_dm_447700900103");
    expect(relayInbound("wa_dm_447700900103", "Grace", "on my way")).toBe(1);
    expect(takePendingRelay("tg_123")).toEqual([
      "Grace (in wa_dm_447700900103): on my way",
    ]);
  });

  it("stays silent for a chat nobody cross-sent into", () => {
    expect(relayInbound("wa_dm_999", "Someone", "hello")).toBe(0);
    expect(takePendingRelay("tg_123")).toEqual([]);
  });

  it("drains exactly once, so a reply is not re-read every turn", () => {
    noteCrossSend("tg_123", "wa_dm_1");
    relayInbound("wa_dm_1", "Grace", "hi");
    expect(takePendingRelay("tg_123")).toHaveLength(1);
    expect(takePendingRelay("tg_123")).toEqual([]);
  });

  it("fans one reply out to every subscribed chat", () => {
    noteCrossSend("tg_123", "wa_dm_1");
    noteCrossSend("discord_9", "wa_dm_1");
    expect(relayInbound("wa_dm_1", "Grace", "hi")).toBe(2);
    expect(takePendingRelay("tg_123")).toHaveLength(1);
    expect(takePendingRelay("discord_9")).toHaveLength(1);
  });

  it("ignores a chat sending into itself", () => {
    noteCrossSend("tg_123", "tg_123");
    expect(relayInbound("tg_123", "Ada", "hi")).toBe(0);
  });

  it("ignores a send with no identified caller", () => {
    noteCrossSend("", "wa_dm_1");
    expect(relayInbound("wa_dm_1", "Grace", "hi")).toBe(0);
  });

  it("refreshes the window on a repeat send rather than double-subscribing", () => {
    noteCrossSend("tg_123", "wa_dm_1");
    noteCrossSend("tg_123", "wa_dm_1");
    expect(relayInbound("wa_dm_1", "Grace", "hi")).toBe(1);
    expect(takePendingRelay("tg_123")).toHaveLength(1);
  });

  it("expires a subscription once the window has passed", () => {
    vi.useFakeTimers();
    try {
      noteCrossSend("tg_123", "wa_dm_1");
      vi.advanceTimersByTime(RELAY_TTL_MS + 1000);
      expect(relayInbound("wa_dm_1", "Grace", "too late")).toBe(0);
      expect(takePendingRelay("tg_123")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the newest lines when a burst exceeds the cap", () => {
    noteCrossSend("tg_123", "wa_dm_1");
    for (let i = 0; i < RELAY_MAX_PENDING + 5; i++) {
      relayInbound("wa_dm_1", "Grace", `msg ${i}`);
    }
    const queued = takePendingRelay("tg_123");
    expect(queued).toHaveLength(RELAY_MAX_PENDING);
    expect(queued.at(-1)).toContain(`msg ${RELAY_MAX_PENDING + 4}`);
  });

  it("truncates a very long message instead of eating the prompt", () => {
    noteCrossSend("tg_123", "wa_dm_1");
    relayInbound("wa_dm_1", "Grace", "x".repeat(RELAY_MAX_TEXT * 3));
    const [line] = takePendingRelay("tg_123");
    expect(line).toContain("truncated");
    expect(line.length).toBeLessThan(RELAY_MAX_TEXT * 2);
  });

  it("renders nothing for an empty drain, and a labelled block otherwise", () => {
    expect(formatRelayBlock([])).toBe("");
    const block = formatRelayBlock(["Grace (in wa_dm_1): hi"]);
    expect(block).toContain("Cross-chat");
    expect(block).toContain("- Grace (in wa_dm_1): hi");
    expect(block.endsWith("\n\n")).toBe(true);
  });
});

describe("send_via subscribes the calling chat", () => {
  beforeEach(() => resetCrossChatRelay());
  afterEach(() => registerCrossSendTarget("whatsapp", null));

  /** The bridge tags every call with the caller's chat as `_chatId`. */
  async function sendVia(extra: Record<string, unknown> = {}) {
    return handleChatFreeAction({
      action: "send_via",
      frontend: "whatsapp",
      target: "+447700900103",
      text: "hi",
      _chatId: "tg_123",
      ...extra,
    });
  }

  it("subscribes to the canonical chat id the frontend resolved", async () => {
    registerCrossSendTarget(
      "whatsapp",
      vi.fn(async () => ({
        ok: true,
        message_id: 1,
        chat_id: "wa_dm_447700900103",
      })),
    );
    expect((await sendVia())?.ok).toBe(true);
    // A phone number is not a chat id — the subscription must key off
    // what the frontend reported, or the reply never matches.
    expect(relayInbound("wa_dm_447700900103", "Grace", "hi back")).toBe(1);
    expect(takePendingRelay("tg_123")).toHaveLength(1);
  });

  it("falls back to the raw target when the frontend reports no chat id", async () => {
    registerCrossSendTarget(
      "whatsapp",
      vi.fn(async () => ({ ok: true })),
    );
    await sendVia({ target: "-1009876543210" });
    expect(relayInbound("-1009876543210", "Someone", "hi")).toBe(1);
  });

  it("does not subscribe when the send failed", async () => {
    registerCrossSendTarget(
      "whatsapp",
      vi.fn(async () => ({ ok: false, error: "not connected" })),
    );
    await sendVia();
    expect(relayInbound("+447700900103", "Grace", "hi")).toBe(0);
  });

  it("does not subscribe when the caller is unidentified", async () => {
    registerCrossSendTarget(
      "whatsapp",
      vi.fn(async () => ({ ok: true, chat_id: "wa_dm_1" })),
    );
    await sendVia({ _chatId: undefined });
    expect(relayInbound("wa_dm_1", "Grace", "hi")).toBe(0);
  });
});
