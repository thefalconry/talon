/**
 * `src/cli/config.ts` is the CLI's own config.json loader — separate from
 * (and simpler than) the daemon's in core/config/index.ts. It backs
 * read-only commands (`status`, `config`, `doctor`, the main menu's
 * "is this configured?" gate) as well as load → edit → save commands
 * (`setup`, `plugin`), which is what makes a swallowed parse error
 * dangerous here: reading a broken file as `{}` used to let `talon setup`
 * (or `talon plugin ...`) write those empty defaults straight back over —
 * destroying — the user's real config.
 *
 * These tests run against a real config.json in a temp TALON_HOME
 * (relocatable per util/paths.ts) rather than mocking node:fs, so the
 * "the file stays byte-identical" assertions are literal byte comparisons
 * of what's actually on disk, not just "the writer wasn't called".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isRoot = process.getuid?.() === 0;
// chmod 000 does not make a file unreadable on Windows (no POSIX mode bits).
const cantRevokeRead = isRoot || process.platform === "win32";

describe("cli config.ts — loadConfig / saveConfig against a real file", () => {
  let dir: string;
  const originalTalonHome = process.env.TALON_HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "talon-cli-config-test-"));
    process.env.TALON_HOME = dir;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalTalonHome === undefined) delete process.env.TALON_HOME;
    else process.env.TALON_HOME = originalTalonHome;
  });

  describe("missing file — first run", () => {
    it("loadConfig returns defaults without throwing", async () => {
      const { loadConfig, DEFAULTS } = await import("../cli/config.js");
      expect(loadConfig()).toEqual(DEFAULTS);
    });

    it("saveConfig still writes normally", async () => {
      const { CONFIG_FILE } = await import("../cli/context.js");
      const { loadConfig, saveConfig, DEFAULTS } =
        await import("../cli/config.js");
      saveConfig({ ...DEFAULTS, model: "opus" });
      expect(existsSync(CONFIG_FILE)).toBe(true);
      expect(loadConfig().model).toBe("opus");
    });
  });

  describe("malformed JSON — a present-but-broken file", () => {
    it("loadConfig throws ConfigFileError naming the file, the line/column, and leaves it untouched", async () => {
      const { CONFIG_FILE } = await import("../cli/context.js");
      const raw = '{\n  "frontend": "terminal",\n}\n'; // trailing comma
      writeFileSync(CONFIG_FILE, raw);

      const { loadConfig, ConfigFileError } = await import("../cli/config.js");
      let caught: unknown;
      try {
        loadConfig();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigFileError);
      const err = caught as InstanceType<typeof ConfigFileError>;
      expect(err.path).toBe(CONFIG_FILE);
      expect(err.message).toContain(CONFIG_FILE);
      expect(err.message).toMatch(/line 3 column 1/);
      // Read-only: the broken file is never rewritten just by loading it.
      expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(raw);
    });

    it("saveConfig refuses to overwrite it — file stays byte-identical", async () => {
      const { CONFIG_FILE } = await import("../cli/context.js");
      const raw = '{ "frontend": "terminal", '; // truncated
      writeFileSync(CONFIG_FILE, raw);

      const { saveConfig, ConfigFileError, DEFAULTS } =
        await import("../cli/config.js");
      expect(() => saveConfig({ ...DEFAULTS, model: "clobbered" })).toThrow(
        ConfigFileError,
      );
      expect(() => saveConfig({ ...DEFAULTS, model: "clobbered" })).toThrow(
        /Refusing to write/,
      );
      // Byte-for-byte: not just "no defaults", the file was never touched.
      expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(raw);
    });

    it("empty file fails instead of loading as defaults", async () => {
      const { CONFIG_FILE } = await import("../cli/context.js");
      writeFileSync(CONFIG_FILE, "");
      const { loadConfig, ConfigFileError } = await import("../cli/config.js");
      expect(() => loadConfig()).toThrow(ConfigFileError);
    });
  });

  describe("valid JSON that isn't a config object", () => {
    it("loadConfig and saveConfig both refuse a top-level array, file untouched", async () => {
      const { CONFIG_FILE } = await import("../cli/context.js");
      const raw = "[1, 2, 3]";
      writeFileSync(CONFIG_FILE, raw);

      const { loadConfig, saveConfig, DEFAULTS } =
        await import("../cli/config.js");
      expect(() => loadConfig()).toThrow(/top level must be a JSON object/);
      expect(() => saveConfig({ ...DEFAULTS })).toThrow(
        /top level must be a JSON object/,
      );
      expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(raw);
    });
  });

  describe("a valid existing file", () => {
    it("loadConfig loads it, and saveConfig can still update it normally", async () => {
      const { CONFIG_FILE } = await import("../cli/context.js");
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({ frontend: "terminal", concurrency: 3 }),
      );

      const { loadConfig, saveConfig } = await import("../cli/config.js");
      const config = loadConfig();
      expect(config.frontend).toBe("terminal");
      expect(config.concurrency).toBe(3);

      saveConfig({ ...config, model: "opus" });
      const after = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(after.model).toBe("opus");
      expect(after.frontend).toBe("terminal");
    });
  });

  describe.skipIf(cantRevokeRead)("an existing file that can't be read", () => {
    it("loadConfig throws ConfigFileError naming the reason, not defaults", async () => {
      const { CONFIG_FILE } = await import("../cli/context.js");
      writeFileSync(CONFIG_FILE, JSON.stringify({ frontend: "terminal" }));
      chmodSync(CONFIG_FILE, 0o000);

      const { loadConfig, ConfigFileError } = await import("../cli/config.js");
      try {
        expect(() => loadConfig()).toThrow(ConfigFileError);
        expect(() => loadConfig()).toThrow(/Cannot read/);
      } finally {
        chmodSync(CONFIG_FILE, 0o600); // restore so afterEach's rmSync works
      }
    });
  });
});
