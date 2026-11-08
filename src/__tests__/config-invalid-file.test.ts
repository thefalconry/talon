import { describe, it, expect, vi, beforeEach } from "vitest";
// Real fs for the package-owned prompt templates the loader reads.
import { readFileSync as realReadFileSync } from "node:fs";

/**
 * A present-but-invalid config.json must stop the daemon (startup) or be
 * rejected without side effects (hot reload) — never silently replaced by
 * defaults. A missing config.json is still first-run: defaults apply.
 */

const writeSync = vi.fn();
vi.mock("write-file-atomic", () => ({
  default: { sync: (...args: unknown[]) => writeSync(...args) },
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const isSystemTemplatePath = (path: string): boolean =>
  /prompts[\\/]system[\\/].*\.md$/.test(path);

const isConfigPath = (path: string): boolean => path.includes("config.json");

/** Mock node:fs with `raw` as config.json's contents (null = no file). */
function mockConfigFile(raw: string | null) {
  vi.doMock("node:fs", () => ({
    existsSync: vi.fn((path: string) => {
      if (isConfigPath(path)) return raw !== null;
      if (path.endsWith(".talon") || path.endsWith("/data")) return true;
      return false;
    }),
    readFileSync: vi.fn((path: string) => {
      if (isSystemTemplatePath(path)) return realReadFileSync(path, "utf-8");
      if (isConfigPath(path)) {
        if (raw === null) throw new Error("ENOENT");
        return raw;
      }
      return "";
    }),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ size: 0 })),
  }));
}

describe("loadConfig with an invalid config.json", () => {
  beforeEach(() => {
    vi.resetModules();
    writeSync.mockClear();
    delete process.env.TALON_FRONTEND_OVERRIDE;
  });

  it("loads a valid config", async () => {
    mockConfigFile(JSON.stringify({ frontend: "terminal", concurrency: 2 }));
    const { loadConfig } = await import("../core/config/index.js");
    const config = loadConfig();
    expect(config.frontend).toBe("terminal");
    expect(config.concurrency).toBe(2);
    expect(writeSync).not.toHaveBeenCalled();
  });

  it("treats a missing file as first run: writes defaults and loads them", async () => {
    mockConfigFile(null);
    const { loadConfig } = await import("../core/config/index.js");
    // Defaults target telegram without a token, which is the existing
    // first-run "run talon setup" error — not a ConfigFileError.
    expect(() => loadConfig()).toThrow(/botToken/);
    expect(writeSync).toHaveBeenCalledTimes(1);
    expect(String(writeSync.mock.calls[0]![0])).toContain("config.json");
  });

  it("throws ConfigFileError with path and line/column on malformed JSON", async () => {
    mockConfigFile('{\n  "frontend": "terminal",\n}\n');
    const { loadConfig, ConfigFileError } =
      await import("../core/config/index.js");
    let caught: unknown;
    try {
      loadConfig();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigFileError);
    const err = caught as InstanceType<typeof ConfigFileError>;
    expect(err.message).toContain("Invalid JSON");
    expect(err.message).toContain("config.json");
    expect(err.message).toMatch(/line 3 column 1/);
    expect(err.path).toContain("config.json");
    // Never rewrites the user's file.
    expect(writeSync).not.toHaveBeenCalled();
  });

  it("fails on an empty file instead of using defaults", async () => {
    mockConfigFile("");
    const { loadConfig, ConfigFileError } =
      await import("../core/config/index.js");
    expect(() => loadConfig()).toThrow(ConfigFileError);
    expect(writeSync).not.toHaveBeenCalled();
  });

  it("fails when the top level is not an object", async () => {
    mockConfigFile("[1, 2]");
    const { loadConfig } = await import("../core/config/index.js");
    expect(() => loadConfig()).toThrow(/top level must be a JSON object/);
  });

  it("lists every offending key path on schema failure", async () => {
    mockConfigFile(
      JSON.stringify({
        frontend: "terminal",
        concurrency: "lots",
        heartbeatEffort: "extreme",
      }),
    );
    const { loadConfig, ConfigFileError } =
      await import("../core/config/index.js");
    let caught: unknown;
    try {
      loadConfig();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigFileError);
    const err = caught as InstanceType<typeof ConfigFileError>;
    expect(err.issues.length).toBe(2);
    expect(err.issues.some((i) => i.startsWith("concurrency: "))).toBe(true);
    expect(err.issues.some((i) => i.startsWith("heartbeatEffort: "))).toBe(
      true,
    );
    expect(err.message).toContain("  - concurrency: ");
    expect(err.message).toContain("  - heartbeatEffort: ");
    expect(writeSync).not.toHaveBeenCalled();
  });
});

