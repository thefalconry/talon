/**
 * Crash-path ordering (incident 2026-09-18).
 *
 * The daemon died on a full disk: the uncaught-exception handler's first
 * act was `logError`, logging was exactly what ENOSPC had broken, the
 * handler threw inside itself and Node aborted the process — stale
 * pidfile, no database checkpoint, and an armed `/update` handoff that
 * never spawned its successor.
 *
 * The contract now: essentials first (pid record → successor → flush),
 * each step isolated, logging last and best-effort. These tests make
 * every logger call throw, the way a broken logger did that night.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const boom = (): never => {
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
    });
  };
  return {
    calls,
    boom,
    removePid: vi.fn(() => {
      calls.push("pid");
      return true;
    }),
    spawnSuccessor: vi.fn(() => {
      calls.push("successor");
    }),
    flushDatabase: vi.fn(() => {
      calls.push("flush");
    }),
    // Records what had already run when the marker was written.
    writeMarker: vi.fn((_kind: string, _err: unknown) => [...calls]),
  };
});

vi.mock("../core/daemon/crash-marker.js", () => ({
  writeCrashMarker: h.writeMarker,
}));

vi.mock("../core/daemon/pidfile.js", () => ({
  removePidRecordIfOwnedBy: h.removePid,
}));
vi.mock("../core/daemon/respawn.js", () => ({
  spawnSuccessor: h.spawnSuccessor,
}));
// Every logging call throws — a logger whose sink is wedged.
vi.mock("../util/log.js", () => ({
  log: h.boom,
  logError: h.boom,
  logWarn: h.boom,
  logDebug: h.boom,
}));

const { crashStep, crashCleanup, handleUncaughtException } =
  await import("../core/daemon/crash.js");

const hooks = { flushDatabase: h.flushDatabase };

describe("crash-path cleanup", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.calls.length = 0;
    h.removePid.mockClear();
    h.spawnSuccessor.mockClear();
    h.flushDatabase.mockClear();
    h.writeMarker.mockClear();
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => code) as never);
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("removes the pid record, hands off, then flushes — in that order", () => {
    crashCleanup(hooks);
    expect(h.calls).toEqual(["pid", "successor", "flush"]);
  });

  it("carries on when a step throws", () => {
    h.spawnSuccessor.mockImplementationOnce(() => {
      h.calls.push("successor");
      throw new Error("spawn failed");
    });
    expect(() => crashCleanup(hooks)).not.toThrow();
    expect(h.calls).toEqual(["pid", "successor", "flush"]);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("cleans up before reporting, even when logging throws", () => {
    handleUncaughtException(new Error("boom"), hooks);
    // The report throws (logError is wedged) and is swallowed — but only
    // after the pid record, the successor and the flush are done.
    expect(h.calls).toEqual(["pid", "successor", "flush"]);
    expect(h.removePid).toHaveBeenCalledWith(process.pid);
    expect(h.spawnSuccessor).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("leaves a crash marker for the next boot, after the essentials", () => {
    const err = new Error("boom");
    handleUncaughtException(err, hooks);
    expect(h.writeMarker).toHaveBeenCalledWith("uncaught", err);
    expect(h.writeMarker.mock.results[0]?.value).toEqual([
      "pid",
      "successor",
      "flush",
    ]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("still exits when the marker cannot be written (full disk)", () => {
    h.writeMarker.mockImplementationOnce(() => h.boom());
    handleUncaughtException(new Error("boom"), hooks);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("still suppresses EPIPE without touching the cleanup path", () => {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    handleUncaughtException(epipe, hooks);
    expect(h.calls).toEqual([]);
    expect(h.writeMarker).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("crashStep never throws and reports to the console", () => {
    expect(() =>
      crashStep("unit", () => {
        throw new Error("nope");
      }),
    ).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("unit"),
      expect.any(Error),
    );
  });
});
