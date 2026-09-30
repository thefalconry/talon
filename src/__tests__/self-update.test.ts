import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runSelfUpdate,
  getRepoRoot,
  wantsForce,
  type CommandRunner,
} from "../core/update/self-update.js";
import { _resetBackupScheduler } from "../core/backup/scheduler.js";
import type { UpdateCheckpoint } from "../core/backup/index.js";
import { BOOT_SMOKE_FLAG, BOOT_SMOKE_OK } from "../core/daemon/respawn.js";

/**
 * Build a runner that replies based on the command + args. `headSeq`
 * supplies successive `git rev-parse HEAD` results (before, after); the
 * remote ref resolves to the last of them, where the reset will land.
 */
function makeRunner(opts: {
  headSeq?: string[];
  fail?: (cmd: string, args: readonly string[]) => string | null;
  calls?: string[][];
  /** Import check exits 0 without printing its marker. */
  silentSmoke?: boolean;
}): CommandRunner {
  const heads = [...(opts.headSeq ?? ["aaaaaaaaaaaa", "aaaaaaaaaaaa"])];
  const target = heads.at(-1) ?? "aaaaaaaaaaaa";
  return async (cmd, args) => {
    opts.calls?.push([cmd, ...args]);
    const failOut = opts.fail?.(cmd, args);
    if (failOut) return { ok: false, output: failOut };
    if (cmd === "git" && args[0] === "rev-parse") {
      if (args[1] !== "HEAD") return { ok: true, output: target };
      return { ok: true, output: heads.shift() ?? "aaaaaaaaaaaa" };
    }
    // The post-install import check: a healthy tree prints its marker.
    if (args.includes(BOOT_SMOKE_FLAG)) {
      return { ok: true, output: opts.silentSmoke ? "" : BOOT_SMOKE_OK };
    }
    return { ok: true, output: "ok" };
  };
}

const ROOT = "/repo";
const ENTRY = { cmd: "/usr/bin/bun", args: ["src/index.ts"] };
const taken = async (): Promise<UpdateCheckpoint> => ({
  status: "taken",
  id: "20260930T000000Z-abcdef",
});

describe("runSelfUpdate", () => {
  it("verifies the new tree imports before anyone restarts into it", async () => {
    const calls: string[][] = [];
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint: taken,
      runner: makeRunner({ headSeq: ["aaa111aaa111", "bbb222bbb222"], calls }),
    });
    expect(res.ok).toBe(true);
    const smoke = calls.find((c) => c.includes(BOOT_SMOKE_FLAG));
    expect(smoke).toEqual(["/usr/bin/bun", "src/index.ts", BOOT_SMOKE_FLAG]);
    // Order matters: the check runs against the installed tree.
    expect(calls.findIndex((c) => c[0] === "npm")).toBeLessThan(
      calls.findIndex((c) => c.includes(BOOT_SMOKE_FLAG)),
    );
  });

  it("fails the update when the installed tree cannot be imported", async () => {
    // node_modules rewritten under the running process, entry no longer
    // resolves: the caller must keep the working process and report.
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint: taken,
      runner: makeRunner({
        headSeq: ["aaa111aaa111", "bbb222bbb222"],
        fail: (_cmd, args) =>
          args.includes(BOOT_SMOKE_FLAG)
            ? "error: Cannot find module 'grammy'"
            : null,
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.changed).toBe(true);
    expect(res.error).toContain("does not import");
    expect(res.error).toContain("aaa111aaa111");
    expect(res.steps.at(-1)?.output).toContain("Cannot find module");
  });

  it("fails the update when the import check prints no marker", async () => {
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint: taken,
      runner: makeRunner({
        headSeq: ["aaa111aaa111", "bbb222bbb222"],
        // Exit 0 but silent — a runtime that died without saying so.
        silentSmoke: true,
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("does not import");
  });

  it("reports no change and skips install when HEAD does not move", async () => {
    const calls: string[][] = [];
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint: taken,
      runner: makeRunner({ headSeq: ["abc123abc123", "abc123abc123"], calls }),
    });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.before).toBe("abc123abc123");
    // npm install must NOT have run.
    expect(calls.some((c) => c[0] === "npm")).toBe(false);
  });

  it("resets, installs, runs setup, and reports change on update", async () => {
    const calls: string[][] = [];
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint: taken,
      remote: "upstream",
      branch: "dev",
      setup: ["npm run build"],
      runner: makeRunner({ headSeq: ["aaa111aaa111", "bbb222bbb222"], calls }),
    });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.before).toBe("aaa111aaa111");
    expect(res.after).toBe("bbb222bbb222");
    // Custom remote/branch threaded into fetch + reset.
    expect(calls).toContainEqual(["git", "fetch", "upstream", "dev"]);
    expect(calls).toContainEqual(["git", "reset", "--hard", "upstream/dev"]);
    expect(calls).toContainEqual(["git", "clean", "-fd"]);
    expect(calls).toContainEqual(["npm", "install"]);
    expect(calls).toContainEqual(["sh", "-c", "npm run build"]);
  });

  it("defaults remote/branch to origin/main", async () => {
    const calls: string[][] = [];
    await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint: taken,
      runner: makeRunner({ headSeq: ["a1", "b2"], calls }),
    });
    expect(calls).toContainEqual(["git", "fetch", "origin", "main"]);
    expect(calls).toContainEqual(["git", "reset", "--hard", "origin/main"]);
  });

  it("stops before install when the reset fails", async () => {
    const calls: string[][] = [];
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint: taken,
      runner: makeRunner({
        headSeq: ["a1", "b2"],
        calls,
        fail: (cmd, args) =>
          cmd === "git" && args[0] === "reset" ? "fatal: reset failed" : null,
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/reset --hard/i);
    expect(calls.some((c) => c[0] === "npm")).toBe(false);
  });

  it("fails when npm install fails (after a real change)", async () => {
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint: taken,
      runner: makeRunner({
        headSeq: ["a1", "b2"],
        fail: (cmd) => (cmd === "npm" ? "ENOSPC" : null),
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/npm install failed/i);
    expect(res.changed).toBe(true);
  });
});

