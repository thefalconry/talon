/**
 * Extended tests for src/storage/cron.ts (SQLite-backed).
 *
 * Covers:
 * - validateCronExpression edge cases and generateCronId format/uniqueness
 * - addCronJob / getCronJob roundtrip, getCronJobsForChat isolation
 * - updateCronJob (merge + undefined-clears), deleteCronJob, recordCronRun
 * - getAllCronJobs
 * - loadCronJobs: the one-shot legacy JSON import (envelope, bare object,
 *   bare array) and startup timezone hygiene, exercised against real tmpdir
 *   files + the real engine (no fs mocks) — the same pattern as
 *   sessions-persistence / history-persistence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// The legacy-import path reads files.cron — point the whole Talon root into a
// per-test tmpdir via a paths proxy so each test gets an isolated cron.json +
// database and the import's rename-to-.imported is observable.
let workDir: string;
vi.mock("../util/paths.js", async () => {
  const real =
    await vi.importActual<typeof import("../util/paths.js")>(
      "../util/paths.js",
    );
  return {
    ...real,
    files: new Proxy(real.files, {
      get(target, prop: string) {
        if (prop === "cron") return join(workDir, "cron.json");
        if (prop === "database") return join(workDir, "talon.db");
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import { closeDatabase } from "../storage/db.js";
import type { CronJob } from "../storage/cron.js";

const {
  loadCronJobs,
  addCronJob,
  getCronJob,
  getCronJobsForChat,
  getAllCronJobs,
  updateCronJob,
  deleteCronJob,
  recordCronRun,
  generateCronId,
  validateCronExpression,
  isValidTimezone,
} = await import("../storage/cron.js");

const envBackup = process.env.TALON_DB_PATH;
const importBackup = process.env.TALON_DISABLE_LEGACY_IMPORT;

let _seq = 0;
function uniqueId(): string {
  return `ext-cron-${++_seq}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: uniqueId(),
    chatId: "default-chat",
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

beforeEach(() => {
  delete process.env.TALON_DISABLE_LEGACY_IMPORT;
  workDir = mkdtempSync(join(tmpdir(), "talon-cron-ext-"));
  closeDatabase();
  process.env.TALON_DB_PATH = join(workDir, "talon.db");
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
  if (envBackup === undefined) delete process.env.TALON_DB_PATH;
  else process.env.TALON_DB_PATH = envBackup;
  if (importBackup === undefined)
    delete process.env.TALON_DISABLE_LEGACY_IMPORT;
  else process.env.TALON_DISABLE_LEGACY_IMPORT = importBackup;
  rmSync(workDir, { recursive: true, force: true });
});

// ── validateCronExpression ─────────────────────────────────────────────────

describe("validateCronExpression", () => {
  it("standard 5-field expression is valid", () => {
    const r = validateCronExpression("0 9 * * *");
    expect(r.valid).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("next-run date is a valid ISO string in the future", () => {
    const r = validateCronExpression("0 9 * * *");
    expect(r.next).toBeDefined();
    const next = new Date(r.next!);
    expect(isNaN(next.getTime())).toBe(false);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it("every-minute expression '* * * * *' is valid", () => {
    expect(validateCronExpression("* * * * *").valid).toBe(true);
  });

  it("every-5-minutes expression '*/5 * * * *' is valid", () => {
    expect(validateCronExpression("*/5 * * * *").valid).toBe(true);
  });

  it("weekday-only expression '0 12 * * 1-5' is valid", () => {
    expect(validateCronExpression("0 12 * * 1-5").valid).toBe(true);
  });

  it("first-of-month expression '0 0 1 * *' is valid", () => {
    expect(validateCronExpression("0 0 1 * *").valid).toBe(true);
  });

  it("random string is invalid and returns error message", () => {
    const r = validateCronExpression("not a cron");
    expect(r.valid).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error!.length).toBeGreaterThan(0);
  });

  it("empty string is invalid", () => {
    const r = validateCronExpression("");
    expect(r.valid).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("expression with too few fields is invalid", () => {
    expect(validateCronExpression("* * *").valid).toBe(false);
  });

  it("valid expression with valid timezone is accepted", () => {
    const r = validateCronExpression("0 9 * * *", "America/New_York");
    expect(r.valid).toBe(true);
    expect(r.next).toBeDefined();
  });

  it("valid expression with Europe/Warsaw timezone is accepted", () => {
    expect(validateCronExpression("30 8 * * *", "Europe/Warsaw").valid).toBe(
      true,
    );
  });

  it("valid expression with Asia/Tokyo timezone is accepted", () => {
    expect(validateCronExpression("0 6 * * *", "Asia/Tokyo").valid).toBe(true);
  });

  it("invalid timezone returns valid: false", () => {
    const r = validateCronExpression("0 9 * * *", "Not/A/Real/Timezone");
    expect(r.valid).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("invalid expression returns no 'next' field", () => {
    expect(validateCronExpression("garbage").next).toBeUndefined();
  });

  it("valid expression without timezone still returns next", () => {
    const r = validateCronExpression("0 0 * * *");
    expect(r.valid).toBe(true);
    expect(r.next).toBeDefined();
  });
});

// ── generateCronId ─────────────────────────────────────────────────────────

describe("generateCronId", () => {
  it("produces IDs starting with 'cron_'", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateCronId()).toMatch(/^cron_/);
    }
  });

  it("produces IDs in cron_<uuid> format", () => {
    const id = generateCronId();
    const uuid = id.slice("cron_".length);
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("UUID part is version 4 (random)", () => {
    const id = generateCronId();
    const uuid = id.slice("cron_".length);
    // Version 4 UUID: 13th char is '4'
    expect(uuid[14]).toBe("4");
  });

  it("produces 100 unique IDs across rapid calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateCronId());
    }
    expect(ids.size).toBe(100);
  });
});

