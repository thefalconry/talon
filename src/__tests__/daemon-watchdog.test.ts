/**
 * `talon watchdog` — a supervisor that only ever starts, and never makes a
 * second daemon.
 *
 * Every test runs `runWatchdogOnce` against a tmpdir pidfile, state file,
 * lock and stop marker, with discovery and `startDaemon` stubbed: the point
 * is the decision (start or not), and the one thing that must never happen
 * is a start while anything that could be a daemon is alive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runWatchdogOnce,
  type WatchdogOptions,
} from "../core/daemon/watchdog/watchdog.js";
import type { RunningInstance } from "../core/daemon/discovery.js";
import type { StartOutcome } from "../core/daemon/control.js";
import { startDaemon, stopDaemon } from "../core/daemon/control.js";
import {
  clearStopMarker,
  readStopMarker,
  writeStopMarker,
} from "../core/daemon/watchdog/stop-marker.js";
import { readPidRecord, writePidRecord } from "../core/daemon/pidfile.js";

let dir: string;
let clock: number;
let started: number;
let instance: RunningInstance | null;
let startResult: StartOutcome;
let crashes: string[];

/** A pid that is certainly not running (max pid on Linux is < 2^22). */
const DEAD_PID = 2 ** 30 + 1;
const BOOT = Date.parse("2026-10-11T00:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "talon-watchdog-"));
  clock = BOOT + 3_600_000;
  started = 0;
  instance = null;
  startResult = { ok: true, pid: 4242, port: 19876 };
  crashes = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function opts(extra: Partial<WatchdogOptions> = {}): WatchdogOptions {
  return {
    pkgRoot: dir,
    pidfilePath: join(dir, "talon.pid"),
    statePath: join(dir, "watchdog.json"),
    lockPath: join(dir, "watchdog.lock"),
    stopMarkerPath: join(dir, "stopped-on-purpose.json"),
    find: async () => instance,
    start: async () => {
      started++;
      return startResult;
    },
    now: () => clock,
    bootTime: () => BOOT,
    // Whatever now holds a recycled pid; tests that need Talon say so.
    cmdline: () => "/usr/sbin/sshd -D",
    markCrash: (why) => crashes.push(why),
    ...extra,
  };
}

/** Run the watchdog once per minute, `n` times. */
async function runMinutes(n: number, o = opts()) {
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(await runWatchdogOnce(o));
    clock += 60_000;
  }
  return results;
}

const live = (source: RunningInstance["source"]): RunningInstance => ({
  pid: process.pid,
  port: 19876,
  source,
  pidfileStale: false,
  ...(source === "pidfile-unverified" ? {} : { health: { app: "talon" } }),
});

