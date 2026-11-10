/**
 * Antigravity plan usage — `agy -p /usage --output-format text` parsed into
 * the shared `PlanUsage` shape, run through a cached, coalesced spawn that
 * never throws. The real CLI is never called.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logWarn,
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Never exit — for the timeout path. */
  hang?: boolean;
  /** Emit `error` instead of running (binary missing). */
  error?: string;
}

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];
  kill(signal: string): boolean {
    this.signals.push(signal);
    this.signalCode = signal;
    return true;
  }
}

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

let children: FakeChild[] = [];

function scripted(script: Script) {
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    setTimeout(() => {
      if (script.error) {
        child.emit("error", new Error(script.error));
        return;
      }
      if (script.hang) return;
      if (script.stderr) child.stderr.emit("data", script.stderr);
      if (script.stdout) child.stdout.emit("data", script.stdout);
      child.exitCode = script.code ?? 0;
      child.emit("close", script.code ?? 0);
    }, 1);
    return child;
  });
}

const { parseAgyUsage, runAgyUsage, getAgyPlanUsage, resetAgyPlanUsage } =
  await import("../backend/agy/plan-usage.js");

/** Verbatim `agy -p /usage --output-format text` from a signed-in host. */
const SAMPLE = [
  "Gemini Models\tWeekly Limit Remaining\t60%\t2026-09-26T17:40:26Z",
  "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-09-23T21:23:05Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-30T16:23:47Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-23T21:23:47Z",
  "",
].join("\n");

beforeEach(() => {
  resetAgyPlanUsage();
  spawnMock.mockReset();
  logWarn.mockReset();
  children = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseAgyUsage", () => {
  it("parses the real report into percent-used windows", () => {
    const usage = parseAgyUsage(SAMPLE);
    expect(usage?.windows).toEqual([
      {
        label: "Gemini · 7d",
        percent: 40,
        resetsAt: "2026-09-26T17:40:26Z",
      },
      {
        label: "Gemini · 5h",
        percent: 0,
        resetsAt: "2026-09-23T21:23:05Z",
      },
      {
        label: "Claude/GPT · 7d",
        percent: 0,
        resetsAt: "2026-09-30T16:23:47Z",
      },
      {
        label: "Claude/GPT · 5h",
        percent: 0,
        resetsAt: "2026-09-23T21:23:47Z",
      },
    ]);
    expect(usage?.plan).toBeUndefined();
    expect(typeof usage?.fetchedAt).toBe("number");
  });

  it("parses the separate Gemini 4 Argon window (agy 1.4.4)", () => {
    // Verbatim from 1.4.4: the Argon bucket's name drops "Remaining",
    // but the JSON form of the same report confirms the figure is still
    // remaining (remaining_fraction 0.2257 → "23%").
    const usage = parseAgyUsage(
      `${SAMPLE}Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t23%\t2026-10-24T11:32:53Z\n`,
    );
    expect(usage?.windows.at(-1)).toEqual({
      label: "Gemini 4 Argon · 7d",
      percent: 77,
      resetsAt: "2026-10-24T11:32:53Z",
    });
    expect(usage?.windows).toHaveLength(5);
  });

  it("tolerates CRLF line endings and padding around columns", () => {
    const usage = parseAgyUsage(
      "  Gemini Models \t Five Hour Limit Remaining \t 30% \t 2026-09-23T21:23:05Z \r\n",
    );
    expect(usage?.windows).toEqual([
      { label: "Gemini · 5h", percent: 70, resetsAt: "2026-09-23T21:23:05Z" },
    ]);
  });

  it("accepts space-aligned columns when there are no tabs", () => {
    const usage = parseAgyUsage(
      "Gemini Models   Weekly Limit Remaining   12%   2026-09-26T17:40:26Z",
    );
    expect(usage?.windows[0]).toMatchObject({
      label: "Gemini · 7d",
      percent: 88,
    });
  });

  it("maps 0% remaining to 100% used and 100% remaining to 0% used", () => {
    const usage = parseAgyUsage(
      [
        "Gemini Models\tFive Hour Limit Remaining\t0%\t2026-09-23T21:23:05Z",
        "Gemini Models\tWeekly Limit Remaining\t100%\t2026-09-26T17:40:26Z",
      ].join("\n"),
    );
    expect(usage?.windows.map((w) => w.percent)).toEqual([100, 0]);
  });

  it("clamps out-of-range and rounds fractional figures", () => {
    const usage = parseAgyUsage(
      [
        "Gemini Models\tFive Hour Limit Remaining\t150%\t",
        "Gemini Models\tWeekly Limit Remaining\t33.4%",
      ].join("\n"),
    );
    expect(usage?.windows.map((w) => w.percent)).toEqual([0, 67]);
  });

  it("keeps a window whose reset column is missing or unparseable", () => {
    const usage = parseAgyUsage(
      [
        "Gemini Models\tFive Hour Limit Remaining\t80%",
        "Gemini Models\tWeekly Limit Remaining\t50%\tsoon",
      ].join("\n"),
    );
    expect(usage?.windows).toEqual([
      { label: "Gemini · 5h", percent: 20 },
      { label: "Gemini · 7d", percent: 50 },
    ]);
  });

  it("skips malformed and unknown lines instead of throwing", () => {
    const usage = parseAgyUsage(
      [
        "Usage report",
        "Gemini Models\tWeekly Limit Remaining\tlots\t2026-09-26T17:40:26Z",
        "Gemini Models\tMonthly Limit Remaining\t10%\t2026-10-01T00:00:00Z",
        "Gemini Models\tWeekly Limit Remaining",
        "\u001b[1mGemini Models\u001b[0m\tFive Hour Limit Remaining\t90%\t2026-09-23T21:23:05Z",
      ].join("\n"),
    );
    expect(usage?.windows).toEqual([
      { label: "Gemini · 5h", percent: 10, resetsAt: "2026-09-23T21:23:05Z" },
    ]);
  });

  it("returns undefined when nothing parses", () => {
    expect(parseAgyUsage("")).toBeUndefined();
    expect(parseAgyUsage("Error: not signed in\n")).toBeUndefined();
  });
});