// ── addCronJob / getCronJob roundtrip ──────────────────────────────────────

describe("addCronJob and getCronJob roundtrip", () => {
  it("stores and retrieves a job with all fields intact", () => {
    const id = uniqueId();
    const job = makeJob({
      id,
      chatId: "roundtrip-chat",
      schedule: "*/15 * * * *",
      type: "query",
      content: "What is the weather today?",
      name: "Hourly weather",
      enabled: false,
      timezone: "Europe/London",
      runCount: 5,
    });
    addCronJob(job);

    const got = getCronJob(id)!;
    expect(got.id).toBe(id);
    expect(got.chatId).toBe("roundtrip-chat");
    expect(got.schedule).toBe("*/15 * * * *");
    expect(got.type).toBe("query");
    expect(got.content).toBe("What is the weather today?");
    expect(got.name).toBe("Hourly weather");
    expect(got.enabled).toBe(false);
    expect(got.timezone).toBe("Europe/London");
    expect(got.runCount).toBe(5);
  });

  it("getCronJob returns undefined for an ID that was never added", () => {
    expect(getCronJob("absolutely-not-a-real-id-xyz")).toBeUndefined();
  });

  it("adding a job with the same ID overwrites the previous one", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id, name: "First version" }));
    addCronJob(makeJob({ id, name: "Second version" }));
    expect(getCronJob(id)!.name).toBe("Second version");
  });
});

// ── getCronJobsForChat ─────────────────────────────────────────────────────

describe("getCronJobsForChat", () => {
  it("returns only jobs belonging to the specified chatId", () => {
    const chatA = `chat-A-${uniqueId()}`;
    const chatB = `chat-B-${uniqueId()}`;

    const idA1 = uniqueId();
    const idA2 = uniqueId();
    const idB1 = uniqueId();

    addCronJob(makeJob({ id: idA1, chatId: chatA }));
    addCronJob(makeJob({ id: idA2, chatId: chatA }));
    addCronJob(makeJob({ id: idB1, chatId: chatB }));

    const resultA = getCronJobsForChat(chatA);
    expect(resultA.map((j) => j.id)).toContain(idA1);
    expect(resultA.map((j) => j.id)).toContain(idA2);
    expect(resultA.map((j) => j.id)).not.toContain(idB1);

    const resultB = getCronJobsForChat(chatB);
    expect(resultB).toHaveLength(1);
    expect(resultB[0].id).toBe(idB1);
  });

  it("returns an empty array for a chat with no jobs", () => {
    expect(getCronJobsForChat("chat-with-zero-jobs-ext-xyz")).toEqual([]);
  });

  it("does not return a deleted job", () => {
    const chat = `del-chat-${uniqueId()}`;
    const id = uniqueId();
    addCronJob(makeJob({ id, chatId: chat }));
    deleteCronJob(id);
    expect(getCronJobsForChat(chat)).toEqual([]);
  });
});

// ── updateCronJob ──────────────────────────────────────────────────────────

describe("updateCronJob", () => {
  it("updates individual fields and returns the updated job", () => {
    const id = uniqueId();
    addCronJob(
      makeJob({ id, name: "Old name", enabled: true, schedule: "0 9 * * *" }),
    );

    const result = updateCronJob(id, { name: "New name", enabled: false });
    expect(result).toBeDefined();
    expect(result!.name).toBe("New name");
    expect(result!.enabled).toBe(false);
    // unchanged fields remain
    expect(result!.schedule).toBe("0 9 * * *");
  });

  it("returns undefined for a non-existent ID", () => {
    expect(
      updateCronJob("no-such-id-ext", { name: "irrelevant" }),
    ).toBeUndefined();
  });

  it("can update schedule and content simultaneously", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    const result = updateCronJob(id, {
      schedule: "*/10 * * * *",
      content: "updated content",
    });
    expect(result!.schedule).toBe("*/10 * * * *");
    expect(result!.content).toBe("updated content");
  });

  it("can update timezone", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    const result = updateCronJob(id, { timezone: "Pacific/Auckland" });
    expect(result!.timezone).toBe("Pacific/Auckland");
  });

  it("clears a field when the update value is undefined", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id, timezone: "Europe/London" }));
    const result = updateCronJob(id, { timezone: undefined });
    expect(result!.timezone).toBeUndefined();
    expect(getCronJob(id)!.timezone).toBeUndefined();
  });
});

