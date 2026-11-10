/**
 * WhatsApp chat-history parity — persisted message keys, date-bounded
 * search, get_message_by_id, download_media with re-upload, and passive
 * recording of group messages the bot was not asked to answer.
 *
 * The socket and the media downloader are stubbed; the message-key,
 * history and chat stores run against the per-worker SQLite file.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../util/watchdog.js", () => ({
  recordMessageProcessed: vi.fn(),
  recordMessageReceived: vi.fn(),
}));
vi.mock("../storage/daily-log.js", () => ({ appendDailyLog: vi.fn() }));
const execute = vi.fn(async () => {});
vi.mock("../core/engine/dispatcher.js", () => ({
  execute: (...args: unknown[]) => execute(...(args as [])),
}));
const saveInboundMedia = vi.fn(async () => undefined as unknown);
vi.mock("../frontend/whatsapp/messages/media-store.js", () => ({
  saveInboundMedia: (...args: unknown[]) => saveInboundMedia(...(args as [])),
}));

import {
  lookupByWaId,
  lookupMessage,
  rememberMessage,
  resetMessageStore,
  resolveKey,
} from "../frontend/whatsapp/messages/message-store.js";
import { maxWhatsAppMsgId } from "../storage/whatsapp-messages.js";
import { historyHandlers as coreHistory } from "../core/engine/gateway-actions/history.js";
import { historyHandlers } from "../frontend/whatsapp/actions/history.js";
import { handleInbound } from "../frontend/whatsapp/messages/inbound.js";
import { resetWhatsAppRegistry } from "../frontend/whatsapp/registry.js";
import {
  getHistoryMessage,
  getRecentHistory,
  pushMessage,
} from "../storage/history.js";
import { purgeChat as deleteChat } from "../storage/repositories/history-repo.js";

const CHAT = "wa_dm_5550001";
const chat = {
  chatId: CHAT,
  numericChatId: 900001,
  jid: "5550001@s.whatsapp.net",
  isGroup: false,
};

function ctxWith(sock: Record<string, unknown> = {}) {
  return {
    sock: { updateMediaMessage: vi.fn(async (m: unknown) => m), ...sock },
    gateway: { incrementMessages: vi.fn() },
    chat,
    scheduledMessages: new Map(),
  } as never;
}

beforeEach(() => {
  resetMessageStore();
  resetWhatsAppRegistry();
  deleteChat(CHAT);
  deleteChat("wa_group_123");
  execute.mockClear();
  saveInboundMedia.mockReset();
  saveInboundMedia.mockResolvedValue(undefined);
});

describe("persisted message keys", () => {
  it("resolves keys evicted from memory from SQLite, proto intact", () => {
    const mediaKey = new Uint8Array([1, 2, 3, 250]);
    const first = rememberMessage({
      key: {
        id: "WA-FIRST",
        remoteJid: "5550001@s.whatsapp.net",
        fromMe: false,
        participant: "5550001@s.whatsapp.net",
      },
      chatId: CHAT,
      text: "the photo",
      senderName: "Ada",
      message: {
        key: { id: "WA-FIRST", remoteJid: "5550001@s.whatsapp.net" },
        message: { imageMessage: { mediaKey, mimetype: "image/jpeg" } },
      } as never,
    });
    // Push the first entry out of the bounded in-memory cache.
    for (let i = 0; i < 2_100; i++) {
      rememberMessage({
        key: { id: `WA-${i}`, remoteJid: "x@s.whatsapp.net" },
        chatId: CHAT,
      });
    }
    const stored = lookupMessage(first);
    expect(stored?.key).toMatchObject({
      id: "WA-FIRST",
      fromMe: false,
      participant: "5550001@s.whatsapp.net",
    });
    expect(stored?.senderName).toBe("Ada");
    const image = stored?.message?.message?.imageMessage;
    expect(image?.mimetype).toBe("image/jpeg");
    expect(Array.from(image?.mediaKey as Uint8Array)).toEqual([1, 2, 3, 250]);

    expect(lookupByWaId("WA-FIRST")?.msgId).toBe(first);
    const resolved = resolveKey(first, CHAT);
    expect("key" in resolved && resolved.key.id).toBe("WA-FIRST");
    // Re-delivery of an evicted id keeps its number.
    expect(
      rememberMessage({
        key: { id: "WA-FIRST", remoteJid: "5550001@s.whatsapp.net" },
        chatId: CHAT,
      }),
    ).toBe(first);
  });

  it("exposes the highest persisted id for the restart seed", () => {
    expect(maxWhatsAppMsgId()).toBeUndefined();
    const a = rememberMessage({
      key: { id: "A", remoteJid: "x" },
      chatId: CHAT,
    });
    const b = rememberMessage({
      key: { id: "B", remoteJid: "x" },
      chatId: CHAT,
    });
    expect(maxWhatsAppMsgId()).toBe(Math.max(a, b));
  });
});

describe("search_history with a date range", () => {
  it("returns only matches inside [after, before)", async () => {
    const day = 24 * 60 * 60 * 1000;
    const base = Date.parse("2026-03-10T12:00:00Z");
    for (const [i, text] of [
      "flight early",
      "flight middle",
      "flight late",
    ].entries()) {
      pushMessage(CHAT, {
        msgId: 1_000_000 + i,
        senderId: 1,
        senderName: "Ada",
        text,
        timestamp: base + i * day,
      });
    }
    const all = await coreHistory.search_history(
      { query: "flight" },
      CHAT as never,
      undefined,
      String(CHAT as never),
    );
    expect(all?.text).toContain("flight early");
    expect(all?.text).toContain("flight late");

    const windowed = await coreHistory.search_history(
      { query: "flight", after: "2026-03-11", before: "2026-03-12" },
      CHAT as never,
      undefined,
      String(CHAT as never),
    );
    expect(windowed?.text).toContain("flight middle");
    expect(windowed?.text).not.toContain("flight early");
    expect(windowed?.text).not.toContain("flight late");

    const open = await coreHistory.search_history(
      { query: "flight", after: "2026-03-12" },
      CHAT as never,
      undefined,
      String(CHAT as never),
    );
    expect(open?.text).toContain("flight late");
    expect(open?.text).not.toContain("flight middle");
  });
});

describe("get_message_by_id", () => {
  it("returns the stored row, pointing at download_media for unsaved media", async () => {
    pushMessage(CHAT, {
      msgId: 1_000_005,
      senderId: 1,
      senderName: "Ada",
      text: "boarding pass",
      timestamp: Date.now(),
      mediaType: "document",
      filePath: "/nonexistent/boarding.pdf",
    });
    const found = await historyHandlers.get_message_by_id(
      { message_id: "1000005" },
      900001,
      ctxWith(),
    );
    expect(found?.ok).toBe(true);
    expect(found?.text).toContain("boarding pass");
    expect(found?.text).toContain("download_media 1000005");

    const missing = await historyHandlers.get_message_by_id(
      { message_id: 42 },
      900001,
      ctxWith(),
    );
    expect(missing?.ok).toBe(false);
  });
});

describe("download_media", () => {
  it("answers a saved file without touching the socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "talon-wa-media-"));
    const filePath = join(dir, "pic.jpg");
    writeFileSync(filePath, "jpeg");
    const msgId = rememberMessage({
      key: { id: "PIC", remoteJid: "5550001@s.whatsapp.net" },
      chatId: CHAT,
    });
    pushMessage(CHAT, {
      msgId,
      senderId: 1,
      senderName: "Ada",
      text: "",
      timestamp: Date.now(),
      mediaType: "photo",
      filePath,
    });
    const result = await historyHandlers.download_media(
      { message_id: msgId },
      900001,
      ctxWith(),
    );
    expect(result).toMatchObject({ ok: true, file_path: filePath });
    expect(saveInboundMedia).not.toHaveBeenCalled();
  });

  it("re-downloads from the retained proto with the socket's re-upload request", async () => {
    const message = {
      key: { id: "OLD", remoteJid: "5550001@s.whatsapp.net" },
      message: { imageMessage: { mediaKey: new Uint8Array([9]) } },
    } as never;
    const msgId = rememberMessage({
      key: { id: "OLD", remoteJid: "5550001@s.whatsapp.net" },
      chatId: CHAT,
      senderName: "Ada",
      message,
    });
    pushMessage(CHAT, {
      msgId,
      senderId: 1,
      senderName: "Ada",
      text: "",
      timestamp: Date.now(),
      mediaType: "photo",
    });
    saveInboundMedia.mockResolvedValueOnce({
      filePath: "/ws/uploads/old.jpg",
      type: "photo",
    });
    const ctx = ctxWith();
    const result = await historyHandlers.download_media(
      { message_id: msgId },
      900001,
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      file_path: "/ws/uploads/old.jpg",
    });
    const [msgArg, chatArg, idArg, senderArg, retrieval] = saveInboundMedia.mock
      .calls[0] as unknown[];
    expect((msgArg as { key: { id: string } }).key.id).toBe("OLD");
    expect([chatArg, idArg, senderArg]).toEqual([CHAT, msgId, "Ada"]);
    expect((retrieval as { reuploadRequest: unknown }).reuploadRequest).toBe(
      (ctx as { sock: { updateMediaMessage: unknown } }).sock
        .updateMediaMessage,
    );
    // History now knows where the file is.
    expect(getHistoryMessage(CHAT, msgId)?.filePath).toBe(
      "/ws/uploads/old.jpg",
    );
  });

  it("refuses ids from another chat or with no retained proto", async () => {
    const foreign = rememberMessage({
      key: { id: "F", remoteJid: "other@s.whatsapp.net" },
      chatId: "wa_dm_other",
    });
    const wrong = await historyHandlers.download_media(
      { message_id: foreign },
      900001,
      ctxWith(),
    );
    expect(wrong?.error).toMatch(/different chat/);

    const bare = rememberMessage({
      key: { id: "B", remoteJid: "5550001@s.whatsapp.net" },
      chatId: CHAT,
    });
    const noProto = await historyHandlers.download_media(
      { message_id: bare },
      900001,
      ctxWith(),
    );
    expect(noProto?.error).toMatch(/not retained/);
  });
});

describe("passive group recording", () => {
  function runtime() {
    return {
      config: { botDisplayName: "Talon" },
      gateway: { backend: null, incrementMessages: vi.fn() },
      settings: {
        respondMode: "mention",
        groupPolicy: "listed",
        sendReadReceipts: false,
      },
      allowedDms: new Set(["100"]),
      allowedGroups: new Set(["123"]),
      groupAllowCache: new Map(),
      selfIds: ["999"],
      sock: {
        sendMessage: vi.fn(async () => ({ key: { id: "S", remoteJid: "x" } })),
      },
      stopping: false,
      reconnectDelay: 0,
      unpairedNotified: false,
    } as never;
  }
  const groupMessage = (id: string, content: Record<string, unknown>) =>
    ({
      key: {
        remoteJid: "123@g.us",
        participant: "100@s.whatsapp.net",
        id,
        fromMe: false,
      },
      message: content,
      messageTimestamp: 1_700_000_000,
      pushName: "Alice",
    }) as never;

  it("records unmentioned group messages without running a turn", async () => {
    await handleInbound(
      runtime(),
      groupMessage("G1", { conversation: "chatter before the mention" }),
    );
    expect(execute).not.toHaveBeenCalled();
    const rows = getRecentHistory("wa_group_123", 5);
    expect(rows.map((r) => [r.senderName, r.text])).toEqual([
      ["Alice", "chatter before the mention"],
    ]);
    expect(lookupByWaId("G1")?.chatId).toBe("wa_group_123");

    await handleInbound(
      runtime(),
      groupMessage("G2", {
        extendedTextMessage: {
          text: "@999 what did I just say?",
          contextInfo: { mentionedJid: ["999@s.whatsapp.net"] },
        },
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(getRecentHistory("wa_group_123", 5)).toHaveLength(2);
  });
});
