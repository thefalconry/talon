/**
 * The handoff watcher — a `/restart` or `/update` must not end with
 * nobody knowing whether the bot came back.
 *
 * Incident 2026-09-18: the outgoing daemon spawned its successor and
 * exited. The successor lived about twenty seconds, never bound its
 * gateway, and died with stdio "ignore". Nothing noticed: the pidfile
 * still named the dead parent, no line was written anywhere, and Talon
 * stayed down until a human ran `talon start` 45 minutes later.
 *
 * The watcher closes that gap. It outlives the handoff, verifies the
 * successor over identity-checked /health within a bounded window, and
 * starts the daemon the way `talon start` does when it never appears.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A failed handoff leaves a crash marker for the next boot — never in
// the real ~/.talon/data during tests.
const writeCrashMarker = vi.hoisted(() => vi.fn());
vi.mock("../core/daemon/crash-marker.js", () => ({ writeCrashMarker }));

import { watchHandoff, runHandoffWatch } from "../core/daemon/handoff.js";
import type { StartOutcome } from "../core/daemon/control.js";

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(() => {
  writeCrashMarker.mockClear();
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A gateway that answers /health exactly the way the daemon's does. */
async function fakeDaemon(pid: number): Promise<number> {
  const server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ app: "talon", mode: "daemon", pid, ok: true }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

function pidfileWith(pid: number, port: number): string {
  const dir = mkdtempSync(join(tmpdir(), "talon-handoff-"));
  dirs.push(dir);
  const file = join(dir, "talon.pid");
  writeFileSync(file, JSON.stringify({ pid, port }));
  return file;
}

const neverStarts = vi.fn(async (): Promise<StartOutcome> => ({
  ok: false,
  reason: "spawn-failed",
}));

describe("watchHandoff", () => {
  it("verifies a successor that answers /health, and starts nothing", async () => {
    const port = await fakeDaemon(5150);
    const start = vi.fn(neverStarts);

    const outcome = await watchHandoff({
      childPid: 5150,
      pkgRoot: "/repo",
      pidfilePath: pidfileWith(5150, port),
      windowMs: 5_000,
      pollMs: 10,
      alive: () => true,
      start,
    });

    expect(outcome).toMatchObject({ ok: true, via: "successor", pid: 5150 });
    expect(start).not.toHaveBeenCalled();
    expect(writeCrashMarker).not.toHaveBeenCalled();
  });

  it("accepts a live daemon that is not the child we spawned", async () => {
    // The successor died and something else (an operator, a watcher from
    // an earlier handoff) already brought Talon back. Still up is still up.
    const port = await fakeDaemon(9001);
    const outcome = await watchHandoff({
      childPid: 5150,
      pkgRoot: "/repo",
      pidfilePath: pidfileWith(9001, port),
      windowMs: 5_000,
      pollMs: 10,
      alive: () => true,
      start: neverStarts,
    });
    expect(outcome).toMatchObject({ ok: true, via: "restart", pid: 9001 });
  });

  it("restarts as soon as the successor exits without serving", async () => {
    const start = vi.fn(async (): Promise<StartOutcome> => ({
      ok: true,
      pid: 777,
      port: 19876,
    }));
    const outcome = await watchHandoff({
      childPid: 5150,
      pkgRoot: "/repo",
      windowMs: 60_000,
      pollMs: 10,
      find: async () => null,
      alive: () => false,
      start,
    });

    expect(start).toHaveBeenCalledWith({
      pkgRoot: "/repo",
      pidfilePath: undefined,
    });
    expect(writeCrashMarker).toHaveBeenCalledWith(
      "handoff",
      "the successor exited before serving /health",
      { keepExisting: true },
    );
    expect(outcome).toEqual({
      ok: true,
      via: "restart",
      pid: 777,
      port: 19876,
    });
  });

  it("restarts when the successor is alive but never binds", async () => {
    // The 2026-09-18 shape exactly: the process exists, /health never
    // answers, and the window closes.
    const start = vi.fn(async (): Promise<StartOutcome> => ({
      ok: true,
      pid: 888,
    }));
    const polls: number[] = [];
    const outcome = await watchHandoff({
      childPid: 5150,
      pkgRoot: "/repo",
      windowMs: 100,
      pollMs: 10,
      find: async () => null,
      alive: () => true,
      start,
      sleep: async (ms) => void polls.push(ms),
    });

    expect(polls.length).toBeGreaterThan(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: true, via: "restart", pid: 888 });
  });

  it("does not mistake an alive pid for a daemon that serves", async () => {
    // Discovery reports a live pid that never answered /health — the
    // 2026-09-18 shape. `talon start` rightly refuses to spawn a second
    // daemon next to it, and that refusal is the failure, not a recovery.
    const outcome = await watchHandoff({
      childPid: 5150,
      pkgRoot: "/repo",
      windowMs: 30,
      pollMs: 10,
      find: async () => ({
        pid: 5150,
        source: "pidfile-unverified",
        pidfileStale: false,
      }),
      alive: () => true,
      start: async () => ({
        ok: false,
        reason: "already-running",
        instance: {
          pid: 5150,
          source: "pidfile-unverified",
          pidfileStale: false,
        },
      }),
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toContain(
      "alive but not serving",
    );
  });

  it("treats an already-running daemon as a successful handoff", async () => {
    const outcome = await watchHandoff({
      childPid: 5150,
      pkgRoot: "/repo",
      windowMs: 1,
      pollMs: 1,
      find: async () => null,
      alive: () => false,
      start: async () => ({
        ok: false,
        reason: "already-running",
        instance: {
          pid: 4242,
          port: 19876,
          health: { app: "talon", mode: "daemon", pid: 4242 },
          source: "pidfile",
          pidfileStale: false,
        },
      }),
    });
    expect(outcome).toEqual({
      ok: true,
      via: "restart",
      pid: 4242,
      port: 19876,
    });
  });

  it("reports both failures when the restart cannot be made either", async () => {
    const outcome = await watchHandoff({
      childPid: 5150,
      pkgRoot: "/repo",
      windowMs: 1,
      pollMs: 1,
      find: async () => null,
      alive: () => false,
      start: async () => ({
        ok: false,
        reason: "exited-early",
        detail: "exited with code 1",
      }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({
      reason: expect.stringContaining("exited before serving /health"),
    });
    expect((outcome as { reason: string }).reason).toContain(
      "exited with code 1",
    );
  });
});

describe("runHandoffWatch", () => {
  it("refuses to watch without a successor pid", async () => {
    const before = process.exitCode;
    try {
      await runHandoffWatch([]);
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = before;
    }
  });
});
