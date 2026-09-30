/**
 * Self-update for git-checkout deployments (the `/update` command).
 *
 * Only meaningful when Talon runs from a git clone in a developer
 * build: it pulls the latest code from a configurable remote/branch,
 * reinstalls dependencies, runs any extra setup commands, and lets
 * the caller respawn the process. Packaged/binary builds have no
 * source tree on disk, so {@link getRepoRoot} returns `null` and the
 * `/update` command is never registered.
 *
 * The install is verified before anyone hands off to it. `npm install`
 * rewrites node_modules underneath the still-running process, so a bad
 * dependency resolution does not surface until the *successor* imports
 * the tree — detached, with its output going nowhere, at the one moment
 * the daemon has no one left to report to. On 2026-09-18 that cost a
 * 45-minute outage. The last step of an update therefore runs the new
 * tree in a child with {@link BOOT_SMOKE_FLAG}: it resolves the daemon's
 * entire import graph and exits without booting. If it fails, the update
 * fails — the caller reports it to the chat and the current process, the
 * one that still works, keeps running.
 *
 * The update force-syncs the checkout to the remote branch with
 * `git reset --hard` (plus `git clean -fd`), discarding any local edits
 * or diverged commits. A bot host is meant to mirror the remote exactly,
 * so "become whatever upstream says" is the right model — and it means a
 * stray local change (a touched lockfile, an experiment left in the tree)
 * can never leave the deployment un-updatable, which is what the old
 * `pull --ff-only` did (it aborts on any dirty/diverged tree). `.gitignore`
 * is respected (no `-x`), so node_modules, secrets and local config survive.
 *
 * Before anything in the checkout moves, a pinned pre-update checkpoint is
 * taken. If it fails, the update is refused. An update with no way back is
 * when data goes missing, so the operator must say `force` to go on
 * without one. Opting out in config (`backup.checkpointBeforeUpdate:
 * false`) is the only way to skip it without being asked.
 */

import { execFile } from "node:child_process";
import {
  checkpointBeforeUpdate,
  type UpdateCheckpoint,
} from "../backup/index.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOT_SMOKE_FLAG,
  BOOT_SMOKE_OK,
  successorCommand,
} from "../daemon/respawn.js";

/** Tuning knobs for {@link runSelfUpdate}. */
export interface UpdateOptions {
  /** Git remote to pull from (default `origin`). */
  remote?: string;
  /** Branch to pull (default `main`). */
  branch?: string;
  /**
   * Extra shell commands run in the repo root after `npm install`
   * and before restart (e.g. a build step). Each runs via `sh -c`.
   */
  setup?: readonly string[];
  /** Override the repo root (tests). Defaults to {@link getRepoRoot}. */
  repoRoot?: string;
  /**
   * The command that re-runs this process, used for the post-install
   * import check. Defaults to our own argv (tests override it).
   */
  entry?: { cmd: string; args: readonly string[] };
  /** Injectable command runner (tests). */
  runner?: CommandRunner;
  /**
   * Go on even when the pre-update checkpoint fails (`/update force`).
   * The result still says the checkpoint failed.
   */
  force?: boolean;
  /** Injectable pre-update checkpoint (tests). */
  checkpoint?: (from: string, to: string) => Promise<UpdateCheckpoint>;
}

/** One executed step in an update run. */
interface UpdateStep {
  label: string;
  ok: boolean;
  output: string;
}

/** Outcome of an update run. */
export interface UpdateResult {
  ok: boolean;
  repoRoot: string | null;
  steps: UpdateStep[];
  /** Commit before the pull (short SHA), if known. */
  before?: string;
  /** Commit after the pull (short SHA), if known. */
  after?: string;
  /** True when the pull moved HEAD — i.e. a restart is warranted. */
  changed: boolean;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
  /** The pre-update checkpoint, when the update got far enough to take one. */
  checkpoint?: UpdateCheckpoint;
  /**
   * True when the update was refused because the checkpoint failed. Nothing
   * in the checkout was touched; `force` would have gone on.
   */
  checkpointRefused?: boolean;
}

