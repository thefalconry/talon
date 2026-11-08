/**
 * The daemon's unhandledRejection handler must keep enough context to find
 * the offending code path. Production logged eight
 * "Unhandled rejection: ENOSPC: no space left on device, write" lines with
 * no stack, syscall or path — unattributable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logDebug: vi.fn(),
  logError: h.logError,
  logWarn: h.logWarn,
}));
vi.mock("../core/daemon/pidfile.js", () => ({
  removePidRecordIfOwnedBy: vi.fn(),
}));
vi.mock("../core/daemon/respawn.js", () => ({ spawnSuccessor: vi.fn() }));

const { handleUnhandledRejection } = await import("../core/daemon/crash.js");

describe("handleUnhandledRejection", () => {
  beforeEach(() => {
    h.logError.mockReset();
    h.logWarn.mockReset();
  });

  it("passes the Error through so its stack is logged", () => {
    const err = new Error("boom");
    handleUnhandledRejection(err);
    expect(h.logError).toHaveBeenCalledWith(
      "bot",
      "Unhandled rejection: boom",
      err,
    );
  });

  it("names the syscall and path of an fs error", () => {
    const err = Object.assign(
      new Error("ENOSPC: no space left on device, write"),
      { code: "ENOSPC", syscall: "write", path: "/tmp/x.log" },
    );
    handleUnhandledRejection(err);
    expect(h.logError).toHaveBeenCalledWith(
      "bot",
      "Unhandled rejection: ENOSPC: no space left on device, write (write /tmp/x.log)",
      err,
    );
  });

  it("stringifies non-Error reasons", () => {
    handleUnhandledRejection("nope");
    expect(h.logError).toHaveBeenCalledWith("bot", "Unhandled rejection: nope");
  });

  it("never throws, even when the logger does", () => {
    h.logError.mockImplementation(() => {
      throw new Error("sink wedged");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => handleUnhandledRejection(new Error("x"))).not.toThrow();
    spy.mockRestore();
  });
});
