/**
 * Regression tests — `chatIdSchema` accepts the negative chat IDs
 * Telegram uses for supergroups/channels, AND the positive ones it
 * uses for private chats / DMs, AND digit-strings of either sign.
 *
 * Background: PR #150 shipped heartbeat outbound `send` / `react`
 * with `chat_id: idSchema`, but `idSchema` is `.positive()` — meant
 * for message/user/reply IDs which are always positive. Supergroup
 * chat IDs (`-1009876543210` shape) failed validation at the MCP
 * tool-schema layer with `expected number, received string` style
 * errors before the request ever reached the gateway — even though
 * the gateway-http tests already proved negative chat_ids route
 * correctly end-to-end. This test pins the new `chatIdSchema` to
 * accept both signs while still rejecting zero and non-integers.
 *
 * The exact -1009876543210 case below is the one Ada asked the
 * heartbeat to test in chat at 2026-05-12 18:13Z. The
 * old schema rejected it; this test ensures the new schema doesn't.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ALL_TOOLS } from "../core/tools/index.js";
import { chatIdSchema, idSchema } from "../core/tools/schemas.js";

function getToolField(toolName: string, field: string): z.ZodTypeAny {
  const tool = ALL_TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error(`tool ${toolName} not found`);
  const schema = (tool.schema as Record<string, z.ZodTypeAny>)[field];
  if (!schema) throw new Error(`field ${field} not found on ${toolName}`);
  return schema;
}

describe("chatIdSchema (standalone)", () => {
  describe("accepts", () => {
    it("a positive integer (user DM)", () => {
      expect(chatIdSchema.parse(424242420)).toBe(424242420);
    });

    it("a negative integer (Telegram supergroup)", () => {
      expect(chatIdSchema.parse(-1009876543210)).toBe(-1009876543210);
    });

    it("a negative integer (Telegram basic group)", () => {
      expect(chatIdSchema.parse(-123456789)).toBe(-123456789);
    });

    it("a positive integer string", () => {
      expect(chatIdSchema.parse("424242420")).toBe(424242420);
    });

    it("a negative integer string", () => {
      expect(chatIdSchema.parse("-1009876543210")).toBe(-1009876543210);
    });
  });

  describe("rejects", () => {
    it("zero", () => {
      expect(() => chatIdSchema.parse(0)).toThrow();
    });

    it("zero as string", () => {
      expect(() => chatIdSchema.parse("0")).toThrow();
    });

    it("negative zero as string", () => {
      // "-0" parses via Number() to -0, which === 0 in JS, so the
      // refine catches it. Lock that in.
      expect(() => chatIdSchema.parse("-0")).toThrow();
    });

    it("a non-integer number", () => {
      expect(() => chatIdSchema.parse(1.5)).toThrow();
    });

    it("a non-numeric string", () => {
      expect(() => chatIdSchema.parse("not-a-number")).toThrow();
    });

    it("an empty string", () => {
      expect(() => chatIdSchema.parse("")).toThrow();
    });

    it("a boolean", () => {
      expect(() => chatIdSchema.parse(true)).toThrow();
    });

    it("null", () => {
      expect(() => chatIdSchema.parse(null)).toThrow();
    });

    it("a string with leading/trailing whitespace", () => {
      expect(() => chatIdSchema.parse(" 123 ")).toThrow();
    });
  });

  describe("does not conflict with idSchema", () => {
    it("idSchema still rejects negatives (chatIdSchema is the negative-aware variant)", () => {
      expect(() => idSchema.parse(-1009876543210)).toThrow();
      expect(() => idSchema.parse("-1009876543210")).toThrow();
    });

    it("idSchema still accepts the same positives chatIdSchema accepts", () => {
      expect(idSchema.parse(2081)).toBe(2081);
      expect(chatIdSchema.parse(2081)).toBe(2081);
    });
  });
});

describe("chat_id tool params (wired into send/react)", () => {
  // The exact two tool fields PR #150 wired to idSchema by mistake.
  // After the fix they must accept both Ada's DM (positive) AND
  // a group chat (negative).
  const cases: Array<[string, number]> = [
    ["send", 424242420], // Ada DM
    ["send", -1009876543210], // group chat
    ["react", 424242420],
    ["react", -1009876543210],
  ];

  for (const [tool, chatId] of cases) {
    it(`${tool}.chat_id accepts ${chatId}`, () => {
      const s = getToolField(tool, "chat_id");
      expect(s.parse(chatId)).toBe(chatId);
    });
  }

  it("send.chat_id accepts stringified negative supergroup ID", () => {
    const s = getToolField("send", "chat_id");
    expect(s.parse("-1009876543210")).toBe(-1009876543210);
  });

  it("react.chat_id rejects zero", () => {
    const s = getToolField("react", "chat_id");
    expect(() => s.parse(0)).toThrow();
  });
});

describe("send.execute threads chat_id through to bridge", () => {
  // Second-half of the PR #150 bug surfaced 2026-05-12: even after the
  // schema accepts chat_id, send.execute builds per-case explicit
  // bridge payloads. If any case forgets to include chat_id, the
  // bridge falls back to the heartbeat sentinel and the gateway
  // rejects with "No active chat context". These tests assert every
  // type case forwards chat_id verbatim to the bridge call.
  //
  // react is unaffected — it does `bridge("react", rest)` with the
  // full param spread, so chat_id passes through naturally.

  type BridgeCall = [string, Record<string, unknown>];

  function findSend() {
    const t = ALL_TOOLS.find((x) => x.name === "send");
    if (!t) throw new Error("send tool not found");
    return t;
  }

  async function runSend(params: Record<string, unknown>): Promise<BridgeCall> {
    const tool = findSend();
    const captured: BridgeCall[] = [];
    const fakeBridge = async (
      action: string,
      bridgeParams: Record<string, unknown> | undefined,
    ) => {
      captured.push([action, bridgeParams ?? {}]);
      return { ok: true };
    };
    // The tool's typed execute expects its branded ToolParams /
    // BridgeFunction; for a behavioural test of the per-case payload
    // shape it's fine to cast through unknown.
    await (
      tool.execute as unknown as (
        p: unknown,
        b: unknown,
      ) => Promise<{ ok: boolean }>
    )(params, fakeBridge);
    if (captured.length !== 1) {
      throw new Error(
        `expected exactly one bridge call, got ${captured.length}`,
      );
    }
    return captured[0]!;
  }

  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      "text (plain)",
      { type: "text", text: "hi", chat_id: -1009876543210 },
      "send_message",
    ],
    [
      "text (with reply_to)",
      { type: "text", text: "hi", reply_to: 100, chat_id: -1009876543210 },
      "send_message",
    ],
    [
      "text (with buttons)",
      {
        type: "text",
        text: "pick",
        buttons: [[{ text: "A", callback_data: "a" }]],
        chat_id: -1009876543210,
      },
      "send_message_with_buttons",
    ],
    [
      "text (scheduled)",
      {
        type: "text",
        text: "later",
        delay_seconds: 60,
        chat_id: -1009876543210,
      },
      "schedule_message",
    ],
    [
      "photo",
      { type: "photo", file_path: "/x.jpg", chat_id: -1009876543210 },
      "send_photo",
    ],
    [
      "file",
      { type: "file", file_path: "/x.pdf", chat_id: -1009876543210 },
      "send_file",
    ],
    [
      "video",
      { type: "video", file_path: "/x.mp4", chat_id: -1009876543210 },
      "send_video",
    ],
    [
      "voice",
      { type: "voice", file_path: "/x.ogg", chat_id: -1009876543210 },
      "send_voice",
    ],
    [
      "audio",
      { type: "audio", file_path: "/x.mp3", chat_id: -1009876543210 },
      "send_audio",
    ],
    [
      "animation",
      { type: "animation", file_path: "/x.gif", chat_id: -1009876543210 },
      "send_animation",
    ],
    [
      "sticker",
      { type: "sticker", file_id: "CAAC", chat_id: -1009876543210 },
      "send_sticker",
    ],
    [
      "poll",
      {
        type: "poll",
        question: "?",
        options: ["a", "b"],
        chat_id: -1009876543210,
      },
      "send_poll",
    ],
    [
      "location",
      {
        type: "location",
        latitude: 37.7,
        longitude: -122.4,
        chat_id: -1009876543210,
      },
      "send_location",
    ],
    [
      "contact",
      {
        type: "contact",
        phone_number: "+1",
        first_name: "Sur",
        chat_id: -1009876543210,
      },
      "send_contact",
    ],
    [
      "dice",
      { type: "dice", emoji: "🎲", chat_id: -1009876543210 },
      "send_dice",
    ],
  ];

  for (const [label, params, expectedAction] of cases) {
    it(`send ${label} forwards chat_id to bridge ${expectedAction}`, async () => {
      const [action, payload] = await runSend(params);
      expect(action).toBe(expectedAction);
      expect(payload.chat_id).toBe(-1009876543210);
    });
  }

  it("send positive chat_id (DM) also threaded", async () => {
    const [action, payload] = await runSend({
      type: "text",
      text: "hi sur",
      chat_id: 424242420,
    });
    expect(action).toBe("send_message");
    expect(payload.chat_id).toBe(424242420);
  });

  it("send without chat_id passes undefined (chat-mode default path)", async () => {
    const [action, payload] = await runSend({ type: "text", text: "hi" });
    expect(action).toBe("send_message");
    expect(payload.chat_id).toBeUndefined();
  });
});
