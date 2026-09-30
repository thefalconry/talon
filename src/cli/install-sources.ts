/**
 * Install-source resolution shared by `talon plugin install` and
 * `talon skill install`.
 *
 * One grammar for both commands, checked in order:
 *
 *   1. an existing local path                → { kind: "local" }
 *   2. a git URL (scheme, `git@`, or `.git`) → { kind: "git" }
 *   3. `owner/repo[/subpath]` shorthand      → { kind: "git" } on github.com
 *   4. anything else                         → { kind: "other" } — the caller
 *      decides (plugins treat it as an npm spec, skills reject it)
 *
 * A git source may name a commit: `<source>#<sha>` (7-64 hex digits), or
 * `--commit <sha>` on the command line (`withCommit`).
 *
 * Without a commit, cloning uses `--depth=1` (installs never need history).
 * With one, it clones with `--filter=blob:none` (history, but only the
 * blobs of the commit it checks out), checks the commit out and verifies
 * HEAD is that commit. Either way the options end with `--` so a URL can
 * never be read as a git flag, a URL starting with "-" is refused before
 * git runs, and the commit it got is reported so the install can record
 * it. It spawns `git`/`npm` via cross-spawn, which resolves the
 * `.cmd`/`.exe` shims on Windows — never assume a POSIX shell here.
 */

import crossSpawn from "cross-spawn";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type GitSource = {
  kind: "git";
  url: string;
  subpath?: string;
  /** Requested commit (lowercase hex, 7-64 digits); unset = default branch. */
  commit?: string;
};

export type ResolvedSource =
  { kind: "local"; dir: string } | GitSource | { kind: "other"; raw: string };

const GIT_URL_RE = /^(https?|git|ssh):\/\//;
/** `owner/repo` or `owner/repo/sub/path` — never an npm scope (`@…`). */
const GITHUB_SHORTHAND_RE =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[^\s/]+)*)$/;
/** An abbreviated or full commit id (SHA-1 or SHA-256). */
const COMMIT_RE = /^[0-9a-f]{7,64}$/;
/** `<source>#<commit>` — only a hex fragment is a pin. */
const COMMIT_FRAGMENT_RE = /^(.+)#([0-9a-fA-F]{7,64})$/;

function gitSource(spec: string): GitSource | undefined {
  if (
    GIT_URL_RE.test(spec) ||
    spec.startsWith("git@") ||
    spec.endsWith(".git")
  ) {
    return { kind: "git", url: spec };
  }
  if (spec.startsWith("@")) return undefined;
  const match = GITHUB_SHORTHAND_RE.exec(spec);
  if (!match) return undefined;
  const [, owner, repo, rest] = match;
  return {
    kind: "git",
    url: `https://github.com/${owner}/${repo}.git`,
    ...(rest ? { subpath: rest.slice(1) } : {}),
  };
}

export function resolveSource(raw: string): ResolvedSource {
  const trimmed = raw.trim();
  if (existsSync(resolve(trimmed))) {
    return { kind: "local", dir: resolve(trimmed) };
  }
  const pinned = COMMIT_FRAGMENT_RE.exec(trimmed);
  if (pinned) {
    const git = gitSource(pinned[1]!);
    if (git) return { ...git, commit: pinned[2]!.toLowerCase() };
  }
  return gitSource(trimmed) ?? { kind: "other", raw: trimmed };
}

/**
 * Apply a `--commit <sha>` flag to a resolved source: only git sources
 * take one, and it must agree with a `#<sha>` already in the source.
 */
export function withCommit(
  source: ResolvedSource,
  commit: string | undefined,
): { ok: true; source: ResolvedSource } | { ok: false; error: string } {
  if (commit === undefined) return { ok: true, source };
  const sha = commit.trim().toLowerCase();
  if (!COMMIT_RE.test(sha)) {
    return {
      ok: false,
      error: `"${commit}" is not a commit id (7-64 hex digits)`,
    };
  }
  if (source.kind !== "git") {
    return { ok: false, error: "--commit only applies to git sources" };
  }
  if (source.commit !== undefined && source.commit !== sha) {
    return {
      ok: false,
      error: `--commit ${sha} conflicts with #${source.commit} in the source`,
    };
  }
  return { ok: true, source: { ...source, commit: sha } };
}

export type CommandOutcome = { ok: true } | { ok: false; error: string };

/**
 * Run a tool from PATH synchronously. `inherit` streams output to the
 * terminal (npm installs); otherwise stderr is captured for the error.
 */
