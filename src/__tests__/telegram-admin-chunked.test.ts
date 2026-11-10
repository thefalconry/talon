/**
 * `/admin chats` (and the other per-item admin listings) must split
 * across messages once they outgrow Telegram's 4096-char cap.
 *
 * With ~115 live chats the listing ran to well over 4096 chars and the
 * single `ctx.reply` failed the whole command with
 * `sendMessage 400 message is too long` — the operator got nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bot, Context } from "grammy";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const getAllSessions = vi.hoisted(() => vi.fn());
vi.mock("../storage/sessions.js", () => ({
  getAllSessions,
  resetSession: vi.fn(),
}));
vi.mock("../storage/history.js", () => ({ markContextCleared: vi.fn() }));
vi.mock("../storage/daily-log.js", () => ({
  todayLogDate: vi.fn(() => "2026-01-01"),
}));
vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: vi.fn(() => ({})),
}));
const getAllCronJobs = vi.hoisted(() => vi.fn());
vi.mock("../storage/cron.js", () => ({
  getAllCronJobs,
  describeSchedule: vi.fn(() => "every 5m"),
  nextRunAt: vi.fn(() => null),
}));
vi.mock("../core/engine/dispatcher.js", () => ({
  getActiveCount: vi.fn(() => 0),
}));
const getPulseStatus = vi.hoisted(() => vi.fn());
vi.mock("../core/background/pulse/pulse.js", () => ({ getPulseStatus }));
vi.mock("../util/watchdog.js", () => ({
  getHealthStatus: vi.fn(),
  getRecentErrors: vi.fn(() => []),
}));

import { handleAdminCommand } from "../frontend/telegram/admin.js";
import { TELEGRAM_MAX_TEXT } from "../frontend/telegram/actions/types.js";
import type { TalonConfig } from "../core/config/index.js";

const config = { model: "claude-sonnet-4-5" } as TalonConfig;

function makeCtx(match: string, type = "private") {
  const replies: Array<{ text: string; opts?: { parse_mode?: string } }> = [];
  const ctx = {
    chat: { id: 1, type },
    match,
    reply: async (text: string, opts?: { parse_mode?: string }) => {
      replies.push({ text, opts });
      return { message_id: replies.length };
    },
  } as unknown as Context;
  return { ctx, replies };
}

const bot = {
  api: {
    getChat: async (id: number) => ({ id, title: `Group number ${id}` }),
  },
} as unknown as Bot;

function expectChunked(
  replies: Array<{ text: string; opts?: { parse_mode?: string } }>,
  everyLine: string,
): void {
  expect(replies.length).toBeGreaterThan(1);
  for (const r of replies) {
    expect(r.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    expect(r.opts?.parse_mode).toBe("HTML");
    // Every chunk parses on its own — no entry split through its tags.
    expect((r.text.match(/<b>/g) ?? []).length).toBe(
      (r.text.match(/<\/b>/g) ?? []).length,
    );
  }
  expect(replies.map((r) => r.text).join("\n")).toContain(everyLine);
}

beforeEach(() => {
  getAllSessions.mockReset();
  getAllCronJobs.mockReset();
  getPulseStatus.mockReset();
});

describe("/admin listings are chunked at Telegram's cap", () => {
  it("sends a long chats listing as multiple messages", async () => {
    getAllSessions.mockReturnValue(
      Array.from({ length: 115 }, (_, i) => ({
        chatId: String(-1000000000000 - i),
        info: { turns: i, lastActive: Date.now() - i * 60000 },
      })),
    );
    const { ctx, replies } = makeCtx("chats");
    await handleAdminCommand(ctx, bot, config);

    expectChunked(replies, "<code>-1000000000114</code>");
    expect(replies[0]!.text).toMatch(/^<b>Active chats \(115\)<\/b>/);
    const entries = replies.flatMap(
      (r) => r.text.match(/<b>Group number /g) ?? [],
    );
    expect(entries).toHaveLength(115);
  });

  it("sends a long cron listing as multiple messages", async () => {
    getAllCronJobs.mockReturnValue(
      Array.from({ length: 120 }, (_, i) => ({
        name: `job-${i}`,
        enabled: true,
        type: "prompt",
        runCount: i,
      })),
    );
    const { ctx, replies } = makeCtx("cron");
    await handleAdminCommand(ctx, bot, config);
    expectChunked(replies, "<b>job-119</b>");
  });

  it("sends a long pulse listing as multiple messages", async () => {
    getPulseStatus.mockReturnValue(
      Array.from({ length: 400 }, (_, i) => ({
        chatId: String(-1000000000000 - i),
        enabled: i % 2 === 0,
      })),
    );
    const { ctx, replies } = makeCtx("pulse");
    await handleAdminCommand(ctx, bot, config);
    expectChunked(replies, "Group number -1000000000399");
  });

  it("keeps a short listing as a single message", async () => {
    getAllSessions.mockReturnValue([
      { chatId: "-100", info: { turns: 1, lastActive: Date.now() } },
    ]);
    const { ctx, replies } = makeCtx("chats");
    await handleAdminCommand(ctx, bot, config);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.opts?.parse_mode).toBe("HTML");
  });
});

describe("/admin operator-data subcommands stay in the DM (#1049)", () => {
  it.each(["chats", "daily", "errors", "logs"])(
    "refuses /admin %s in a group without running it",
    async (sub) => {
      getAllSessions.mockClear();
      const { ctx, replies } = makeCtx(sub, "supergroup");
      await handleAdminCommand(ctx, bot, config);
      expect(replies).toHaveLength(1);
      expect(replies[0]!.text).toMatch(/only works in a private chat/);
      expect(getAllSessions).not.toHaveBeenCalled();
    },
  );

  it("still runs group-safe subcommands in a group", async () => {
    getAllCronJobs.mockReturnValue([]);
    const { ctx, replies } = makeCtx("cron", "group");
    await handleAdminCommand(ctx, bot, config);
    expect(replies[0]!.text).not.toMatch(/only works in a private chat/);
  });
});