export type CommandRunner = (
  cmd: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ ok: boolean; output: string }>;

const GIT_TIMEOUT_MS = 60_000;
/** A cold import of the whole daemon graph, on a busy host. */
const VERIFY_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 300_000;
const SETUP_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BUFFER = 16 * 1024 * 1024;

const defaultRunner: CommandRunner = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BUFFER },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        resolve({
          ok: !err,
          output: err && !output ? err.message : output,
        });
      },
    );
  });

/**
 * Walk up from this module's location looking for a directory that
 * is both a git checkout (`.git` present) and an npm package
 * (`package.json` present). Returns that directory, or `null` when
 * the process is not running from a source checkout (packaged binary,
 * global install, etc.).
 */
export function getRepoRoot(startDir?: string): string | null {
  let dir: string;
  try {
    dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(join(dir, ".git")) &&
      existsSync(join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function shortSha(sha: string): string {
  return sha.trim().slice(0, 12);
}

/**
 * Force-sync the checkout to the remote branch (`git reset --hard` +
 * `git clean -fd`), reinstall deps, run setup commands. Stops at the
 * first failing step and never restarts on its own — the caller decides
 * (typically: respawn only when `changed` is true).
 */
export async function runSelfUpdate(
  opts: UpdateOptions = {},
): Promise<UpdateResult> {
  const repoRoot = opts.repoRoot ?? getRepoRoot();
  const steps: UpdateStep[] = [];
  if (!repoRoot) {
    return {
      ok: false,
      repoRoot: null,
      steps,
      changed: false,
      error: "Not running from a git checkout — nothing to update.",
    };
  }

  const remote = opts.remote?.trim() || "origin";
  const branch = opts.branch?.trim() || "main";
  const run = opts.runner ?? defaultRunner;

  const record: Recorder = async (label, cmd, args, timeoutMs) => {
    const { ok, output } = await run(cmd, args, repoRoot, timeoutMs);
    const step: UpdateStep = { label, ok, output };
    steps.push(step);
    return step;
  };

  const fail = (error: string, before?: string): UpdateResult => ({
    ok: false,
    repoRoot,
    steps,
    before,
    changed: false,
    error,
  });

  // Snapshot current HEAD so we can tell whether the update moved it.
  const head = await record(
    "rev-parse HEAD",
    "git",
    ["rev-parse", "HEAD"],
    GIT_TIMEOUT_MS,
  );
  if (!head.ok) return fail(`Failed to read current commit: ${head.output}`);
  const before = shortSha(head.output);

  const fetch = await record(
    `fetch ${remote} ${branch}`,
    "git",
    ["fetch", remote, branch],
    GIT_TIMEOUT_MS,
  );
  if (!fetch.ok) return fail(`git fetch failed: ${fetch.output}`, before);

  // Where the update is going, read before the tree moves: the checkpoint
  // is labelled with it, and "already up to date" needs no checkpoint.
  const targetRef = `${remote}/${branch}`;
  const target = await record(
    `rev-parse ${targetRef}`,
    "git",
    ["rev-parse", targetRef],
    GIT_TIMEOUT_MS,
  );
  if (!target.ok) {
    return fail(`Failed to read ${targetRef}: ${target.output}`, before);
  }
  const upcoming = shortSha(target.output);

  // The safety net goes up before anything is destroyed: the reset and
  // clean below discard local state, and the new code may migrate data.
  let checkpoint: UpdateCheckpoint | undefined;
  if (upcoming !== before) {
    checkpoint = await (opts.checkpoint ?? checkpointBeforeUpdate)(
      before,
      upcoming,
    );
    steps.push({
      label: "pre-update checkpoint",
      ok: checkpoint.status !== "failed",
      output: describeCheckpoint(checkpoint),
    });
    if (checkpoint.status === "failed" && !opts.force) {
      return {
        ...fail(refusal(checkpoint.error), before),
        checkpoint,
        checkpointRefused: true,
      };
    }
  }

  // Force the checkout to exactly match the freshly-fetched remote
  // branch, discarding ANY local edits or diverged commits. The old
  // `pull --ff-only` aborted here whenever the tree was dirty, leaving the
  // deployment stuck; a bot host is meant to mirror the remote, so resetting
  // to it is both correct and reliable.
  const reset = await record(
    `reset --hard ${targetRef}`,
    "git",
    ["reset", "--hard", targetRef],
    GIT_TIMEOUT_MS,
  );
  if (!reset.ok) {
    return {
      ...fail(`git reset --hard ${targetRef} failed: ${reset.output}`, before),
      checkpoint,
    };
  }

  // Drop untracked files too so the tree is pristine and a future update
  // can't collide with a leftover untracked path. `.gitignore` is respected
  // (no `-x`), so node_modules / secrets / local config are preserved.
  // Best-effort: a clean failure must not abort an otherwise-good update.
  await record("clean -fd", "git", ["clean", "-fd"], GIT_TIMEOUT_MS);

  const headAfter = await record(
    "rev-parse HEAD (post-reset)",
    "git",
    ["rev-parse", "HEAD"],
    GIT_TIMEOUT_MS,
  );
  const after = headAfter.ok ? shortSha(headAfter.output) : before;
  const changed = after !== before;

  // Nothing moved — skip the expensive install/setup and tell the
  // caller no restart is needed.
  if (!changed) {
    return {
      ok: true,
      repoRoot,
      steps,
      before,
      after,
      changed: false,
      checkpoint,
    };
  }

  const error = await installAndVerify(record, opts, before, after);
  return {
    ok: !error,
    repoRoot,
    steps,
    before,
    after,
    changed: true,
    checkpoint,
    ...(error ? { error } : {}),
  };
}

type Recorder = (
  label: string,
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<UpdateStep>;

function refusal(error: string): string {
  return (
    `the pre-update checkpoint failed (${error}). ` +
    `Nothing was changed. Fix the backup problem, or run the update ` +
    `with "force" to go on without a checkpoint.`
  );
}

/**
 * Reinstall, run setup, and prove the new tree imports. Returns the
 * failure reason, or null when the tree is ready to restart into.
 */
async function installAndVerify(
  record: Recorder,
  opts: UpdateOptions,
  before: string,
  after: string,
): Promise<string | null> {
  const install = await record(
    "npm install",
    "npm",
    ["install"],
    INSTALL_TIMEOUT_MS,
  );
  if (!install.ok) return `npm install failed: ${install.output}`;

  for (const cmd of opts.setup ?? []) {
    const trimmed = cmd.trim();
    if (!trimmed) continue;
    const setup = await record(
      `setup: ${trimmed}`,
      "sh",
      ["-c", trimmed],
      SETUP_TIMEOUT_MS,
    );
    if (!setup.ok) {
      return `setup command failed (${trimmed}): ${setup.output}`;
    }
  }

  const entry = opts.entry ?? successorCommand();
  const verify = await record(
    "verify import",
    entry.cmd,
    [...entry.args, BOOT_SMOKE_FLAG],
    VERIFY_TIMEOUT_MS,
  );
  if (!verify.ok || !verify.output.includes(BOOT_SMOKE_OK)) {
    return (
      `the updated tree does not import — not restarting into it. ` +
      `Still running ${before}; the checkout is at ${after}.`
    );
  }
  return null;
}

/** One line for the step log and the chat reply. */
export function describeCheckpoint(checkpoint: UpdateCheckpoint): string {
  switch (checkpoint.status) {
    case "taken":
      return `checkpoint ${checkpoint.id} taken`;
    case "disabled":
      return "no checkpoint (backup.checkpointBeforeUpdate is off)";
    case "failed":
      return `checkpoint failed: ${checkpoint.error}`;
  }
}

/**
 * Whether the arguments to `/update` ask to go on without a checkpoint.
 * `force` and `--force` both work, so the chat command and a CLI habit
 * read the same.
 */
export function wantsForce(args: string | undefined | null): boolean {
  return (args ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .some((token) => token === "force" || token === "--force");
}
