import { describe, expect, it, vi } from "vitest";
import {
  EXEC_JOB_MAX_POLL_FAILURES,
  ExecJobTracker,
} from "../core/mesh/devices/exec-jobs.js";

const base = {
  jobId: "job_1",
  deviceId: "node",
  deviceName: "Mini",
  cmd: "make",
};

describe("ExecJobTracker", () => {
  it("wakes the starting chat once, with exit code and tail", async () => {
    vi.useFakeTimers();
    const wake = vi.fn();
    const tracker = new ExecJobTracker(10);
    tracker.setWake(wake);
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { running: true } })
      .mockResolvedValue({
        ok: true,
        data: { running: false, exitCode: 3, stdout: "x".repeat(5000) },
      });
    expect(tracker.track({ ...base, wakeChatKey: "42", poll })).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![0]).toBe("42");
    expect(wake.mock.calls[0]![1]).toContain("exit 3");
    expect(wake.mock.calls[0]![1].length).toBeLessThan(2200);
    vi.useRealTimers();
  });

  it("cleans wrapper output out of the wake-up", async () => {
    const tracker = new ExecJobTracker(1);
    const wake = vi.fn();
    tracker.setWake(wake);
    const poll = vi.fn(async () => ({
      commandId: "c",
      deviceId: "d",
      ok: true,
      data: { running: false, exitCode: 0, stdout: "real\nMARKER" },
    }));
    tracker.track({
      ...base,
      wakeChatKey: "42",
      poll,
      cleanOutput: (text) => text.replace("MARKER", ""),
    });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(wake.mock.calls[0]![1]).toContain("real");
    expect(wake.mock.calls[0]![1]).not.toContain("MARKER");
    tracker.stop();
  });

  it("does not watch without a numeric chat to wake", () => {
    const tracker = new ExecJobTracker(10);
    tracker.setWake(vi.fn());
    const poll = vi.fn();
    for (const key of [undefined, "0", "agent:abc"]) {
      expect(tracker.track({ ...base, wakeChatKey: key, poll })).toBe(false);
    }
    expect(poll).not.toHaveBeenCalled();
  });

  it("says the outcome is unknown after repeated failed polls", async () => {
    vi.useFakeTimers();
    const wake = vi.fn();
    const tracker = new ExecJobTracker(10);
    tracker.setWake(wake);
    const poll = vi.fn().mockResolvedValue({ ok: false, message: "offline" });
    tracker.track({ ...base, wakeChatKey: 42, poll });
    await vi.advanceTimersByTimeAsync(10 * (EXEC_JOB_MAX_POLL_FAILURES + 2));
    expect(poll).toHaveBeenCalledTimes(EXEC_JOB_MAX_POLL_FAILURES);
    expect(wake.mock.calls[0]![1]).toContain("outcome is unknown");
    vi.useRealTimers();
  });
});