describe("talon watchdog", () => {
  it("does nothing while a daemon answers", async () => {
    instance = live("pidfile");
    const results = await runMinutes(10);
    expect(started).toBe(0);
    expect(
      results.every((r) => r.action === "none" && r.reason === "running"),
    ).toBe(true);
  });

  it("never starts while a pidfile pid is alive, even with no /health (booting, hung, mid-handoff)", async () => {
    instance = live("pidfile-unverified");
    writePidRecord(
      { pid: process.pid, startedAt: new Date(BOOT + 1000).toISOString() },
      join(dir, "talon.pid"),
    );
    await runMinutes(10);
    expect(started).toBe(0);
  });

  it("starts after three empty checks spanning two minutes, then counts afresh", async () => {
    const results = await runMinutes(3);
    expect(results.map((r) => r.action)).toEqual(["none", "none", "started"]);
    expect(results[0]).toMatchObject({ reason: "waiting", misses: 1 });
    expect(results[2]).toEqual({ action: "started", pid: 4242, port: 19876 });
    expect(started).toBe(1);
    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toMatch(/no daemon answered for 120s \(3 checks\)/);
    // The next outage needs its own three misses.
    await runMinutes(2);
    expect(started).toBe(1);
  });

  it("a timer firing faster than expected still waits two minutes", async () => {
    const o = opts();
    for (let i = 0; i < 10; i++) {
      await runWatchdogOnce(o);
      clock += 10_000; // ten runs in 100 s
    }
    expect(started).toBe(0);
    clock += 20_000;
    await runWatchdogOnce(o);
    expect(started).toBe(1);
  });

  it("a daemon that comes back resets the count (a /restart gap is not an outage)", async () => {
    await runMinutes(2);
    instance = live("pidfile");
    await runMinutes(1);
    instance = null;
    await runMinutes(2);
    expect(started).toBe(0);
  });

  it("respects `talon stop`, and starts again once something withdraws it", async () => {
    const marker = join(dir, "stopped-on-purpose.json");
    writeStopMarker("talon stop", marker);
    const results = await runMinutes(10);
    expect(started).toBe(0);
    expect(results[9]).toMatchObject({
      action: "none",
      reason: "stopped-on-purpose",
      by: "talon stop",
    });
    clearStopMarker(marker);
    await runMinutes(3);
    expect(started).toBe(1);
  });

  it("treats an unreadable stop marker as a stop", async () => {
    writeFileSync(join(dir, "stopped-on-purpose.json"), "{garbage");
    await runMinutes(5);
    expect(started).toBe(0);
  });

  it("does nothing while another watchdog run holds the lock", async () => {
    // A live holder (this test process), freshly taken.
    writeFileSync(
      join(dir, "watchdog.lock"),
      JSON.stringify({ pid: process.ppid, at: clock }),
    );
    const results = await runMinutes(5);
    expect(started).toBe(0);
    expect(
      results.every((r) => r.action === "none" && r.reason === "busy"),
    ).toBe(true);
  });

  it("takes over a lock left by a run that died", async () => {
    writeFileSync(
      join(dir, "watchdog.lock"),
      JSON.stringify({ pid: DEAD_PID, at: clock }),
    );
    await runMinutes(3);
    expect(started).toBe(1);
    expect(existsSync(join(dir, "watchdog.lock"))).toBe(false);
  });

  it("serialises two runs that overlap", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    // Two misses already on the books; the third run starts, slowly.
    await runMinutes(2);
    const slow = opts({
      start: async () => {
        started++;
        await gate;
        return startResult;
      },
    });
    const first = runWatchdogOnce(slow);
    await new Promise((r) => setTimeout(r, 10));
    const second = await runWatchdogOnce(slow);
    release();
    expect((await first).action).toBe("started");
    expect(second).toEqual({ action: "none", reason: "busy" });
    expect(started).toBe(1);
  });

  it("ignores a pidfile pid recycled after a reboot, and clears it so the start goes through", async () => {
    // The record is from before this boot; the pid now belongs to someone
    // else, so discovery sees "alive, no /health".
    instance = live("pidfile-unverified");
    const pidfile = join(dir, "talon.pid");
    writePidRecord(
      { pid: process.pid, startedAt: new Date(BOOT - 60_000).toISOString() },
      pidfile,
    );
    // Like the real startDaemon, refuse while the pidfile names a live pid:
    // its discovery has no boot-time rule.
    const seen: Array<number | undefined> = [];
    const o = opts({
      start: async () => {
        started++;
        const rec = readPidRecord(pidfile);
        seen.push(rec?.pid);
        return rec
          ? {
              ok: false,
              reason: "already-running",
              instance: live("pidfile-unverified"),
            }
          : startResult;
      },
    });
    const results = await runMinutes(3, o);
    expect(started).toBe(1);
    expect(seen).toEqual([undefined]);
    expect(results[2]).toMatchObject({ action: "started" });
  });

  it("keeps a pre-boot record whose live pid still looks like Talon (clock stepped after boot)", async () => {
    instance = live("pidfile-unverified");
    const pidfile = join(dir, "talon.pid");
    writePidRecord(
      { pid: process.pid, startedAt: new Date(BOOT - 60_000).toISOString() },
      pidfile,
    );
    await runMinutes(
      5,
      opts({ cmdline: () => "node tsx/dist/cli.mjs /srv/talon/src/index.ts" }),
    );
    expect(started).toBe(0);
    expect(readPidRecord(pidfile)?.pid).toBe(process.pid);
    // Unreadable command line: assume it might be Talon.
    await runMinutes(5, opts({ cmdline: () => null }));
    expect(started).toBe(0);
  });

  it("reports a start that `startDaemon` refused as running", async () => {
    startResult = {
      ok: false,
      reason: "already-running",
      instance: live("scan"),
    };
    const results = await runMinutes(3);
    expect(results[2]).toMatchObject({ action: "none", reason: "running" });
  });

  it("reports a failed start", async () => {
    startResult = {
      ok: false,
      reason: "exited-early",
      detail: "exited with code 1",
    };
    const results = await runMinutes(3);
    expect(results[2]).toEqual({
      action: "start-failed",
      detail: "exited with code 1",
    });
    // ...and tries again after another full window, not every minute.
    await runMinutes(2);
    expect(started).toBe(1);
    await runMinutes(1);
    expect(started).toBe(2);
  });
});

describe("stop marker", () => {
  it("`talon stop` leaves it; the stop half of a restart does not", async () => {
    const marker = join(dir, "stopped-on-purpose.json");
    const pidfilePath = join(dir, "talon.pid");
    // Pin discovery to a dead port so no real daemon is found.
    const envBackup = process.env.TALON_HEALTH_PORT;
    process.env.TALON_HEALTH_PORT = "1";
    try {
      await stopDaemon({ pidfilePath, stopMarkerPath: marker });
      expect(readStopMarker(marker)).toBeNull();
      await stopDaemon({
        pidfilePath,
        stopMarkerPath: marker,
        intentional: true,
      });
      expect(readStopMarker(marker)).toMatchObject({ by: "talon stop" });
    } finally {
      if (envBackup === undefined) delete process.env.TALON_HEALTH_PORT;
      else process.env.TALON_HEALTH_PORT = envBackup;
    }
  });

  it("any start withdraws it", async () => {
    const marker = join(dir, "stopped-on-purpose.json");
    writeStopMarker("talon stop", marker);
    const pidfilePath = join(dir, "talon.pid");
    // A live daemon answers, so startDaemon stops at "already running"
    // without spawning anything; the marker is gone regardless.
    writePidRecord({ pid: process.pid }, pidfilePath);
    const envBackup = process.env.TALON_HEALTH_PORT;
    process.env.TALON_HEALTH_PORT = "1";
    try {
      const result = await startDaemon({
        pkgRoot: dir,
        pidfilePath,
        stopMarkerPath: marker,
      });
      expect(result).toMatchObject({ ok: false, reason: "already-running" });
      expect(readStopMarker(marker)).toBeNull();
    } finally {
      if (envBackup === undefined) delete process.env.TALON_HEALTH_PORT;
      else process.env.TALON_HEALTH_PORT = envBackup;
    }
    expect(readFileSync(pidfilePath, "utf-8")).toContain(String(process.pid));
  });
});
