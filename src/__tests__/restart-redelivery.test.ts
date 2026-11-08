/**
 * Restart-redelivery guard.
 *
 * Telegram's getUpdates is at-least-once: an update is redelivered until
 * a later call confirms its id. A `/restart` ends the process before
 * grammY's next poll can confirm, so the successor received the same
 * command and restarted again — a boot loop that took the live daemon
 * down four times in a row on 2026-08-22.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  confirmUpdates,
  lastUpdateId,
  noteUpdateId,
  resetUpdateOffset,
} from "../frontend/telegram/polling/update-offset.js";
import { isStaleCommand } from "../frontend/telegram/polling/stale-command.js";

describe("update-offset confirmation", () => {
  beforeEach(() => resetUpdateOffset());

  it("tracks the highest update id, not the latest one seen", () => {
    noteUpdateId(10);
    noteUpdateId(7); // out-of-order dispatch must not rewind the offset
    noteUpdateId(12);
    expect(lastUpdateId()).toBe(12);
  });

  it("confirms one past the highest id so nothing is redelivered", async () => {
    noteUpdateId(270723891);
    const getUpdates = vi.fn(async () => []);
    await confirmUpdates({ api: { getUpdates } } as never);
    expect(getUpdates).toHaveBeenCalledWith({
      offset: 270723892,
      limit: 1,
      timeout: 0,
    });
  });

  it("does nothing when no update was ever seen", async () => {
    const getUpdates = vi.fn(async () => []);
    await confirmUpdates({ api: { getUpdates } } as never);
    expect(getUpdates).not.toHaveBeenCalled();
  });

  it("never throws on the shutdown path", async () => {
    noteUpdateId(5);
    const getUpdates = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      confirmUpdates({ api: { getUpdates } } as never),
    ).resolves.toBeUndefined();
  });
});

describe("stale process-ending commands", () => {
  it("ignores a command issued before this process started", () => {
    const longAgo = Math.floor((Date.now() - 10 * 60_000) / 1000);
    expect(isStaleCommand(longAgo, "/restart")).toBe(true);
  });

  it("obeys a command issued now", () => {
    expect(isStaleCommand(Math.floor(Date.now() / 1000), "/restart")).toBe(
      false,
    );
  });

  it("tolerates clock skew rather than dropping a live command", () => {
    // Telegram's clock running slightly behind ours must not look stale.
    const slightlyBehind = Math.floor((Date.now() - 10_000) / 1000);
    expect(isStaleCommand(slightlyBehind, "/restart")).toBe(false);
  });

  it("treats a message with no timestamp as live", () => {
    expect(isStaleCommand(undefined, "/restart")).toBe(false);
  });
});
