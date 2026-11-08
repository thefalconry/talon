import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../core/frontend-runtime/alerts.js", () => ({
  raiseAlert: vi.fn(),
  resolveAlert: vi.fn(),
}));

import { GrammyError } from "grammy";
import { pollHealth } from "../frontend/telegram/polling/poll-health.js";
import { raiseAlert, resolveAlert } from "../core/frontend-runtime/alerts.js";
import { log, logWarn } from "../util/log.js";

type Prev = Parameters<ReturnType<typeof pollHealth>>[0];

/** A `prev` whose outcome the test sets before each call. */
function scriptedPrev() {
  const state: { next: () => Promise<unknown> } = {
    next: async () => ({ ok: true, result: [] }),
  };
  const prev = (() => state.next()) as unknown as Prev;
  return { prev, state };
}

function grammyError(code: number, description: string): GrammyError {
  return new GrammyError(
    `Call to 'getUpdates' failed! (${code}: ${description})`,
    { ok: false, error_code: code, description },
    "getUpdates",
    {},
  );
}

const MIN = 60_000;

describe("pollHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(raiseAlert).mockClear();
    vi.mocked(resolveAlert).mockClear();
    vi.mocked(log).mockClear();
    vi.mocked(logWarn).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("raises telegram.polling after 5 min of failed polls and resolves on the next success", async () => {
    const { prev, state } = scriptedPrev();
    const t = pollHealth();
    state.next = async () => {
      throw new Error("Network request for 'getUpdates' failed! ETIMEDOUT");
    };

    await expect(t(prev, "getUpdates", {} as never)).rejects.toThrow();
    expect(logWarn).toHaveBeenLastCalledWith(
      "bot",
      "telegram.poll.fail attempt=1 down_ms=0 backoff_ms=3000 " +
        "err=Network request for 'getUpdates' failed! ETIMEDOUT",
    );
    await vi.advanceTimersByTimeAsync(4 * MIN);
    await expect(t(prev, "getUpdates", {} as never)).rejects.toThrow();
    expect(raiseAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MIN);
    expect(raiseAlert).toHaveBeenCalledWith(
      "telegram.polling",
      "Telegram polling has failed for 5 min: Network request for 'getUpdates' failed! ETIMEDOUT. " +
        "Messages are not being received.",
      { severity: undefined },
    );

    state.next = async () => ({ ok: true, result: [] });
    await t(prev, "getUpdates", {} as never);
    expect(resolveAlert).toHaveBeenCalledWith(
      "telegram.polling",
      "Telegram polling is working again.",
    );
    expect(log).toHaveBeenCalledWith(
      "bot",
      `telegram.poll.recovered failed_attempts=2 down_ms=${5 * MIN}`,
    );
  });

  it("does not raise for a short blip", async () => {
    const { prev, state } = scriptedPrev();
    const t = pollHealth();
    state.next = async () => {
      throw new Error("ECONNRESET");
    };
    await expect(t(prev, "getUpdates", {} as never)).rejects.toThrow();
    state.next = async () => ({ ok: true, result: [] });
    await t(prev, "getUpdates", {} as never);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(raiseAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("logs Telegram's retry_after as the backoff on a 429", async () => {
    const { prev, state } = scriptedPrev();
    const t = pollHealth();
    const err = grammyError(429, "Too Many Requests: retry after 7");
    (err.parameters as { retry_after?: number }).retry_after = 7;
    state.next = async () => {
      throw err;
    };
    await expect(t(prev, "getUpdates", {} as never)).rejects.toBe(err);
    expect(logWarn).toHaveBeenLastCalledWith(
      "bot",
      expect.stringContaining("backoff_ms=7000"),
    );
  });

  it("raises telegram.conflict at once on 409, and resolves it on a later success", async () => {
    const { prev, state } = scriptedPrev();
    const t = pollHealth();
    const err = grammyError(
      409,
      "Conflict: terminated by other getUpdates request",
    );
    state.next = async () => {
      throw err;
    };
    await expect(t(prev, "getUpdates", {} as never)).rejects.toBe(err);
    expect(raiseAlert).toHaveBeenCalledWith(
      "telegram.conflict",
      expect.stringContaining(
        "Another process is polling this Telegram bot token",
      ),
      { severity: "critical" },
    );

    state.next = async () => ({ ok: true, result: [] });
    await t(prev, "getUpdates", {} as never);
    expect(resolveAlert).toHaveBeenCalledWith(
      "telegram.conflict",
      expect.any(String),
    );
  });

  it("raises telegram.polling critically at once on 401", async () => {
    const { prev, state } = scriptedPrev();
    const t = pollHealth();
    state.next = async () => {
      throw grammyError(401, "Unauthorized");
    };
    await expect(t(prev, "getUpdates", {} as never)).rejects.toThrow();
    expect(raiseAlert).toHaveBeenCalledWith(
      "telegram.polling",
      expect.stringContaining("Telegram rejected the bot token"),
      { severity: "critical" },
    );
  });

  it("ignores a poll cancelled by bot.stop() and every other method", async () => {
    const { prev, state } = scriptedPrev();
    const t = pollHealth();
    state.next = async () => {
      throw new Error("aborted");
    };
    const stop = new AbortController();
    stop.abort();
    await expect(
      t(prev, "getUpdates", {} as never, stop.signal as never),
    ).rejects.toThrow();
    await expect(t(prev, "sendMessage", {} as never)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(logWarn).not.toHaveBeenCalled();
    expect(raiseAlert).not.toHaveBeenCalled();
  });
});
