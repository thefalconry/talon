/**
 * Functional tests for tool schemas + the Telegram action handler.
 *
 * Covers two wiring layers that have historically broken silently:
 *
 *   1. Tool definition → bridge call
 *      `tool.execute(parsedParams, bridge)` must call the bridge
 *      with the correct action name and the correct params shape.
 *      Catches: action-name typos, missing param forwarding, and
 *      multiplexed dispatch (e.g. `send` → 13 different bridge
 *      actions depending on `type`).
 *
 *   2. Bridge → Telegram Bot API
 *      `createTelegramActionHandler(...)` translates a bridge
 *      action body into the right grammy `bot.api.*` call with
 *      the right arguments. Catches: drift between the bridge
 *      action name produced by a tool and the case label in the
 *      handler switch, or wrong arg ordering.
 *
 * No real bot, no real network, no spawned processes. Pure
 * in-process round trips with vi.fn() spies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { ALL_TOOLS } from "../core/tools/index.js";
import type { ToolDefinition } from "../core/tools/types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function getTool(name: string): ToolDefinition {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found in ALL_TOOLS`);
  return tool;
}

/** Run the tool's zod schema over `raw` and return the parsed/coerced output. */
function parseSchema(
  tool: ToolDefinition,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const obj = z.object(tool.schema as Record<string, z.ZodTypeAny>);
  return obj.parse(raw) as Record<string, unknown>;
}

