/**
 * Trigger store — SQLite-backed CRUD, validation, path helpers, on-disk
 * script/log handling, the one-shot legacy JSON import and SQL restart
 * recovery.
 *
 * Real tmpdir files + the real engine (no fs mocks). A paths proxy points
 * files.triggers / files.database and dirs.triggerRuns into a per-test
 * tmpdir so imports, script writes and log reads stay isolated and never
 * touch ~/.talon — the same harness as sessions-persistence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

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
        if (prop === "triggers") return join(workDir, "triggers.json");
        if (prop === "database") return join(workDir, "talon.db");
        return target[prop as keyof typeof target];
      },
    }),
    dirs: new Proxy(real.dirs, {
      get(target, prop: string) {
        if (prop === "triggerRuns") return join(workDir, "trigger-runs");
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import { closeDatabase } from "../storage/db.js";
import type { Trigger } from "../storage/triggers.js";

const {
  loadTriggers,
  addTrigger,
  getTrigger,
  getTriggersForChat,
  getActiveTriggersForChat,
  getTriggerByName,
  updateTrigger,
  deleteTrigger,
  generateTriggerId,
  validateLanguage,
  validateName,
  validateScript,
  validateTimeout,
  writeScriptFile,
  triggerScriptPath,
  triggerLogPath,
  readTriggerLogTail,
  sanitizeChatId,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MAX_ACTIVE_PER_CHAT,
  pruneSettledTriggers,
  SETTLED_TRIGGER_TTL_MS,
} = await import("../storage/triggers.js");

const envBackup = process.env.TALON_DB_PATH;
const importBackup = process.env.TALON_DISABLE_LEGACY_IMPORT;

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  const id = overrides.id ?? generateTriggerId();
  return {
    id,
    chatId: "chat-1",
    numericChatId: 1,
    name: "watch-pr",
    language: "bash",
    scriptPath: join(workDir, "trigger-runs", "chat-1", `${id}.sh`),
    logPath: join(workDir, "trigger-runs", "chat-1", `${id}.log`),
    status: "running",
    createdAt: Date.now(),
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    fireCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.TALON_DISABLE_LEGACY_IMPORT;
  workDir = mkdtempSync(join(tmpdir(), "talon-trigger-store-"));
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

describe("trigger-store", () => {
  describe("constants", () => {
    it("exposes sane defaults", () => {
      expect(DEFAULT_TIMEOUT_SECONDS).toBe(24 * 60 * 60);
      expect(MAX_TIMEOUT_SECONDS).toBe(7 * 24 * 60 * 60);
      expect(MAX_ACTIVE_PER_CHAT).toBe(5);
    });
  });

  describe("validation", () => {
    it("validateLanguage accepts only the four supported languages", () => {
      expect(validateLanguage("bash")).toBe(true);
      expect(validateLanguage("python")).toBe(true);
      expect(validateLanguage("node")).toBe(true);
      expect(validateLanguage("lua")).toBe(true);
      expect(validateLanguage("ruby")).toBe(false);
      expect(validateLanguage(undefined)).toBe(false);
      expect(validateLanguage(123)).toBe(false);
    });

    it("validateName requires a sane identifier", () => {
      expect(validateName("watch-pr")).toBeNull();
      expect(validateName("Watch PR 35337")).toBeNull();
      expect(validateName("foo.bar_baz")).toBeNull();
      expect(validateName("")).toMatch(/Missing/);
      expect(validateName("has/slash")).toMatch(/letters/);
      expect(validateName("a".repeat(65))).toMatch(/letters/);
    });

    it("validateScript rejects empty and oversized scripts", () => {
      expect(validateScript("echo ok")).toBeNull();
      expect(validateScript("")).toMatch(/Missing/);
      expect(validateScript("   ")).toMatch(/Missing/);
      expect(validateScript("x".repeat(70_000))).toMatch(/too large/);
    });

    it("validateTimeout enforces bounds", () => {
      expect(validateTimeout(60)).toBeNull();
      expect(validateTimeout(MAX_TIMEOUT_SECONDS)).toBeNull();
      expect(validateTimeout(0)).toMatch(/positive/);
      expect(validateTimeout(-1)).toMatch(/positive/);
      expect(validateTimeout(NaN)).toMatch(/positive/);
      expect(validateTimeout(MAX_TIMEOUT_SECONDS + 1)).toMatch(/exceeds max/);
    });
  });

  describe("path helpers", () => {
    it("sanitizeChatId strips path-unsafe characters", () => {
      expect(sanitizeChatId("424242420")).toBe("424242420");
      expect(sanitizeChatId("-100123")).toBe("-100123");
      expect(sanitizeChatId("../etc/passwd")).toBe("___etc_passwd");
    });

    it("triggerScriptPath uses the language extension", () => {
      const id = generateTriggerId();
      // Normalise path separators for cross-platform compat (Windows uses \)
      const norm = (p: string) => p.replace(/\\/g, "/");
      expect(norm(triggerScriptPath("c1", id, "bash"))).toMatch(
        new RegExp(`/c1/${id}\\.sh$`),
      );
      expect(triggerScriptPath("c1", id, "python")).toMatch(/\.py$/);
      expect(triggerScriptPath("c1", id, "node")).toMatch(/\.js$/);
      expect(triggerScriptPath("c1", id, "lua")).toMatch(/\.lua$/);
    });

    it("triggerLogPath always uses .log", () => {
      const id = generateTriggerId();
      expect(triggerLogPath("c1", id)).toMatch(/\.log$/);
    });
  });

  describe("CRUD", () => {
    it("addTrigger / getTrigger round-trips a record", () => {
      const t = makeTrigger();
      addTrigger(t);
      const retrieved = getTrigger(t.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe("watch-pr");
      expect(retrieved!.language).toBe("bash");
    });

    it("getTriggersForChat scopes correctly", () => {
      addTrigger(makeTrigger({ chatId: "a" }));
      addTrigger(makeTrigger({ chatId: "a", name: "second" }));
      addTrigger(makeTrigger({ chatId: "b" }));
      expect(getTriggersForChat("a")).toHaveLength(2);
      expect(getTriggersForChat("b")).toHaveLength(1);
      expect(getTriggersForChat("c")).toHaveLength(0);
    });

    it("getActiveTriggersForChat only returns running/pending", () => {
      addTrigger(makeTrigger({ chatId: "a", status: "running" }));
      addTrigger(makeTrigger({ chatId: "a", name: "two", status: "pending" }));
      addTrigger(makeTrigger({ chatId: "a", name: "three", status: "fired" }));
      addTrigger(makeTrigger({ chatId: "a", name: "four", status: "errored" }));
      expect(getActiveTriggersForChat("a")).toHaveLength(2);
    });

    it("getTriggerByName scopes to chat", () => {
      addTrigger(makeTrigger({ chatId: "a", name: "shared" }));
      addTrigger(makeTrigger({ chatId: "b", name: "shared" }));
      expect(getTriggerByName("a", "shared")?.chatId).toBe("a");
      expect(getTriggerByName("b", "shared")?.chatId).toBe("b");
      expect(getTriggerByName("c", "shared")).toBeUndefined();
    });

    it("updateTrigger merges fields", () => {
      const t = makeTrigger();
      addTrigger(t);
      updateTrigger(t.id, { status: "fired", exitCode: 0, fireCount: 1 });
      const updated = getTrigger(t.id);
      expect(updated!.status).toBe("fired");
      expect(updated!.exitCode).toBe(0);
      expect(updated!.fireCount).toBe(1);
    });

    it("updateTrigger clears a field when the value is undefined", () => {
      // Merge semantics: a key present with value undefined drops the column —
      // the supervisor relies on it to drop e.g. a dead pid.
      const t = makeTrigger({ pid: 4321 });
      addTrigger(t);
      const updated = updateTrigger(t.id, { pid: undefined });
      expect(updated!.pid).toBeUndefined();
      expect(getTrigger(t.id)!.pid).toBeUndefined();
    });

    it("updateTrigger returns undefined for an unknown id", () => {
      expect(updateTrigger("nope", { status: "fired" })).toBeUndefined();
    });

    it("deleteTrigger removes from store and cleans up files", () => {
      const t = makeTrigger();
      mkdirSync(join(workDir, "trigger-runs", "chat-1"), { recursive: true });
      writeFileSync(t.scriptPath, "echo hi");
      writeFileSync(t.logPath, "log");
      addTrigger(t);

      expect(deleteTrigger(t.id)).toBe(true);
      expect(getTrigger(t.id)).toBeUndefined();
      // best-effort rm of script + log
      expect(existsSync(t.scriptPath)).toBe(false);
      expect(existsSync(t.logPath)).toBe(false);
    });

    it("deleteTrigger returns false for unknown id", () => {
      expect(deleteTrigger("nope")).toBe(false);
    });
  });

  describe("loadTriggers — restart recovery (SQL)", () => {
    it("marks a non-persistent running trigger as terminated", () => {
      const t = makeTrigger({ status: "running", pid: 999 });
      addTrigger(t);

      loadTriggers();

      const restored = getTrigger(t.id)!;
      expect(restored.status).toBe("terminated");
      expect(restored.pid).toBeUndefined();
      expect(restored.lastError).toMatch(/restarted/);
      expect(restored.endedAt).toBeDefined();
    });

    it("marks a non-persistent pending trigger as terminated", () => {
      const t = makeTrigger({ status: "pending" });
      addTrigger(t);

      loadTriggers();

      expect(getTrigger(t.id)!.status).toBe("terminated");
    });

    it("preserves a clean endedAt/lastError already recorded (COALESCE)", () => {
      const t = makeTrigger({
        status: "running",
        endedAt: 12345,
        lastError: "already noted",
      });
      addTrigger(t);

      loadTriggers();

      const restored = getTrigger(t.id)!;
      expect(restored.status).toBe("terminated");
      expect(restored.endedAt).toBe(12345);
      expect(restored.lastError).toBe("already noted");
    });

    it("preserves terminal statuses across load", () => {
      const t = makeTrigger({
        status: "fired",
        endedAt: Date.now() - 60_000,
        exitCode: 0,
      });
      addTrigger(t);

      loadTriggers();

      expect(getTrigger(t.id)!.status).toBe("fired");
    });

    it("parks a persistent running trigger as pending and preserves its pid", () => {
      const t = makeTrigger({ status: "running", pid: 1234, persistent: true });
      addTrigger(t);

      loadTriggers();

      const restored = getTrigger(t.id)!;
      expect(restored.status).toBe("pending");
      // pid is kept so resumeAfterRestart() can detect/kill an orphaned child
      expect(restored.pid).toBe(1234);
      expect(restored.lastError).toBeUndefined();
      expect(restored.endedAt).toBeUndefined();
    });

    it("does not touch persistent triggers already in a terminal state", () => {
      const t = makeTrigger({
        status: "cancelled",
        persistent: true,
        endedAt: Date.now() - 1000,
        lastError: "Cancelled by user",
      });
      addTrigger(t);

      loadTriggers();

      // Cancelled persistent stays cancelled — only running/pending convert.
      expect(getTrigger(t.id)!.status).toBe("cancelled");
    });

    it("does not throw on an empty store", () => {
      expect(() => loadTriggers()).not.toThrow();
      expect(getTrigger("any")).toBeUndefined();
    });
  });

  describe("loadTriggers — legacy JSON import", () => {
    const legacy = (over: Partial<Trigger> = {}): Trigger =>
      makeTrigger({ status: "fired", exitCode: 0, ...over });

    it("imports the JsonStore envelope and renames the file to .imported", () => {
      const t = legacy({ id: "trig-env" });
      writeFileSync(
        join(workDir, "triggers.json"),
        JSON.stringify({
          schemaVersion: 1,
          savedAt: 1716540000000,
          data: { [t.id]: t },
        }),
      );

      loadTriggers();

      expect(getTrigger("trig-env")?.status).toBe("fired");
      expect(existsSync(join(workDir, "triggers.json"))).toBe(false);
      expect(existsSync(join(workDir, "triggers.json.imported"))).toBe(true);
    });

    it("imports the bare pre-envelope object shape { id: trigger }", () => {
      const t = legacy({ id: "trig-bare" });
      writeFileSync(
        join(workDir, "triggers.json"),
        JSON.stringify({ [t.id]: t }),
      );

      loadTriggers();

      expect(getTrigger("trig-bare")?.status).toBe("fired");
    });

    it("imports the original bare-array shape [trigger, ...]", () => {
      const a = legacy({ id: "trig-arr-1" });
      const b = legacy({ id: "trig-arr-2", name: "second" });
      writeFileSync(join(workDir, "triggers.json"), JSON.stringify([a, b]));

      loadTriggers();

      expect(getTrigger("trig-arr-1")).toBeDefined();
      expect(getTrigger("trig-arr-2")).toBeDefined();
    });

    it("applies restart recovery to imported running triggers", () => {
      const t = legacy({ id: "trig-imp-run", status: "running", pid: 42 });
      writeFileSync(
        join(workDir, "triggers.json"),
        JSON.stringify({ [t.id]: t }),
      );

      loadTriggers();

      const restored = getTrigger("trig-imp-run")!;
      expect(restored.status).toBe("terminated");
      expect(restored.pid).toBeUndefined();
    });

    it("survives a corrupt legacy file without throwing", () => {
      writeFileSync(join(workDir, "triggers.json"), "{ not valid json");
      expect(() => loadTriggers()).not.toThrow();
      // The store still works after the failed import.
      addTrigger(makeTrigger({ id: "after-corrupt" }));
      expect(getTrigger("after-corrupt")).toBeDefined();
    });

    it("does nothing when the legacy file does not exist", () => {
      expect(() => loadTriggers()).not.toThrow();
      expect(getTrigger("any")).toBeUndefined();
    });
  });

  describe("pruneSettledTriggers", () => {
    const now = Date.now();
    const old = now - SETTLED_TRIGGER_TTL_MS - 60_000; // past retention
    const fresh = now - 60_000; // well inside retention

    it("removes settled triggers past the retention window", () => {
      addTrigger(
        makeTrigger({ id: "old-fired", status: "fired", endedAt: old }),
      );
      addTrigger(
        makeTrigger({ id: "old-errored", status: "errored", endedAt: old }),
      );
      addTrigger(
        makeTrigger({ id: "old-timeout", status: "timed_out", endedAt: old }),
      );
      expect(pruneSettledTriggers(now)).toBe(3);
      expect(getTrigger("old-fired")).toBeUndefined();
      expect(getTrigger("old-errored")).toBeUndefined();
      expect(getTrigger("old-timeout")).toBeUndefined();
    });

    it("keeps settled triggers inside the retention window", () => {
      addTrigger(
        makeTrigger({ id: "new-fired", status: "fired", endedAt: fresh }),
      );
      expect(pruneSettledTriggers(now)).toBe(0);
      expect(getTrigger("new-fired")).toBeDefined();
    });

    it("never touches running or pending triggers, however old", () => {
      addTrigger(
        makeTrigger({ id: "old-running", status: "running", createdAt: old }),
      );
      addTrigger(
        makeTrigger({ id: "old-pending", status: "pending", createdAt: old }),
      );
      expect(pruneSettledTriggers(now)).toBe(0);
      expect(getTrigger("old-running")).toBeDefined();
      expect(getTrigger("old-pending")).toBeDefined();
    });

    it("falls back through lastFireAt/startedAt/createdAt when endedAt is unset", () => {
      addTrigger(
        makeTrigger({
          id: "old-no-ended",
          status: "terminated",
          createdAt: old,
        }),
      );
      addTrigger(
        makeTrigger({
          id: "kept-late-fire",
          status: "fired",
          createdAt: old,
          lastFireAt: fresh,
        }),
      );
      expect(pruneSettledTriggers(now)).toBe(1);
      expect(getTrigger("old-no-ended")).toBeUndefined();
      expect(getTrigger("kept-late-fire")).toBeDefined();
    });
  });

  describe("writeScriptFile", () => {
    it("writes the script body with 0o700 perms and returns the path", () => {
      const path = writeScriptFile("c1", "trig_x", "bash", "echo hi");
      expect(path).toMatch(/\.sh$/);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("echo hi");
    });
  });

  describe("readTriggerLogTail", () => {
    it("returns empty for a non-existent log", () => {
      const result = readTriggerLogTail(join(workDir, "nope.log"), 10);
      expect(result.tail).toBe("");
      expect(result.truncated).toBe(false);
    });

    it("returns last N lines and flags truncation", () => {
      const path = join(workDir, "x.log");
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      writeFileSync(path, lines.join("\n"));
      const result = readTriggerLogTail(path, 5);
      expect(result.truncated).toBe(true);
      expect(result.tail.split("\n")).toEqual([
        "line 16",
        "line 17",
        "line 18",
        "line 19",
        "line 20",
      ]);
    });

    it("returns full content untruncated when small enough", () => {
      const path = join(workDir, "y.log");
      writeFileSync(path, "a\nb\nc");
      const result = readTriggerLogTail(path, 10);
      expect(result.truncated).toBe(false);
      expect(result.tail).toBe("a\nb\nc");
    });

    it("returns an error string when the log cannot be read (catch path)", () => {
      // A directory path: existsSync passes but readFileSync throws EISDIR.
      const dirPath = join(workDir, "a-directory");
      mkdirSync(dirPath);
      const result = readTriggerLogTail(dirPath, 10);
      expect(result.tail).toMatch(/Failed to read log/);
      expect(result.truncated).toBe(false);
    });
  });
});
