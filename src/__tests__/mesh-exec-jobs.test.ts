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

  it("does not watch without a chat to wake", () => {
    const tracker = new ExecJobTracker(10);
    tracker.setWake(vi.fn());
    const poll = vi.fn();
    for (const key of [undefined, "0", "", "agent:abc", "heartbeat", "dream"]) {
      expect(tracker.track({ ...base, wakeChatKey: key, poll })).toBe(false);
    }
    expect(poll).not.toHaveBeenCalled();
  });

  it("wakes a chat on any frontend under its string id", () => {
    const tracker = new ExecJobTracker(10);
    tracker.setWake(vi.fn());
    for (const key of [
      "d_17_x",
      "wa_dm_353",
      "teams_chat_19:a",
      "discord_dm_1",
    ]) {
      expect(tracker.canNotify(key)).toBe(true);
    }
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

  it("reports a job the device no longer holds on the first answer", async () => {
    vi.useFakeTimers();
    const wake = vi.fn();
    const tracker = new ExecJobTracker(10);
    tracker.setWake(wake);
    const poll = vi.fn().mockResolvedValue({
      ok: false,
      message:
        "No such job: job_1 (it may have expired, or the node restarted).",
    });
    tracker.track({ ...base, wakeChatKey: 42, poll });
    await vi.advanceTimersByTimeAsync(100);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![1]).toContain("is gone");
    expect(wake.mock.calls[0]![1]).not.toContain("..");
    expect(wake.mock.calls[0]![1]).not.toContain("may still be running");
    vi.useRealTimers();
  });

  it("says when the node killed the job at its lifetime limit", async () => {
    const tracker = new ExecJobTracker(1);
    const wake = vi.fn();
    tracker.setWake(wake);
    const poll = vi.fn(async () => ({
      commandId: "c",
      deviceId: "d",
      ok: true,
      data: {
        running: false,
        exitCode: -1,
        timedOut: true,
        stderr: "[killed: timeout]",
      },
    }));
    tracker.track({ ...base, wakeChatKey: "42", poll });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(wake.mock.calls[0]![1]).toContain("24h job limit");
    expect(wake.mock.calls[0]![1]).not.toContain("finished");
    tracker.stop();
  });

  it("polls a long-running job less often after the first minutes", async () => {
    vi.useFakeTimers();
    const tracker = new ExecJobTracker(15_000);
    tracker.setWake(vi.fn());
    const poll = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { running: true } });
    tracker.track({ ...base, wakeChatKey: "42", poll });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const fast = poll.mock.calls.length;
    expect(fast).toBe(20);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Ten minutes at one poll a minute, not forty at one per 15s.
    expect(poll.mock.calls.length - fast).toBeLessThanOrEqual(11);
    tracker.stop();
    vi.useRealTimers();
  });

  it("decides detach from on_timeout, else from whether a chat can be woken", () => {
    const tracker = new ExecJobTracker(10);
    tracker.setWake(vi.fn());
    expect(tracker.shouldDetach(undefined, "42")).toBe(true);
    expect(tracker.shouldDetach(undefined, "t_123")).toBe(true);
    expect(tracker.shouldDetach("kill", "42")).toBe(false);
    for (const key of ["heartbeat", "agent:abc", "dream", "0", undefined]) {
      expect(tracker.shouldDetach(undefined, key)).toBe(false);
      expect(tracker.shouldDetach("detach", key)).toBe(true);
    }
    tracker.setWake(null);
    expect(tracker.shouldDetach(undefined, "42")).toBe(false);
  });
});
