/**
 * `cloneShallow` hardening (#1049): option-looking URLs never reach git,
 * `--` ends option parsing, and the cloned commit is reported so installs
 * can record exactly what they installed. `cloneAtCommit` installs the
 * commit the user asked for and verifies HEAD is that commit.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneAtCommit,
  cloneShallow,
  cloneSource,
  resolveSource,
  withCommit,
  writeInstallRecord,
} from "../cli/install-sources.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

/** A repo with two commits of SKILL.md; returns both shas (old, new). */
function twoCommitRepo(): { repo: string; first: string; second: string } {
  const repo = mkdtempSync(join(tmpdir(), "clone-src-"));
  git(repo, "init", "-q");
  writeFileSync(join(repo, "SKILL.md"), "# first\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  const first = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "SKILL.md"), "# second\n");
  git(repo, "commit", "-q", "-am", "second");
  const second = git(repo, "rev-parse", "HEAD");
  return { repo, first, second };
}

describe("cloneShallow", () => {
  it("refuses a URL that starts with a dash before running git", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "clone-dash-")), "pwned");
    const result = cloneShallow(`--upload-pack=touch ${marker}`);
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/starts with "-"/),
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("reports the commit it cloned", () => {
    const repo = mkdtempSync(join(tmpdir(), "clone-src-"));
    git(repo, "init", "-q");
    writeFileSync(join(repo, "SKILL.md"), "# skill\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const head = git(repo, "rev-parse", "HEAD");

    const result = cloneShallow(`file://${repo}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      expect(result.commit).toBe(head);
      expect(existsSync(join(result.dir, "SKILL.md"))).toBe(true);
    } finally {
      result.cleanup();
    }
    expect(existsSync(result.dir)).toBe(false);
  });
});

describe("cloneAtCommit", () => {
  it("checks out the requested commit, not the default branch", () => {
    const { repo, first } = twoCommitRepo();
    const result = cloneAtCommit(`file://${repo}`, first);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      expect(result.commit).toBe(first);
      expect(readFileSync(join(result.dir, "SKILL.md"), "utf8")).toBe(
        "# first\n",
      );
    } finally {
      result.cleanup();
    }
  });

  it("accepts an abbreviated commit and reports the full one", () => {
    const { repo, first } = twoCommitRepo();
    const result = cloneAtCommit(`file://${repo}`, first.slice(0, 7));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      expect(result.commit).toBe(first);
    } finally {
      result.cleanup();
    }
  });

  it("fetches a commit no branch reaches, by its full id", () => {
    const { repo, first, second } = twoCommitRepo();
    // Park `second` on a non-branch ref (like a PR head), rewind the branch.
    git(repo, "update-ref", "refs/pull/1/head", second);
    git(repo, "reset", "-q", "--hard", first);
    git(repo, "config", "uploadpack.allowAnySHA1InWant", "true");
    const result = cloneAtCommit(`file://${repo}`, second);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      expect(result.commit).toBe(second);
      expect(readFileSync(join(result.dir, "SKILL.md"), "utf8")).toBe(
        "# second\n",
      );
    } finally {
      result.cleanup();
    }
  });

  it("fails cleanly on a commit the repo does not have", () => {
    const { repo } = twoCommitRepo();
    const result = cloneAtCommit(`file://${repo}`, "deadbeef".repeat(5));
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/Commit deadbeef.* not found/),
    });
  });

  it("refuses a URL that starts with a dash before running git", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "clone-dash-")), "pwned");
    const result = cloneAtCommit(`--upload-pack=touch ${marker}`, "abc1234");
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/starts with "-"/),
    });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("cloneSource", () => {
  it("pins a url#<sha> source and follows the default branch otherwise", () => {
    const { repo, first, second } = twoCommitRepo();
    // A `.git` URL is what resolveSource recognises as a repository.
    const bare = `${repo}-bare.git`;
    git(tmpdir(), "clone", "-q", "--bare", repo, bare);
    const pinned = resolveSource(`file://${bare}#${first}`);
    const latest = resolveSource(`file://${bare}`);
    if (pinned.kind !== "git" || latest.kind !== "git") {
      throw new Error("expected git sources");
    }
    const a = cloneSource(pinned);
    const b = cloneSource(latest);
    try {
      expect(a.ok && a.commit).toBe(first);
      expect(b.ok && b.commit).toBe(second);
    } finally {
      if (a.ok) a.cleanup();
      if (b.ok) b.cleanup();
    }
  });
});

describe("withCommit", () => {
  const git = resolveSource("https://github.com/o/r.git");

  it("adds a --commit to a git source, lowercased", () => {
    expect(withCommit(git, "ABCDEF1")).toEqual({
      ok: true,
      source: { ...git, commit: "abcdef1" },
    });
    expect(withCommit(git, undefined)).toEqual({ ok: true, source: git });
  });

  it("rejects non-hex ids, non-git sources and conflicting pins", () => {
    expect(withCommit(git, "main")).toMatchObject({ ok: false });
    expect(withCommit(git, "--upload-pack=x")).toMatchObject({ ok: false });
    expect(
      withCommit({ kind: "other", raw: "some-package" }, "abcdef1"),
    ).toEqual({ ok: false, error: "--commit only applies to git sources" });
    const pinned = resolveSource("https://github.com/o/r.git#abcdef1");
    expect(withCommit(pinned, "1234567")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/conflicts/),
    });
    expect(withCommit(pinned, "ABCDEF1")).toMatchObject({ ok: true });
  });
});

describe("writeInstallRecord", () => {
  it("records source, subpath and commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-record-"));
    writeInstallRecord(dir, {
      source: "https://github.com/o/r.git",
      subpath: "plugins/x",
      commit: "a".repeat(40),
      pinned: true,
    });
    const record = JSON.parse(
      readFileSync(join(dir, ".talon-install.json"), "utf8"),
    );
    expect(record).toMatchObject({
      source: "https://github.com/o/r.git",
      subpath: "plugins/x",
      commit: "a".repeat(40),
      pinned: true,
    });
    expect(typeof record.installedAt).toBe("string");
  });
});