describe("runAgyUsage", () => {
  it("spawns the binary with the usage argv, no shell, and parses stdout", async () => {
    scripted({ stdout: SAMPLE });
    const usage = await runAgyUsage("/opt/agy");
    expect(usage?.windows).toHaveLength(4);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { shell?: boolean; env?: NodeJS.ProcessEnv },
    ];
    expect(bin).toBe("/opt/agy");
    expect(args).toEqual(["-p", "/usage", "--output-format", "text"]);
    expect(opts.shell).toBeFalsy();
    expect(opts.env).toBe(process.env);
  });

  it("resolves the binary from AGY_BINARY when none is passed", async () => {
    const prev = process.env.AGY_BINARY;
    process.env.AGY_BINARY = "/stub/agy";
    try {
      scripted({ stdout: SAMPLE });
      await runAgyUsage();
      expect(spawnMock.mock.calls[0]?.[0]).toBe("/stub/agy");
    } finally {
      if (prev === undefined) delete process.env.AGY_BINARY;
      else process.env.AGY_BINARY = prev;
    }
  });

  it("resolves undefined on a non-zero exit", async () => {
    scripted({ stdout: SAMPLE, stderr: "auth expired\n", code: 1 });
    await expect(runAgyUsage("agy")).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      "agent",
      expect.stringContaining("exited 1: auth expired"),
    );
  });

  it("resolves undefined when the binary cannot be spawned", async () => {
    scripted({ error: "spawn agy ENOENT" });
    await expect(runAgyUsage("agy")).resolves.toBeUndefined();
    // A host without agy is not a fault: no warning every refresh.
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("still warns on a spawn error that is not a missing binary", async () => {
    scripted({ error: "spawn agy EACCES" });
    await expect(runAgyUsage("agy")).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      "agent",
      expect.stringContaining("EACCES"),
    );
  });

  it("resolves undefined on unparseable output", async () => {
    scripted({ stdout: "something else entirely\n" });
    await expect(runAgyUsage("agy")).resolves.toBeUndefined();
  });

  it("kills a hung child and resolves undefined on timeout", async () => {
    vi.useFakeTimers();
    scripted({ hang: true });
    const pending = runAgyUsage("agy", 500);
    await vi.advanceTimersByTimeAsync(501);
    await expect(pending).resolves.toBeUndefined();
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    vi.useFakeTimers();
    scripted({ hang: true });
    spawnMock.mockImplementationOnce(() => {
      const child = new FakeChild();
      child.kill = (signal: string) => {
        child.signals.push(signal);
        return true;
      };
      children.push(child);
      return child;
    });
    const pending = runAgyUsage("agy", 500);
    await vi.advanceTimersByTimeAsync(501);
    await pending;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("getAgyPlanUsage", () => {
  it("coalesces concurrent callers into one spawn", async () => {
    scripted({ stdout: SAMPLE });
    const [a, b, c] = await Promise.all([
      getAgyPlanUsage(),
      getAgyPlanUsage(),
      getAgyPlanUsage(),
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("serves the cache for a minute, then re-reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    scripted({ stdout: SAMPLE });
    await getAgyPlanUsage();
    vi.setSystemTime(Date.now() + 59_000);
    await getAgyPlanUsage();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2_000);
    await getAgyPlanUsage();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good value when a refresh fails, and backs off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    scripted({ stdout: SAMPLE });
    const good = await getAgyPlanUsage();

    vi.setSystemTime(Date.now() + 61_000);
    scripted({ code: 1 });
    await expect(getAgyPlanUsage()).resolves.toBe(good);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Within the failure backoff: no new spawn.
    vi.setSystemTime(Date.now() + 5_000);
    await expect(getAgyPlanUsage()).resolves.toBe(good);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Backoff over: try again.
    vi.setSystemTime(Date.now() + 11_000);
    scripted({ stdout: SAMPLE });
    const fresh = await getAgyPlanUsage();
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(fresh).not.toBe(good);
  });

  it("resolves undefined when there has never been a good read", async () => {
    scripted({ code: 2 });
    await expect(getAgyPlanUsage()).resolves.toBeUndefined();
  });
});
