import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  ADMIN_NOTIFY_QUEUE_MAX,
  adminNotifyFlushed,
  clearPendingAdminNotifications,
  notifyAdmin,
  pendingAdminNotificationCount,
  setAdminNotifier,
} from "../core/frontend-runtime/admin-notify.js";

afterEach(() => {
  setAdminNotifier(null);
  clearPendingAdminNotifications();
  vi.useRealTimers();
});

describe("admin notify queue (alerts raised before a notifier is wired)", () => {
  it("queues while unwired and flushes in order on registration", async () => {
    expect(await notifyAdmin("restore report")).toBe(false);
    expect(await notifyAdmin("security alert")).toBe(false);
    expect(pendingAdminNotificationCount()).toBe(2);

    const delivered: string[] = [];
    setAdminNotifier(async (text) => {
      delivered.push(text);
    });
    await adminNotifyFlushed();
    expect(delivered).toEqual(["restore report", "security alert"]);
    expect(pendingAdminNotificationCount()).toBe(0);

    // Live delivery afterwards is direct, not duplicated.
    expect(await notifyAdmin("live")).toBe(true);
    expect(delivered).toEqual(["restore report", "security alert", "live"]);
  });

  it("is bounded: keeps the newest and reports how many were dropped", async () => {
    for (let i = 0; i < ADMIN_NOTIFY_QUEUE_MAX + 3; i++)
      await notifyAdmin(`alert ${i}`);
    expect(pendingAdminNotificationCount()).toBe(ADMIN_NOTIFY_QUEUE_MAX);

    const delivered: string[] = [];
    setAdminNotifier(async (text) => {
      delivered.push(text);
    });
    await adminNotifyFlushed();
    expect(delivered).toHaveLength(ADMIN_NOTIFY_QUEUE_MAX + 1);
    expect(delivered[0]).toMatch(/^3 earlier admin alert\(s\) were dropped/);
    expect(delivered[1]).toBe("alert 3");
    expect(delivered.at(-1)).toBe(`alert ${ADMIN_NOTIFY_QUEUE_MAX + 2}`);
  });

  it("marks alerts that waited a while as delayed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    await notifyAdmin("old news");
    vi.setSystemTime(new Date("2026-09-30T10:00:42Z"));
    const delivered: string[] = [];
    setAdminNotifier(async (text) => {
      delivered.push(text);
    });
    await adminNotifyFlushed();
    expect(delivered).toEqual(["(delayed 42s) old news"]);
  });

  it("a failing notifier drops the queued alert instead of looping", async () => {
    await notifyAdmin("doomed");
    const fn = vi.fn(async () => {
      throw new Error("telegram down");
    });
    setAdminNotifier(fn);
    await expect(adminNotifyFlushed()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(pendingAdminNotificationCount()).toBe(0);
  });

  it("nothing is flushed when the notifier is cleared", async () => {
    await notifyAdmin("waiting");
    setAdminNotifier(null);
    await adminNotifyFlushed();
    expect(pendingAdminNotificationCount()).toBe(1);
  });
});
