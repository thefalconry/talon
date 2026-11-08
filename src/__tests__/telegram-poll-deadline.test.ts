import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../util/log.js", () => ({ logWarn: vi.fn() }));

import { pollDeadline } from "../frontend/telegram/polling/poll-deadline.js";
import { logWarn } from "../util/log.js";

type Prev = Parameters<ReturnType<typeof pollDeadline>>[0];

/** A `prev` that never answers until its signal aborts — a dead socket. */
function hangingPrev(): Prev & { seen: (AbortSignal | undefined)[] } {
  const seen: (AbortSignal | undefined)[] = [];
  const prev = ((_method: string, _payload: unknown, signal?: AbortSignal) => {
    seen.push(signal);
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }) as unknown as Prev & { seen: typeof seen };
  prev.seen = seen;
  return prev;
}

describe("pollDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(logWarn).mockClear();
  });

  it("aborts a getUpdates that outlives its long-poll window plus grace", async () => {
    vi.useFakeTimers();
    const prev = hangingPrev();
    const call = pollDeadline(5)(prev, "getUpdates", { timeout: 10 } as never);
    const settled = expect(call).rejects.toThrow("aborted");

    await vi.advanceTimersByTimeAsync(14_000);
    expect(prev.seen[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(logWarn).toHaveBeenCalledWith(
      "bot",
      expect.stringContaining("within 15s"),
    );
  });

  it("still honours grammY's own abort signal (bot.stop) without warning", async () => {
    const prev = hangingPrev();
    const stop = new AbortController();
    const call = pollDeadline()(
      prev,
      "getUpdates",
      { timeout: 30 } as never,
      stop.signal as never,
    );
    stop.abort();
    await expect(call).rejects.toThrow("aborted");
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("leaves every other method untouched", async () => {
    const prev = vi.fn(async () => ({ ok: true, result: true }));
    const signal = new AbortController().signal;
    await pollDeadline()(
      prev as unknown as Prev,
      "sendDocument",
      {} as never,
      signal as never,
    );
    expect(prev).toHaveBeenCalledWith("sendDocument", {}, signal);
  });
});
