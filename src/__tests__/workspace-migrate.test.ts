/**
 * Tests for workspace migrateLayout, identity seeding, and prompt seeding.
 * Uses temp directories and mocks process.cwd() + os.homedir().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_ROOT = join(tmpdir(), `talon-migrate-test-${Date.now()}`);
const OLD_WORKSPACE = join(TEST_ROOT, "workspace");
const NEW_ROOT = join(TEST_ROOT, ".talon");

beforeEach(() => {
  vi.resetModules();
  // The worker home sets TALON_HOME, which outranks the homedir() mock
  // below; point it at this suite's root too.
  vi.stubEnv("TALON_HOME", join(TEST_ROOT, ".talon"));
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_ROOT, { recursive: true });

  vi.doMock("node:os", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, homedir: () => TEST_ROOT };
  });
  vi.doMock("../util/log.js", () => ({
    log: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    logDebug: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

describe("migrateLayout", () => {
  it("is a no-op when workspace/ does not exist", async () => {
    const { migrateLayout } = await import("../core/vfs/workspace.js");
    expect(() => migrateLayout()).not.toThrow();
    // workspace/sessions.json should NOT have been created since migration never ran
    expect(existsSync(join(NEW_ROOT, "data", "sessions.json"))).toBe(false);
  });

  it("is a no-op when .talon/ already exists", async () => {
    mkdirSync(OLD_WORKSPACE, { recursive: true });
    mkdirSync(NEW_ROOT, { recursive: true });

    const { migrateLayout } = await import("../core/vfs/workspace.js");
    expect(() => migrateLayout()).not.toThrow();
    // workspace/ should still exist — migration was skipped
    expect(existsSync(OLD_WORKSPACE)).toBe(true);
  });

  it("migrates files from workspace/ to .talon/ layout", async () => {
    mkdirSync(OLD_WORKSPACE, { recursive: true });
    writeFileSync(join(OLD_WORKSPACE, "sessions.json"), '{"chat1":{}}');
    writeFileSync(join(OLD_WORKSPACE, "history.json"), "{}");
    writeFileSync(join(OLD_WORKSPACE, "talon.json"), '{"frontend":"telegram"}');

    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { migrateLayout } = await import("../core/vfs/workspace.js");
      migrateLayout();

      const dataDir = join(NEW_ROOT, "data");
      expect(existsSync(join(dataDir, "sessions.json"))).toBe(true);
      expect(existsSync(join(dataDir, "history.json"))).toBe(true);
      expect(existsSync(join(NEW_ROOT, "config.json"))).toBe(true);
      // Original files should be gone
      expect(existsSync(join(OLD_WORKSPACE, "sessions.json"))).toBe(false);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("migrates directories from workspace/ to .talon/workspace/ layout", async () => {
    mkdirSync(OLD_WORKSPACE, { recursive: true });
    const memoryDir = join(OLD_WORKSPACE, "memory");
    mkdirSync(memoryDir);
    writeFileSync(join(memoryDir, "notes.md"), "# Memory");

    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { migrateLayout } = await import("../core/vfs/workspace.js");
      migrateLayout();

      const newMemory = join(NEW_ROOT, "workspace", "memory");
      expect(existsSync(newMemory)).toBe(true);
      expect(existsSync(join(newMemory, "notes.md"))).toBe(true);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("removes empty workspace/ after migration", async () => {
    mkdirSync(OLD_WORKSPACE, { recursive: true });
    // No files — workspace/ is empty

    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { migrateLayout } = await import("../core/vfs/workspace.js");
      migrateLayout();

      // Empty workspace/ should be removed
      expect(existsSync(OLD_WORKSPACE)).toBe(false);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("falls back to copy+delete when renameSync throws (cross-filesystem simulation)", async () => {
    mkdirSync(OLD_WORKSPACE, { recursive: true });
    writeFileSync(join(OLD_WORKSPACE, "sessions.json"), '{"chat1":{}}');
    const memDir = join(OLD_WORKSPACE, "memory");
    mkdirSync(memDir);
    writeFileSync(join(memDir, "notes.md"), "# notes");

    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    // Override renameSync to simulate cross-device link error
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        renameSync: vi.fn(() => {
          throw Object.assign(
            new Error("EXDEV: cross-device link not permitted"),
            { code: "EXDEV" },
          );
        }),
      };
    });

    try {
      const { migrateLayout } = await import("../core/vfs/workspace.js");
      migrateLayout();

      // File was copied via copyFileSync fallback (line 57)
      expect(existsSync(join(NEW_ROOT, "data", "sessions.json"))).toBe(true);
      // Directory was copied via cpSync fallback (line 81)
      expect(
        existsSync(join(NEW_ROOT, "workspace", "memory", "notes.md")),
      ).toBe(true);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("leaves workspace/ when non-migration files remain after migration", async () => {
    mkdirSync(OLD_WORKSPACE, { recursive: true });
    // A file that is NOT in the migration list
    writeFileSync(join(OLD_WORKSPACE, "unknown-extra-file.txt"), "extra");

    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { migrateLayout } = await import("../core/vfs/workspace.js");
      migrateLayout();

      // workspace/ should still exist since it's not empty
      expect(existsSync(OLD_WORKSPACE)).toBe(true);
      expect(existsSync(join(OLD_WORKSPACE, "unknown-extra-file.txt"))).toBe(
        true,
      );
    } finally {
      process.cwd = originalCwd;
    }
  });
});

describe("initWorkspace — identity and prompt seeding", () => {
  it("creates identity.md when it does not exist", async () => {
    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { initWorkspace } = await import("../core/vfs/workspace.js");
      initWorkspace(join(TEST_ROOT, "ws"));

      // identity.md is at ~/.talon/workspace/identity.md
      const identityFile = join(NEW_ROOT, "workspace", "identity.md");
      expect(existsSync(identityFile)).toBe(true);
      const content = readFileSync(identityFile, "utf-8");
      expect(content).toContain("Identity");
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("seeds .md prompt files from the package prompts/ directory", async () => {
    // Seeding reads the PACKAGE prompts dir (resolved relative to the
    // module, not process.cwd()) — a daemon launched from any other
    // directory used to silently seed nothing.
    const { initWorkspace } = await import("../core/vfs/workspace.js");
    initWorkspace(join(TEST_ROOT, "ws"));

    // prompts are seeded to ~/.talon/prompts/
    const talonPromptsDir = join(NEW_ROOT, "prompts");
    expect(existsSync(join(talonPromptsDir, "base.md"))).toBe(true);
    expect(existsSync(join(talonPromptsDir, "dream.md"))).toBe(true);
    // The architecture README is docs, not a prompt — never seeded.
    expect(existsSync(join(talonPromptsDir, "README.md"))).toBe(false);
    // system/ templates are package-owned and read in place — a seeded
    // copy would go stale, so the directory is never copied.
    expect(existsSync(join(talonPromptsDir, "system"))).toBe(false);
    // Non-.md files (e.g. custom.md.example) are not copied.
    expect(existsSync(join(talonPromptsDir, "custom.md.example"))).toBe(false);
  });

  it("does not overwrite existing prompt files", async () => {
    const talonPromptsDir = join(NEW_ROOT, "prompts");
    mkdirSync(talonPromptsDir, { recursive: true });
    // Pre-existing user copy of a real package prompt must survive.
    writeFileSync(
      join(talonPromptsDir, "base.md"),
      "# User customized version",
    );

    const { initWorkspace } = await import("../core/vfs/workspace.js");
    initWorkspace(join(TEST_ROOT, "ws"));

    // User version should be preserved
    const content = readFileSync(join(talonPromptsDir, "base.md"), "utf-8");
    expect(content).toBe("# User customized version");
  });
});

describe("initWorkspace — upgrade-aware prompt seeding (.seeded.json)", () => {
  const talonPromptsDir = () => join(NEW_ROOT, "prompts");
  const manifestPath = () => join(talonPromptsDir(), ".seeded.json");
  const sha256 = async (text: string) => {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(text).digest("hex");
  };

  it("records seeded hashes in the manifest on first run", async () => {
    const { initWorkspace } = await import("../core/vfs/workspace.js");
    initWorkspace(join(TEST_ROOT, "ws"));

    const manifest = JSON.parse(readFileSync(manifestPath(), "utf-8"));
    const seeded = readFileSync(join(talonPromptsDir(), "base.md"), "utf-8");
    expect(manifest["base.md"]).toBe(await sha256(seeded));
  });

  it("refreshes a pristine seeded copy when the package version changes", async () => {
    // Simulate a pre-upgrade state: the on-disk file is an older package
    // version and the manifest records exactly that content as seeded.
    mkdirSync(talonPromptsDir(), { recursive: true });
    const oldVersion = "# Old package version of base.md\n";
    writeFileSync(join(talonPromptsDir(), "base.md"), oldVersion);
    writeFileSync(
      manifestPath(),
      JSON.stringify({ "base.md": await sha256(oldVersion) }),
    );

    const { initWorkspace } = await import("../core/vfs/workspace.js");
    initWorkspace(join(TEST_ROOT, "ws"));

    const content = readFileSync(join(talonPromptsDir(), "base.md"), "utf-8");
    expect(content).not.toBe(oldVersion);
    expect(content).toContain("## Tools"); // current package content
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf-8"));
    expect(manifest["base.md"]).toBe(await sha256(content));
  });

  it("never touches a user-edited copy, even across upgrades", async () => {
    // Manifest says one thing was seeded; the on-disk file differs from
    // it (user edit) AND from the current package → must stay put.
    mkdirSync(talonPromptsDir(), { recursive: true });
    const edited = "# My hand-tuned base prompt\n";
    writeFileSync(join(talonPromptsDir(), "base.md"), edited);
    writeFileSync(
      manifestPath(),
      JSON.stringify({ "base.md": await sha256("whatever was seeded") }),
    );

    const { initWorkspace } = await import("../core/vfs/workspace.js");
    initWorkspace(join(TEST_ROOT, "ws"));

    expect(readFileSync(join(talonPromptsDir(), "base.md"), "utf-8")).toBe(
      edited,
    );
  });

  it("adopts a pre-manifest file only when byte-identical to the package", async () => {
    // First run seeds everything; drop the manifest to simulate a
    // deployment that predates it, and edit one file.
    const { initWorkspace } = await import("../core/vfs/workspace.js");
    initWorkspace(join(TEST_ROOT, "ws"));
    rmSync(manifestPath());
    writeFileSync(join(talonPromptsDir(), "dream.md"), "# edited\n");

    initWorkspace(join(TEST_ROOT, "ws"));

    const manifest = JSON.parse(readFileSync(manifestPath(), "utf-8"));
    // Pristine file (matches package) → adopted, tracks upgrades again.
    expect(manifest["base.md"]).toBeDefined();
    // Unknown-provenance file that differs → user-owned, not adopted.
    expect(manifest["dream.md"]).toBeUndefined();
    expect(readFileSync(join(talonPromptsDir(), "dream.md"), "utf-8")).toBe(
      "# edited\n",
    );
  });

  it("promptSeedReport classifies tracking vs user-edited prompts", async () => {
    const { initWorkspace, promptSeedReport } =
      await import("../core/vfs/workspace.js");
    initWorkspace(join(TEST_ROOT, "ws"));

    // Fresh seed: everything tracks the package.
    let report = promptSeedReport();
    expect(report.tracking).toContain("base.md");
    expect(report.edited).toEqual([]);

    // Edit one file → it flips to user-edited; the rest keep tracking.
    writeFileSync(join(talonPromptsDir(), "base.md"), "# my custom base\n");
    report = promptSeedReport();
    expect(report.edited).toEqual(["base.md"]);
    expect(report.tracking).not.toContain("base.md");
    expect(report.tracking.length).toBeGreaterThan(0);
  });

  it("a seed write cut short by a full disk is retried next boot, not adopted as a user edit", async () => {
    // Model each write primitive's real ENOSPC behaviour for base.md: a
    // plain write leaves the bytes it got out, an atomic write leaves
    // nothing (its temp file never gets renamed into place).
    const enospc = () =>
      Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });
    const hitsBase = (p: unknown) => String(p).endsWith("base.md");
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        writeFileSync: ((p: string, data: string, ...rest: unknown[]) => {
          if (!hitsBase(p)) {
            return (actual.writeFileSync as (...a: unknown[]) => void)(
              p,
              data,
              ...rest,
            );
          }
          actual.writeFileSync(p, String(data).slice(0, 40));
          throw enospc();
        }) as typeof actual.writeFileSync,
      };
    });
    vi.doMock("write-file-atomic", async (importOriginal) => {
      const { default: real } = await importOriginal<{
        default: typeof import("write-file-atomic");
      }>();
      const sync = ((p: string, ...rest: unknown[]) => {
        if (hitsBase(p)) throw enospc();
        return (real.sync as (...a: unknown[]) => void)(p, ...rest);
      }) as typeof real.sync;
      // A fresh function object: the real module is shared across
      // resetModules, so it must not be patched in place.
      const wrapped = Object.assign(
        (...a: Parameters<typeof real>) => real(...a),
        real,
        { sync },
      );
      return { default: wrapped };
    });

    const first = await import("../core/vfs/workspace.js");
    first.initWorkspace(join(TEST_ROOT, "ws"));

    // Disk freed, daemon restarts.
    vi.doUnmock("node:fs");
    vi.doUnmock("write-file-atomic");
    vi.resetModules();
    const second = await import("../core/vfs/workspace.js");
    second.initWorkspace(join(TEST_ROOT, "ws"));

    const content = readFileSync(join(talonPromptsDir(), "base.md"), "utf-8");
    expect(content).toContain("## Tools"); // the full package copy
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf-8"));
    expect(manifest["base.md"]).toBe(await sha256(content));
  });

  it("re-adopts a file that matches the current package despite a stale manifest entry", async () => {
    // A user edit that lands byte-identical to the current package copy
    // (e.g. hand-applying an upstream change) must not strand the file
    // as user-owned-forever: content matching the package re-adopts it.
    const { initWorkspace } = await import("../core/vfs/workspace.js");
    initWorkspace(join(TEST_ROOT, "ws"));
    const pkgContent = readFileSync(
      join(talonPromptsDir(), "base.md"),
      "utf-8",
    );
    writeFileSync(
      manifestPath(),
      JSON.stringify({ "base.md": await sha256("some stale seeded hash") }),
    );

    initWorkspace(join(TEST_ROOT, "ws"));

    const manifest = JSON.parse(readFileSync(manifestPath(), "utf-8"));
    expect(manifest["base.md"]).toBe(await sha256(pkgContent));
  });
});
