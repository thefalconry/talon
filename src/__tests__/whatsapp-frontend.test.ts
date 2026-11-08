/**
 * WhatsApp frontend — formatting translation, chat-id/JID mapping, the
 * message-key store, and the action adapter's contract with the gateway.
 *
 * The socket is stubbed: these pin the adapter's own logic (what it
 * sends, how it addresses messages, what it refuses), not Baileys.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  toWhatsAppChunks,
  toWhatsAppText,
} from "../frontend/whatsapp/formatting.js";
import {
  chatIdForJid,
  lookupWhatsAppChat,
  lookupWhatsAppChatByString,
  registerWhatsAppChat,
  resetWhatsAppRegistry,
} from "../frontend/whatsapp/registry.js";
import {
  lookupByWaId,
  rememberMessage,
  resetMessageStore,
  resolveKey,
} from "../frontend/whatsapp/messages/message-store.js";
import { createWhatsAppActionHandler } from "../frontend/whatsapp/actions/index.js";
import {
  canonicalId,
  identityAllowed,
  resetIdentityCache,
  resolveIdentity,
} from "../frontend/whatsapp/connection/identity.js";
import { isWhatsAppChatId } from "../core/frontend-runtime/chat-id.js";

describe("WhatsApp formatting", () => {
  it("translates Markdown emphasis into WhatsApp's dialect", () => {
    expect(toWhatsAppText("**bold** and *italic* and ~~gone~~")).toBe(
      "*bold* and _italic_ and ~gone~",
    );
  });

  it("leaves code spans and fenced blocks untouched", () => {
    // The regex approach this replaced would bold the asterisks inside.
    expect(toWhatsAppText("use `a * b` here")).toBe("use `a * b` here");
    expect(toWhatsAppText("```\nx = a ** b\n```")).toBe("```\nx = a ** b\n```");
  });

  it("does not treat underscores inside a URL as emphasis", () => {
    const url = "https://example.com/a_b_c";
    expect(toWhatsAppText(url)).toContain("a_b_c");
  });

  it("renders headings as bold and keeps link targets", () => {
    expect(toWhatsAppText("# Title")).toBe("*Title*");
    expect(toWhatsAppText("[docs](https://e.com)")).toBe(
      "docs (https://e.com)",
    );
  });

  it("keeps list structure with WhatsApp's own bullets", () => {
    expect(toWhatsAppText("- one\n- two")).toBe("- one\n- two");
    expect(toWhatsAppText("1. one\n2. two")).toBe("1. one\n2. two");
  });

  it("splits long text into sendable chunks", () => {
    const chunks = toWhatsAppChunks("x".repeat(9000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
  });
});

describe("WhatsApp chat ids", () => {
  beforeEach(() => resetWhatsAppRegistry());

  it("maps DM and group JIDs onto distinct namespaced ids", () => {
    expect(chatIdForJid("447700900101@s.whatsapp.net")).toBe(
      "wa_dm_447700900101",
    );
    expect(chatIdForJid("120363012345678901@g.us")).toBe(
      "wa_group_120363012345678901",
    );
  });

  it("claims only its own chat ids", () => {
    expect(isWhatsAppChatId("wa_dm_447700900101")).toBe(true);
    expect(isWhatsAppChatId("discord_dm_1")).toBe(false);
    expect(isWhatsAppChatId("-1009876543210")).toBe(false);
  });

  it("registers a chat once and finds it by numeric id", () => {
    const first = registerWhatsAppChat("447700900101@s.whatsapp.net");
    const again = registerWhatsAppChat("447700900101@s.whatsapp.net");
    expect(again).toBe(first);
    expect(lookupWhatsAppChat(first.numericChatId)?.jid).toBe(
      "447700900101@s.whatsapp.net",
    );
    expect(first.isGroup).toBe(false);
  });
});

describe("WhatsApp message store", () => {
  beforeEach(() => resetMessageStore());

  it("assigns one numeric id per WhatsApp message id", () => {
    const key = { id: "WA1", remoteJid: "x@s.whatsapp.net", fromMe: false };
    const first = rememberMessage({ key, chatId: "wa_dm_x", text: "hi" });
    const second = rememberMessage({ key, chatId: "wa_dm_x", text: "hi" });
    expect(second).toBe(first);
    expect(lookupByWaId("WA1")?.msgId).toBe(first);
  });

  it("resolves an id back to its key, scoped to the chat", () => {
    const msgId = rememberMessage({
      key: { id: "WA2", remoteJid: "x@s.whatsapp.net", fromMe: false },
      chatId: "wa_dm_x",
      text: "hi",
    });
    const ok = resolveKey(msgId, "wa_dm_x");
    expect("key" in ok && ok.key.id).toBe("WA2");

    const wrongChat = resolveKey(msgId, "wa_group_other");
    expect("error" in wrongChat && wrongChat.error).toMatch(/different chat/);

    const unknown = resolveKey(999, "wa_dm_x");
    expect("error" in unknown && unknown.error).toMatch(/Unknown message_id/);
  });
});

describe("WhatsApp action adapter", () => {
  const gateway = { incrementMessages: vi.fn() } as never;
  let sent: Array<{ jid: string; content: Record<string, unknown> }>;
  let sock: never;

  beforeEach(() => {
    resetWhatsAppRegistry();
    resetMessageStore();
    sent = [];
    sock = {
      sendMessage: vi.fn(
        async (jid: string, content: Record<string, unknown>) => {
          sent.push({ jid, content });
          return {
            key: { id: `S${sent.length}`, remoteJid: jid, fromMe: true },
          };
        },
      ),
      sendPresenceUpdate: vi.fn(async () => {}),
      groupMetadata: vi.fn(async () => ({
        subject: "The Group",
        desc: "about us",
        participants: [
          { id: "1@s.whatsapp.net", admin: "superadmin" },
          { id: "2@s.whatsapp.net", admin: null },
        ],
      })),
    } as never;
  });

  function handlerFor(jid: string) {
    const chat = registerWhatsAppChat(jid);
    const handle = createWhatsAppActionHandler(() => sock, gateway);
    return { handle, chat };
  }

  it("sends text translated into WhatsApp markup", async () => {
    const { handle, chat } = handlerFor("447700900101@s.whatsapp.net");
    const result = await handle(
      { action: "send_message", text: "**hi** there" },
      chat.numericChatId,
    );
    expect(result?.ok).toBe(true);
    expect(sent[0].content.text).toBe("*hi* there");
    expect(sent[0].jid).toBe("447700900101@s.whatsapp.net");
  });

  it("returns null for actions it does not own, so the core can serve them", async () => {
    const { handle, chat } = handlerFor("447700900101@s.whatsapp.net");
    expect(
      await handle({ action: "read_history" }, chat.numericChatId),
    ).toBeNull();
  });

  it("reacts to a message addressed by its numeric id", async () => {
    const { handle, chat } = handlerFor("447700900101@s.whatsapp.net");
    const msgId = rememberMessage({
      key: { id: "WA9", remoteJid: chat.jid, fromMe: false },
      chatId: chat.chatId,
      text: "hello",
    });
    const result = await handle(
      { action: "react", message_id: msgId, emoji: "👍" },
      chat.numericChatId,
    );
    expect(result?.ok).toBe(true);
    expect(sent[0].content).toEqual({
      react: {
        text: "👍",
        key: { id: "WA9", remoteJid: chat.jid, fromMe: false },
      },
    });
  });

  it("refuses to act on a message id it never saw", async () => {
    const { handle, chat } = handlerFor("447700900101@s.whatsapp.net");
    const result = await handle(
      { action: "delete_message", message_id: 424242 },
      chat.numericChatId,
    );
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toMatch(/Unknown message_id/);
  });

  it("renders button rows as a numbered list (no buttons on personal accounts)", async () => {
    const { handle, chat } = handlerFor("447700900101@s.whatsapp.net");
    await handle(
      {
        action: "send_message_with_buttons",
        text: "Pick one",
        rows: [[{ text: "Alpha" }, { text: "Beta" }]],
      },
      chat.numericChatId,
    );
    expect(sent[0].content.text).toBe("Pick one\n\n1. Alpha\n2. Beta");
  });

  it("reports group metadata for a group chat", async () => {
    const { handle, chat } = handlerFor("120363012345678901@g.us");
    const info = await handle({ action: "get_chat_info" }, chat.numericChatId);
    expect(info).toMatchObject({
      ok: true,
      type: "group",
      title: "The Group",
      member_count: 2,
    });
  });

  it("fails clearly when the socket is down", async () => {
    const { chat } = handlerFor("447700900101@s.whatsapp.net");
    const handle = createWhatsAppActionHandler(() => null, gateway);
    const result = await handle(
      { action: "send_message", text: "hi" },
      chat.numericChatId,
    );
    expect(result).toEqual({
      ok: false,
      error: "WhatsApp socket is not connected",
    });
  });

  it("fails clearly for a chat it has never seen", async () => {
    const handle = createWhatsAppActionHandler(() => sock, gateway);
    const result = await handle({ action: "send_message", text: "hi" }, 12345);
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toMatch(/No WhatsApp chat known/);
  });

  it("resolves a phone-number cross-send target and registers the chat", async () => {
    const handle = createWhatsAppActionHandler(() => sock, gateway);
    const result = await handle(
      { action: "send_message", text: "hi", target: "+353 87 123 4567" },
      0,
    );
    expect(result?.ok).toBe(true);
    expect(sent[0].jid).toBe("353871234567@s.whatsapp.net");
    // The caller named a phone number; report back the chat id it became,
    // so a cross-frontend caller can follow the thread it just started.
    expect(result?.chat_id).toBe(chatIdForJid("353871234567@s.whatsapp.net"));
    // Registered on the fly, so numeric-id routing and replies now work.
    const info = lookupWhatsAppChatByString("wa_dm_353871234567");
    expect(info?.jid).toBe("353871234567@s.whatsapp.net");
    expect(lookupWhatsAppChat(info!.numericChatId)).toBe(info);
  });

  it("resolves a wa_dm_ string target it has never seen", async () => {
    const handle = createWhatsAppActionHandler(() => sock, gateway);
    const result = await handle(
      { action: "send_message", text: "hi", target: "wa_dm_353871234567" },
      0,
    );
    expect(result?.ok).toBe(true);
    expect(sent[0].jid).toBe("353871234567@s.whatsapp.net");
  });

  it("resolves a registered numeric chat id target", async () => {
    const { chat } = handlerFor("447700900101@s.whatsapp.net");
    const handle = createWhatsAppActionHandler(() => sock, gateway);
    const result = await handle(
      {
        action: "send_message",
        text: "hi",
        target: String(chat.numericChatId),
      },
      0,
    );
    expect(result?.ok).toBe(true);
    expect(sent[0].jid).toBe("447700900101@s.whatsapp.net");
  });

  it("resolves a group JID target", async () => {
    const handle = createWhatsAppActionHandler(() => sock, gateway);
    const result = await handle(
      { action: "send_message", text: "hi", target: "120363012345678901@g.us" },
      0,
    );
    expect(result?.ok).toBe(true);
    expect(sent[0].jid).toBe("120363012345678901@g.us");
    expect(
      lookupWhatsAppChatByString("wa_group_120363012345678901")?.isGroup,
    ).toBe(true);
  });

  it("fails a cross-send clearly when the socket is down (no silent no-op)", async () => {
    const handle = createWhatsAppActionHandler(() => null, gateway);
    const result = await handle(
      { action: "send_message", text: "hi", target: "+353871234567" },
      0,
    );
    expect(result).toEqual({
      ok: false,
      error: "WhatsApp socket is not connected",
    });
  });

  it("rejects a target it cannot derive a JID from", async () => {
    const handle = createWhatsAppActionHandler(() => sock, gateway);
    const result = await handle(
      { action: "send_message", text: "hi", target: "not-a-number" },
      0,
    );
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toMatch(/Unresolvable WhatsApp target/);
    expect(sent).toHaveLength(0);
  });

  it("maps a moderation op onto WhatsApp's own semantics", async () => {
    const { handle, chat } = handlerFor("120363012345678901@g.us");
    (
      sock as unknown as {
        groupParticipantsUpdate: unknown;
      }
    ).groupParticipantsUpdate = vi.fn(async () => [{ status: "200" }]);
    const result = await handle(
      { action: "moderate", op: "ban", user_id: "447700900101" },
      chat.numericChatId,
    );
    expect(result?.ok).toBe(true);
    // WhatsApp has no ban list; the adapter says so rather than pretending.
    expect(String(result?.text)).toMatch(/no ban list/i);
  });
});

describe("WhatsApp identity (LID ↔ phone number)", () => {
  beforeEach(() => resetIdentityCache());

  it("pairs a LID with the phone number from the message key", async () => {
    const identity = await resolveIdentity(
      null,
      "190000000000001@lid",
      "447700900102@s.whatsapp.net",
    );
    expect(identity.lid).toBe("190000000000001");
    expect(identity.phone).toBe("447700900102");
    expect(identity.ids).toEqual(["447700900102", "190000000000001"]);
  });

  it("falls back to the signal store when the key carries no counterpart", async () => {
    const sock = {
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => "447700900102@s.whatsapp.net",
          getLIDForPN: async () => null,
        },
      },
    } as never;
    const identity = await resolveIdentity(sock, "190000000000001@lid");
    expect(identity.phone).toBe("447700900102");
  });

  it("matches a phone-number allowlist against a LID-addressed sender", async () => {
    // The bug this fixes: the first real message to the live account
    // arrived as a LID and was ignored as "unlisted".
    const identity = await resolveIdentity(
      null,
      "190000000000001@lid",
      "447700900102@s.whatsapp.net",
    );
    expect(identityAllowed(identity, new Set(["447700900102"]))).toBe(true);
    expect(identityAllowed(identity, new Set(["999999999999"]))).toBe(false);
  });

  it("keeps one chat id whichever form addresses the conversation", async () => {
    const viaLid = await resolveIdentity(
      null,
      "190000000000001@lid",
      "447700900102@s.whatsapp.net",
    );
    expect(canonicalId(viaLid)).toBe("447700900102");
    expect(chatIdForJid("190000000000001@lid", canonicalId(viaLid))).toBe(
      "wa_dm_447700900102",
    );
  });

  it("degrades to the form it has when no mapping is available", async () => {
    const identity = await resolveIdentity(null, "190000000000001@lid");
    expect(identity.ids).toEqual(["190000000000001"]);
    expect(canonicalId(identity)).toBe("190000000000001");
  });

  it("treats an empty id as absent rather than a value", async () => {
    // WhatsApp hands out empty `participant` fields on DMs. An empty id
    // that flows onward builds "wa_dm_" — one chat id every DM shares,
    // which is how two people's conversations end up in one session.
    const identity = await resolveIdentity(null, "");
    expect(identity.ids).toEqual([]);
    expect(canonicalId(identity)).toBeUndefined();
    expect(
      chatIdForJid("447700900102@s.whatsapp.net", canonicalId(identity)),
    ).toBe("wa_dm_447700900102");
  });

  it("keeps distinct DMs in distinct chats", () => {
    expect(chatIdForJid("447700900102@s.whatsapp.net")).not.toBe(
      chatIdForJid("353871234567@s.whatsapp.net"),
    );
  });
});
