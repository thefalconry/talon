/**
 * The scheduler — timing, the mutex, and the failure path.
 *
 * All three are things you only find out about at 3am on a live host, so
 * they are pinned here on fake timers with the snapshot builder stubbed:
 * what is under test is when a run fires, that two never overlap, and
 * that a failing run tells the admin once rather than every tick.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOT_DELAY_MS,
  _backupDeps,
  _resetBackupScheduler,
  firstRunDelayMs,
  initBackup,
  runBackup,
  schedulerStatus,
  stopBackupScheduler,
} from "../core/backup/scheduler.js";
import {
  DEFAULT_BACKUP_SETTINGS,
  resolveBackupSettings,
} from "../core/backup/plan.js";
import type { Manifest } from "../core/backup/types.js";

const HOUR = 60 * 60_000;

function manifest(id: string): Manifest {
  return {
    schema: 1,
    id,
    kind: "backup",
    pinned: false,
    createdAt: Date.now(),
    host: "test",
    talonVersion: "0.0.0",
    parts: [],
    includes: [],
    excludes: [],
    sizeBytes: 0,
    remote: {},
  };
}

const original = { ...(_backupDeps as Record<string, unknown>) };

/**
 * Drain the microtask queue. A tick is fire-and-forget (`void tick()`), so
 * advancing the fake clock starts a run but does not wait for the promise
 * chain that re-arms the timer afterwards; on a loaded machine the next
 * `advanceTimersByTime` would otherwise find nothing scheduled.
 */
async function drain(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

/**
 * Wait for a condition the run's promise chain will make true. Draining
 * microtasks is not always enough — the chain can hop through a real
 * macrotask under load — so each attempt also yields one.
 */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await drain();
    await vi.advanceTimersByTimeAsync(0);
  }
}

beforeEach(() => {
  _resetBackupScheduler();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  _resetBackupScheduler();
  Object.assign(_backupDeps, original);
});

describe("firstRunDelayMs", () => {
  it("waits out the boot delay when there is no snapshot or an old one", () => {
    expect(firstRunDelayMs(undefined, 6, 1_000_000)).toBe(BOOT_DELAY_MS);
    // Newest is 12h old and the interval is 6h — due, but not during boot.
    expect(firstRunDelayMs(1_000_000 - 12 * HOUR, 6, 1_000_000)).toBe(
      BOOT_DELAY_MS,
    );
  });

  it("waits until a recent snapshot comes due", () => {
    const now = 1_000_000_000;
    expect(firstRunDelayMs(now - HOUR, 6, now)).toBe(5 * HOUR);
    // Never sooner than the boot delay, even for a snapshot taken seconds ago.
    expect(firstRunDelayMs(now - 1_000, 0.0001 as number, now)).toBe(
      BOOT_DELAY_MS,
    );
  });
});

