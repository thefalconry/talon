/**
 * /ping reports live state, not constants.
 *
 * Telegram printed `Bridge: ✓` from `const bridgeOk = true`, and Discord
 * printed a literal `Gateway: ✓`, so neither could ever show a fault.
 */
import { describe, it, expect, vi } from "vitest";
import type { Bot } from "grammy";
import { Status } from "discord.js";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../frontend/telegram/userbot.js", () => ({
  isUserClientReady: vi.fn(() => true),
}));
vi.mock("../core/mesh/index.js", () => ({
  getMeshService: vi.fn(() => null),
}));
vi.mock("../core/plugin/index.js", () => ({
  getLoadedPlugins: vi.fn(() => []),
}));

import { registerInfoCommands } from "../frontend/telegram/commands/info.js";
import { registerCommands } from "../frontend/telegram/commands/index.js";
import type { TalonConfig } from "../core/config/index.js";
import { renderPingReply } from "../frontend/discord/commands/info.js";
import { Gateway } from "../core/engine/gateway.js";

/** A bot double that keeps each command's first handler. */
function recordingBot() {
  const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const edits: string[] = [];
  const bot = {
    command(name: string, handler: (ctx: unknown) => Promise<void>) {
      if (!handlers.has(name)) handlers.set(name, handler);
      return bot;
    },
    on: () => bot,
    use: () => bot,
    callbackQuery: () => bot,
    api: {
      editMessageText: async (_chat: number, _id: number, text: string) => {
        edits.push(text);
      },
    },
  };
  return { bot: bot as unknown as Bot, handlers, edits };
}

async function runPing(
  handlers: Map<string, (ctx: unknown) => Promise<void>>,
): Promise<void> {
  await handlers.get("ping")!({
    chat: { id: 1 },
    reply: async () => ({ message_id: 7 }),
  });
}

async function telegramPing(bridgeListening?: () => boolean): Promise<string> {
  const { bot, handlers, edits } = recordingBot();
  registerInfoCommands(bot, bridgeListening ? { bridgeListening } : {});
  await handlers.get("ping")!({
    chat: { id: 1 },
    reply: async () => ({ message_id: 7 }),
  });
  return edits[0] ?? "";
}

describe("Telegram /ping", () => {
  it("reports the bridge as down when it is not listening", async () => {
    const text = await telegramPing(() => false);
    expect(text).toContain("Bridge: ✗");
    expect(text).toContain("Userbot: ✓");
  });

  it("reports the bridge as up when it is listening", async () => {
    expect(await telegramPing(() => true)).toContain("Bridge: ✓");
  });

  it("omits the bridge when no health source is wired", async () => {
    expect(await telegramPing()).not.toContain("Bridge");
  });

  it("reads the real gateway when wired through registerCommands", async () => {
    const gateway = new Gateway();
    const { bot, handlers, edits } = recordingBot();
    registerCommands(bot, { devBuild: false } as TalonConfig, gateway);

    await runPing(handlers);
    expect(edits.pop()).toContain("Bridge: ✗");

    await gateway.start(0);
    try {
      await runPing(handlers);
      expect(edits.pop()).toContain("Bridge: ✓");
    } finally {
      await gateway.stop();
    }
  });
});

describe("Discord /ping", () => {
  it("shows ✓ only when the gateway socket is Ready", () => {
    expect(renderPingReply({ ping: 42, status: Status.Ready }, 10)).toContain(
      "Gateway: ✓",
    );
  });

  it("names the state when the gateway is not Ready", () => {
    const text = renderPingReply({ ping: 42, status: Status.Reconnecting }, 10);
    expect(text).toContain("Gateway: ✗ (Reconnecting)");
  });

  it("does not print -1ms before the first heartbeat", () => {
    const text = renderPingReply({ ping: -1, status: Status.Connecting }, 10);
    expect(text).toContain("WS: n/a");
    expect(text).not.toContain("-1ms");
  });
});

describe("Gateway.isListening", () => {
  it("is false before start and after stop, true while bound", async () => {
    const gateway = new Gateway();
    expect(gateway.isListening()).toBe(false);
    await gateway.start(0);
    expect(gateway.isListening()).toBe(true);
    await gateway.stop();
    expect(gateway.isListening()).toBe(false);
  });
});
