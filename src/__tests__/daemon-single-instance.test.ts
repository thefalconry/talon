/**
 * The daemon's single-instance guard and the ownership stamp its orphan
 * sweeps rely on. Regression: 2026-09-27, two daemons ran for 13 minutes
 * (pidfile overwritten, ports fell back, Telegram 409s, and the newcomer's
 * trigger resume killed the running daemon's watchers).
 */

import { createServer, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkSingleInstance,
  describeRefusal,
  PREDECESSOR_PID_ENV,
} from "../core/daemon/discovery.js";
import type { RunningInstance } from "../core/daemon/discovery.js";
import {
  DAEMON_PID_ENV,
  DAEMON_STARTTIME_ENV,
  isOtherLiveDaemon,
  ownerFromEnviron,
  readPidStarttimeSync,
  stampDaemonOwner,
} from "../core/daemon/pidfile.js";
import { listenWithRetry } from "../core/engine/gateway-routes.js";

const daemon = (pid: number, port = 19876): RunningInstance => ({
  pid,
  port,
  source: "pidfile",
  pidfileStale: false,
  health: { app: "talon", mode: "daemon", pid },
});

/** A clock that advances by whatever the guard sleeps. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("checkSingleInstance", () => {
  it("boots when nothing is running", async () => {
    const verdict = await checkSingleInstance({
      find: async () => null,
      env: {},
    });
    expect(verdict.ok).toBe(true);
  });

  it("refuses when /health confirms another daemon", async () => {
    const verdict = await checkSingleInstance({
      find: async () => daemon(4242),
      env: {},
    });
    expect(verdict).toMatchObject({ ok: false, instance: { pid: 4242 } });
    if (!verdict.ok) {
      expect(describeRefusal(verdict.instance)).toMatch(
        /already running \(pid 4242 on :19876\)/,
      );
    }
  });

  it("waits out its /restart predecessor instead of refusing", async () => {
    const clock = fakeClock();
    let predecessorAlive = true;
    let slept = 0;
    const env: NodeJS.ProcessEnv = { [PREDECESSOR_PID_ENV]: "777" };
    const verdict = await checkSingleInstance({
      now: clock.now,
      sleep: async (ms) => {
        slept += ms;
        await clock.sleep(ms);
        predecessorAlive = false; // it exits during our first poll
      },
      env,
      isAlive: (pid) => pid === 777 && predecessorAlive,
      find: async () => (predecessorAlive ? daemon(777) : null),
      predecessorWaitMs: 5_000,
    });
    expect(verdict.ok).toBe(true);
    expect(slept).toBeGreaterThan(0);
    expect(slept).toBeLessThan(5_000);
    // Consumed, so this daemon's own children don't inherit it.
    expect(env[PREDECESSOR_PID_ENV]).toBeUndefined();
  });

  it("does not refuse over a predecessor still alive past the wait", async () => {
    const clock = fakeClock();
    const verdict = await checkSingleInstance({
      ...clock,
      env: { [PREDECESSOR_PID_ENV]: "777" },
      isAlive: () => true,
      find: async () => daemon(777),
      predecessorWaitMs: 1_000,
    });
    expect(verdict.ok).toBe(true);
  });

  it("still refuses a daemon that is not its predecessor", async () => {
    const clock = fakeClock();
    const verdict = await checkSingleInstance({
      ...clock,
      env: { [PREDECESSOR_PID_ENV]: "777" },
      isAlive: () => false,
      find: async () => daemon(4242),
    });
    expect(verdict.ok).toBe(false);
  });

  it("waits for a booting daemon to answer, then refuses", async () => {
    const clock = fakeClock();
    let calls = 0;
    const verdict = await checkSingleInstance({
      ...clock,
      env: {},
      isAlive: () => true,
      find: async () => {
        calls += 1;
        return calls < 3
          ? { pid: 4242, source: "pidfile-unverified", pidfileStale: false }
          : daemon(4242);
      },
    });
    expect(verdict.ok).toBe(false);
    expect(calls).toBe(3);
  });

  it("treats a live pid that never answers as recycled", async () => {
    const clock = fakeClock();
    const verdict = await checkSingleInstance({
      ...clock,
      env: {},
      isAlive: () => true,
      find: async () => ({
        pid: 4242,
        source: "pidfile-unverified",
        pidfileStale: false,
      }),
      unverifiedWaitMs: 2_000,
    });
    expect(verdict.ok).toBe(true);
  });

  it("boots if discovery itself throws", async () => {
    const verdict = await checkSingleInstance({
      env: {},
      find: async () => {
        throw new Error("boom");
      },
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("daemon ownership stamp", () => {
  it("stamps our pid (and start time where /proc exists)", () => {
    const env: NodeJS.ProcessEnv = { [DAEMON_PID_ENV]: "1" };
    stampDaemonOwner(env);
    expect(env[DAEMON_PID_ENV]).toBe(String(process.pid));
    const start = readPidStarttimeSync(process.pid);
    if (start !== undefined) {
      expect(env[DAEMON_STARTTIME_ENV]).toBe(String(start));
    }
  });

  it("parses the stamp out of an environ block", () => {
    expect(ownerFromEnviron(["A=b", `${DAEMON_PID_ENV}=12`, "C=d"])).toEqual({
      pid: 12,
    });
    expect(
      ownerFromEnviron([`${DAEMON_PID_ENV}=12`, `${DAEMON_STARTTIME_ENV}=99`]),
    ).toEqual({ pid: 12, starttime: 99 });
    expect(ownerFromEnviron(["A=b"])).toBeUndefined();
  });

  it("knows a live other daemon from ourselves, a dead one, and a recycled pid", () => {
    expect(isOtherLiveDaemon(undefined)).toBe(false);
    expect(isOtherLiveDaemon({ pid: process.pid })).toBe(false);
    expect(isOtherLiveDaemon({ pid: 2147483646 })).toBe(false);
    expect(isOtherLiveDaemon({ pid: process.ppid })).toBe(true);
    const start = readPidStarttimeSync(process.ppid);
    if (start !== undefined) {
      expect(isOtherLiveDaemon({ pid: process.ppid, starttime: start })).toBe(
        true,
      );
      expect(
        isOtherLiveDaemon({ pid: process.ppid, starttime: start + 1 }),
      ).toBe(false);
    }
  });
});

describe("listenWithRetry port veto", () => {
  const open: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      open.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
    );
  });

  async function occupy(): Promise<number> {
    const blocker = createServer();
    open.push(blocker);
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    return (blocker.address() as { port: number }).port;
  }

  it("walks to the next port when the check allows it", async () => {
    const busy = await occupy();
    const server = createHttpServer();
    open.push(server as unknown as Server);
    const bound = await listenWithRetry(server, busy, async () => undefined);
    expect(bound).not.toBe(busy);
  });

  it("fails instead of walking when the check refuses", async () => {
    const busy = await occupy();
    const server = createHttpServer();
    await expect(
      listenWithRetry(server, busy, async (port) => `port ${port} is a daemon`),
    ).rejects.toThrow(`port ${busy} is a daemon`);
  });
});
