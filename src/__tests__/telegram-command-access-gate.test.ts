/**
 * /commands and inline-button presses must pass the same access check as
 * ordinary messages.
 *
 * The regression: command and callback handlers are registered with grammy
 * directly and never ran `isAccessAllowed`, so a sender outside
 * `allowedUsers` was refused for plain text but could still run /model,
 * /settings, /status, /mesh, /plugins, /memory in a DM and press buttons.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Bot, Context } from "grammy";
import {
  setAccessControl,
  isCommandOrCallback,
  registerCommandAccessGate,
} from "../frontend/telegram/handlers/access.js";

const ADMIN = 111;
const STRANGER = 999;

type Mw = (ctx: Context, next: () => Promise<void>) => Promise<void>;

function makeBot() {
  const mws: Mw[] = [];
  const bot = {
    use: vi.fn((mw: Mw) => mws.push(mw)),
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getChatMember: vi.fn().mockResolvedValue({ status: "member" }),
    },
  } as unknown as Bot;
  return { bot, mws };
}

function commandCtx(fromId: number, text = "/model", chatType = "private") {
  return {
    chat: { id: fromId, type: chatType },
    from: { id: fromId, first_name: "T", username: "t" },
    message: {
      message_id: 1,
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    },
  } as unknown as Context;
}

function textCtx(fromId: number) {
  return {
    chat: { id: fromId, type: "private" },
    from: { id: fromId, first_name: "T" },
    message: { message_id: 2, text: "hello" },
  } as unknown as Context;
}

function callbackCtx(fromId: number) {
  return {
    chat: { id: fromId, type: "private" },
    from: { id: fromId, first_name: "T" },
    callbackQuery: { id: "q", data: "model:opus" },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("isCommandOrCallback", () => {
  it("detects a leading bot_command entity", () => {
    expect(isCommandOrCallback(commandCtx(1))).toBe(true);
  });
  it("detects a button press", () => {
    expect(isCommandOrCallback(callbackCtx(1))).toBe(true);
  });
  it("ignores plain text", () => {
    expect(isCommandOrCallback(textCtx(1))).toBe(false);
  });
  it("ignores a command that is not at the start", () => {
    const ctx = {
      message: {
        text: "try /model",
        entities: [{ type: "bot_command", offset: 4, length: 6 }],
      },
    } as unknown as Context;
    expect(isCommandOrCallback(ctx)).toBe(false);
  });
});

describe("command access gate", () => {
  beforeEach(() => {
    setAccessControl({ allowedUsers: [ADMIN], adminUserId: ADMIN });
  });

  it("blocks a /command from an unauthorized DM sender", async () => {
    const { bot, mws } = makeBot();
    registerCommandAccessGate(bot);
    const next = vi.fn().mockResolvedValue(undefined);
    await mws[0](commandCtx(STRANGER), next);
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks a button press from an unauthorized DM sender and clears the spinner", async () => {
    const { bot, mws } = makeBot();
    registerCommandAccessGate(bot);
    const next = vi.fn().mockResolvedValue(undefined);
    const ctx = callbackCtx(STRANGER);
    await mws[0](ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it("lets the admin's commands through", async () => {
    const { bot, mws } = makeBot();
    registerCommandAccessGate(bot);
    const next = vi.fn().mockResolvedValue(undefined);
    await mws[0](commandCtx(ADMIN), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("passes non-command updates straight through (the message path has its own check)", async () => {
    const { bot, mws } = makeBot();
    registerCommandAccessGate(bot);
    const next = vi.fn().mockResolvedValue(undefined);
    await mws[0](textCtx(STRANGER), next);
    expect(next).toHaveBeenCalledOnce();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses everyone when neither a whitelist nor an admin is configured", async () => {
    // An empty whitelist never means "everyone".
    setAccessControl({ allowedUsers: [], adminUserId: 0 });
    const { bot, mws } = makeBot();
    registerCommandAccessGate(bot);
    const next = vi.fn().mockResolvedValue(undefined);
    await mws[0](commandCtx(STRANGER), next);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("wiring", () => {
  it("installs the gate before any command or callback handler", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../frontend/telegram/index.ts", import.meta.url)),
      "utf8",
    );
    const gate = src.indexOf("registerCommandAccessGate(bot)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(src.indexOf("registerCommands(bot"));
    expect(gate).toBeLessThan(src.indexOf("registerCallbacks(bot"));
  });
});
