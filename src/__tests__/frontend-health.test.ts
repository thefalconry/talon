/**
 * Frontend health seams: connection outages (threshold timer → alert,
 * recovery → resolve) and reply-delivery streaks (N failures in a row for
 * one chat → alert, next success → resolve). Real alerts module, fake
 * delivery, fake timers.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { resetAlertsForTest } from "../core/frontend-runtime/alerts.js";
import { createOutage, errorText } from "../frontend/health/outage.js";
import {
  createDeliveryTracker,
  trackDeliveries,
} from "../frontend/health/delivery.js";
import { log, logWarn } from "../util/log.js";

const sent: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  resetAlertsForTest(async (text) => {
    sent.push(text);
  });
  vi.mocked(log).mockClear();
  vi.mocked(logWarn).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function outage() {
  return createOutage({
    key: "test.link",
    thresholdMs: 5 * 60_000,
    describe: (err, mins) => `Link down for ${mins} min: ${err}.`,
    recovered: "Link is back.",
  });
}

describe("createOutage", () => {
  it("stays quiet before the threshold and recovers silently", () => {
    const o = outage();
    expect(o.fail(new Error("ETIMEDOUT"))).toEqual({ attempt: 1, downMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(o.fail(new Error("ETIMEDOUT"))).toEqual({
      attempt: 2,
      downMs: 60_000,
    });
    vi.advanceTimersByTime(3 * 60_000);
    expect(sent).toEqual([]);
    expect(o.ok()).toEqual({ attempts: 2, downMs: 4 * 60_000 });
    expect(o.down).toBe(false);
    // Nothing was delivered, so nothing is announced as recovered.
    vi.advanceTimersByTime(10 * 60_000);
    expect(sent).toEqual([]);
  });

  it("raises with the latest error once the threshold passes, resolves on recovery", () => {
    const o = outage();
    o.fail(new Error("ECONNRESET"));
    vi.advanceTimersByTime(2 * 60_000);
    o.fail(new Error("ETIMEDOUT api.example.org"));
    vi.advanceTimersByTime(3 * 60_000);
    expect(sent).toEqual([
      "🔴 Link down for 5 min: ETIMEDOUT api.example.org.",
    ]);
    expect(o.ok()).not.toBeNull();
    expect(sent[1]).toMatch(/^✅ Link is back\./);
  });

  it("raises even when no further failure arrives (a link that dies silently)", () => {
    const o = outage();
    o.fail("socket closed");
    vi.advanceTimersByTime(5 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it("raiseNow alerts at once and is still resolved by ok()", () => {
    const o = outage();
    o.raiseNow("Token rejected.", "critical");
    expect(sent).toEqual(["🚨 Token rejected."]);
    o.ok();
    expect(sent[1]).toMatch(/^✅ Link is back\./);
  });

  it("dispose drops the pending raise without announcing anything", () => {
    const o = outage();
    o.fail("x");
    o.dispose();
    vi.advanceTimersByTime(10 * 60_000);
    expect(sent).toEqual([]);
    expect(o.down).toBe(false);
  });
});

describe("errorText", () => {
  it("masks bot tokens and webhook signatures, and bounds the length", () => {
    expect(errorText(new Error("GET /bot123:AAabc-_x/getMe failed"))).toBe(
      "GET /bot<redacted>/getMe failed",
    );
    expect(errorText("POST https://h/x?api=1&sig=SECRET&a=b 500")).toBe(
      "POST https://h/x?api=1&sig=<redacted>&a=b 500",
    );
    expect(errorText("x".repeat(500)).length).toBe(201);
  });
});

describe("delivery tracking", () => {
  const ok = async () => ({ ok: true });
  const fail = async () => ({ ok: false, error: "403 Forbidden" });

  it("raises after three failed replies to one chat, resolves on the next delivery", async () => {
    const tracker = createDeliveryTracker("tg", "Telegram", "bot");
    let impl: () => Promise<{ ok: boolean; error?: string }> = fail;
    const handler = trackDeliveries(tracker, () => impl());
    const send = { action: "send_message", text: "hi" };

    await handler(send, 42);
    await handler(send, 42);
    expect(sent).toEqual([]);
    await handler(send, 42);
    expect(sent).toEqual([
      "🔴 Telegram replies to chat 42 have failed 3 times in a row: 403 Forbidden. " +
        "Answers are not reaching that chat.",
    ]);
    expect(logWarn).toHaveBeenCalledWith(
      "bot",
      "delivery.fail frontend=tg chat=42 streak=3 err=403 Forbidden",
    );

    impl = ok;
    await handler(send, 42);
    expect(sent[1]).toBe(
      "✅ Telegram replies are being delivered again. (after 1 min)",
    );
    expect(log).toHaveBeenCalledWith(
      "bot",
      "delivery.recovered frontend=tg chat=42 after_failures=3",
    );
  });

  it("counts streaks per chat, and a success elsewhere does not reset them", async () => {
    const tracker = createDeliveryTracker("tg", "Telegram", "bot");
    tracker.failed(1, "e");
    tracker.failed(1, "e");
    tracker.delivered(2);
    tracker.failed(2, "e");
    expect(sent).toEqual([]);
    tracker.failed(1, "e");
    expect(sent).toHaveLength(1);
  });

  it("a success before the threshold resets the streak", async () => {
    const tracker = createDeliveryTracker("tg", "Telegram", "bot");
    tracker.failed(1, "e");
    tracker.failed(1, "e");
    tracker.delivered(1);
    tracker.failed(1, "e");
    tracker.failed(1, "e");
    expect(sent).toEqual([]);
  });

  it("counts thrown errors, rethrows them, and ignores non-reply actions", async () => {
    const tracker = createDeliveryTracker("tg", "Telegram", "bot");
    const failed = vi.spyOn(tracker, "failed");
    const handler = trackDeliveries(tracker, async () => {
      throw new Error("network down");
    });
    await expect(handler({ action: "reply_to", text: "x" }, 7)).rejects.toThrow(
      "network down",
    );
    expect(failed).toHaveBeenCalledWith(7, expect.any(Error));

    failed.mockClear();
    await expect(handler({ action: "react" }, 7)).rejects.toThrow();
    expect(failed).not.toHaveBeenCalled();
  });

  it("passes results through untouched, and null (not ours) is not a delivery", async () => {
    const tracker = createDeliveryTracker("tg", "Telegram", "bot");
    const failed = vi.spyOn(tracker, "failed");
    const delivered = vi.spyOn(tracker, "delivered");
    const result = { ok: true, message_id: 9 };
    expect(
      await trackDeliveries(tracker, async () => result)(
        { action: "send_message_with_buttons" },
        1,
      ),
    ).toBe(result);
    expect(
      await trackDeliveries(tracker, async () => null)(
        { action: "send_message" },
        1,
      ),
    ).toBeNull();
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it("names the destination with chatOf when an action targets another chat", async () => {
    const tracker = createDeliveryTracker("wa", "WhatsApp", "whatsapp");
    const failed = vi.spyOn(tracker, "failed");
    await trackDeliveries(tracker, fail, (body, chatId) =>
      body.target !== undefined ? String(body.target) : chatId,
    )({ action: "send_message", target: "+15550100" }, 1);
    expect(failed).toHaveBeenCalledWith("+15550100", "403 Forbidden");
  });
});