describe("the timer", () => {
  it("fires the first run after the boot delay, then every interval", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-sched-"));
    const build = vi.fn(async () => manifest("20260101T000000Z-aaaaaa"));
    _backupDeps.build = build as unknown as typeof _backupDeps.build;
    _backupDeps.discover = vi.fn(async () => []);

    await initBackup({
      settings: resolveBackupSettings({
        ...DEFAULT_BACKUP_SETTINGS,
        intervalHours: 6,
      }),
      home,
      notify: async () => undefined,
    });
    expect(build).not.toHaveBeenCalled();
    expect(schedulerStatus().nextRunAt).toBeDefined();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    await until(() => build.mock.calls.length === 1);
    expect(build).toHaveBeenCalledTimes(1);
    // The run re-arms the timer when it finishes, not when it starts.
    const armedAfterFirst = schedulerStatus().nextRunAt ?? 0;
    await until(() => (schedulerStatus().nextRunAt ?? 0) > armedAfterFirst);

    await vi.advanceTimersByTimeAsync(6 * HOUR);
    await until(() => build.mock.calls.length === 2);
    expect(build).toHaveBeenCalledTimes(2);

    stopBackupScheduler();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    await drain();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("does not arm a timer when backups are disabled", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-sched-off-"));
    const build = vi.fn(async () => manifest("20260101T000000Z-bbbbbb"));
    _backupDeps.build = build as unknown as typeof _backupDeps.build;
    await initBackup({
      settings: resolveBackupSettings({ enabled: false }),
      home,
      notify: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    await drain();
    expect(build).not.toHaveBeenCalled();
    expect(schedulerStatus().nextRunAt).toBeUndefined();
  });
});

describe("the mutex", () => {
  it("runs one snapshot at a time, and every request still gets its own", async () => {
    // Real timers: nothing here is scheduled, and the assertions are about
    // the order two promises get to run in.
    vi.useRealTimers();
    const home = mkdtempSync(join(tmpdir(), "talon-sched-mutex-"));
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    _backupDeps.build = (async (options: { label?: string }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return { ...manifest("20260101T000000Z-cccccc"), label: options.label };
    }) as unknown as typeof _backupDeps.build;
    _backupDeps.discover = vi.fn(async () => []);
    _backupDeps.pruneLocal = (async () => undefined) as never;

    await initBackup({
      settings: resolveBackupSettings({ enabled: false }),
      home,
      notify: async () => undefined,
    });

    const first = runBackup({
      kind: "checkpoint",
      label: "one",
      trigger: "manual",
    });
    const second = runBackup({
      kind: "checkpoint",
      label: "two",
      trigger: "manual",
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
    await settle();
    expect(release.length).toBe(1); // the second has not started

    release[0]();
    // Poll rather than sleep: on a loaded runner the first run's tail can
    // outlast a fixed pause, and a stranded second run leaks into the next test.
    await vi.waitFor(() => expect(release.length).toBe(2));
    release[1]();

    expect((await first).label).toBe("one");
    expect((await second).label).toBe("two");
    expect(peak).toBe(1);
  });
});

describe("the failure path", () => {
  it("notifies once per streak, not once per failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-sched-fail-"));
    const notify = vi.fn(async (_text: string) => undefined);
    _backupDeps.build = (async () => {
      throw new Error("disk is full");
    }) as unknown as typeof _backupDeps.build;

    await initBackup({
      settings: resolveBackupSettings({ enabled: false }),
      home,
      notify,
    });

    await expect(
      runBackup({ kind: "backup", trigger: "manual" }),
    ).rejects.toThrow(/disk is full/);
    await expect(
      runBackup({ kind: "backup", trigger: "manual" }),
    ).rejects.toThrow(/disk is full/);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0])).toMatch(/disk is full/);
    expect(schedulerStatus().consecutiveFailures).toBe(2);
    expect(schedulerStatus().lastError).toBe("disk is full");
  });

  it("raises backup.failing on the default route and resolves on the next good run", async () => {
    const { activeAlerts, resetAlertsForTest } =
      await import("../core/frontend-runtime/alerts.js");
    const sent: string[] = [];
    resetAlertsForTest(async (text) => {
      sent.push(text);
    });
    const home = mkdtempSync(join(tmpdir(), "talon-sched-alert-"));
    let fail = true;
    _backupDeps.build = (async () => {
      if (fail) throw new Error("disk is full");
      return manifest("ok-1");
    }) as unknown as typeof _backupDeps.build;
    _backupDeps.pruneLocal = (async () => undefined) as never;
    _backupDeps.discover = (async () => []) as never;

    // No `notify`: the default route is the operator alert.
    await initBackup({
      settings: resolveBackupSettings({ enabled: false }),
      home,
    });
    await expect(
      runBackup({ kind: "backup", trigger: "manual" }),
    ).rejects.toThrow(/disk is full/);
    await expect(
      runBackup({ kind: "backup", trigger: "manual" }),
    ).rejects.toThrow(/disk is full/);
    expect(activeAlerts().map((a) => a.key)).toEqual(["backup.failing"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(
      /^⚠️ Backup failed: disk is full\. Retrying after \d\d:\d\d UTC\.$/,
    );

    fail = false;
    await runBackup({ kind: "backup", trigger: "manual" });
    expect(activeAlerts()).toEqual([]);
    expect(sent.at(-1)).toMatch(/Backups are succeeding again/);
  });

  it("skips scheduled ticks while the backoff window is armed", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-sched-backoff-"));
    const build = vi.fn(async () => {
      throw new Error("model of failure");
    });
    _backupDeps.build = build as unknown as typeof _backupDeps.build;

    await initBackup({
      settings: resolveBackupSettings({ intervalHours: 1 }),
      home,
      notify: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    await drain();
    expect(build).toHaveBeenCalledTimes(1);

    // The 5-minute backoff after one failure swallows the next tick.
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS - 1);
    await drain();
    expect(build).toHaveBeenCalledTimes(1);
  });
});