// ── deleteCronJob ──────────────────────────────────────────────────────────

describe("deleteCronJob", () => {
  it("removes the job and returns true", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    expect(deleteCronJob(id)).toBe(true);
    expect(getCronJob(id)).toBeUndefined();
  });

  it("returns false for a non-existent ID", () => {
    expect(deleteCronJob("phantom-id-ext-999")).toBe(false);
  });

  it("deleting twice returns false on second call", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    expect(deleteCronJob(id)).toBe(true);
    expect(deleteCronJob(id)).toBe(false);
  });
});

// ── recordCronRun ──────────────────────────────────────────────────────────

describe("recordCronRun", () => {
  it("increments runCount from 0 to 1 on first call", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id, runCount: 0 }));
    recordCronRun(id);
    expect(getCronJob(id)!.runCount).toBe(1);
  });

  it("increments runCount on each successive call", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id, runCount: 0 }));
    recordCronRun(id);
    recordCronRun(id);
    recordCronRun(id);
    expect(getCronJob(id)!.runCount).toBe(3);
  });

  it("sets lastRunAt to a timestamp close to now", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    const before = Date.now();
    recordCronRun(id);
    const after = Date.now();

    const lastRun = getCronJob(id)!.lastRunAt!;
    expect(lastRun).toBeGreaterThanOrEqual(before);
    expect(lastRun).toBeLessThanOrEqual(after);
  });

  it("is a no-op (does not throw) for a non-existent ID", () => {
    expect(() => recordCronRun("non-existent-run-id-ext")).not.toThrow();
  });

  it("does not reset runCount when called on a job with existing runCount", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id, runCount: 10 }));
    recordCronRun(id);
    expect(getCronJob(id)!.runCount).toBe(11);
  });
});

// ── getAllCronJobs ─────────────────────────────────────────────────────────

