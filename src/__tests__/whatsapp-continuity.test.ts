/**
 * WhatsApp session continuity — the pieces that make a fresh session able
 * to reconstruct the conversation, and a broken turn visible in the chat.
 *
 * 1. Outbound recording: the bot's own replies must land in persistent
 *    history, or read/search_chat_history shows a one-sided chat.
 * 2. Id seeding: the in-memory msg-id counter restarts at its base every
 *    boot while history persists; unseeded, post-restart messages re-issue
 *    ids INSERT OR IGNORE silently drops.
 * 3. Paging: the read_history fallback must honor offset_id/before — the
 *    tool schema advertises them, and WhatsApp has no platform override.
 * 4. Turn recovery: a failed turn must surface a friendly error in the
 *    chat (with one retry for brief transients), not just a log line.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  rememberMessage,
  resetMessageStore,
  seedMessageStore,
  lookupMessage,
} from "../frontend/whatsapp/messages/message-store.js";
import {
  sendContent,
  setWhatsAppBotName,
} from "../frontend/whatsapp/actions/send.js";
import {
  runTurnWithRecovery,
  shouldReplyToCatchUp,
  CATCH_UP_REPLY_WINDOW_MS,
} from "../frontend/whatsapp/messages/turn-recovery.js";
import { historyHandlers } from "../core/engine/gateway-actions/history.js";
import {
  pushMessage,
  getRecentHistory,
  maxMsgIdForChatPrefix,
} from "../storage/history.js";
import { purgeChat as deleteChat } from "../storage/repositories/history-repo.js";
import { TalonError } from "../core/errors.js";

const CHAT = "wa_dm_5550001";

const fakeChat = {
  chatId: CHAT,
  numericChatId: 900001,
  jid: "5550001@s.whatsapp.net",
  isGroup: false,
} as never;

function fakeCtx(sendResult: unknown = undefined) {
  const sock = {
    sendMessage: vi.fn(async () => sendResult),
  };
  const gateway = { incrementMessages: vi.fn() };
  return { sock: sock as never, gateway, mocks: { sock } };
}

beforeEach(() => {
  resetMessageStore();
  deleteChat(CHAT);
  deleteChat("wa_dm_other");
});

describe("outbound history recording", () => {
  it("persists the bot's reply alongside inbound messages", async () => {
    setWhatsAppBotName("Talon");
    pushMessage(CHAT, {
      msgId: 1_000_000,
      senderId: 42,
      senderName: "Ada",
      text: "what time is the flight?",
      timestamp: Date.now() - 1000,
    });

    const ctx = fakeCtx({ key: { id: "WA1", remoteJid: "x", fromMe: true } });
    seedMessageStore(1_000_001);
    await sendContent(ctx, fakeChat, { text: "Departure is 07:35 from DUB." });

    const rows = getRecentHistory(CHAT, 10);
    expect(rows.map((r) => [r.senderName, r.text])).toEqual([
      ["Ada", "what time is the flight?"],
      ["Talon", "Departure is 07:35 from DUB."],
    ]);
    // The bot row uses the cross-frontend assistant sender id.
    expect(rows[1].senderId).toBe(0);
  });

  it("records media sends with their caption and type", async () => {
    const ctx = fakeCtx({ key: { id: "WA2", remoteJid: "x", fromMe: true } });
    await sendContent(ctx, fakeChat, {
      image: { url: "/tmp/x.jpg" },
      caption: "the boarding pass",
    } as never);

    const [row] = getRecentHistory(CHAT, 1);
    expect(row.text).toBe("the boarding pass");
    expect(row.mediaType).toBe("photo");
  });

  it("does not write empty rows for reaction-like payloads", async () => {
    const ctx = fakeCtx({ key: { id: "WA3", remoteJid: "x", fromMe: true } });
    // Location has no text/caption and no history media type → marker text.
    await sendContent(ctx, fakeChat, {
      location: { degreesLatitude: 1, degreesLongitude: 2 },
    } as never);
    const rows = getRecentHistory(CHAT, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("[location]");
  });
});

describe("message-id seeding across restarts", () => {
  it("continues past what history already holds", () => {
    // Simulate the previous run: history rows up to 1_000_012.
    pushMessage(CHAT, {
      msgId: 1_000_012,
      senderId: 42,
      senderName: "Ada",
      text: "old",
      timestamp: Date.now(),
    });

    // Simulate the restart: fresh counter, then the boot-time seed.
    resetMessageStore();
    seedMessageStore((maxMsgIdForChatPrefix("wa_") ?? 0) + 1);

    const id = rememberMessage({
      key: { id: "WAX", remoteJid: "x" },
      chatId: CHAT,
    });
    expect(id).toBeGreaterThan(1_000_012);

    // And the history insert is not silently IGNOREd.
    pushMessage(CHAT, {
      msgId: id,
      senderId: 42,
      senderName: "Ada",
      text: "new after restart",
      timestamp: Date.now(),
    });
    const rows = getRecentHistory(CHAT, 10);
    expect(rows.map((r) => r.text)).toContain("new after restart");
  });

  it("matches the wa_ prefix literally, not as a LIKE wildcard", () => {
    // "waX..." must not satisfy the "wa_" prefix — _ is a LIKE wildcard
    // unless escaped, and an unescaped match would seed from foreign chats.
    pushMessage("waXfoo", {
      msgId: 9_999_999,
      senderId: 1,
      senderName: "x",
      text: "not a whatsapp chat",
      timestamp: Date.now(),
    });
    try {
      expect(maxMsgIdForChatPrefix("wa_") ?? 0).toBeLessThan(9_999_999);
    } finally {
      deleteChat("waXfoo");
    }
  });

  it("never lowers the counter", () => {
    seedMessageStore(2_000_000);
    seedMessageStore(5); // a later, lower seed must not rewind
    const id = rememberMessage({
      key: { id: "WAY", remoteJid: "x" },
      chatId: CHAT,
    });
    expect(id).toBeGreaterThanOrEqual(2_000_000);
    expect(lookupMessage(id)?.chatId).toBe(CHAT);
  });
});

describe("read_history fallback paging", () => {
  beforeEach(() => {
    const base = Date.parse("2026-08-01T00:00:00Z");
    for (let i = 0; i < 10; i++) {
      pushMessage(CHAT, {
        msgId: 1_000_000 + i,
        senderId: 42,
        senderName: "Ada",
        text: `message ${i}`,
        timestamp: base + i * 60_000,
      });
    }
  });

  it("pages back with offset_id", async () => {
    const res = (await historyHandlers.read_history(
      { offset_id: 1_000_005, limit: 3 },
      CHAT as never,
      undefined,
      String(CHAT as never),
    )) as { ok: boolean; text: string };
    expect(res.ok).toBe(true);
    expect(res.text).toContain("message 2");
    expect(res.text).toContain("message 4");
    expect(res.text).not.toContain("message 5");
    expect(res.text).not.toContain("message 9");
  });

  it("pages back with a before date", async () => {
    const res = (await historyHandlers.read_history(
      { before: "2026-08-01T00:03:00Z", limit: 10 },
      CHAT as never,
      undefined,
      String(CHAT as never),
    )) as { ok: boolean; text: string };
    expect(res.text).toContain("message 2");
    expect(res.text).not.toContain("message 3");
  });

  it("still returns the newest window with no cursor", async () => {
    const res = (await historyHandlers.read_history(
      { limit: 2 },
      CHAT as never,
      undefined,
      String(CHAT as never),
    )) as {
      ok: boolean;
      text: string;
    };
    expect(res.text).toContain("message 9");
    expect(res.text).not.toContain("message 0");
  });

  it("ignores an unparseable before date rather than failing", async () => {
    const res = (await historyHandlers.read_history(
      { before: "not-a-date", limit: 2 },
      CHAT as never,
      undefined,
      String(CHAT as never),
    )) as { ok: boolean; text: string };
    expect(res.ok).toBe(true);
    expect(res.text).toContain("message 9");
  });
});

describe("turn recovery — errors reach the chat", () => {
  const noWait = () => Promise.resolve();

  it("sends a friendly error for a non-retryable failure", async () => {
    const sent: string[] = [];
    await runTurnWithRecovery({
      chatId: CHAT,
      senderName: "Ada",
      runTurn: async () => {
        throw new TalonError("boom", { reason: "unknown" });
      },
      sendErrorText: async (t) => {
        sent.push(t);
      },
      wait: noWait,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].length).toBeGreaterThan(0);
  });

  it("retries a transient once and stays silent when the retry succeeds", async () => {
    const sent: string[] = [];
    let calls = 0;
    await runTurnWithRecovery({
      chatId: CHAT,
      senderName: "Ada",
      runTurn: async () => {
        calls++;
        if (calls === 1)
          throw new TalonError("overloaded", {
            reason: "overloaded",
            retryable: true,
          });
      },
      sendErrorText: async (t) => {
        sent.push(t);
      },
      wait: noWait,
    });
    expect(calls).toBe(2);
    expect(sent).toHaveLength(0);
  });

  it("reports the failure when the retry also fails", async () => {
    const sent: string[] = [];
    await runTurnWithRecovery({
      chatId: CHAT,
      senderName: "Ada",
      runTurn: async () => {
        throw new TalonError("overloaded", {
          reason: "overloaded",
          retryable: true,
        });
      },
      sendErrorText: async (t) => {
        sent.push(t);
      },
      wait: noWait,
    });
    expect(sent).toHaveLength(1);
  });

  it("stays silent for a user-initiated stop", async () => {
    const sent: string[] = [];
    await runTurnWithRecovery({
      chatId: CHAT,
      senderName: "Ada",
      runTurn: async () => {
        throw new TalonError("Turn stopped by user", { reason: "stopped" });
      },
      sendErrorText: async (t) => {
        sent.push(t);
      },
      wait: noWait,
    });
    expect(sent).toHaveLength(0);
  });
});

describe("catch-up (offline-queued) reply policy", () => {
  it("replies to a message queued during a short restart", () => {
    const now = Date.parse("2026-08-23T12:00:00Z");
    const fiveMinAgo = now - 5 * 60_000;
    expect(shouldReplyToCatchUp(fiveMinAgo, now)).toBe(true);
  });

  it("records but does not reply past the window", () => {
    const now = Date.parse("2026-08-23T12:00:00Z");
    const hourAgo = now - 60 * 60_000;
    expect(shouldReplyToCatchUp(hourAgo, now)).toBe(false);
  });

  it("is inclusive at the boundary", () => {
    const now = Date.parse("2026-08-23T12:00:00Z");
    expect(shouldReplyToCatchUp(now - CATCH_UP_REPLY_WINDOW_MS, now)).toBe(
      true,
    );
    expect(shouldReplyToCatchUp(now - CATCH_UP_REPLY_WINDOW_MS - 1, now)).toBe(
      false,
    );
  });

  it("treats a missing timestamp as fresh — better one odd reply than a dropped question", () => {
    expect(shouldReplyToCatchUp(0)).toBe(true);
    expect(shouldReplyToCatchUp(Number.NaN)).toBe(true);
  });
});
