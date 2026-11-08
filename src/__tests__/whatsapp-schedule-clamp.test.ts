/**
 * WhatsApp schedule_message clamps its delay to the tool schema's 1-86400s,
 * like telegram/discord. Unclamped, a month-long delay overflowed
 * setTimeout's 2^31-1 ms ceiling and the "scheduled" message went out at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
const sendText = vi.fn(async () => {});
vi.mock("../frontend/whatsapp/actions/send.js", () => ({
  sendText: (...args: unknown[]) => sendText(...(args as [])),
  sendContent: vi.fn(),
  resolveQuoted: vi.fn(),
  boundedSend: vi.fn(),
}));

import { messagingHandlers } from "../frontend/whatsapp/actions/messaging.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function ctx() {
  return {
    chat: { chatId: "wa_dm_5550001", jid: "5550001@s.whatsapp.net" },
    scheduledMessages: new Map(),
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  sendText.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("whatsapp schedule_message", () => {
  it("clamps a delay past the documented ceiling to one day", async () => {
    const res = (await messagingHandlers.schedule_message!(
      { text: "later", delay_seconds: 30 * 24 * 60 * 60 },
      0,
      ctx(),
    )) as { ok: boolean; text: string };
    expect(res.ok).toBe(true);
    expect(res.text).toContain("Scheduled in 86400s");

    await vi.advanceTimersByTimeAsync(DAY_MS - 1000);
    expect(sendText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("keeps a delay inside the ceiling as asked", async () => {
    const res = (await messagingHandlers.schedule_message!(
      { text: "soon", delay_seconds: 90 },
      0,
      ctx(),
    )) as { text: string };
    expect(res.text).toContain("Scheduled in 90s");
  });
});
