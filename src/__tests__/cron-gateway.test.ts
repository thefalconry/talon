/**
 * Validation tests for the cron gateway actions in
 * src/core/engine/gateway-actions.ts:
 *   - create_cron_job
 *   - edit_cron_job
 *   - run_cron_job
 *
 * These exercise handleSharedAction's *validation* surface for the
 * scheduler features (interval vs cron mode, lifecycle bounds, run cap,
 * catch-up policy, model overrides) plus a backward-compat check that a
 * legacy bare-schedule job still works.
 *
 * Strategy
 * ────────
 * handleSharedAction imports a lot of the world. For these validation
 * paths we only need three things to behave:
 *   1. cron-store — used REAL (fs mocked out, in-memory) so create_cron_job
 *      actually persists and we can read the stored job back and assert on
 *      its fields (e.g. everyMs).
 *   2. background/cron/scheduler.js (runJobNow) — mocked, so we never drag in the
 *      dispatcher / backend / agent runtime for run_cron_job.
 *   3. backend-controller + active-model — mocked, so the per-job model
 *      override validation is deterministic (a known model resolves, an
 *      unknown one returns null → rejected).
 * background/triggers/index.js is imported at the top of gateway-actions purely
 * for the trigger_* actions; mocked to a no-op so the module loads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── fs / persistence mocks (so the REAL cron-store stays in-memory) ──────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const existsSyncMock = vi.fn(() => false);
const readFileSyncMock = vi.fn(() => "{}");
const mkdirSyncMock = vi.fn();
const renameSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  mkdirSync: mkdirSyncMock,
  renameSync: renameSyncMock,
  unlinkSync: unlinkSyncMock,
}));

vi.mock("write-file-atomic", () => ({
  default: Object.assign((...args: unknown[]) => writeFileSyncMock(...args), {
    sync: writeFileSyncMock,
  }),
}));

// ── Heavy-module mocks ───────────────────────────────────────────────────────

// run_cron_job → runJobNow. Mocked so we never import the dispatcher / runtime.
const runJobNowMock = vi.fn(
  async (_id: string) => ({ ok: true }) as { ok: boolean; error?: string },
);
vi.mock("../core/background/cron/scheduler.js", () => ({
  runJobNow: (id: string) => runJobNowMock(id),
}));

// Trigger spawn/cancel — only referenced by trigger_* actions; no-op here.
// The per-chat cap check is the real one (caps.ts is not mocked).
vi.mock("../core/background/triggers/index.js", async () => ({
  spawnTrigger: vi.fn(),
  cancelTrigger: vi.fn(() => false),
  triggerCapError: (
    await vi.importActual<typeof import("../core/background/triggers/caps.js")>(
      "../core/background/triggers/caps.js",
    )
  ).triggerCapError,
}));

// Per-chat backend lookup — values are opaque to the model validator below.
vi.mock("../core/engine/backend-controller/index.js", () => ({
  getBackendForChat: vi.fn(() => ({ id: "test-backend", background: {} })),
  getBackendIdForChat: vi.fn(() => "test-backend"),
  getAvailableBackends: vi.fn(() => [{ id: "test-backend", label: "Test" }]),
  getPooledBackend: vi.fn(() => null),
  acquireBackendInstance: vi.fn(),
  isModelValidForBackend: vi.fn(),
}));

// Model-override validation: "good-model" resolves, anything else is unknown.
const resolveExplicitModelRefMock = vi.fn(async (modelId: string) =>
  modelId === "good-model" ? ({ id: modelId } as unknown) : null,
);
vi.mock("../core/models/active-model.js", () => ({
  resolveExplicitModelRef: (modelId: string) =>
    resolveExplicitModelRefMock(modelId),
}));

// ── System under test (after mocks) ──────────────────────────────────────────
// Dynamic imports so these modules load AFTER the mock `const`s above are
// initialized (vi.mock factories are hoisted; a static import of the SUT would
// pull in the mocked `node:fs` before `existsSyncMock` exists).

import type { CronJob } from "../storage/cron.js";
import type { ActionResult } from "../core/types.js";

const { handleSharedAction } =
  await import("../core/engine/gateway-actions/index.js");
const { getCronJob, addCronJob } = await import("../storage/cron.js");
const { getTrigger } = await import("../storage/triggers.js");
const { setTriggerCaps } = await import("../core/background/triggers/caps.js");

const CHAT_ID = 4242;

/** Run a create_cron_job action and return its (non-null) result. */
async function create(body: Record<string, unknown>): Promise<ActionResult> {
  const res = await handleSharedAction(
    {
      action: "create_cron_job",
      name: "Job",
      type: "message",
      content: "hi",
      ...body,
    },
    CHAT_ID,
  );
  expect(res).not.toBeNull();
  return res as ActionResult;
}

