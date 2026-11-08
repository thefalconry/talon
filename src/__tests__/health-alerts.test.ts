/**
 * System-level alert producers (core/daemon/health-alerts.ts): disk space,
 * error spikes, unhandled rejections, and the crash marker a dead daemon
 * leaves for the next boot to announce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  listener: null as
    ((component: string, message: string, err?: unknown) => void) | null,
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  onLogError: (fn: typeof h.listener) => {
    h.listener = fn;
  },
}));

import {
  activeAlerts,
  resetAlertsForTest,
} from "../core/frontend-runtime/alerts.js";
import {
  announceLastCrash,
  noteUnhandledRejection,
  startHealthAlerts,
  stopHealthAlerts,
} from "../core/daemon/health-alerts.js";
import {
  takeCrashMarker,
  writeCrashMarker,
} from "../core/daemon/crash-marker.js";

const MIN = 60_000;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const sent: string[] = [];
let dir: string;

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  resetAlertsForTest(async (text) => {
    sent.push(text);
  });
  dir = mkdtempSync(join(tmpdir(), "talon-health-"));
});

afterEach(() => {
  stopHealthAlerts();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** A statfs whose free space the test moves; 4 KiB blocks. */
function fakeDisk(freeBytes: number, totalBytes = 20 * GIB) {
  const disk = { free: freeBytes };
  const statfs = vi.fn(async () => ({
    bsize: 4096,
    blocks: totalBytes / 4096,
    bavail: Math.floor(disk.free / 4096),
  }));
  return { disk, statfs };
}

describe("disk.low", () => {
  it("raises under 1 GiB, escalates under 256 MiB, resolves above 1.5 GiB", async () => {
    const { disk, statfs } = fakeDisk(800 * MIB);
    startHealthAlerts({ dataDir: "/srv/talon", statfs });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^🔴 Disk almost full: 800 MiB free/);
    expect(sent[0]).toContain("/srv/talon");

    disk.free = 200 * MIB;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sent[1]).toMatch(/^🚨 Disk almost full: 200 MiB free/);

    // Inside the hysteresis band: neither raise nor resolve.
    disk.free = 1.2 * GIB;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sent).toHaveLength(2);
    expect(activeAlerts().map((a) => a.key)).toEqual(["disk.low"]);

    disk.free = 2 * GIB;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(sent[2]).toMatch(/^✅ Disk space recovered: 2\.0 GiB free/);
    expect(activeAlerts()).toEqual([]);
  });

  it("raises under 5% even with gigabytes free", async () => {
    const { statfs } = fakeDisk(3 * GIB, 100 * GIB);
    startHealthAlerts({ dataDir: "/srv/talon", statfs });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]).toMatch(/3\.0 GiB free \(3\.0%\)/);
  });

  it("stops probing once stopped", async () => {
    const { statfs } = fakeDisk(50 * GIB);
    startHealthAlerts({ dataDir: "/srv/talon", statfs });
    stopHealthAlerts();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(statfs).toHaveBeenCalledTimes(1);
  });
});

