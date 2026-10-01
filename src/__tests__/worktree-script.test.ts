/**
 * scripts/worktree.mjs — worktrees with hardlinked, shared node_modules.
 * Unit tests for the store key and prune plan, then the real CLI against a
 * throwaway repo: links share inodes with the store, the store never shares
 * them with the reference checkout, and nothing writes through to either.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../../scripts/worktree.mjs");

interface StoreEntry {
  hash: string;
  lastUsedMs: number;
}
interface WorktreeModule {
  lockHash(
    lock: string,
    env?: { nodeMajor?: string; platform?: string; arch?: string },
  ): string;
  planPrune(
    entries: StoreEntry[],
    inUse: Set<string>,
    now: number,
    maxAgeMs: number,
  ): string[];
  MUTABLE_DIRS: string[];
}

const mod = (await import(SCRIPT)) as WorktreeModule;
const ENV = { nodeMajor: "24", platform: "linux", arch: "x64" };
const DAY = 86_400_000;

describe("lockHash", () => {
  it("is a stable 16-hex key", () => {
    const a = mod.lockHash('{"lockfileVersion":3}', ENV);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(mod.lockHash('{"lockfileVersion":3}', ENV)).toBe(a);
  });

  it("changes with the lockfile, platform, arch and node major", () => {
    const base = mod.lockHash("lock", ENV);
    expect(mod.lockHash("lock2", ENV)).not.toBe(base);
    expect(mod.lockHash("lock", { ...ENV, platform: "darwin" })).not.toBe(base);
    expect(mod.lockHash("lock", { ...ENV, arch: "arm64" })).not.toBe(base);
    expect(mod.lockHash("lock", { ...ENV, nodeMajor: "26" })).not.toBe(base);
  });
});

describe("planPrune", () => {
  const now = 100 * DAY;
  const entries = [
    { hash: "old-unused", lastUsedMs: now - 10 * DAY },
    { hash: "old-in-use", lastUsedMs: now - 10 * DAY },
    { hash: "fresh-unused", lastUsedMs: now - DAY },
  ];

  it("drops only unused entries past the age limit", () => {
    expect(
      mod.planPrune(entries, new Set(["old-in-use"]), now, 3 * DAY),
    ).toEqual(["old-unused"]);
  });

  it("drops every unused entry at age 0, never one in use", () => {
    expect(mod.planPrune(entries, new Set(["old-in-use"]), now, 0)).toEqual([
      "old-unused",
      "fresh-unused",
    ]);
  });
});

describe("mutable dirs", () => {
  it("keeps tool caches out of the shared store", () => {
    expect(mod.MUTABLE_DIRS).toEqual(
      expect.arrayContaining([".cache", ".vite"]),
    );
  });
});

describe.skipIf(process.platform !== "linux")("worktree.mjs CLI", () => {
  let root: string;
  let repo: string;
  let ref: string;
  let store: string;
  let env: NodeJS.ProcessEnv;
  const LOCK = JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    packages: { "": { name: "fixture" } },
  });

  const cli = (args: string[], cwd = repo): string =>
    execFileSync("node", [SCRIPT, ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const git = (args: string[], cwd = repo): string =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "talon-wt-"));
    repo = join(root, "repo");
    ref = join(root, "reference");
    store = join(root, "store");
    env = {
      ...process.env,
      TALON_NM_STORE: store,
      TALON_NM_REFERENCE: ref,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    mkdirSync(repo);
    writeFileSync(join(repo, "package.json"), '{"name":"fixture"}');
    writeFileSync(join(repo, "package-lock.json"), LOCK);
    git(["init", "-q", "-b", "main"]);
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);

    // A reference checkout with an installed tree and some tool caches.
    mkdirSync(join(ref, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(ref, "node_modules", ".vite"));
    writeFileSync(join(ref, "package-lock.json"), LOCK);
    writeFileSync(join(ref, "node_modules", ".package-lock.json"), LOCK);
    writeFileSync(join(ref, "node_modules", "dep", "index.js"), "ok\n");
    writeFileSync(join(ref, "node_modules", ".vite", "results.json"), "{}");
  });

  afterAll(() => {
    execFileSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  });

  it("links a new worktree's node_modules to the store, not the reference", () => {
    const wt = join(root, "wt");
    cli(["add", wt, "feat/x", "--base", "main"]);
    const hash = cli(["hash", join(repo, "package-lock.json")]).trim();
    const linked = statSync(join(wt, "node_modules", "dep", "index.js"));
    const stored = statSync(
      join(store, hash, "node_modules", "dep", "index.js"),
    );
    const refFile = statSync(join(ref, "node_modules", "dep", "index.js"));

    expect(linked.ino).toBe(stored.ino);
    expect(linked.nlink).toBe(2);
    expect(refFile.ino).not.toBe(stored.ino);
    expect(refFile.nlink).toBe(1);
    // Read-only, so an in-place write cannot reach the store.
    expect(stored.mode & 0o222).toBe(0);
    // Caches are not shared; npm's hidden lockfile is a private copy.
    expect(existsSync(join(wt, "node_modules", ".vite"))).toBe(false);
    expect(statSync(join(wt, "node_modules", ".package-lock.json")).nlink).toBe(
      1,
    );
    expect(git(["branch", "--show-current"], wt).trim()).toBe("feat/x");
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses in-place writes and leaves store and reference intact",
    () => {
      const wt = join(root, "wt");
      expect(() =>
        writeFileSync(join(wt, "node_modules", "dep", "index.js"), "bad"),
      ).toThrow(/EACCES/);
      const hash = cli(["hash", join(repo, "package-lock.json")]).trim();
      expect(
        readFileSync(
          join(store, hash, "node_modules", "dep", "index.js"),
          "utf8",
        ),
      ).toBe("ok\n");
      expect(
        readFileSync(join(ref, "node_modules", "dep", "index.js"), "utf8"),
      ).toBe("ok\n");
    },
  );

  it("relinks with --force without making the store writable", () => {
    const wt = join(root, "wt");
    cli(["link", wt, "--force"]);
    const hash = cli(["hash", join(repo, "package-lock.json")]).trim();
    const stored = statSync(
      join(store, hash, "node_modules", "dep", "index.js"),
    );
    expect(stored.mode & 0o222).toBe(0);
  });

  it("keeps an in-use entry on prune and drops it once the worktree is gone", () => {
    const wt = join(root, "wt");
    const hash = cli(["hash", join(repo, "package-lock.json")]).trim();
    cli(["prune", "--max-age-days", "0"]);
    expect(existsSync(join(store, hash))).toBe(true);
    cli(["remove", wt, "--max-age-days", "0"]);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(store, hash))).toBe(false);
    expect(existsSync(join(ref, "node_modules", "dep", "index.js"))).toBe(true);
  });
});
