/**
 * `/admin kill <chatId>` performs the same reset as /reset in that chat.
 *
 * It used to clear only Talon's session and history stores, leaving the
 * backend's own per-chat session (and the pulse checkpoint) alive, so the
 * "killed" chat carried on with its old context.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bot, Context } from "grammy";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
const performSessionReset = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../frontend/presentation/session-status.js", () => ({
  performSessionReset,
}));
const perChatBackend = vi.hoisted(() => ({ id: "per-chat" }));
const resolveBackendForChat = vi.hoisted(() => vi.fn(() => perChatBackend));
vi.mock("../frontend/telegram/model-menu.js", () => ({
  resolveBackendForChat,
}));

import { handleAdminCommand } from "../frontend/telegram/admin.js";
import type { TalonConfig } from "../core/config/index.js";

function makeCtx(match: string) {
  const replies: string[] = [];
  const ctx = {
    chat: { id: 1, type: "private" },
    match,
    reply: async (text: string) => {
      replies.push(text);
    },
  } as unknown as Context;
  return { ctx, replies };
}

beforeEach(() => {
  performSessionReset.mockClear();
  resolveBackendForChat.mockClear();
});

describe("/admin kill", () => {
  it("resets through performSessionReset with the chat's backend", async () => {
    const gateway = { backend: null };
    const { ctx, replies } = makeCtx("kill -10042");
    await handleAdminCommand(ctx, {} as Bot, {} as TalonConfig, gateway);

    expect(resolveBackendForChat).toHaveBeenCalledWith("-10042", gateway);
    expect(performSessionReset).toHaveBeenCalledWith("-10042", perChatBackend);
    expect(replies).toEqual(["Session -10042 reset."]);
  });

  it("prints usage without a chat id", async () => {
    const { ctx, replies } = makeCtx("kill");
    await handleAdminCommand(ctx, {} as Bot, {} as TalonConfig);
    expect(performSessionReset).not.toHaveBeenCalled();
    expect(replies[0]).toContain("Usage");
  });
});