/** Build a vi-mocked bridge that records every call and returns ok. */
function makeBridge() {
  return vi.fn(async (_action: string, _params: Record<string, unknown>) => ({
    ok: true,
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// Part A — Tool definition → bridge call
// ════════════════════════════════════════════════════════════════════════════

describe("Tool → bridge round-trip", () => {
  // ── Single-action tools (1:1 with a bridge action name) ──────────────────
  describe("single-action telegram tools", () => {
    const cases: Array<{
      tool: string;
      params: Record<string, unknown>;
      bridgeAction: string;
      expectedParams?: Record<string, unknown>;
    }> = [
      {
        tool: "react",
        params: { message_id: 2081, emoji: "❤️" },
        bridgeAction: "react",
        expectedParams: { message_id: "2081", emoji: "❤️" },
      },
      {
        tool: "edit_message",
        params: { message_id: 2081, text: "edited" },
        bridgeAction: "edit_message",
        expectedParams: { message_id: "2081", text: "edited" },
      },
      {
        tool: "delete_message",
        params: { message_id: 2081 },
        bridgeAction: "delete_message",
        expectedParams: { message_id: "2081" },
      },
      {
        tool: "forward_message",
        params: { message_id: 2081 },
        bridgeAction: "forward_message",
      },
      {
        tool: "pin_message",
        params: { message_id: 2081 },
        bridgeAction: "pin_message",
      },
      {
        tool: "unpin_message",
        params: { message_id: 2081 },
        bridgeAction: "unpin_message",
      },
      {
        tool: "stop_poll",
        params: { message_id: 2081 },
        bridgeAction: "stop_poll",
      },
      {
        tool: "get_member_info",
        params: { user_id: 424242420 },
        bridgeAction: "get_member_info",
      },
      {
        tool: "get_message_by_id",
        params: { message_id: 2081 },
        bridgeAction: "get_message_by_id",
      },
      {
        tool: "download_media",
        params: { message_id: 2081 },
        bridgeAction: "download_media",
      },
    ];

    for (const c of cases) {
      it(`${c.tool} → bridge("${c.bridgeAction}")`, async () => {
        const tool = getTool(c.tool);
        const bridge = makeBridge();
        const parsed = parseSchema(tool, c.params);

        await tool.execute(parsed, bridge);

        expect(bridge).toHaveBeenCalledTimes(1);
        const [action, params] = bridge.mock.calls[0]!;
        expect(action).toBe(c.bridgeAction);
        if (c.expectedParams) {
          expect(params).toEqual(c.expectedParams);
        }
      });
    }
  });

  // ── send tool dispatches to many bridge actions ──────────────────────────
  describe("send tool dispatches by type", () => {
    const cases: Array<{
      label: string;
      params: Record<string, unknown>;
      bridgeAction: string;
      paramShape?: (p: Record<string, unknown>) => void;
    }> = [
      {
        label: "text",
        params: { type: "text", text: "hello" },
        bridgeAction: "send_message",
        paramShape: (p) => {
          expect(p.text).toBe("hello");
        },
      },
      {
        label: "text with reply_to",
        params: { type: "text", text: "ok", reply_to: 2081 },
        bridgeAction: "send_message",
        paramShape: (p) => {
          expect(p.reply_to_message_id).toBe("2081");
        },
      },
      {
        label: "text with buttons",
        params: {
          type: "text",
          text: "choose",
          buttons: [[{ text: "A", callback_data: "a" }]],
        },
        bridgeAction: "send_message_with_buttons",
        paramShape: (p) => {
          expect((p.rows as unknown[]).length).toBe(1);
        },
      },
      {
        label: "delayed text → schedule_message",
        params: { type: "text", text: "later", delay_seconds: 60 },
        bridgeAction: "schedule_message",
        paramShape: (p) => {
          expect(p.delay_seconds).toBe(60);
        },
      },
      {
        label: "photo",
        params: { type: "photo", file_path: "/tmp/x.jpg", caption: "hi" },
        bridgeAction: "send_photo",
      },
      {
        label: "file",
        params: { type: "file", file_path: "/tmp/x.pdf" },
        bridgeAction: "send_file",
      },
      {
        label: "video",
        params: { type: "video", file_path: "/tmp/x.mp4" },
        bridgeAction: "send_video",
      },
      {
        label: "voice",
        params: { type: "voice", file_path: "/tmp/x.ogg" },
        bridgeAction: "send_voice",
      },
      {
        label: "audio",
        params: {
          type: "audio",
          file_path: "/tmp/song.mp3",
          title: "T",
          performer: "P",
        },
        bridgeAction: "send_audio",
        paramShape: (p) => {
          expect(p.title).toBe("T");
          expect(p.performer).toBe("P");
        },
      },
      {
        label: "animation",
        params: { type: "animation", file_path: "/tmp/x.gif" },
        bridgeAction: "send_animation",
      },
      {
        label: "sticker",
        params: { type: "sticker", file_id: "CAACAgI..." },
        bridgeAction: "send_sticker",
      },
      {
        label: "poll",
        params: {
          type: "poll",
          question: "Best?",
          options: ["A", "B"],
        },
        bridgeAction: "send_poll",
        paramShape: (p) => {
          expect(p.question).toBe("Best?");
          expect(p.type).toBe("regular");
        },
      },
      {
        label: "poll with correct_option_id → quiz",
        params: {
          type: "poll",
          question: "Q?",
          options: ["A", "B"],
          correct_option_id: 1,
        },
        bridgeAction: "send_poll",
        paramShape: (p) => {
          expect(p.type).toBe("quiz");
        },
      },
      {
        label: "location",
        params: { type: "location", latitude: 53.15, longitude: -6.07 },
        bridgeAction: "send_location",
      },
      {
        label: "contact",
        params: {
          type: "contact",
          phone_number: "+1234",
          first_name: "Test",
        },
        bridgeAction: "send_contact",
      },
      {
        label: "dice",
        params: { type: "dice" },
        bridgeAction: "send_dice",
      },
    ];

    for (const c of cases) {
      it(`send(${c.label}) → bridge("${c.bridgeAction}")`, async () => {
        const tool = getTool("send");
        const bridge = makeBridge();
        const parsed = parseSchema(tool, c.params);

        await tool.execute(parsed, bridge);

        expect(bridge).toHaveBeenCalledTimes(1);
        const [action, params] = bridge.mock.calls[0]!;
        expect(action).toBe(c.bridgeAction);
        if (c.paramShape) c.paramShape(params as Record<string, unknown>);
      });
    }
  });

  // ── ID forwarding goes end-to-end through execute() ──────────────────────
  // Tools shared with the Discord frontend use `snowflakeOrIdSchema` which
  // passes digit strings through verbatim (snowflakes can't survive a
  // Number() round-trip). Telegram-only tools still coerce via `idSchema`.
  // The bridge layer normalizes at its boundary, so both shapes are valid
  // on the wire — these tests just assert the value semantically equals
  // the input ID, accepting either representation.
  describe("ID values survive the schema → execute pipeline", () => {
    it("react with stringified message_id arrives at bridge intact", async () => {
      const tool = getTool("react");
      const bridge = makeBridge();
      const parsed = parseSchema(tool, {
        message_id: "2081",
        emoji: "❤️",
      });

      await tool.execute(parsed, bridge);

      const [, params] = bridge.mock.calls[0]!;
      const messageId = (params as { message_id: unknown }).message_id;
      expect(messageId === 2081 || messageId === "2081").toBe(true);
    });

    it("send.reply_to with stringified value survives to send_message", async () => {
      const tool = getTool("send");
      const bridge = makeBridge();
      const parsed = parseSchema(tool, {
        type: "text",
        text: "hi",
        reply_to: "2081",
      });

      await tool.execute(parsed, bridge);

      const [, params] = bridge.mock.calls[0]!;
      const replyTo = (params as { reply_to_message_id: unknown })
        .reply_to_message_id;
      expect(replyTo === 2081 || replyTo === "2081").toBe(true);
    });

    it("get_member_info with stringified user_id arrives at bridge intact", async () => {
      const tool = getTool("get_member_info");
      const bridge = makeBridge();
      const parsed = parseSchema(tool, { user_id: "424242420" });

      await tool.execute(parsed, bridge);

      const [, params] = bridge.mock.calls[0]!;
      const userId = (params as { user_id: unknown }).user_id;
      expect(userId === 424242420 || userId === "424242420").toBe(true);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Part B — Telegram action handler → grammy Bot API
// ════════════════════════════════════════════════════════════════════════════

import {
  createTelegramActionHandler,
  // re-export for test side-only — handler depends on the InputFile constructor
} from "../frontend/telegram/actions/index.js";
import { resetRichMessageSupport } from "../frontend/telegram/actions/rich-messages.js";
import type { Bot } from "grammy";
import type { Gateway } from "../core/engine/gateway.js";

interface BotApiSpy {
  setMessageReaction: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  pinChatMessage: ReturnType<typeof vi.fn>;
  unpinChatMessage: ReturnType<typeof vi.fn>;
  forwardMessage: ReturnType<typeof vi.fn>;
  copyMessage: ReturnType<typeof vi.fn>;
  sendRichMessage: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendChatAction: ReturnType<typeof vi.fn>;
}

function makeBotSpy(): { bot: Bot; api: BotApiSpy } {
  const api: BotApiSpy = {
    setMessageReaction: vi.fn(async () => true),
    editMessageText: vi.fn(async () => ({ message_id: 1 })),
    deleteMessage: vi.fn(async () => true),
    pinChatMessage: vi.fn(async () => true),
    unpinChatMessage: vi.fn(async () => true),
    forwardMessage: vi.fn(async () => ({ message_id: 999 })),
    copyMessage: vi.fn(async () => ({ message_id: 1000 })),
    sendRichMessage: vi.fn(async () => ({ message_id: 1001 })),
    sendMessage: vi.fn(async () => ({ message_id: 1001 })),
    sendChatAction: vi.fn(async () => true),
  };
  const bot = { api } as unknown as Bot;
  return { bot, api };
}

function makeGateway(): Gateway {
  return {
    incrementMessages: vi.fn(),
    incrementErrors: vi.fn(),
    incrementRetries: vi.fn(),
    incrementSuccess: vi.fn(),
  } as unknown as Gateway;
}

class StubInputFile {
  // Match the grammy InputFile shape just enough for `new InputFileClass(...)`.
  data: unknown;
  filename: string;
  constructor(data: unknown, filename: string) {
    this.data = data;
    this.filename = filename;
  }
}

describe("createTelegramActionHandler", () => {
  let bot: Bot;
  let api: BotApiSpy;
  let gateway: Gateway;
  let handler: ReturnType<typeof createTelegramActionHandler>;
  const chatId = 12345;

  beforeEach(() => {
    // The Rich-Message capability probe latches process-wide; re-arm it so a
    // test that simulates an old Bot API server can't leak into the next one.
    resetRichMessageSupport();
    const spy = makeBotSpy();
    bot = spy.bot;
    api = spy.api;
    gateway = makeGateway();
    handler = createTelegramActionHandler(
      bot,
      StubInputFile as unknown as typeof import("grammy").InputFile,
      "fake-token",
      gateway,
    );
  });

  it("react → bot.api.setMessageReaction with chatId, message_id, emoji", async () => {
    const result = await handler(
      { action: "react", message_id: 2081, emoji: "❤️" },
      chatId,
    );

    expect(api.setMessageReaction).toHaveBeenCalledTimes(1);
    expect(api.setMessageReaction).toHaveBeenCalledWith(chatId, 2081, [
      { type: "emoji", emoji: "❤️" },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it("react with stringified message_id (post-coercion) still calls bot.api correctly", async () => {
    // Even if something upstream skipped coercion and delivered a string,
    // the handler does Number(body.message_id) and recovers.
    await handler({ action: "react", message_id: "2081", emoji: "🔥" }, chatId);

    expect(api.setMessageReaction).toHaveBeenCalledWith(chatId, 2081, [
      { type: "emoji", emoji: "🔥" },
    ]);
  });

  it("react falls back to 👍 if custom emoji rejected, and reports ok", async () => {
    const seen: string[] = [];
    api.setMessageReaction.mockImplementation(
      async (
        _chatId: number,
        _msgId: number,
        reactions: Array<{ type: string; emoji: string }>,
      ) => {
        seen.push(reactions[0]!.emoji);
        if (reactions[0]!.emoji === "🦄") {
          throw new Error("REACTION_INVALID");
        }
        return true;
      },
    );

    const result = await handler(
      { action: "react", message_id: 1, emoji: "🦄" },
      chatId,
    );

    expect(api.setMessageReaction).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["🦄", "👍"]);
    expect(result).toEqual({ ok: true });
  });

  it("delete_message → bot.api.deleteMessage(chatId, message_id)", async () => {
    const result = await handler(
      { action: "delete_message", message_id: 2081 },
      chatId,
    );

    expect(api.deleteMessage).toHaveBeenCalledWith(chatId, 2081);
    expect(result).toEqual({ ok: true });
  });

  it("pin_message → bot.api.pinChatMessage(chatId, message_id)", async () => {
    await handler({ action: "pin_message", message_id: 2081 }, chatId);
    expect(api.pinChatMessage).toHaveBeenCalledWith(chatId, 2081);
  });

  it("unpin_message → bot.api.unpinChatMessage(chatId, message_id?)", async () => {
    await handler({ action: "unpin_message", message_id: 2081 }, chatId);
    expect(api.unpinChatMessage).toHaveBeenCalledWith(chatId, 2081);

    api.unpinChatMessage.mockClear();
    await handler({ action: "unpin_message" }, chatId);
    expect(api.unpinChatMessage).toHaveBeenCalledWith(chatId, undefined);
  });

  it("forward_message → bot.api.forwardMessage(chatId, chatId, message_id)", async () => {
    const result = await handler(
      { action: "forward_message", message_id: 2081 },
      chatId,
    );

    expect(api.forwardMessage).toHaveBeenCalledWith(chatId, chatId, 2081);
    expect(result).toEqual({ ok: true, message_id: 999 });
  });

  it("forward_message honours an explicit cross-chat target", async () => {
    const result = await handler(
      { action: "forward_message", message_id: 2081, to_chat_id: 99999 },
      chatId,
    );

    expect(api.forwardMessage).toHaveBeenCalledWith(99999, chatId, 2081);
    expect(result).toEqual({ ok: true, message_id: 999 });
  });

  it("copy_message → bot.api.copyMessage(chatId, chatId, message_id)", async () => {
    const result = await handler(
      { action: "copy_message", message_id: 2081 },
      chatId,
    );

    expect(api.copyMessage).toHaveBeenCalledWith(chatId, chatId, 2081);
    expect(result).toEqual({ ok: true, message_id: 1000 });
  });

  it("edit_message → bot.api.editMessageText with native Rich Markdown", async () => {
    await handler(
      { action: "edit_message", message_id: 2081, text: "**bold**" },
      chatId,
    );

    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    const call = api.editMessageText.mock.calls[0]!;
    expect(call[0]).toBe(chatId);
    expect(call[1]).toBe(2081);
    expect(call[2]).toEqual({ markdown: "**bold**" });
  });

  it("edit_message rejects text > TELEGRAM_MAX_TEXT (4096)", async () => {
    const longText = "x".repeat(5000);
    const result = await handler(
      { action: "edit_message", message_id: 2081, text: longText },
      chatId,
    );

    expect(result).toEqual({
      ok: false,
      error: "Text too long (max 4096)",
    });
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("send_chat_action → bot.api.sendChatAction(chatId, action_str)", async () => {
    await handler(
      { action: "send_chat_action", chat_action: "typing" },
      chatId,
    );
    expect(api.sendChatAction).toHaveBeenCalledWith(chatId, "typing", {
      message_thread_id: undefined,
    });
  });

  it("send_message → bot.api.sendRichMessage with Markdown and reply_to", async () => {
    const result = await handler(
      {
        action: "send_message",
        text: "hello",
        reply_to_message_id: 2081,
      },
      chatId,
    );

    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(gateway.incrementMessages).toHaveBeenCalledWith(chatId);
    const call = api.sendRichMessage.mock.calls[0]!;
    expect(call[0]).toBe(chatId);
    expect(call[1]).toEqual({ markdown: "hello" });
    expect(call[2]).toMatchObject({
      reply_parameters: { message_id: 2081 },
    });
    expect(result).toEqual({ ok: true, message_id: 1001 });
  });

  it("send_message → coerced string reply_to becomes a numeric reply", async () => {
    // snowflakeOrIdSchema normalizes IDs to digit-strings, so reply_to arrives
    // here as "2081". The Telegram handler must coerce it back to a number or
    // GramJS drops the reply/threading silently. Regression guard for that.
    await handler(
      {
        action: "send_message",
        text: "hi",
        reply_to_message_id: "2081",
      },
      chatId,
    );
    const call = api.sendRichMessage.mock.calls[0]!;
    expect(call[2]).toMatchObject({
      reply_parameters: { message_id: 2081 },
    });
  });

  it("send_message passes URL asterisks untouched to native Rich Markdown", async () => {
    const text =
      "[song](https://chomikuj.pl/Jak+Si*c4*99+Bawi*c4*85+Ludzie.mp3)";

    await handler({ action: "send_message", text }, chatId);

    expect(api.sendRichMessage).toHaveBeenCalledWith(
      chatId,
      { markdown: text },
      expect.any(Object),
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("send_message falls back to legacy HTML when a Rich Message is rejected", async () => {
    api.sendRichMessage.mockRejectedValueOnce(
      new Error("Bad Request: can't parse rich message"),
    );

    const result = await handler(
      { action: "send_message", text: "**still formatted**" },
      chatId,
    );

    expect(api.sendMessage).toHaveBeenCalledWith(
      chatId,
      "<b>still formatted</b>",
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(result).toEqual({ ok: true, message_id: 1001 });

    // A payload-level rejection must NOT disable the capability: the next
    // send still tries native Rich Markdown first.
    await handler({ action: "send_message", text: "second" }, chatId);
    expect(api.sendRichMessage).toHaveBeenCalledTimes(2);
  });

  it("send_message stops attempting Rich Messages once the method is unsupported", async () => {
    api.sendRichMessage.mockRejectedValueOnce(
      new Error("Bad Request: method not found"),
    );

    await handler({ action: "send_message", text: "**one**" }, chatId);
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    // Capability latched off — no second doomed round-trip.
    await handler({ action: "send_message", text: "**two**" }, chatId);
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[1]![1]).toBe("<b>two</b>");
  });

  it("send_message keeps fenced code on the Rich path", async () => {
    // One renderer for everything: delivery must not branch on message
    // content. Telegram owns markdown parsing, including code blocks.
    const text = "here:\n```ts\nconst x = 1;\n```";

    await handler({ action: "send_message", text }, chatId);

    expect(api.sendRichMessage).toHaveBeenCalledWith(
      chatId,
      { markdown: text },
      expect.any(Object),
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("send_message_with_buttons keeps the inline keyboard on the Rich path", async () => {
    const result = await handler(
      {
        action: "send_message_with_buttons",
        text: "**pick one**",
        rows: [[{ text: "A", callback_data: "a" }]],
      },
      chatId,
    );

    expect(api.sendRichMessage).toHaveBeenCalledWith(
      chatId,
      { markdown: "**pick one**" },
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [[{ text: "A", callback_data: "a" }]],
        },
      }),
    );
    expect(result).toEqual({ ok: true, message_id: 1001 });
  });

  it("edit_message falls back to legacy HTML when the Rich edit is rejected", async () => {
    api.editMessageText
      .mockRejectedValueOnce(new Error("Bad Request: can't parse rich message"))
      .mockResolvedValueOnce(true);

    const result = await handler(
      { action: "edit_message", message_id: 2081, text: "**bold**" },
      chatId,
    );

    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    const fallback = api.editMessageText.mock.calls[1]!;
    expect(fallback[2]).toBe("<b>bold</b>");
    expect(fallback[3]).toEqual({ parse_mode: "HTML" });
    expect(result).toEqual({ ok: true });
  });

  it("schedule_message returns a schedule id and keeps a timer", async () => {
    vi.useFakeTimers();
    try {
      const result = (await handler(
        {
          action: "schedule_message",
          text: "later",
          delay_seconds: 5,
        },
        chatId,
      )) as { ok: true; schedule_id: string; delay_seconds: number };

      expect(result.ok).toBe(true);
      expect(result.delay_seconds).toBe(5);
      expect(typeof result.schedule_id).toBe("string");

      // Cancel before it fires so we don't leak a real send.
      const cancel = await handler(
        { action: "cancel_scheduled", schedule_id: result.schedule_id },
        chatId,
      );
      expect(cancel).toEqual({ ok: true, cancelled: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel_scheduled with unknown id returns ok:false", async () => {
    const result = await handler(
      { action: "cancel_scheduled", schedule_id: "nonexistent" },
      chatId,
    );
    expect(result).toEqual({ ok: false, error: "Schedule not found" });
  });
});
