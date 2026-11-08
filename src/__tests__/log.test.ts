import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pino before importing log module
const mockInfo = vi.fn();
const mockError = vi.fn();
const mockWarn = vi.fn();
const mockDebug = vi.fn();

// log.ts builds the logger as `pino(opts, pino.multistream(streams))` with
// a pino-pretty console stream, so the mock must expose both the callable
// default and `multistream`, and pino-pretty must be stubbed.
vi.mock("pino", () => ({
  default: Object.assign(
    () => ({
      info: mockInfo,
      error: mockError,
      warn: mockWarn,
      debug: mockDebug,
    }),
    { multistream: vi.fn(() => ({ write: vi.fn() })) },
  ),
}));
vi.mock("pino-pretty", () => ({
  default: () => ({ write: vi.fn(), on: vi.fn() }),
}));

const { log, logError, logWarn, logDebug, onLogError } =
  await import("../util/log.js");

describe("log", () => {
  beforeEach(() => {
    mockInfo.mockClear();
    mockError.mockClear();
    mockWarn.mockClear();
    mockDebug.mockClear();
  });

  describe("log(component, message)", () => {
    it("calls pino.info with component and message", () => {
      log("bot", "started successfully");
      expect(mockInfo).toHaveBeenCalledOnce();
      expect(mockInfo).toHaveBeenCalledWith(
        { component: "bot" },
        "started successfully",
      );
    });

    it("works with all valid component types", () => {
      const components = [
        "bot",
        "bridge",
        "agent",
        "pulse",
        "userbot",
        "users",
        "watchdog",
        "workspace",
        "shutdown",
        "file",
        "sessions",
        "settings",
        "commands",
        "cron",
        "dispatcher",
      ] as const;
      for (const component of components) {
        mockInfo.mockClear();
        log(component, "test");
        expect(mockInfo).toHaveBeenCalledWith({ component }, "test");
      }
    });
  });

  describe("logError(component, message, err?)", () => {
    it("calls pino.error with component and message", () => {
      logError("bot", "failed to start");
      expect(mockError).toHaveBeenCalledOnce();
      expect(mockError).toHaveBeenCalledWith(
        { component: "bot" },
        "failed to start",
      );
    });

    it("includes Error message and stack in context", () => {
      const err = new Error("timeout");
      logError("bridge", "request failed", err);
      expect(mockError).toHaveBeenCalledWith(
        { component: "bridge", err: "timeout", stack: err.stack },
        "request failed",
      );
    });

    it("stringifies non-Error err values", () => {
      logError("sessions", "save failed", "disk full");
      expect(mockError).toHaveBeenCalledWith(
        { component: "sessions", err: "disk full" },
        "save failed",
      );
    });

    it("handles numeric err values", () => {
      logError("sessions", "exit code", 1);
      expect(mockError).toHaveBeenCalledWith(
        { component: "sessions", err: "1" },
        "exit code",
      );
    });

    it("omits err field when err is undefined", () => {
      logError("settings", "something wrong");
      expect(mockError).toHaveBeenCalledWith(
        { component: "settings" },
        "something wrong",
      );
    });
  });

  describe("logWarn(component, message)", () => {
    it("calls pino.warn with component and message", () => {
      logWarn("watchdog", "inactivity detected");
      expect(mockWarn).toHaveBeenCalledOnce();
      expect(mockWarn).toHaveBeenCalledWith(
        { component: "watchdog" },
        "inactivity detected",
      );
    });
  });

  describe("logDebug(component, message)", () => {
    it("calls pino.debug with component and message", () => {
      logDebug("agent", "processing query");
      expect(mockDebug).toHaveBeenCalledOnce();
      expect(mockDebug).toHaveBeenCalledWith(
        { component: "agent" },
        "processing query",
      );
    });
  });

  describe("onLogError(listener)", () => {
    it("feeds every logError to the listener, never re-entrantly", () => {
      const seen: string[] = [];
      onLogError((component, message, err) => {
        seen.push(`${component}:${message}:${String(err)}`);
        logError("bot", "from inside the listener");
      });
      logError("cron", "job failed", "ETIMEDOUT");
      onLogError(null);
      logError("cron", "after clear");
      expect(seen).toEqual(["cron:job failed:ETIMEDOUT"]);
      expect(mockError).toHaveBeenCalledTimes(3);
    });

    it("never lets a throwing listener break logError", () => {
      onLogError(() => {
        throw new Error("listener bug");
      });
      expect(() => logError("bot", "still logged")).not.toThrow();
      onLogError(null);
      expect(mockError).toHaveBeenCalledOnce();
    });
  });
});