export function runTool(
  tool: string,
  args: string[],
  options: { cwd?: string; inherit?: boolean } = {},
): CommandOutcome {
  const result = crossSpawn.sync(tool, args, {
    cwd: options.cwd,
    stdio: options.inherit ? "inherit" : ["ignore", "ignore", "pipe"],
  });
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      ok: false,
      error: missing
        ? `${tool} is not installed or not on PATH`
        : result.error.message,
    };
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    return {
      ok: false,
      error: stderr || `${tool} ${args[0]} exited with ${result.status}`,
    };
  }
  return { ok: true };
}

export type CloneOutcome =
  | { ok: true; dir: string; commit?: string; cleanup: () => void }
  | { ok: false; error: string };

/** The checked-out commit of a clone, when git can tell us. */
function headCommit(dir: string): string | undefined {
  const result = crossSpawn.sync("git", ["-C", dir, "rev-parse", "HEAD"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const sha = result.status === 0 ? result.stdout?.toString().trim() : "";
  return sha && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
}

/** Whether the clone already has `commit` (no network). */
function hasCommit(dir: string, commit: string): boolean {
  return (
    crossSpawn.sync(
      "git",
      ["-C", dir, "cat-file", "-e", `${commit}^{commit}`],
      {
        stdio: "ignore",
      },
    ).status === 0
  );
}

/**
 * `--` stops git's option parsing; refusing a leading dash too means a
 * hostile "URL" never even reaches git.
 */
function dashRefusal(url: string): CloneOutcome | undefined {
  return url.startsWith("-")
    ? { ok: false, error: `Refusing a git URL that starts with "-"` }
    : undefined;
}

/**
 * Check out bytes exactly as committed. Windows git defaults to
 * core.autocrlf=true, which rewrites LF to CRLF on checkout — a pinned
 * install would then differ from the commit it names, and CRLF frontmatter
 * fails to parse as a skill. `clone -c` writes this into the new repo's
 * config, so the later `checkout` honours it too.
 */
const EXACT_BYTES = ["-c", "core.autocrlf=false"];

function tempCloneDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "talon-install-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Shallow-clone into a fresh temp directory. Caller must run `cleanup`. */
export function cloneShallow(url: string): CloneOutcome {
  const refused = dashRefusal(url);
  if (refused) return refused;
  const { dir, cleanup } = tempCloneDir();
  const outcome = runTool("git", [
    "clone",
    ...EXACT_BYTES,
    "--depth=1",
    "--",
    url,
    dir,
  ]);
  if (!outcome.ok) {
    cleanup();
    return { ok: false, error: `Clone failed: ${outcome.error}` };
  }
  return { ok: true, dir, commit: headCommit(dir), cleanup };
}

/**
 * Clone and check out exactly `commit`, verifying HEAD is that commit.
 * Caller must run `cleanup`. The clone keeps history (a commit can be
 * anywhere in it) but fetches file contents only for the checked-out tree.
 */
export function cloneAtCommit(url: string, commit: string): CloneOutcome {
  const refused = dashRefusal(url);
  if (refused) return refused;
  const { dir, cleanup } = tempCloneDir();
  const fail = (error: string): CloneOutcome => {
    cleanup();
    return { ok: false, error };
  };
  const cloned = runTool("git", [
    "clone",
    ...EXACT_BYTES,
    "--filter=blob:none",
    "--no-checkout",
    "--",
    url,
    dir,
  ]);
  if (!cloned.ok) return fail(`Clone failed: ${cloned.error}`);
  if (!hasCommit(dir, commit) && commit.length >= 40) {
    // A commit no branch reaches (a PR head, say): ask for it by id.
    runTool("git", ["-C", dir, "fetch", "-q", "origin", commit]);
  }
  const checkout = runTool("git", [
    "-C",
    dir,
    "checkout",
    "-q",
    "--detach",
    commit,
    "--",
  ]);
  if (!checkout.ok) {
    return fail(`Commit ${commit} not found in ${url}: ${checkout.error}`);
  }
  const head = headCommit(dir);
  if (!head?.startsWith(commit)) {
    return fail(`Checked out ${head ?? "nothing"}, not commit ${commit}`);
  }
  return { ok: true, dir, commit: head, cleanup };
}

/** Clone a git source: at its requested commit, else the default branch. */
export function cloneSource(source: GitSource): CloneOutcome {
  return source.commit
    ? cloneAtCommit(source.url, source.commit)
    : cloneShallow(source.url);
}

/** The file a git-installed plugin keeps its provenance in. */
const INSTALL_RECORD = ".talon-install.json";

/**
 * Write where an install came from and exactly which commit it is.
 * `pinned` marks a commit the user asked for, rather than whatever the
 * default branch pointed at.
 */
export function writeInstallRecord(
  dir: string,
  record: {
    source: string;
    subpath?: string;
    commit?: string;
    pinned?: boolean;
  },
): void {
  writeFileSync(
    join(dir, INSTALL_RECORD),
    JSON.stringify(
      { ...record, installedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
}