/** Extract the created job id from a successful create_cron_job result text. */
function idFromCreate(res: ActionResult): string {
  const m = /id: (cron_[0-9a-f-]+)\)/.exec(res.text ?? "");
  expect(m).not.toBeNull();
  return m![1];
}

let _seq = 0;
function legacyJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: `legacy-${++_seq}`,
    chatId: String(CHAT_ID),
    schedule: "0 9 * * *",
    type: "message",
    content: "Good morning!",
    name: "Legacy job",
    enabled: true,
    createdAt: Date.now(),
    runCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveExplicitModelRefMock.mockImplementation(async (modelId: string) =>
    modelId === "good-model" ? ({ id: modelId } as unknown) : null,
  );
  runJobNowMock.mockResolvedValue({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// create_cron_job — cadence validation
// ─────────────────────────────────────────────────────────────────────────────

describe("create_cron_job — cadence (schedule XOR every_seconds)", () => {
  it("rejects when BOTH schedule and every_seconds are provided", async () => {
    const res = await create({ schedule: "0 9 * * *", every_seconds: 120 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only one of/i);
  });

  it("rejects when NEITHER schedule nor every_seconds is provided", async () => {
    const res = await create({});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/either 'schedule'.*'every_seconds'/i);
  });

  it("rejects every_seconds below the 60s minimum", async () => {
    const res = await create({ every_seconds: 59 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/every_seconds.*60/i);
  });

  it("rejects every_seconds that is not a finite number", async () => {
    const res = await create({ every_seconds: "soon" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/every_seconds/i);
  });

  it("rejects an invalid cron expression", async () => {
    const res = await create({ schedule: "not a cron expression" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid cron expression/i);
  });

  it("accepts exactly every_seconds=60 (boundary) and stores everyMs", async () => {
    const res = await create({ every_seconds: 60 });
    expect(res.ok).toBe(true);
    const job = getCronJob(idFromCreate(res))!;
    expect(job.everyMs).toBe(60_000);
    expect(job.schedule).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create_cron_job — a valid interval job is stored with everyMs
// ─────────────────────────────────────────────────────────────────────────────

describe("create_cron_job — interval job storage", () => {
  it("stores a valid interval job with everyMs and no schedule", async () => {
    const res = await create({ every_seconds: 300, name: "Every 5 min" });
    expect(res.ok).toBe(true);
    const job = getCronJob(idFromCreate(res))!;
    expect(job.everyMs).toBe(300_000);
    expect(job.schedule).toBeUndefined();
    expect(job.name).toBe("Every 5 min");
    expect(job.enabled).toBe(true);
    expect(job.runCount).toBe(0);
  });

  it("stores a valid cron job with schedule and no everyMs", async () => {
    const res = await create({ schedule: "*/15 * * * *" });
    expect(res.ok).toBe(true);
    const job = getCronJob(idFromCreate(res))!;
    expect(job.schedule).toBe("*/15 * * * *");
    expect(job.everyMs).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create_cron_job — content guards
// ─────────────────────────────────────────────────────────────────────────────

describe("create_cron_job — content", () => {
  it("rejects an empty content", async () => {
    const res = await create({ schedule: "0 9 * * *", content: "" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/content/i);
  });

  it("rejects content over 10,000 chars", async () => {
    const res = await create({
      schedule: "0 9 * * *",
      content: "x".repeat(10_001),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/too long/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create_cron_job — missed-run catch-up policy default
// ─────────────────────────────────────────────────────────────────────────────

describe("create_cron_job — catchup default", () => {
  it("defaults new jobs to catchup 'once' so missed runs replay at startup", async () => {
    const res = await create({ schedule: "0 9 * * *" });
    expect(res.ok).toBe(true);
    const job = getCronJob(idFromCreate(res));
    expect(job?.catchup).toBe("once");
  });

  it("honors an explicit catchup override", async () => {
    const res = await create({ schedule: "0 9 * * *", catchup: "skip" });
    expect(res.ok).toBe(true);
    const job = getCronJob(idFromCreate(res));
    expect(job?.catchup).toBe("skip");
  });

  it("still rejects an invalid catchup value", async () => {
    const res = await create({ schedule: "0 9 * * *", catchup: "maybe" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/catchup/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create_cron_job — lifecycle bounds (start_at / end_at)
// ─────────────────────────────────────────────────────────────────────────────

describe("create_cron_job — start_at / end_at", () => {
  it("rejects an end_at in the past", async () => {
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    const res = await create({ schedule: "0 9 * * *", end_at: past });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/end_at.*past/i);
  });

  it("rejects end_at <= start_at", async () => {
    const start = Date.now() + 2 * 60 * 60_000;
    const end = start - 60 * 60_000; // before start, still in the future
    const res = await create({
      schedule: "0 9 * * *",
      start_at: new Date(start).toISOString(),
      end_at: new Date(end).toISOString(),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/end_at.*after.*start_at/i);
  });

  it("rejects end_at exactly equal to start_at", async () => {
    const t = Date.now() + 3 * 60 * 60_000;
    const iso = new Date(t).toISOString();
    const res = await create({
      schedule: "0 9 * * *",
      start_at: iso,
      end_at: iso,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/end_at.*after.*start_at/i);
  });

  it("rejects an unparseable start_at", async () => {
    const res = await create({
      schedule: "0 9 * * *",
      start_at: "whenever feels right",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/start_at/i);
  });

  it("rejects an unparseable end_at", async () => {
    const res = await create({
      schedule: "0 9 * * *",
      end_at: "the heat death of the universe",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/end_at/i);
  });

  it("accepts a valid future start_at + end_at window and stores both", async () => {
    const start = Date.now() + 60 * 60_000;
    const end = Date.now() + 2 * 60 * 60_000;
    const res = await create({
      schedule: "0 9 * * *",
      start_at: new Date(start).toISOString(),
      end_at: new Date(end).toISOString(),
    });
    expect(res.ok).toBe(true);
    const job = getCronJob(idFromCreate(res))!;
    expect(job.startAt).toBe(start);
    expect(job.endAt).toBe(end);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create_cron_job — run cap (once / max_runs)
// ─────────────────────────────────────────────────────────────────────────────

describe("create_cron_job — run cap", () => {
  it("once=true is sugar for max_runs=1", async () => {
    const res = await create({ schedule: "0 9 * * *", once: true });
    expect(res.ok).toBe(true);
    const job = getCronJob(idFromCreate(res))!;
    expect(job.maxRuns).toBe(1);
  });

  it("stores an explicit max_runs", async () => {
    const res = await create({ schedule: "0 9 * * *", max_runs: 7 });
    expect(res.ok).toBe(true);
    expect(getCronJob(idFromCreate(res))!.maxRuns).toBe(7);
  });

  it("rejects a non-integer max_runs", async () => {
    const res = await create({ schedule: "0 9 * * *", max_runs: 2.5 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/max_runs.*positive integer/i);
  });

  it("rejects max_runs < 1", async () => {
    const res = await create({ schedule: "0 9 * * *", max_runs: 0 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/max_runs.*positive integer/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create_cron_job — catch-up policy enum
// ─────────────────────────────────────────────────────────────────────────────

describe("create_cron_job — catchup enum", () => {
  it.each(["skip", "once", "all"])("accepts catchup=%s", async (policy) => {
    const res = await create({ schedule: "0 9 * * *", catchup: policy });
    expect(res.ok).toBe(true);
    expect(getCronJob(idFromCreate(res))!.catchup).toBe(policy);
  });

  it("rejects an unknown catchup policy", async () => {
    const res = await create({ schedule: "0 9 * * *", catchup: "sometimes" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/catchup.*skip.*once.*all/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create_cron_job — model override
// ─────────────────────────────────────────────────────────────────────────────

describe("create_cron_job — model override", () => {
  it("rejects a model override on a 'message' job (model only applies to query)", async () => {
    const res = await create({
      schedule: "0 9 * * *",
      type: "message",
      model: "good-model",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only apply to 'query'/i);
  });

  it("rejects an unresolvable model on a 'query' job", async () => {
    const res = await create({
      schedule: "0 9 * * *",
      type: "query",
      model: "no-such-model",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a selectable model/i);
  });

  it("accepts a resolvable model on a 'query' job and stores it", async () => {
    const res = await create({
      schedule: "0 9 * * *",
      type: "query",
      model: "good-model",
    });
    expect(res.ok).toBe(true);
    expect(getCronJob(idFromCreate(res))!.model).toBe("good-model");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// create_cron_job — backward compat (legacy bare schedule)
// ─────────────────────────────────────────────────────────────────────────────

describe("create_cron_job — backward compat", () => {
  it("a bare-schedule job with no new fields stores none of them", async () => {
    const res = await create({ schedule: "0 9 * * *" });
    expect(res.ok).toBe(true);
    const job = getCronJob(idFromCreate(res))!;
    expect(job.everyMs).toBeUndefined();
    expect(job.startAt).toBeUndefined();
    expect(job.endAt).toBeUndefined();
    expect(job.maxRuns).toBeUndefined();
    // catchup is the one deliberate exception: new jobs default to "once"
    // so runs missed during downtime replay instead of being lost.
    expect(job.catchup).toBe("once");
    expect(job.model).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// edit_cron_job — validation
// ─────────────────────────────────────────────────────────────────────────────

describe("edit_cron_job", () => {
  async function edit(body: Record<string, unknown>): Promise<ActionResult> {
    const res = await handleSharedAction(
      { action: "edit_cron_job", ...body },
      CHAT_ID,
    );
    expect(res).not.toBeNull();
    return res as ActionResult;
  }

  it("rejects a missing job_id", async () => {
    const res = await edit({});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing job_id/i);
  });

  it("rejects an unknown job_id", async () => {
    const res = await edit({ job_id: "cron_does-not-exist" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("rejects editing a job that belongs to a different chat", async () => {
    const job = legacyJob({ chatId: "9999" });
    addCronJob(job);
    const res = await edit({ job_id: job.id, name: "hijack" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/different chat/i);
  });

  it("rejects setting both schedule and every_seconds at once", async () => {
    const job = legacyJob();
    addCronJob(job);
    const res = await edit({
      job_id: job.id,
      schedule: "0 9 * * *",
      every_seconds: 120,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only one of/i);
  });

  it("rejects an invalid cron expression on edit", async () => {
    const job = legacyJob();
    addCronJob(job);
    const res = await edit({ job_id: job.id, schedule: "garbage cron" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid cron expression/i);
  });

  it("rejects every_seconds below the minimum on edit", async () => {
    const job = legacyJob();
    addCronJob(job);
    const res = await edit({ job_id: job.id, every_seconds: 30 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/every_seconds.*60/i);
  });

  it("rejects an unknown catchup policy on edit", async () => {
    const job = legacyJob();
    addCronJob(job);
    const res = await edit({ job_id: job.id, catchup: "maybe" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/catchup.*skip.*once.*all/i);
  });

  it("rejects max_runs < 1 on edit", async () => {
    const job = legacyJob();
    addCronJob(job);
    const res = await edit({ job_id: job.id, max_runs: -3 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/max_runs.*positive integer/i);
  });

  it("rejects a window where the merged end_at <= start_at", async () => {
    // Existing job already has a startAt; new end_at lands before it.
    const start = Date.now() + 5 * 60 * 60_000;
    const job = legacyJob({ startAt: start });
    addCronJob(job);
    const res = await edit({
      job_id: job.id,
      end_at: new Date(start - 60_000).toISOString(),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/end_at.*after.*start_at/i);
  });

  it("rejects an unresolvable model override on edit", async () => {
    const job = legacyJob({ type: "query" });
    addCronJob(job);
    const res = await edit({ job_id: job.id, model: "no-such-model" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a selectable model/i);
  });

  it("switching to every_seconds clears the schedule", async () => {
    const job = legacyJob();
    addCronJob(job);
    const res = await edit({ job_id: job.id, every_seconds: 120 });
    expect(res.ok).toBe(true);
    const updated = getCronJob(job.id)!;
    expect(updated.everyMs).toBe(120_000);
    expect(updated.schedule).toBeUndefined();
  });

  it("once=true on edit sets max_runs to 1", async () => {
    const job = legacyJob();
    addCronJob(job);
    const res = await edit({ job_id: job.id, once: true });
    expect(res.ok).toBe(true);
    expect(getCronJob(job.id)!.maxRuns).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run_cron_job — validation
// ─────────────────────────────────────────────────────────────────────────────

describe("run_cron_job", () => {
  async function run(body: Record<string, unknown>): Promise<ActionResult> {
    const res = await handleSharedAction(
      { action: "run_cron_job", ...body },
      CHAT_ID,
    );
    expect(res).not.toBeNull();
    return res as ActionResult;
  }

  it("rejects a missing job_id", async () => {
    const res = await run({});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing job_id/i);
  });

  it("rejects an unknown job_id", async () => {
    const res = await run({ job_id: "cron_nope" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("rejects a job owned by a different chat", async () => {
    const job = legacyJob({ chatId: "1234" });
    addCronJob(job);
    const res = await run({ job_id: job.id });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/different chat/i);
    expect(runJobNowMock).not.toHaveBeenCalled();
  });

  it("runs a valid owned job via runJobNow", async () => {
    const job = legacyJob();
    addCronJob(job);
    const res = await run({ job_id: job.id });
    expect(res.ok).toBe(true);
    expect(runJobNowMock).toHaveBeenCalledWith(job.id);
  });

  it("surfaces a runJobNow failure as an error result", async () => {
    const job = legacyJob();
    addCronJob(job);
    runJobNowMock.mockResolvedValueOnce({ ok: false, error: "boom" });
    const res = await run({ job_id: job.id });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
  });
});

// ── Canonical chat key ───────────────────────────────────────────────────────
// The bridge only carries a numeric chat id. For native/WhatsApp/Discord chats
// the gateway resolves the real string id and passes it as `chatKey`; jobs and
// triggers must be stored under that key. Stored under the numeric one they
// fire into Telegram, which has no such chat — a `d_…` chat's trigger wake-up
// was lost exactly that way (`sendChatAction … chat not found`, 2026-09-16).

describe("canonical chat key", () => {
  it("create_cron_job stores the chat's string id, not the numeric one", async () => {
    const res = await handleSharedAction(
      {
        action: "create_cron_job",
        name: "Native job",
        type: "message",
        content: "hi",
        schedule: "0 9 * * *",
      },
      CHAT_ID,
      undefined,
      "d_native",
    );
    expect(res?.ok).toBe(true);
    expect(getCronJob(idFromCreate(res as ActionResult))?.chatId).toBe(
      "d_native",
    );

    // The same chat seen through its numeric-only key owns nothing.
    const numericView = await handleSharedAction(
      { action: "list_cron_jobs" },
      CHAT_ID,
    );
    expect(numericView?.text).not.toContain("Native job");
    const keyedView = await handleSharedAction(
      { action: "list_cron_jobs" },
      CHAT_ID,
      undefined,
      "d_native",
    );
    expect(keyedView?.text).toContain("Native job");
  });

  it("trigger_create keys the trigger by the string id and keeps the numeric id for routing", async () => {
    const res = await handleSharedAction(
      {
        action: "trigger_create",
        name: "native-watch",
        language: "bash",
        script: "echo hi",
      },
      CHAT_ID,
      undefined,
      "d_native",
    );
    expect(res?.ok).toBe(true);
    const id = /id: (trig_[0-9a-f-]+)\)/.exec(res?.text ?? "")?.[1];
    expect(id).toBeDefined();
    const trigger = getTrigger(id!);
    expect(trigger?.chatId).toBe("d_native");
    expect(trigger?.numericChatId).toBe(CHAT_ID);
  });

  describe("trigger_create per-chat cap", () => {
    async function createTrigger(
      chatKey: string,
      name: string,
      persistent = false,
    ): Promise<ActionResult> {
      const res = await handleSharedAction(
        {
          action: "trigger_create",
          name,
          language: "bash",
          script: "sleep 60",
          persistent,
        },
        CHAT_ID,
        undefined,
        chatKey,
      );
      return res as ActionResult;
    }

    afterEach(() => setTriggerCaps());

    it("refuses the 6th active trigger by default and names the config key", async () => {
      for (let i = 0; i < 5; i++) {
        expect((await createTrigger("cap_default", `w${i}`)).ok).toBe(true);
      }
      const res = await createTrigger("cap_default", "w5");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("(5 active)");
      expect(res.error).toContain("triggers.maxActivePerChat");
    });

    it("honours a configured cap", async () => {
      setTriggerCaps({ maxActivePerChat: 7 });
      for (let i = 0; i < 7; i++) {
        expect((await createTrigger("cap_config", `w${i}`)).ok).toBe(true);
      }
      const res = await createTrigger("cap_config", "w7");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("(7 active)");
    });

    it("keeps persistent watchers from starving ad-hoc ones when budgeted", async () => {
      setTriggerCaps({ maxActivePerChat: 1, maxPersistentPerChat: 2 });
      expect((await createTrigger("cap_split", "p0", true)).ok).toBe(true);
      expect((await createTrigger("cap_split", "p1", true)).ok).toBe(true);
      const p2 = await createTrigger("cap_split", "p2", true);
      expect(p2.ok).toBe(false);
      expect(p2.error).toContain("triggers.maxPersistentPerChat");
      expect((await createTrigger("cap_split", "ci-wait")).ok).toBe(true);
      const second = await createTrigger("cap_split", "ci-wait-2");
      expect(second.ok).toBe(false);
      expect(second.error).toContain("triggers.maxActivePerChat");
    });
  });
});
