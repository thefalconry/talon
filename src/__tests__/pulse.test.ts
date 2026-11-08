/**
 * Tests for src/core/background/pulse/pulse.ts — the interval loop that
 * feeds a chat's unread messages to the dispatcher.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(async (_params: Record<string, unknown>) => ({})),
  latestMsgId: 5 as number | undefined,
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/engine/dispatcher.js", () => ({
  execute: mocks.execute,
  getActiveCount: () => 0,
}));

vi.mock("../storage/chat-settings.js", () => ({
  setChatPulse: vi.fn(),
  getRegisteredPulseChats: () => [],
  getChatSettings: () => ({ pulse: true }),
  setPulseLastCheckMsgId: vi.fn(),
}));

vi.mock("../storage/history.js", () => ({
  getLatestMessageId: () => mocks.latestMsgId,
  getRecentHistory: () => [
    {
      msgId: mocks.latestMsgId,
      timestamp: Date.now(),
      senderName: "Ada",
      text: "anyone around?",
    },
  ],
}));

const { disablePulse, enablePulse, startPulseTimer, stopPulseTimer } =
  await import("../core/background/pulse/pulse.js");

const INTERVAL_MS = 5 * 60 * 1000;

describe("pulse timer — a pulse turn outlasting the interval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.execute.mockReset();
  });

  afterEach(() => {
    stopPulseTimer();
    disablePulse("100");
    disablePulse("200");
    mocks.latestMsgId = 5;
    vi.useRealTimers();
  });

  it("does not queue the same unread messages again while the first pulse is pending", async () => {
    // The pulse turn waits behind the chat's other turns, so it can easily
    // take longer than one interval to settle.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mocks.execute.mockImplementation(async () => {
      await gate;
      return {};
    });
    enablePulse("100");

    startPulseTimer(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // pulse #1 dispatched
    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS); // two more ticks
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    // Checkpoint advanced: nothing new, nothing re-sent.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("pulses the chat again once the pending turn has settled", async () => {
    mocks.execute.mockResolvedValue({});
    mocks.latestMsgId = 5;
    enablePulse("200");

    startPulseTimer(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    mocks.latestMsgId = 6; // a new message arrives
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });
});