describe("backup.encryption in config.json", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.TALON_FRONTEND_OVERRIDE;
  });

  it("accepts a passphrase file, or an empty block for the env var", async () => {
    for (const encryption of [{ passphraseFile: "~/.talon/backup.key" }, {}]) {
      mockConfigFile(
        JSON.stringify({ frontend: "terminal", backup: { encryption } }),
      );
      const { loadConfig } = await import("../core/config/index.js");
      expect(loadConfig().backup?.encryption).toEqual(encryption);
      vi.resetModules();
    }
  });

  it("rejects an inline passphrase and an empty file path", async () => {
    for (const encryption of [
      { passphrase: "hunter2hunter2" },
      { passphraseFile: "  " },
    ]) {
      mockConfigFile(
        JSON.stringify({ frontend: "terminal", backup: { encryption } }),
      );
      const { loadConfig, ConfigFileError } =
        await import("../core/config/index.js");
      expect(() => loadConfig()).toThrow(ConfigFileError);
      expect(() => loadConfig()).toThrow(/backup\.encryption/);
      vi.resetModules();
    }
  });
});

describe("reloadPlugins with an invalid config.json", () => {
  const destroyAndClear = vi.fn(async () => {});
  const reloadHubChildren = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    destroyAndClear.mockClear();
    reloadHubChildren.mockClear();
    vi.doMock("../core/plugin/registry.js", () => ({
      registry: { destroyAndClear, all: [] },
      reloadState: { lastReloadAt: "" },
    }));
    vi.doMock("../core/plugin/loader.js", () => ({
      initPluginWithTimeout: vi.fn(),
      loadPlugins: vi.fn(async () => {}),
      registerPlugin: vi.fn(),
    }));
    vi.doMock("../core/mcp-hub/index.js", () => ({ reloadHubChildren }));
  });

  it("rejects malformed JSON and keeps the running plugins", async () => {
    mockConfigFile('{ "frontend": "terminal", ');
    const { reloadPlugins } = await import("../core/plugin/builtins.js");
    const { ConfigFileError } = await import("../core/config/index.js");
    await expect(reloadPlugins(["terminal"])).rejects.toBeInstanceOf(
      ConfigFileError,
    );
    expect(destroyAndClear).not.toHaveBeenCalled();
    expect(reloadHubChildren).not.toHaveBeenCalled();
    expect(writeSync).not.toHaveBeenCalled();
  });

  it("rejects a schema-invalid config and keeps the running plugins", async () => {
    mockConfigFile(JSON.stringify({ frontend: "terminal", concurrency: -1 }));
    const { reloadPlugins } = await import("../core/plugin/builtins.js");
    await expect(reloadPlugins(["terminal"])).rejects.toThrow(/concurrency/);
    expect(destroyAndClear).not.toHaveBeenCalled();
  });

  it("reloads normally from a valid config", async () => {
    mockConfigFile(JSON.stringify({ frontend: "terminal" }));
    const { reloadPlugins } = await import("../core/plugin/builtins.js");
    const { config } = await reloadPlugins(["terminal"]);
    expect(config.frontend).toBe("terminal");
    expect(destroyAndClear).toHaveBeenCalledTimes(1);
    expect(reloadHubChildren).toHaveBeenCalledTimes(1);
  });
});
