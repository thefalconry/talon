/**
 * Canary: the suite cannot reach the real user home.
 *
 * setup/home-isolation.ts gives every worker a throwaway home, and
 * util/fs-path.ts makes the path resolvers throw if they land on the real
 * one anyway. If either regresses, this file fails first — before a backup
 * prune or restore test gets the chance to run against a live ~/.talon.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import {
  REAL_HOME_ENV,
  assertNotRealHome,
  realHomes,
  touchesRealHome,
  userHome,
} from "../util/fs-path.js";
import {
  ISOLATED_HOME_ENV,
  REAL_HOME_ENV as SETUP_REAL_HOME_ENV,
} from "./setup/home-env.js";

const isolatedHome = process.env[ISOLATED_HOME_ENV]!;

function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Every home this process must stay out of: the one the global setup
 * replaced and, on Node, the password database's (Bun's follows $HOME).
 */
const forbidden = [
  process.env[REAL_HOME_ENV]!,
  ...(process.versions.bun ? [] : [userInfo().homedir]),
].map((p) => resolve(p));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("per-worker home isolation", () => {
  it("runs each worker in a private temp home", () => {
    expect(isolatedHome).toBeTruthy();
    expect(inside(isolatedHome, tmpdir())).toBe(true);
    expect(isolatedHome).toContain(`talon-home-${process.pid}-`);
    for (const home of forbidden) {
      expect(resolve(isolatedHome)).not.toBe(home);
    }
  });

  it("points os.homedir(), HOME and USERPROFILE at it", () => {
    expect(homedir()).toBe(isolatedHome);
    expect(userHome()).toBe(isolatedHome);
    expect(process.env.HOME).toBe(isolatedHome);
    expect(process.env.USERPROFILE).toBe(isolatedHome);
  });

  it("points TALON_HOME and the backend store dirs inside it", () => {
    expect(process.env.TALON_HOME).toBe(join(isolatedHome, ".talon"));
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(isolatedHome, ".claude"));
    expect(process.env.CODEX_HOME).toBe(join(isolatedHome, ".codex"));
    for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
      expect(inside(process.env[name]!, isolatedHome)).toBe(true);
    }
  });

  it("resolves dirs.root and files.* under the temp home", async () => {
    const { dirs, files } = await import("../util/paths.js");
    expect(dirs.root).toBe(resolve(isolatedHome, ".talon"));
    for (const p of [...Object.values(dirs), ...Object.values(files)]) {
      expect(inside(p, isolatedHome)).toBe(true);
      expect(touchesRealHome(p)).toBe(false);
    }
  });

  it("resolves the backup defaults (store, restore-pending, key) under it", async () => {
    const { dirs } = await import("../util/paths.js");
    const { snapshotDir } = await import("../core/backup/store.js");
    const { restorePendingPath } = await import("../core/backup/restore.js");
    const { expandUserPath } = await import("../core/backup/plan.js");

    const defaults = [
      snapshotDir("20260101T000000Z-abcdef"),
      restorePendingPath(),
      join(dirs.root, "backup.key"),
      expandUserPath("~/.talon"),
      expandUserPath("~"),
    ];
    for (const p of defaults) {
      expect(inside(p, isolatedHome)).toBe(true);
      expect(touchesRealHome(p)).toBe(false);
    }
  });
});

describe("home guard", () => {
  it("reads the real home from the variable the global setup writes", () => {
    expect(REAL_HOME_ENV).toBe(SETUP_REAL_HOME_ENV);
    expect(process.env[REAL_HOME_ENV]).toBeTruthy();
  });

  it("knows the real home from the password database and the setup, not HOME", () => {
    for (const home of forbidden) expect(realHomes()).toContain(home);
    expect(realHomes()).not.toContain(resolve(isolatedHome));
  });

  it("throws for the real home, its ~/.talon, anything inside it, and ancestors", () => {
    for (const home of forbidden) {
      for (const p of [
        home,
        join(home, ".talon"),
        join(home, ".talon", "backups"),
        join(home, ".talon", "backup.key"),
        resolve(home, ".."),
      ]) {
        expect(() => assertNotRealHome(p, "canary")).toThrow(/home-guard/);
      }
    }
  });

  it("allows the temp home", () => {
    expect(() => assertNotRealHome(isolatedHome, "canary")).not.toThrow();
    expect(() =>
      assertNotRealHome(join(isolatedHome, ".talon"), "canary"),
    ).not.toThrow();
  });

  it.each(forbidden)(
    "stops util/paths.ts from loading when TALON_HOME is %s/.talon",
    async (home) => {
      vi.stubEnv("TALON_HOME", join(home, ".talon"));
      vi.resetModules();
      await expect(import("../util/paths.js")).rejects.toThrow(/home-guard/);
    },
  );

  it.each(forbidden)(
    "stops util/paths.ts from loading when HOME is forced back to %s",
    async (home) => {
      vi.stubEnv("TALON_HOME", "");
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.resetModules();
      await expect(import("../util/paths.js")).rejects.toThrow(/home-guard/);
    },
  );

  it("cannot be bypassed by mocking os.homedir() to the real home", async () => {
    const real = forbidden[forbidden.length - 1]!;
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      homedir: () => real,
      userInfo: () => ({ homedir: isolatedHome }),
    }));
    vi.stubEnv("TALON_HOME", "");
    vi.resetModules();
    try {
      await expect(import("../util/paths.js")).rejects.toThrow(/home-guard/);
      const guard = await import("../util/fs-path.js");
      expect(() => guard.userHome()).toThrow(/home-guard/);
    } finally {
      vi.doUnmock("node:os");
    }
  });

  it("is a no-op outside vitest", async () => {
    vi.stubEnv("VITEST", "");
    expect(() =>
      assertNotRealHome(join(forbidden[0]!, ".talon"), "canary"),
    ).not.toThrow();
  });
});