describe("getAllCronJobs", () => {
  it("includes recently added jobs", () => {
    const id1 = uniqueId();
    const id2 = uniqueId();
    addCronJob(makeJob({ id: id1 }));
    addCronJob(makeJob({ id: id2 }));

    const ids = getAllCronJobs().map((j) => j.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("does not include deleted jobs", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    deleteCronJob(id);
    expect(getAllCronJobs().map((j) => j.id)).not.toContain(id);
  });

  it("returns an array (not an object)", () => {
    expect(Array.isArray(getAllCronJobs())).toBe(true);
  });
});

// ── loadCronJobs — one-shot legacy JSON import ─────────────────────────────

describe("loadCronJobs — legacy import", () => {
  const legacyJob = (over: Record<string, unknown> = {}) => ({
    id: "legacy-1",
    chatId: "chat-legacy",
    schedule: "0 8 * * *",
    type: "message",
    content: "Good morning",
    name: "Morning",
    enabled: true,
    createdAt: 1000,
    runCount: 2,
    ...over,
  });

  it("imports the JsonStore envelope and renames the file to .imported", () => {
    writeFileSync(
      join(workDir, "cron.json"),
      JSON.stringify({
        schemaVersion: 1,
        savedAt: 1716540000000,
        data: { "legacy-1": legacyJob() },
      }),
    );

    loadCronJobs();

    expect(getCronJob("legacy-1")).toBeDefined();
    expect(getCronJob("legacy-1")!.name).toBe("Morning");
    expect(existsSync(join(workDir, "cron.json"))).toBe(false);
    expect(existsSync(join(workDir, "cron.json.imported"))).toBe(true);
  });

  it("imports the bare pre-envelope object shape { id: job }", () => {
    writeFileSync(
      join(workDir, "cron.json"),
      JSON.stringify({
        "legacy-1": legacyJob(),
        "legacy-2": legacyJob({
          id: "legacy-2",
          chatId: "chat-2",
          type: "query",
          name: "Status check",
        }),
      }),
    );

    loadCronJobs();

    expect(getCronJob("legacy-1")!.name).toBe("Morning");
    expect(getCronJob("legacy-2")!.type).toBe("query");
  });

  it("imports the original bare-array shape [job, ...]", () => {
    writeFileSync(
      join(workDir, "cron.json"),
      JSON.stringify([
        legacyJob({ id: "arr-1", name: "One" }),
        legacyJob({ id: "arr-2", name: "Two", type: "query" }),
      ]),
    );

    loadCronJobs();

    expect(getCronJob("arr-1")!.name).toBe("One");
    expect(getCronJob("arr-2")!.type).toBe("query");
  });

  it("skips malformed legacy entries but keeps valid ones", () => {
    writeFileSync(
      join(workDir, "cron.json"),
      JSON.stringify({
        good: legacyJob({ id: "good" }),
        // neither schedule nor everyMs → rejected by isCronJob
        bad: legacyJob({ id: "bad", schedule: undefined }),
        alsoBad: { id: "alsoBad" },
      }),
    );

    loadCronJobs();

    expect(getCronJob("good")).toBeDefined();
    expect(getCronJob("bad")).toBeUndefined();
    expect(getCronJob("alsoBad")).toBeUndefined();
  });

  it("strips an invalid timezone from an imported job", () => {
    writeFileSync(
      join(workDir, "cron.json"),
      JSON.stringify({
        "tz-bad": legacyJob({ id: "tz-bad", timezone: "Not/A_Real_Zone" }),
      }),
    );

    loadCronJobs();

    expect(getCronJob("tz-bad")).toBeDefined();
    expect(getCronJob("tz-bad")!.timezone).toBeUndefined();
  });

  it("preserves a valid timezone on an imported job", () => {
    writeFileSync(
      join(workDir, "cron.json"),
      JSON.stringify({
        "tz-good": legacyJob({ id: "tz-good", timezone: "Europe/Warsaw" }),
      }),
    );

    loadCronJobs();

    expect(getCronJob("tz-good")!.timezone).toBe("Europe/Warsaw");
  });

  it("does not re-import on a subsequent load", () => {
    writeFileSync(
      join(workDir, "cron.json"),
      JSON.stringify({ "once-1": legacyJob({ id: "once-1", runCount: 0 }) }),
    );

    loadCronJobs();
    recordCronRun("once-1");
    loadCronJobs();

    // A re-import would clobber runCount back to the file's 0.
    expect(getCronJob("once-1")!.runCount).toBe(1);
  });

  it("survives a corrupt legacy file without throwing", () => {
    writeFileSync(join(workDir, "cron.json"), "not json at all!!!");
    expect(() => loadCronJobs()).not.toThrow();
    // The store still works after the failed import.
    addCronJob(makeJob({ id: "after-corrupt" }));
    expect(getCronJob("after-corrupt")).toBeDefined();
  });

  it("does nothing when the legacy file does not exist", () => {
    expect(() => loadCronJobs()).not.toThrow();
    expect(getAllCronJobs()).toEqual([]);
  });
});

// ── loadCronJobs — stranded one-shot sweep ─────────────────────────────────

describe("loadCronJobs — one-shots stranded by a failed run", () => {
  it("retires a one-shot whose only run failed under the old accounting", () => {
    addCronJob(
      makeJob({
        id: "stranded",
        maxRuns: 1,
        runCount: 0,
        lastRunAt: 1_000,
        lastStatus: "error",
        lastError: "model not found",
      }),
    );

    loadCronJobs();

    const after = getCronJob("stranded")!;
    expect(after.enabled).toBe(false);
    expect(after.runCount).toBe(1);
    expect(after.lastError).toBe("model not found");
  });

  it("leaves never-run, succeeded, and uncapped jobs alone", () => {
    addCronJob(makeJob({ id: "fresh", maxRuns: 1, runCount: 0 }));
    addCronJob(
      makeJob({
        id: "uncapped",
        runCount: 0,
        lastRunAt: 1_000,
        lastStatus: "error",
      }),
    );
    addCronJob(
      makeJob({
        id: "multi",
        maxRuns: 3,
        runCount: 0,
        lastRunAt: 1_000,
        lastStatus: "error",
      }),
    );

    loadCronJobs();

    for (const id of ["fresh", "uncapped", "multi"]) {
      expect(getCronJob(id)!.enabled).toBe(true);
    }
  });

  it("round-trips a per-job timeout", () => {
    addCronJob(makeJob({ id: "slow", type: "query", timeoutMs: 1_800_000 }));
    expect(getCronJob("slow")!.timeoutMs).toBe(1_800_000);
  });
});

// ── isValidTimezone ────────────────────────────────────────────────────────

describe("isValidTimezone", () => {
  it("returns true for valid IANA timezones", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Europe/Warsaw")).toBe(true);
    expect(isValidTimezone("Asia/Tokyo")).toBe(true);
  });

  it("returns false for invalid timezone strings", () => {
    expect(isValidTimezone("Not/Real")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("BadString")).toBe(false);
  });
});
