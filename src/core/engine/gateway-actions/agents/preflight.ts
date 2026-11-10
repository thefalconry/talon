/**
 * `run_preflight` — run a checkout's pre-flight lane and return its verdict.
 *
 * The pre-flight lane (`scripts/preflight.sh`, `npm run preflight`) is the
 * light CI suite an agent runs before `git push`, so GitHub confirms a change
 * instead of being the first compiler it meets. This action runs it in the
 * caller's checkout on the daemon host and answers with the one-line verdict,
 * the per-step table and the tail of every failing step's log — enough to
 * fix the change without re-running anything by hand.
 *
 * Available from a chat and from inside a sub-agent (it is in
 * `agentContextActions`), because agents are the ones opening PRs.
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { dirs } from "../../../../util/paths.js";
import { resolvePathParam } from "../native/params.js";
import type { ActionResult } from "../../../types.js";
import type { SharedActionHandlers } from "../types.js";

/** Relative path of the lane inside a checkout. */
const SCRIPT = join("scripts", "preflight.sh");
/** Hard cap on one run. The lane targets ≤5 min; this is the backstop. */
const PREFLIGHT_TIMEOUT_MS = 600_000;
/** Grace between SIGTERM and SIGKILL of the run's process group. */
const KILL_GRACE_MS = 5_000;
/** Lines of each failing step's log to hand back. */
const FAIL_TAIL_LINES = 30;
/** How to give a checkout dependencies without a fresh ~1.2 GB `npm ci`. */
const LINK_HINT =
  "No node_modules in this checkout: run `node scripts/worktree.mjs link` " +
  "in it (hardlinks a shared install, ~0 extra disk), then retry.";

interface PreflightStep {
  readonly name: string;
  readonly status: "pass" | "fail" | "skipped";
  readonly ms: number;
  readonly note?: string;
}

interface PreflightSummary {
  readonly verdict: "green" | "red";
  readonly ok: boolean;
  readonly base: string;
  readonly totalMs: number;
  readonly failed: readonly string[];
  readonly steps: readonly PreflightStep[];
}

interface RunOutcome {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly output: string;
}

/** The checkout root for `dir`: its git toplevel, else `dir` itself. */
function repoRoot(dir: string): Promise<string> {
  return new Promise((resolveRoot) => {
    const child = spawn("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", () => resolveRoot(dir));
    child.on("close", (code) =>
      resolveRoot(code === 0 && out.trim() ? out.trim() : dir),
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Run the lane in its own process group so a timeout takes every child. */
function runLane(root: string, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolveRun) => {
    const child = spawn("bash", [SCRIPT], {
      cwd: root,
      detached: process.platform !== "win32",
      env: { ...process.env, PREFLIGHT_QUIET: "1", CI: "1" },
    });
    let output = "";
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-8_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, signal);
        } else child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: null, timedOut, output: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, timedOut, output });
    });
  });
}

async function readSummary(root: string): Promise<PreflightSummary | null> {
  try {
    const raw = await readFile(join(root, ".preflight", "last.json"), "utf8");
    return JSON.parse(raw) as PreflightSummary;
  } catch {
    return null;
  }
}

async function logTail(root: string, step: string): Promise<string> {
  try {
    const raw = await readFile(join(root, ".preflight", `${step}.log`), "utf8");
    return raw.trimEnd().split("\n").slice(-FAIL_TAIL_LINES).join("\n");
  } catch {
    return "(no log)";
  }
}

function stepLine(step: PreflightStep): string {
  const mark =
    step.status === "pass" ? "✓" : step.status === "fail" ? "✗" : "·";
  const time =
    step.status === "skipped" ? "" : ` (${Math.round(step.ms / 1000)}s)`;
  const note = step.status === "skipped" && step.note ? ` — ${step.note}` : "";
  return `${mark} ${step.name}${time}${note}`;
}

/** Render the summary a model can act on: verdict, table, failing tails. */
async function renderPreflight(
  root: string,
  summary: PreflightSummary,
): Promise<string> {
  const verdict = summary.ok
    ? `Pre-flight GREEN in ${Math.round(summary.totalMs / 1000)}s — safe to push.`
    : `Pre-flight RED in ${Math.round(summary.totalMs / 1000)}s — failed: ` +
      `${summary.failed.join(", ")}. Fix before pushing, or explain in the PR body.`;
  const parts = [
    verdict,
    `Base: ${summary.base}. Summary: ${join(root, ".preflight", "last.json")}`,
    "",
    ...summary.steps.map(stepLine),
  ];
  for (const name of summary.failed) {
    parts.push("", `── ${name} (last ${FAIL_TAIL_LINES} lines) ──`);
    parts.push(await logTail(root, name));
  }
  return parts.join("\n");
}

/** Run the lane in `dir`'s checkout and describe the result. */
async function runPreflight(
  dir: string,
  timeoutMs: number = PREFLIGHT_TIMEOUT_MS,
): Promise<ActionResult> {
  try {
    if (!(await stat(dir)).isDirectory()) {
      return { ok: false, error: `cwd is not a directory: ${dir}` };
    }
  } catch {
    return { ok: false, error: `Working directory does not exist: ${dir}` };
  }
  const root = await repoRoot(dir);
  if (!(await isFile(join(root, SCRIPT)))) {
    return {
      ok: false,
      error:
        `No ${SCRIPT} in ${root}. Pass cwd = the root of a talon checkout ` +
        `(a branch that has the pre-flight lane).`,
    };
  }
  const run = await runLane(root, timeoutMs);
  if (run.timedOut) {
    return {
      ok: false,
      error:
        `Pre-flight did not finish within ${Math.round(timeoutMs / 1000)}s ` +
        `and was killed. Tail of its output:\n${run.output.slice(-2_000)}`,
    };
  }
  const summary = await readSummary(root);
  if (!summary) {
    const hint = (await exists(join(root, "node_modules")))
      ? ""
      : `\n${LINK_HINT}`;
    return {
      ok: false,
      error:
        `Pre-flight exited ${run.code} without writing .preflight/last.json. ` +
        `Output:\n${run.output.slice(-2_000)}${hint}`,
    };
  }
  // A red lane is a successful tool call with a red verdict — the model is
  // meant to read it and act, not treat it as the tool breaking.
  return { ok: true, text: await renderPreflight(root, summary) };
}

export const agentPreflightHandlers: SharedActionHandlers = {
  run_preflight: (body) => {
    const raw =
      typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : "";
    const dir = raw ? resolvePathParam(raw, undefined) : dirs.workspace;
    return runPreflight(dir);
  },
};