describe("runSelfUpdate — the pre-update checkpoint", () => {
  it("is taken after the fetch and before the reset, labelled with both commits", async () => {
    const calls: string[][] = [];
    const checkpoint = vi.fn(async (): Promise<UpdateCheckpoint> => {
      calls.push(["checkpoint"]);
      return { status: "taken", id: "snap-1" };
    });
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint,
      runner: makeRunner({ headSeq: ["aaa111aaa111", "bbb222bbb222"], calls }),
    });
    expect(res.ok).toBe(true);
    expect(checkpoint).toHaveBeenCalledWith("aaa111aaa111", "bbb222bbb222");
    const at = (pred: (c: string[]) => boolean) => calls.findIndex(pred);
    const cp = at((c) => c[0] === "checkpoint");
    expect(at((c) => c[1] === "fetch")).toBeLessThan(cp);
    expect(cp).toBeLessThan(at((c) => c[1] === "reset"));
    expect(cp).toBeLessThan(at((c) => c[1] === "clean"));
    expect(res.checkpoint).toEqual({ status: "taken", id: "snap-1" });
  });

  it("refuses the update when it fails, and touches nothing", async () => {
    const calls: string[][] = [];
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint: async () => ({
        status: "failed",
        error: "Cannot read backup.encryption.passphraseFile /k: ENOENT",
      }),
      runner: makeRunner({ headSeq: ["aaa111aaa111", "bbb222bbb222"], calls }),
    });
    expect(res.ok).toBe(false);
    expect(res.checkpointRefused).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.error).toContain("ENOENT");
    expect(res.error).toContain("force");
    expect(calls.some((c) => c[1] === "reset")).toBe(false);
    expect(calls.some((c) => c[1] === "clean")).toBe(false);
    expect(calls.some((c) => c[0] === "npm")).toBe(false);
  });

  it("goes on without one when forced, and still reports the failure", async () => {
    const calls: string[][] = [];
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      force: true,
      checkpoint: async () => ({ status: "failed", error: "disk full" }),
      runner: makeRunner({ headSeq: ["aaa111aaa111", "bbb222bbb222"], calls }),
    });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.checkpointRefused).toBeUndefined();
    expect(res.checkpoint).toEqual({ status: "failed", error: "disk full" });
    expect(calls).toContainEqual(["git", "reset", "--hard", "origin/main"]);
  });

  it("goes on when the operator turned it off in config", async () => {
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint: async () => ({ status: "disabled" }),
      runner: makeRunner({ headSeq: ["aaa111aaa111", "bbb222bbb222"] }),
    });
    expect(res.ok).toBe(true);
    expect(res.checkpoint).toEqual({ status: "disabled" });
  });

  it("is not taken when the checkout is already at the remote commit", async () => {
    const checkpoint = vi.fn(taken);
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      checkpoint,
      runner: makeRunner({ headSeq: ["abc123abc123", "abc123abc123"] }),
    });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("refuses by default when this process has no backup subsystem", async () => {
    _resetBackupScheduler();
    const calls: string[][] = [];
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      entry: ENTRY,
      runner: makeRunner({ headSeq: ["aaa111aaa111", "bbb222bbb222"], calls }),
    });
    expect(res.checkpointRefused).toBe(true);
    expect(res.error).toContain("not running");
    expect(calls.some((c) => c[1] === "reset")).toBe(false);
  });
});

describe("wantsForce", () => {
  it("accepts force and --force, and nothing else", () => {
    expect(wantsForce("force")).toBe(true);
    expect(wantsForce(" --force ")).toBe(true);
    expect(wantsForce("FORCE")).toBe(true);
    expect(wantsForce("")).toBe(false);
    expect(wantsForce(undefined)).toBe(false);
    expect(wantsForce("forced")).toBe(false);
    expect(wantsForce("now")).toBe(false);
  });
});

describe("getRepoRoot", () => {
  it("finds a dir containing both .git and package.json", () => {
    const base = mkdtempSync(join(tmpdir(), "talon-repo-"));
    try {
      mkdirSync(join(base, ".git"));
      writeFileSync(join(base, "package.json"), "{}");
      const nested = join(base, "src", "core", "update");
      mkdirSync(nested, { recursive: true });
      expect(getRepoRoot(nested)).toBe(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("returns null when there is no git checkout above", () => {
    const base = mkdtempSync(join(tmpdir(), "talon-nogit-"));
    try {
      const nested = join(base, "a", "b");
      mkdirSync(nested, { recursive: true });
      // No .git anywhere up to filesystem root from this temp dir.
      const found = getRepoRoot(nested);
      // Either null, or (paranoia) not inside our temp tree.
      expect(found === null || !found.startsWith(base)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