describe("errors.spike", () => {
  it("raises at 20 errors in 5 min and resolves after 15 quiet min", async () => {
    startHealthAlerts({
      dataDir: "/srv/talon",
      statfs: fakeDisk(50 * GIB).statfs,
    });
    const fire = (component: string, n: number) => {
      for (let i = 0; i < n; i++)
        h.listener?.(component, "send failed", new Error("ETIMEDOUT"));
    };
    fire("telegram", 12);
    fire("cron", 3);
    fire("backend", 4);
    expect(sent).toEqual([]);
    fire("backend", 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(
      "⚠️ Talon logged 20 errors in 5 min (telegram ×12, backend ×5, cron ×3). " +
        "Latest: backend: send failed: ETIMEDOUT",
    );
    // More errors while hot don't re-raise; they only move the quiet clock.
    await vi.advanceTimersByTimeAsync(4 * MIN);
    fire("telegram", 20);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(activeAlerts().map((a) => a.key)).toEqual(["errors.spike"]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(sent[1]).toMatch(/^✅ Error rate is back to normal/);
    expect(activeAlerts()).toEqual([]);
  });

  it("ignores errors spread thinner than the window", async () => {
    startHealthAlerts({
      dataDir: "/srv/talon",
      statfs: fakeDisk(50 * GIB).statfs,
    });
    for (let i = 0; i < 40; i++) {
      h.listener?.("cron", "tick failed");
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(sent).toEqual([]);
  });

  it("detaches from logError on stop", () => {
    startHealthAlerts({
      dataDir: "/srv/talon",
      statfs: fakeDisk(50 * GIB).statfs,
    });
    expect(h.listener).not.toBeNull();
    stopHealthAlerts();
    expect(h.listener).toBeNull();
  });
});

describe("daemon.unhandled", () => {
  it("raises at 3 rejections in 10 min and resolves after 10 quiet min", async () => {
    noteUnhandledRejection(new Error("first"));
    noteUnhandledRejection(new Error("second"));
    await vi.advanceTimersByTimeAsync(11 * MIN);
    noteUnhandledRejection(new Error("third"));
    expect(sent).toEqual([]); // the first two aged out
    noteUnhandledRejection("fourth");
    noteUnhandledRejection(new Error("ENOSPC: no space left on device"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^🔴 Talon hit 3 unhandled promise rejections/);
    expect(sent[0]).toContain("Latest: ENOSPC: no space left on device");
    await vi.advanceTimersByTimeAsync(11 * MIN);
    expect(sent[1]).toMatch(/^✅ No unhandled promise rejections/);
  });
});

describe("crash marker", () => {
  it("round-trips once, then is gone", () => {
    const path = join(dir, "last-crash.json");
    const err = new TypeError("x is undefined");
    writeCrashMarker("uncaught", err, { path });
    const marker = takeCrashMarker(path);
    expect(marker).toMatchObject({
      kind: "uncaught",
      message: "TypeError: x is undefined",
      pid: process.pid,
    });
    expect(marker?.stack[0]).toMatch(/^at /);
    expect(marker?.stack.length).toBeLessThanOrEqual(5);
    expect(existsSync(path)).toBe(false);
    expect(takeCrashMarker(path)).toBeNull();
  });

  it("drops a corrupt marker", () => {
    const path = join(dir, "last-crash.json");
    writeFileSync(path, "{not json");
    expect(takeCrashMarker(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("keepExisting never clobbers a marker already there", () => {
    const path = join(dir, "last-crash.json");
    writeCrashMarker("uncaught", new Error("the real cause"), { path });
    expect(() =>
      writeCrashMarker("handoff", "successor never served", {
        path,
        keepExisting: true,
      }),
    ).toThrow(/EEXIST/);
    expect(takeCrashMarker(path)?.message).toBe("the real cause");
  });
});

describe("daemon.crash", () => {
  it("announces the marker at boot and resolves once stable", async () => {
    vi.setSystemTime(new Date("2026-09-25T14:03:00Z"));
    const marker = join(dir, "last-crash.json");
    const ledger = join(dir, "crash-announced.json");
    writeCrashMarker("uncaught", new Error("boom"), { path: marker });
    announceLastCrash(marker, ledger);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(
      /^🔴 Talon restarted after a crash at 2026-09-25 14:03 UTC: boom \(at /,
    );
    expect(existsSync(marker)).toBe(false);
    announceLastCrash(marker, ledger); // nothing left to announce
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(sent[1]).toMatch(/^✅ Talon has stayed up since the crash restart/);
  });

  it("holds back a crash loop across restarts and folds it in later", () => {
    const marker = join(dir, "last-crash.json");
    const ledger = join(dir, "crash-announced.json");
    const crashAndReboot = (why: string) => {
      writeCrashMarker("uncaught", new Error(why), { path: marker });
      resetAlertsForTest(async (text) => {
        sent.push(text);
      }); // a fresh process: no in-memory cooldown
      announceLastCrash(marker, ledger);
    };
    crashAndReboot("one");
    vi.advanceTimersByTime(MIN);
    crashAndReboot("two");
    crashAndReboot("three");
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(30 * MIN);
    crashAndReboot("four");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("four");
    expect(sent[1]).toContain("2 more crash(es) since the last alert.");
  });

  it("words a failed handoff and a failed start for what they were", () => {
    const marker = join(dir, "last-crash.json");
    writeCrashMarker("handoff", "the successor exited before serving /health", {
      path: marker,
    });
    announceLastCrash(marker, join(dir, "l1.json"));
    expect(sent[0]).toMatch(
      /didn't come up \(the successor exited before serving \/health\); it was started again\.$/,
    );
    writeCrashMarker("startup", new Error("EADDRINUSE"), { path: marker });
    resetAlertsForTest(async (text) => {
      sent.push(text);
    });
    announceLastCrash(marker, join(dir, "l2.json"));
    expect(sent[1]).toMatch(/Talon failed to start at .*: EADDRINUSE/);
  });
});
