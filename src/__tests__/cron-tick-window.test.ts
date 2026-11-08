/**
 * Window-based cron dueness — regression tests for the drifted-tick bug.
 *
 * The scheduler's tick is a plain setInterval(60s): under event-loop load a
 * tick can land at :29:59 and the next at :31:01, so nothing ever evaluates
 * during the :30 minute. The old minute-equality check ("does the current
 * minute match a fire time?") silently skipped such fires. Dueness is now
 * window-based: a job fires when a scheduled time fell inside
 * (windowStart, now], where windowStart is the previous tick's wall clock.
 *
 * These tests exercise `_internals.isCronDue` / `_internals.isDue` directly
 * as pure functions — no timers, no store.
 */

import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../storage/cron.js";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../storage/daily-log.js", () => ({
  appendDailyLog: vi.fn(),
  appendDailyLogResponse: vi.fn(),
}));

vi.mock("../core/engine/dispatcher.js", () => ({
  getActiveCount: vi.fn(() => 0),
}));

vi.mock("../core/background/cron/job-oneshot.js", () => ({
  runJobOneShot: vi.fn(async () => ({ status: "ran" as const })),
}));

const { _cronInternals } = await import("../core/background/cron/scheduler.js");
const { isCronDue, isDue } = _cronInternals;

let seq = 0;
function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: `win-cron-${++seq}`,
    chatId: "123",
    schedule: "30 15 * * *",
    timezone: "UTC",
    type: "message",
    content: "Hello!",
    name: "Window test job",
    enabled: true,
    createdAt: Date.UTC(2026, 6, 1),
    runCount: 0,
    ...overrides,
  };
}

const T = (h: number, m: number, s: number) => Date.UTC(2026, 6, 22, h, m, s);

describe("isCronDue — window semantics", () => {
  it("fires when the scheduled minute fell between two drifted ticks (regression)", () => {
    // Previous tick at 15:29:59, this tick at 15:31:01 — no tick landed
    // inside the 15:30 minute. The 15:30:00 fire is inside the window.
    const job = makeJob();
    const due = isCronDue(job, new Date(T(15, 31, 1)), T(15, 29, 59));
    expect(due).toBe(true);
  });

  it("fires on an exactly-aligned tick (baseline behavior preserved)", () => {
    const job = makeJob();
    const due = isCronDue(job, new Date(T(15, 30, 5)), T(15, 29, 30));
    expect(due).toBe(true);
  });

  it("does not re-fire a slot the previous tick already covered", () => {
    // Window starts after the 15:30:00 fire — the previous tick was
    // responsible for it.
    const job = makeJob();
    const due = isCronDue(job, new Date(T(15, 31, 5)), T(15, 30, 10));
    expect(due).toBe(false);
  });

  it("dedupes via lastRunAt when the slot already ran", () => {
    const job = makeJob({ lastRunAt: T(15, 30, 2) });
    const due = isCronDue(job, new Date(T(15, 30, 40)), T(15, 29, 0));
    expect(due).toBe(false);
  });

  it("suppresses runs within 55s of the last execution", () => {
    // Fire time in window but lastRunAt only 30s ago (e.g. run-now raced).
    const job = makeJob({ lastRunAt: T(15, 30, 20) });
    const due = isCronDue(job, new Date(T(15, 30, 50)), T(15, 29, 0));
    expect(due).toBe(false);
  });

  it("honors timezones — the London yearly one-shot regression case", () => {
    // "0 9 13 7 *" Europe/London fires 2026-07-13T08:00:00Z. A tick pair
    // spanning that instant must catch it.
    const job = makeJob({ schedule: "0 9 13 7 *", timezone: "Europe/London" });
    const windowStart = Date.UTC(2026, 6, 13, 7, 59, 30);
    const now = new Date(Date.UTC(2026, 6, 13, 8, 1, 10));
    expect(isCronDue(job, now, windowStart)).toBe(true);
  });

  it("returns false for an invalid schedule instead of throwing", () => {
    const job = makeJob({ schedule: "not a cron" });
    expect(isCronDue(job, new Date(T(15, 31, 0)), T(15, 29, 0))).toBe(false);
  });
});

describe("isDue — gates on top of the window", () => {
  it("never counts fire times from before startAt", () => {
    // Job becomes eligible at 15:30:30 — the 15:30:00 fire predates it.
    const job = makeJob({ startAt: T(15, 30, 30) });
    expect(isDue(job, new Date(T(15, 31, 0)), T(15, 29, 0))).toBe(false);
  });

  it("still fires the first slot at/after startAt", () => {
    const job = makeJob({ startAt: T(15, 29, 0) });
    expect(isDue(job, new Date(T(15, 31, 0)), T(15, 29, 30))).toBe(true);
  });

  it("interval jobs are unaffected by the window", () => {
    const job = makeJob({
      schedule: undefined,
      everyMs: 3_600_000,
      lastRunAt: T(14, 0, 0),
    });
    expect(isDue(job, new Date(T(14, 59, 30)), T(14, 58, 0))).toBe(false);
    expect(isDue(job, new Date(T(15, 0, 1)), T(14, 59, 0))).toBe(true);
  });
});
