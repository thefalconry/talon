/**
 * Telegram /settings panel and /effort on a model with no reasoning levels.
 *
 * The panel used to render a grid of model buttons whose callbacks only
 * answered "Picker moved — use /model", so its largest section did
 * nothing. It now carries one button into the /model menu instead.
 *
 * `/effort adaptive` (and the Auto button) used to hit the "no reasoning
 * levels" guard before the reset branch, so a model without levels could
 * never be put back to adaptive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bot, Context } from "grammy";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
const setChatEffort = vi.hoisted(() => vi.fn());
vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: vi.fn(() => ({ effort: "high" })),
  setChatModelForBackend: vi.fn(),
  setChatBackend: vi.fn(),
  setChatEffort,
  setChatPulseInterval: vi.fn(),
}));
vi.mock("../core/background/pulse/pulse.js", () => ({
  registerChat: vi.fn(),
  disablePulse: vi.fn(),
  enablePulse: vi.fn(),
  isPulseEnabled: vi.fn(() => false),
}));
vi.mock("../core/engine/backend-controller/index.js", () => ({
  getBackendIdForChat: vi.fn(() => "opencode"),
}));
const activeModel = vi.hoisted(() => ({ value: "glm-5" as string | null }));
vi.mock("../core/models/active-model.js", () => ({
  resolveActiveModelForChat: vi.fn(async () => ({ model: activeModel.value })),
}));
// A backend with a model catalog but no per-model reasoning levels.
const backend = vi.hoisted(() => ({
  models: {
    getSettingsPresentation: vi.fn(),
    getRawModelInfo: vi.fn(async () => ({ supportedReasoningLevels: [] })),
  },
}));
vi.mock("../frontend/telegram/model-menu.js", () => ({
  resolveBackendForChat: vi.fn(() => backend),
  buildModelMenuViewForChat: vi.fn(async () => null),
}));

import { registerSettingsCommands } from "../frontend/telegram/commands/settings.js";
import { handleEffortCallback } from "../frontend/telegram/callbacks/effort.js";
import { renderSettingsKeyboard } from "../frontend/telegram/render/menu.js";

type Keyboard = Array<Array<{ text: string; callback_data: string }>>;
type Reply = {
  text: string;
  opts?: { reply_markup?: { inline_keyboard?: Keyboard } };
};

function captureCommands(): Map<string, (ctx: unknown) => Promise<void>> {
  const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const bot = {
    command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
      handlers.set(name, handler);
    },
  } as unknown as Bot;
  registerSettingsCommands(bot, { config: {}, gateway: {} } as never);
  return handlers;
}

function makeCtx(arg = "") {
  const replies: Reply[] = [];
  return {
    ctx: {
      chat: { id: 42 },
      match: arg,
      reply: async (text: string, opts?: Reply["opts"]) => {
        replies.push({ text, opts });
      },
    },
    replies,
  };
}

const callbacks = (kb: Keyboard) => kb.flat().map((b) => b.callback_data);

beforeEach(() => {
  setChatEffort.mockClear();
  activeModel.value = "glm-5";
});

describe("/settings keyboard", () => {
  it("links to the /model menu instead of rendering dead model buttons", () => {
    const kb = renderSettingsKeyboard("glm-5", "high", false, ["low", "high"]);
    const data = callbacks(kb);
    expect(data).toContain("model:menu");
    expect(data.some((d) => d.startsWith("settings:model"))).toBe(false);
    expect(kb[0]![0]).toEqual({
      text: "Model: glm-5",
      callback_data: "model:menu",
    });
  });

  it("offers a model choice when none is selected", () => {
    const kb = renderSettingsKeyboard(null, "adaptive", false);
    expect(kb[0]![0]).toEqual({
      text: "Choose model",
      callback_data: "model:menu",
    });
  });

  it("omits the model button when the backend has no model menu", () => {
    const kb = renderSettingsKeyboard("sonnet", "adaptive", true, [], false);
    expect(callbacks(kb)).toEqual(["settings:proactive:off"]);
  });

  it("the /settings command sends the new keyboard", async () => {
    const { ctx, replies } = makeCtx();
    await captureCommands().get("settings")!(ctx);
    const kb = replies[0]!.opts!.reply_markup!.inline_keyboard!;
    expect(callbacks(kb)).toContain("model:menu");
    expect(callbacks(kb).some((d) => d.startsWith("settings:model"))).toBe(
      false,
    );
  });
});

describe("/effort adaptive on a model with no reasoning levels", () => {
  it("resets to adaptive", async () => {
    const { ctx, replies } = makeCtx("adaptive");
    await captureCommands().get("effort")!(ctx);
    expect(setChatEffort).toHaveBeenCalledWith("42", undefined);
    expect(replies[0]!.text).toContain("adaptive");
  });

  it("still refuses a concrete level", async () => {
    const { ctx, replies } = makeCtx("high");
    await captureCommands().get("effort")!(ctx);
    expect(setChatEffort).not.toHaveBeenCalled();
    expect(replies[0]!.text).toContain("No valid reasoning levels");
  });

  it("the Auto button resets too", async () => {
    const answers: unknown[] = [];
    const ctx = {
      answerCallbackQuery: async (a: unknown) => {
        answers.push(a);
      },
      editMessageText: vi.fn(async () => {}),
    } as unknown as Context;
    await handleEffortCallback(ctx, "effort:adaptive", "42", {
      config: {},
      gateway: {},
    } as never);
    expect(setChatEffort).toHaveBeenCalledWith("42", undefined);
    expect(JSON.stringify(answers)).toContain("adaptive");
  });
});
