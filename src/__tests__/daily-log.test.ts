import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";

// Mock log to prevent pino initialization
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toYMD } from "../util/time.js";

// Use a unique temp directory for each test run
const TEST_ROOT = join(tmpdir(), `talon-daily-log-test-${Date.now()}`);
const LOGS_DIR = join(TEST_ROOT, ".talon", "workspace", "logs");

// paths.ts uses os.homedir() — mock it to point to our temp directory
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, homedir: () => TEST_ROOT };
});

beforeEach(() => {
  vi.resetModules();
  // The worker home sets TALON_HOME, which outranks the homedir() mock
  // below; point it at this suite's root too.
  vi.stubEnv("TALON_HOME", join(TEST_ROOT, ".talon"));
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

describe("daily-log", () => {
  describe("appendDailyLog", () => {
    it("creates the log file if missing", async () => {
      // Re-import to pick up the mocked cwd
      const { appendDailyLog, getLogsDir } =
        await import("../storage/daily-log.js");

      // Ensure logs dir doesn't exist yet
      expect(existsSync(LOGS_DIR)).toBe(false);

      appendDailyLog("TestChat", "User asked about weather");

      // The logs dir should now exist
      const logsDir = getLogsDir();
      expect(existsSync(logsDir)).toBe(true);

      // There should be a log file for today
      const files = readdirSync(logsDir);
      expect(files.length).toBeGreaterThanOrEqual(1);

      const todayStr = toYMD(new Date());
      const todayFile = files.find((f) => f.startsWith(todayStr));
      expect(todayFile).toBeDefined();
    });

    it("appends to existing file", async () => {
      const { appendDailyLog, getLogsDir } =
        await import("../storage/daily-log.js");

      appendDailyLog("Chat1", "First entry");
      appendDailyLog("Chat2", "Second entry");

      const logsDir = getLogsDir();
      const todayStr = toYMD(new Date());
      const logFile = join(logsDir, `${todayStr}.md`);

      const content = readFileSync(logFile, "utf-8");
      expect(content).toContain("First entry");
      expect(content).toContain("Second entry");
      expect(content).toContain("[Chat1]");
      expect(content).toContain("[Chat2]");
    });

    it("uses correct log format (## HH:MM -- [name])", async () => {
      const { appendDailyLog, getLogsDir } =
        await import("../storage/daily-log.js");

      appendDailyLog("MyChat", "Did some testing");

      const logsDir = getLogsDir();
      const todayStr = toYMD(new Date());
      const logFile = join(logsDir, `${todayStr}.md`);

      const content = readFileSync(logFile, "utf-8");

      // Format: ## HH:MM -- [chatName]
      expect(content).toMatch(/## \d{2}:\d{2} -- \[MyChat\]/);
      // Summary line
      expect(content).toContain("Did some testing");
    });

    it("todayLogDate names the exact file appendDailyLog writes", async () => {
      const { appendDailyLog, getLogsDir, todayLogDate } =
        await import("../storage/daily-log.js");

      appendDailyLog("KeyTest", "reader/writer key agreement");

      expect(readdirSync(getLogsDir())).toContain(`${todayLogDate()}.md`);
    });

    it("uses .talon/workspace/logs/ directory", async () => {
      const { appendDailyLog, getLogsDir } =
        await import("../storage/daily-log.js");

      appendDailyLog("LogDirTest", "checking path");

      const logsDir = getLogsDir();
      expect(logsDir).toContain(".talon");
      expect(logsDir).toContain("logs");
    });
  });

  describe("cleanupOldLogs", () => {
    it("deletes logs older than 30 days", async () => {
      const { cleanupOldLogs } = await import("../storage/daily-log.js");
      mkdirSync(LOGS_DIR, { recursive: true });

      // Create an old log file (40 days ago)
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 40);
      const oldName = toYMD(oldDate) + ".md";
      writeFileSync(join(LOGS_DIR, oldName), "old log content");

      // Create a recent log file (5 days ago)
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5);
      const recentName = toYMD(recentDate) + ".md";
      writeFileSync(join(LOGS_DIR, recentName), "recent log content");

      cleanupOldLogs();

      const remaining = readdirSync(LOGS_DIR);
      expect(remaining).not.toContain(oldName);
      expect(remaining).toContain(recentName);
    });

    it("handles missing logs directory", async () => {
      const { cleanupOldLogs } = await import("../storage/daily-log.js");
      expect(() => cleanupOldLogs()).not.toThrow();
    });

    it("does not log when no files are deleted (line 93 FALSE branch: deleted=0)", async () => {
      const { cleanupOldLogs } = await import("../storage/daily-log.js");
      mkdirSync(LOGS_DIR, { recursive: true });

      // Only a recent file — not old enough to be deleted
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5);
      const recentName = toYMD(recentDate) + ".md";
      writeFileSync(join(LOGS_DIR, recentName), "recent content");

      cleanupOldLogs();

      // File should still be present (not deleted)
      expect(readdirSync(LOGS_DIR)).toContain(recentName);
    });
  });

  describe("cleanupOldLogs — daily memory files", () => {
    const DAILY_MEM_DIR = join(
      TEST_ROOT,
      ".talon",
      "workspace",
      "memory",
      "daily",
    );

    it("deletes daily memory files older than 30 days", async () => {
      const { cleanupOldLogs } = await import("../storage/daily-log.js");
      mkdirSync(LOGS_DIR, { recursive: true });
      mkdirSync(DAILY_MEM_DIR, { recursive: true });

      // Create an old daily memory file (40 days ago)
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 40);
      const oldName = toYMD(oldDate) + ".md";
      writeFileSync(join(DAILY_MEM_DIR, oldName), "old daily memory");

      // Create a recent daily memory file (5 days ago)
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5);
      const recentName = toYMD(recentDate) + ".md";
      writeFileSync(join(DAILY_MEM_DIR, recentName), "recent daily memory");

      cleanupOldLogs();

      const remaining = readdirSync(DAILY_MEM_DIR);
      expect(remaining).not.toContain(oldName);
      expect(remaining).toContain(recentName);
    });

    it("handles missing daily memory directory gracefully", async () => {
      const { cleanupOldLogs } = await import("../storage/daily-log.js");
      // Create logs dir but NOT the daily memory dir
      mkdirSync(LOGS_DIR, { recursive: true });
      expect(() => cleanupOldLogs()).not.toThrow();
    });

    it("ignores non-YYYY-MM-DD.md files in daily memory dir", async () => {
      const { cleanupOldLogs } = await import("../storage/daily-log.js");
      mkdirSync(LOGS_DIR, { recursive: true });
      mkdirSync(DAILY_MEM_DIR, { recursive: true });

      // A file that would sort before the cutoff but doesn't match the pattern
      writeFileSync(join(DAILY_MEM_DIR, "2020-summary.md"), "should survive");
      writeFileSync(join(DAILY_MEM_DIR, "notes.md"), "also should survive");

      cleanupOldLogs();

      const remaining = readdirSync(DAILY_MEM_DIR);
      expect(remaining).toContain("2020-summary.md");
      expect(remaining).toContain("notes.md");
    });

    it("ignores non-YYYY-MM-DD.md files in logs dir", async () => {
      const { cleanupOldLogs } = await import("../storage/daily-log.js");
      mkdirSync(LOGS_DIR, { recursive: true });

      writeFileSync(join(LOGS_DIR, "2020-summary.md"), "should survive");

      cleanupOldLogs();

      expect(readdirSync(LOGS_DIR)).toContain("2020-summary.md");
    });

    it("does not delete recent daily memory files", async () => {
      const { cleanupOldLogs } = await import("../storage/daily-log.js");
      mkdirSync(LOGS_DIR, { recursive: true });
      mkdirSync(DAILY_MEM_DIR, { recursive: true });

      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 3);
      const recentName = toYMD(recentDate) + ".md";
      writeFileSync(join(DAILY_MEM_DIR, recentName), "keep me");

      cleanupOldLogs();

      expect(readdirSync(DAILY_MEM_DIR)).toContain(recentName);
    });
  });

  describe("appendDailyLogResponse", () => {
    it("writes bot response with chat title context", async () => {
      const { appendDailyLogResponse, getLogsDir } =
        await import("../storage/daily-log.js");
      appendDailyLogResponse("Talon", "Here is the weather.", {
        chatTitle: "MyGroup",
      });
      const logsDir = getLogsDir();
      const todayStr = toYMD(new Date());
      const content = readFileSync(join(logsDir, `${todayStr}.md`), "utf-8");
      expect(content).toContain("Talon in MyGroup");
      expect(content).toContain("Here is the weather.");
    });

    it("writes bot response without chat title", async () => {
      const { appendDailyLogResponse, getLogsDir } =
        await import("../storage/daily-log.js");
      appendDailyLogResponse("Talon", "Standalone response");
      const logsDir = getLogsDir();
      const todayStr = toYMD(new Date());
      const content = readFileSync(join(logsDir, `${todayStr}.md`), "utf-8");
      expect(content).toContain("[Talon]");
      expect(content).toContain("Standalone response");
    });

    it("formats response with ## HH:MM -- [label] header", async () => {
      const { appendDailyLogResponse, getLogsDir } =
        await import("../storage/daily-log.js");
      appendDailyLogResponse("BotName", "response text");
      const logsDir = getLogsDir();
      const todayStr = toYMD(new Date());
      const content = readFileSync(join(logsDir, `${todayStr}.md`), "utf-8");
      expect(content).toMatch(/## \d{2}:\d{2} -- \[BotName\]/);
    });
  });

  describe("appendDailyLog — chat context labels", () => {
    it("includes username in label", async () => {
      const { appendDailyLog, getLogsDir } =
        await import("../storage/daily-log.js");
      appendDailyLog("Alice", "hello", { username: "alice_tg" });
      const logsDir = getLogsDir();
      const todayStr = toYMD(new Date());
      const content = readFileSync(join(logsDir, `${todayStr}.md`), "utf-8");
      expect(content).toContain("Alice (@alice_tg)");
    });

    it("includes chat title and username together", async () => {
      const { appendDailyLog, getLogsDir } =
        await import("../storage/daily-log.js");
      appendDailyLog("Bob", "test message", {
        chatTitle: "DevGroup",
        username: "bob_dev",
      });
      const logsDir = getLogsDir();
      const todayStr = toYMD(new Date());
      const content = readFileSync(join(logsDir, `${todayStr}.md`), "utf-8");
      expect(content).toContain("Bob (@bob_dev) in DevGroup");
    });
  });
});

describe("daily-log — error resilience", () => {
  it("appendDailyLog does not throw when write fails (e.g. permissions)", async () => {
    vi.resetModules();
    // Mock node:fs to make appendFileSync throw
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(() => {
        throw new Error("EPERM: permission denied");
      }),
      readdirSync: vi.fn(() => []),
      unlinkSync: vi.fn(),
    }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    vi.doMock("node:os", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, homedir: () => TEST_ROOT };
    });
    const { appendDailyLog } = await import("../storage/daily-log.js");
    // Should swallow the error, not throw
    expect(() => appendDailyLog("Test", "message")).not.toThrow();
  });

  it("appendDailyLogResponse does not throw when write fails", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(() => {
        throw new Error("EROFS: read-only file system");
      }),
      readdirSync: vi.fn(() => []),
      unlinkSync: vi.fn(),
    }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    vi.doMock("node:os", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, homedir: () => TEST_ROOT };
    });
    const { appendDailyLogResponse } = await import("../storage/daily-log.js");
    expect(() => appendDailyLogResponse("Bot", "response")).not.toThrow();
  });
});
