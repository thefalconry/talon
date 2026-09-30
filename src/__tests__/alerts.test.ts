import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  activeAlerts,
  configureAlerts,
  raiseAlert,
  resetAlertsForTest,
  resolveAlert,
} from "../core/frontend-runtime/alerts.js";

const sent: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  resetAlertsForTest(async (text) => {
    sent.push(text);
  });
});

describe("alerts", () => {
  it("delivers once per cooldown and folds repeats into the next delivery", () => {
    raiseAlert("k", "down");
    raiseAlert("k", "still down");
    raiseAlert("k", "still down");
    expect(sent).toEqual(["🔴 down"]);
    vi.advanceTimersByTime(30 * 60_000);
    raiseAlert("k", "down again", { severity: "critical" });
    expect(sent[1]).toBe("🚨 down again\n(+2 more since the last alert)");
  });

  it("announces recovery only for a delivered alert", () => {
    resolveAlert("never-raised");
    expect(sent).toEqual([]);
    raiseAlert("k", "down", { severity: "warn" });
    vi.advanceTimersByTime(5 * 60_000);
    resolveAlert("k", "Back up");
    expect(sent).toEqual(["⚠️ down", "✅ Back up (after 5 min)"]);
    expect(activeAlerts()).toEqual([]);
  });

  it("tracks but does not deliver when disabled", () => {
    configureAlerts({ enabled: false });
    raiseAlert("k", "down");
    expect(sent).toEqual([]);
    expect(activeAlerts().map((a) => a.key)).toEqual(["k"]);
  });

  it("delivers an escalation inside the cooldown", () => {
    raiseAlert("disk", "low", { severity: "error" });
    raiseAlert("disk", "still low", { severity: "error" });
    raiseAlert("disk", "almost full", { severity: "critical" });
    expect(sent).toEqual([
      "🔴 low",
      "🚨 almost full\n(+1 more since the last alert)",
    ]);
    expect(activeAlerts()[0]?.severity).toBe("critical");
  });

  it("retries on the next raise when delivery failed", async () => {
    let ok = false;
    resetAlertsForTest(async (text) => {
      sent.push(text);
      return ok;
    });
    raiseAlert("k", "down");
    await vi.advanceTimersByTimeAsync(0);
    ok = true;
    raiseAlert("k", "still down");
    await vi.advanceTimersByTimeAsync(0);
    raiseAlert("k", "still down");
    expect(sent).toEqual(["🔴 down", "🔴 still down"]);
  });

  it("applies the configured cooldown", () => {
    configureAlerts({ cooldownMs: 60_000 });
    raiseAlert("k", "down");
    vi.advanceTimersByTime(60_000);
    raiseAlert("k", "down");
    expect(sent).toHaveLength(2);
  });

  it("queues one copy per key before a notifier is wired and drops it if resolved first", async () => {
    const notify = await import("../core/frontend-runtime/admin-notify.js");
    notify.setAdminNotifier(null);
    notify.clearPendingAdminNotifications();
    resetAlertsForTest(); // real notifyAdmin
    try {
      raiseAlert("plugin.playwright", "init timed out");
      await vi.advanceTimersByTimeAsync(0);
      raiseAlert("plugin.playwright", "init timed out");
      await vi.advanceTimersByTimeAsync(0);
      raiseAlert("disk", "low");
      await vi.advanceTimersByTimeAsync(0);
      expect(notify.pendingAdminNotificationCount()).toBe(2);

      resolveAlert("plugin.playwright", "fine now");
      expect(notify.pendingAdminNotificationCount()).toBe(1);

      const delivered: string[] = [];
      notify.setAdminNotifier(async (text) => {
        delivered.push(text);
      });
      await notify.adminNotifyFlushed();
      expect(delivered).toEqual(["🔴 low"]);
    } finally {
      notify.setAdminNotifier(null);
      notify.clearPendingAdminNotifications();
    }
  });
});
