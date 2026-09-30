/**
 * Runtime-wiring tests for src/core/background/cron/scheduler.ts.
 *
 * These exercise the parts of scheduler.ts that actually run jobs: run-now,
 * last-run telemetry, one-shot retirement, startup catch-up, and isolated
 * query execution via runJobOneShot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../storage/cron.js";
import { deriveNumericChatId } from "../core/frontend-runtime/chat-id.js";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  atomicWrite: vi.fn(),
  sendMessage: vi.fn(async (_chatId: number, _text: string) => {}),
  resolveChatModel: vi.fn(async (_chatId: string) => ({
    model: "chat-model",
    backendId: "chat-backend",
  })),
  getActiveCount: vi.fn(() => 0),
  resolveJobFallback: vi.fn(() => ({
    model: "hb-model",
    backendId: "hb-backend",
  })),
  runJobOneShot: vi.fn(async (_params: Record<string, unknown>) => ({
    status: "ran" as const,
  })),
  chooseBackend: vi.fn(async (_req: Record<string, unknown>) => ({
    backendId: "chat-backend",
    reason: "no candidates",
    routed: false,
  })),
  resolveRoutedModel: vi.fn(
    async (_id: string): Promise<string | null> => "routed-model",
  ),
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: Object.assign((...args: unknown[]) => mocks.atomicWrite(...args), {
    sync: mocks.atomicWrite,
  }),
}));

vi.mock("../util/paths.js", () => ({
  files: { cron: "/mock/data/cron.json" },
  dirs: {},
}));

vi.mock("../storage/daily-log.js", () => ({
  appendDailyLog: vi.fn(),
  appendDailyLogResponse: vi.fn(),
}));

vi.mock("../core/engine/dispatcher.js", () => ({
  getActiveCount: mocks.getActiveCount,
}));

vi.mock("../core/background/cron/job-oneshot.js", () => ({
  runJobOneShot: mocks.runJobOneShot,
}));

// The plan-aware router, stubbed: these tests assert what the scheduler
// ASKS it (the purpose, and that a pinned job never reaches it) and what it
// does with the answer, not how the router decides.
vi.mock("../core/engine/backend-router/index.js", () => ({
  chooseBackend: mocks.chooseBackend,
  resolveRoutedModel: mocks.resolveRoutedModel,
  recordBackendRunUsage: vi.fn(),
  recordBackendRunFailure: vi.fn(),
  recordBackendRunSuccess: vi.fn(),
}));

const {
  executeJob,
  initCron,
  runJobNow,
  runStartupCatchup,
  startCronTimer,
  stopCronTimer,
} = await import("../core/background/cron/scheduler.js");
const { addCronJob, getCronJob, getAllCronJobs, deleteCronJob } =
  await import("../storage/cron.js");
const { resetJobHealth } =
  await import("../core/background/cron/job-health.js");

let seq = 0;
function uniqueId(): string {
  return `rt-cron-${++seq}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: uniqueId(),
    chatId: "123",
    schedule: "0 9 * * *",
    type: "message",
    content: "Hello!",
    name: "Test job",
    enabled: true,
    createdAt: Date.now(),
    runCount: 0,
    ...overrides,
  };
}

function seed(overrides: Partial<CronJob> = {}): CronJob {
  const job = makeJob(overrides);
  addCronJob(job);
  return job;
}

beforeEach(() => {
  for (const j of getAllCronJobs()) deleteCronJob(j.id);
  resetJobHealth();
  vi.clearAllMocks();
  mocks.getActiveCount.mockReturnValue(0);
  mocks.resolveChatModel.mockResolvedValue({
    model: "chat-model",
    backendId: "chat-backend",
  });
  mocks.runJobOneShot.mockResolvedValue({ status: "ran" });
  mocks.chooseBackend.mockResolvedValue({
    backendId: "chat-backend",
    reason: "no candidates",
    routed: false,
  });
  mocks.resolveRoutedModel.mockResolvedValue("routed-model");
  mocks.resolveJobFallback.mockReturnValue({
    model: "hb-model",
    backendId: "hb-backend",
  });
  initCron({
    sendMessage: mocks.sendMessage,
    resolveChatModel: mocks.resolveChatModel,
    resolveJobFallback: mocks.resolveJobFallback,
  });
});

// ── isolated query execution ────────────────────────────────────────────────

describe("executeJob — isolated query runtime", () => {
  it("falls back to resolveChatModel when no provider/model override is stored", async () => {
    const result = await executeJob(
      makeJob({ type: "query", chatId: "42", content: "check status" }),
    );

    expect(result).toEqual({ status: "ran" });
    expect(mocks.resolveChatModel).toHaveBeenCalledWith("42");
    expect(mocks.runJobOneShot).toHaveBeenCalledOnce();
    expect(mocks.runJobOneShot.mock.calls[0]?.[0]).toMatchObject({
      chatId: "42",
      backendId: "chat-backend",
      model: "chat-model",
      label: "Test job",
      kind: "cron",
      timeoutMs: 10 * 60_000,
    });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("hands the role backend to jobs that inherited the chat's backend", async () => {
    await executeJob(makeJob({ type: "query", chatId: "42" }));

    expect(mocks.runJobOneShot.mock.calls[0]?.[0]).toMatchObject({
      backendId: "chat-backend",
      model: "chat-model",
      fallback: { backendId: "hb-backend", model: "hb-model" },
    });
  });

  it("omits the fallback when the role backend resolves no model", async () => {
    (mocks.resolveJobFallback as any).mockReturnValueOnce({
      model: null,
      backendId: "hb-backend",
    });

    await executeJob(makeJob({ type: "query", chatId: "42" }));

    expect(mocks.runJobOneShot.mock.calls[0]?.[0]).not.toHaveProperty(
      "fallback",
    );
  });

  it("never reroutes a job that pinned its own provider", async () => {
    await executeJob(
      makeJob({
        type: "query",
        provider: "cheap-provider",
        model: "cheap-model",
        instructions: "Be terse.",
      }),
    );

    expect(mocks.resolveChatModel).not.toHaveBeenCalled();
    expect(mocks.runJobOneShot.mock.calls[0]?.[0]).toMatchObject({
      backendId: "cheap-provider",
      model: "cheap-model",
      instructions: "Be terse.",
    });
    expect(mocks.resolveJobFallback).not.toHaveBeenCalled();
    expect(mocks.runJobOneShot.mock.calls[0]?.[0]).not.toHaveProperty(
      "fallback",
    );
  });

  it("asks the router where an unpinned query job should run", async () => {
    mocks.chooseBackend.mockResolvedValue({
      backendId: "spare-backend",
      reason: "most headroom 92%",
      routed: true,
    });

    await executeJob(makeJob({ type: "query", chatId: "42" }));

    expect(mocks.chooseBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "cron",
        chatBackendId: "chat-backend",
      }),
    );
    // A routed job cannot carry the chat's model across providers.
    expect(mocks.runJobOneShot.mock.calls[0]?.[0]).toMatchObject({
      backendId: "spare-backend",
      model: "routed-model",
    });
  });

  it("stays put when the routed backend names no default model", async () => {
    mocks.chooseBackend.mockResolvedValue({
      backendId: "spare-backend",
      reason: "most headroom 92%",
      routed: true,
    });
    mocks.resolveRoutedModel.mockResolvedValue(null);

    await executeJob(makeJob({ type: "query", chatId: "42" }));

    expect(mocks.runJobOneShot.mock.calls[0]?.[0]).toMatchObject({
      backendId: "chat-backend",
      model: "chat-model",
    });
  });

  it("never asks the router about a job that pinned its own provider", async () => {
    await executeJob(
      makeJob({ type: "query", provider: "cheap-provider", model: "m" }),
    );
    expect(mocks.chooseBackend).not.toHaveBeenCalled();
  });

  it("pins the backend when the job named a model but no provider", async () => {
    mocks.chooseBackend.mockResolvedValue({
      backendId: "chat-backend",
      reason: "pinned",
      routed: false,
    });

    await executeJob(
      makeJob({ type: "query", chatId: "42", model: "pinned-model" }),
    );

    expect(mocks.chooseBackend).toHaveBeenCalledWith(
      expect.objectContaining({ requestedModel: "pinned-model" }),
    );
    expect(mocks.runJobOneShot.mock.calls[0]?.[0]).toMatchObject({
      backendId: "chat-backend",
      model: "pinned-model",
    });
  });

  it("includes interval schedules in the isolated payload description", async () => {
    await executeJob(
      makeJob({
        type: "query",
        schedule: undefined,
        everyMs: 90 * 60_000,
        content: "summarize",
      }),
    );

    const params = mocks.runJobOneShot.mock.calls[0]?.[0] as {
      payload?: string;
    };
    expect(params.payload).toContain("schedule: every 1.5h");
    expect(params.payload).toContain("summarize");
  });

  it("throws clearly when the no-override path resolves no model", async () => {
    (mocks.resolveChatModel as any).mockResolvedValueOnce({
      model: null,
      backendId: "chat-backend",
    });

    await expect(executeJob(makeJob({ type: "query" }))).rejects.toThrow(
      /no model resolved for backend "chat-backend"/,
    );
    expect(mocks.runJobOneShot).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("skips and notifies the chat when runJobOneShot reports a stale target", async () => {
    (mocks.runJobOneShot as any).mockResolvedValueOnce({
      status: "skipped",
      reason: 'model "stale-model" is not selectable on provider "codex".',
    });

    const result = await executeJob(
      makeJob({
        chatId: "42",
        type: "query",
        provider: "codex",
        model: "stale-model",
        name: "Status check",
      }),
    );

    expect(result).toEqual({
      status: "skipped",
      reason: 'model "stale-model" is not selectable on provider "codex".',
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Cron job "Status check" skipped: model'),
      "42",
    );
  });
});

// ── runJobNow — routing ─────────────────────────────────────────────────────

describe("runJobNow — routing", () => {
  it("a message job calls sendMessage with the numeric chatId and content", async () => {
    const job = seed({ type: "message", chatId: "777", content: "ping" });

    const res = await runJobNow(job.id);

    expect(res.ok).toBe(true);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith(777, "ping", "777");
    expect(mocks.runJobOneShot).not.toHaveBeenCalled();
  });

  it("a message job for a non-Telegram chat routes with the frontend's derived numeric id", async () => {
    const job = seed({ type: "message", chatId: "d_native", content: "ping" });

    const res = await runJobNow(job.id);

    expect(res.ok).toBe(true);
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      deriveNumericChatId("d_native"),
      "ping",
      "d_native",
    );
  });

  it("a query job runs as an isolated one-shot, not a chat message", async () => {
    const job = seed({ type: "query", chatId: "42", content: "what is up" });

    const res = await runJobNow(job.id);

    expect(res.ok).toBe(true);
    expect(mocks.runJobOneShot).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    const params = mocks.runJobOneShot.mock.calls[0]?.[0] as {
      chatId?: string;
      payload?: string;
    };
    expect(params.chatId).toBe("42");
    expect(params.payload).toContain("what is up");
  });
});

// ── runJobNow — success telemetry ────────────────────────────────────────────

describe("runJobNow — success bookkeeping", () => {
  it("records lastStatus ok, a numeric duration, and bumps runCount", async () => {
    const job = seed({ type: "message", runCount: 2 });

    const res = await runJobNow(job.id);
    expect(res.ok).toBe(true);

    const after = getCronJob(job.id)!;
    expect(after.lastStatus).toBe("ok");
    expect(typeof after.lastDurationMs).toBe("number");
    expect(after.lastDurationMs!).toBeGreaterThanOrEqual(0);
    expect(after.runCount).toBe(3);
    expect(after.lastRunAt).toBeGreaterThan(0);
  });

  it("clears a previous lastError on a successful run", async () => {
    const job = seed({
      type: "message",
      lastStatus: "error",
      lastError: "stale failure",
    });

    await runJobNow(job.id);

    const after = getCronJob(job.id)!;
    expect(after.lastStatus).toBe("ok");
    expect(after.lastError).toBeUndefined();
  });
});

// ── runJobNow — failure telemetry ────────────────────────────────────────────

describe("runJobNow — failure bookkeeping", () => {
  it("a throwing query run records error telemetry and returns ok:false", async () => {
    mocks.runJobOneShot.mockRejectedValueOnce(new Error("boom from one-shot"));
    const job = seed({ type: "query", content: "explode" });

    const res = await runJobNow(job.id);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom from one-shot");

    const after = getCronJob(job.id)!;
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toBe("boom from one-shot");
    expect(typeof after.lastDurationMs).toBe("number");
  });

  it("a failure does not bump runCount", async () => {
    mocks.runJobOneShot.mockRejectedValueOnce(new Error("nope"));
    const job = seed({ type: "query", content: "x", runCount: 5 });

    await runJobNow(job.id);

    expect(getCronJob(job.id)!.runCount).toBe(5);
  });

  it("a message job whose sendMessage throws is reported as an error", async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error("send failed"));
    const job = seed({ type: "message", content: "hi" });

    const res = await runJobNow(job.id);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("send failed");
    expect(getCronJob(job.id)!.lastStatus).toBe("error");
  });
});

// ── runJobNow — guards ───────────────────────────────────────────────────────

describe("runJobNow — guards", () => {
  it("returns an error for a missing job id", async () => {
    const res = await runJobNow("does-not-exist-xyz");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
    expect(mocks.runJobOneShot).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("returns an error when the job is already running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mocks.runJobOneShot.mockImplementationOnce(async () => {
      await gate;
      return { status: "ran" };
    });

    const job = seed({ type: "query", content: "slow" });

    const first = runJobNow(job.id);
    await Promise.resolve();
    await Promise.resolve();

    const second = await runJobNow(job.id);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already running");

    release();
    expect((await first).ok).toBe(true);
  });
});

// ── runJobNow — one-shot retirement ──────────────────────────────────────────

describe("runJobNow — maxRuns retirement", () => {
  it("a maxRuns:1 job is disabled after a single run-now", async () => {
    const job = seed({ type: "message", maxRuns: 1, runCount: 0 });

    const res = await runJobNow(job.id);
    expect(res.ok).toBe(true);

    const after = getCronJob(job.id)!;
    expect(after.runCount).toBe(1);
    expect(after.enabled).toBe(false);
  });

  it("a maxRuns:3 job stays enabled until the cap is reached", async () => {
    const job = seed({ type: "message", maxRuns: 3, runCount: 0 });

    await runJobNow(job.id);
    expect(getCronJob(job.id)!.enabled).toBe(true);
    await runJobNow(job.id);
    expect(getCronJob(job.id)!.enabled).toBe(true);
    await runJobNow(job.id);

    expect(getCronJob(job.id)!.runCount).toBe(3);
    expect(getCronJob(job.id)!.enabled).toBe(false);
  });

  it("a failed run does not retire a one-shot job", async () => {
    mocks.runJobOneShot.mockRejectedValueOnce(new Error("fail"));
    const job = seed({ type: "query", content: "x", maxRuns: 1, runCount: 0 });

    await runJobNow(job.id);

    const after = getCronJob(job.id)!;
    expect(after.runCount).toBe(0);
    expect(after.enabled).toBe(true);
  });
});

const MINUTE = 60_000;

// ── runStartupCatchup — policy honoring ──────────────────────────────────────

describe("runStartupCatchup — policies", () => {
  it("skip policy never replays, even with many missed runs", async () => {
    seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 10 * MINUTE,
      catchup: "skip",
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.runJobOneShot).not.toHaveBeenCalled();
  });

  it("a job with no catchup field defaults to skip", async () => {
    seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 8 * MINUTE,
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("once with N missed runs replays exactly one run", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 7 * MINUTE,
      catchup: "once",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(getCronJob(job.id)!.runCount).toBe(1);
  });

  it("all replays min(missed, CATCHUP_MAX=5) when missed exceeds the cap", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 50 * MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(5);
    expect(getCronJob(job.id)!.runCount).toBe(5);
  });

  it("all replays exactly the missed count when below the cap", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 3 * MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(3);
    expect(getCronJob(job.id)!.runCount).toBe(3);
  });

  it("all replays nothing when no intervals have elapsed", async () => {
    seed({
      schedule: undefined,
      everyMs: 10 * MINUTE,
      lastRunAt: Date.now() - 1000,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("a disabled job is never caught up", async () => {
    seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 9 * MINUTE,
      catchup: "all",
      enabled: false,
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});

// ── runStartupCatchup — lifecycle bounds ─────────────────────────────────────

describe("runStartupCatchup — lifecycle bounds", () => {
  it("a job whose endAt has passed is disabled and skipped", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 9 * MINUTE,
      endAt: Date.now() - MINUTE,
      catchup: "all",
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(getCronJob(job.id)!.enabled).toBe(false);
  });

  it("a job whose startAt is still in the future is skipped", async () => {
    seed({
      schedule: undefined,
      everyMs: MINUTE,
      startAt: Date.now() + 60 * MINUTE,
      catchup: "all",
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("maxRuns stops replay mid-way", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 5 * MINUTE,
      catchup: "all",
      maxRuns: 2,
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    const after = getCronJob(job.id)!;
    expect(after.runCount).toBe(2);
    expect(after.enabled).toBe(false);
  });

  it("maxRuns already consumed gets one replay then disables", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 5 * MINUTE,
      catchup: "all",
      maxRuns: 3,
      runCount: 3,
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(getCronJob(job.id)!.enabled).toBe(false);
  });
});

// ── runStartupCatchup — interval vs cron missed-run counting ─────────────────

describe("runStartupCatchup — interval vs cron", () => {
  it("interval jobs compute missed runs from everyMs and a stale lastRunAt", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 4 * MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(4);
    expect(getCronJob(job.id)!.runCount).toBe(4);
  });

  it("cron jobs compute missed runs by walking fire times since the anchor", async () => {
    const job = seed({
      schedule: "* * * * *",
      lastRunAt: Date.now() - 10 * MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage.mock.calls.length).toBeGreaterThan(0);
    expect(mocks.sendMessage.mock.calls.length).toBeLessThanOrEqual(5);
    expect(getCronJob(job.id)!.runCount).toBe(
      mocks.sendMessage.mock.calls.length,
    );
  });

  it("a cron once job with missed fire times replays exactly one", async () => {
    const job = seed({
      schedule: "* * * * *",
      lastRunAt: Date.now() - 10 * MINUTE,
      catchup: "once",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(getCronJob(job.id)!.runCount).toBe(1);
  });

  it("a cron job with no due fire times since its last run replays nothing", async () => {
    seed({
      schedule: "0 9 * * *",
      lastRunAt: Date.now() - MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("an interval query catch-up routes through isolated one-shot", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 2 * MINUTE,
      catchup: "all",
      type: "query",
      content: "catch me up",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.runJobOneShot).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(getCronJob(job.id)!.runCount).toBe(2);
  });
});

// ── runStartupCatchup — multi-job + guards ───────────────────────────────────

describe("runStartupCatchup — fleet behavior", () => {
  it("processes each job by its own policy in one pass", async () => {
    const skip = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 6 * MINUTE,
      catchup: "skip",
      type: "message",
    });
    const once = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 6 * MINUTE,
      catchup: "once",
      type: "message",
      runCount: 0,
    });
    const all = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 6 * MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(getCronJob(skip.id)!.runCount).toBe(0);
    expect(getCronJob(once.id)!.runCount).toBe(1);
    expect(getCronJob(all.id)!.runCount).toBe(5);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(6);
  });

  it("stops catch-up when active work is high", async () => {
    mocks.getActiveCount.mockReturnValue(11);
    seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 6 * MINUTE,
      catchup: "all",
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});

// ── live tick — overlapping ticks ────────────────────────────────────────────

describe("cron tick — a slow job overlapping the next tick", () => {
  afterEach(() => {
    stopCronTimer();
    vi.useRealTimers();
  });

  it("does not re-fire a job the overlapping tick already ran", async () => {
    vi.useFakeTimers();
    const MINUTE = 60_000;
    // Tick A reaches `slow` first and blocks on its send; tick B runs 60s
    // later and runs `fast`. When `slow` finally returns, tick A walks on
    // to `fast` — which must not run a second time off tick A's stale
    // listing (lastRunAt from before tick B ran it).
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mocks.sendMessage.mockImplementation(async (_chatId, text) => {
      if (text === "slow") await gate;
    });
    const due = {
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 2 * MINUTE,
      type: "message" as const,
    };
    seed({ ...due, content: "slow", createdAt: Date.now() - 2 });
    const fast = seed({ ...due, content: "fast", createdAt: Date.now() - 1 });

    startCronTimer();
    await vi.advanceTimersByTimeAsync(MINUTE); // tick A: blocks on "slow"
    await vi.advanceTimersByTimeAsync(MINUTE); // tick B: runs "fast"
    expect(getCronJob(fast.id)!.runCount).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0); // tick A resumes

    const fastSends = mocks.sendMessage.mock.calls.filter(
      (c) => c[1] === "fast",
    );
    expect(fastSends).toHaveLength(1);
    expect(getCronJob(fast.id)!.runCount).toBe(1);
  });
});

// ── operator alert ───────────────────────────────────────────────────────────

describe("cron.job alert", () => {
  it("raises when the breaker opens on the third failure and resolves on the next success", async () => {
    const { resetAlertsForTest, activeAlerts } =
      await import("../core/frontend-runtime/alerts.js");
    const sent: string[] = [];
    resetAlertsForTest(async (text) => {
      sent.push(text);
    });
    const job = seed({ type: "query", content: "x", name: "Morning digest" });
    const key = `cron.job.${job.id}`;

    mocks.runJobOneShot.mockRejectedValue(new Error("model unavailable"));
    await runJobNow(job.id);
    await runJobNow(job.id);
    expect(activeAlerts().map((a) => a.key)).not.toContain(key);
    await runJobNow(job.id);
    expect(activeAlerts().map((a) => a.key)).toContain(key);
    expect(sent[0]).toMatch(
      /Cron job "Morning digest" failed 3 runs in a row: model unavailable/,
    );

    mocks.runJobOneShot.mockResolvedValue({ status: "ran" });
    await runJobNow(job.id);
    expect(activeAlerts().map((a) => a.key)).not.toContain(key);
    expect(sent.at(-1)).toMatch(/Cron job "Morning digest" is running again/);
  });
});
