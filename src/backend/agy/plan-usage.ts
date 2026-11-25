/**
 * Antigravity subscription quota windows for `/usage`, `/status` and the
 * plan-aware router.
 *
 * `agy` has no account API, but its `/usage` slash command also runs
 * headlessly and exits without a model call. `--output-format json` gives
 * the report as data: quota groups, the models each group covers, and each
 * group's buckets with the fraction REMAINING and the next reset:
 *
 *   {"command": {"name": "usage", "data": {"groups": [{
 *     "name": "Gemini Models",
 *     "description": "Models within this group: Gemini 4 Neon, …",
 *     "buckets": [{"id": "gemini-weekly", "name": "Weekly Limit Remaining",
 *                  "window": "weekly", "remaining_fraction": 0.6,
 *                  "reset_time": "2026-09-26T17:40:26Z"}, …]}, …]}}}
 *
 * Each group becomes the scope of its windows: models share a group's
 * limits, and nothing else. A model can also carry a group of its own
 * (agy 1.4.4 reported "Gemini 4 Argon" apart from the Gemini group), so
 * one model's limit never reads as the whole backend's. The same report's
 * `response` field is the text form, one tab-separated line per window
 * (group, window, percent remaining, reset), which is parsed when the JSON
 * is not there. Talon speaks percent used, so figures are flipped on the
 * way in.
 *
 * A read is a subprocess spawn (~a second of Go start-up plus an account
 * round-trip), so it is cached for a minute, concurrent callers share one
 * spawn, and a failed read backs off before trying again. Everything
 * degrades to the last good value or `undefined` — never a throw, so
 * `/status` and the router fall through to the local-budget ledger.
 */

import { spawn } from "node:child_process";
import { logDebug, logWarn } from "../../util/log.js";
import { isMissingBinary } from "./models.js";
import type {
  PlanUsage,
  PlanWindow,
} from "../../core/agent-runtime/capabilities.js";
import { AGY_KILL_GRACE_MS } from "./constants.js";
import { agyBinary } from "./state.js";

/** argv for the headless quota report. */
const AGY_USAGE_ARGS: readonly string[] = [
  "-p",
  "/usage",
  "--output-format",
  "json",
];
const RUN_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 60_000;
/** After a failed read, how long to wait before spawning `agy` again. */
const FAILURE_BACKOFF_MS = 15_000;
/** The report is a handful of lines; anything past this is not it. */
const MAX_OUTPUT_BYTES = 64 * 1024;

// ── Parsing ─────────────────────────────────────────────────────────────────

const HOUR_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  eight: 8,
  twelve: 12,
};

/**
 * Short duration label for a window name, in the claude/codex vocabulary
 * (`5h`, `7d`). Unknown window kinds return undefined and are skipped
 * rather than rendered under a guessed name.
 */
function windowLabel(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (/\bweekly\b/.test(lower)) return "7d";
  if (/\bdaily\b/.test(lower)) return "1d";
  const hours = /\b(\d+|[a-z]+)[\s-]+hours?\b/.exec(lower);
  if (hours) {
    const raw = hours[1] as string;
    const n = /^\d+$/.test(raw) ? Number(raw) : HOUR_WORDS[raw];
    if (n && n > 0) return n % 24 === 0 ? `${n / 24}d` : `${n}h`;
  }
  return undefined;
}

/** `Gemini Models` → `Gemini`, `Claude and GPT models` → `Claude/GPT`. */
function groupLabel(name: string): string {
  const short = name
    .replace(/\s+models?$/i, "")
    .replace(/\s+and\s+/gi, "/")
    .trim();
  return short.length > 0 ? short : name.trim();
}

/** Percent remaining (`60%`, `60`, `12.5 %`) → percent used, 0-100. */
function usedPercent(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*%?$/.exec(raw.trim());
  if (!match) return undefined;
  const remaining = Number(match[1]);
  if (!Number.isFinite(remaining)) return undefined;
  return Math.max(0, Math.min(100, Math.round(100 - remaining)));
}

// oxlint-disable-next-line no-control-regex -- stripping terminal escapes
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function columns(line: string): string[] {
  const clean = line.replace(ANSI, "").trim();
  // Tabs are the real separator; runs of 2+ spaces cover a report that
  // was padded into aligned columns instead.
  const parts = clean.includes("\t")
    ? clean.split(/\t+/)
    : clean.split(/ {2,}/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** One window from a group, its duration and how much of it is used. */
function groupWindow(
  group: string,
  models: string[] | undefined,
  period: string,
  used: number,
  reset: string | undefined,
): PlanWindow {
  const scope = groupLabel(group);
  return {
    label: `${scope} · ${period}`,
    percent: used,
    period,
    scope,
    // Without the report's list, the group's own name is what a model id
    // is matched against ("Gemini 4 Argon", "Claude/GPT").
    models: models && models.length > 0 ? models : scope.split("/"),
    ...(used > 0 && hasReset(reset) ? { resetsAt: reset } : {}),
  };
}

/**
 * agy sends the epoch for a window nobody has used, and a window that is
 * untouched has no reset worth showing yet.
 */
function hasReset(reset: string | undefined): reset is string {
  const at = reset ? Date.parse(reset) : NaN;
  return Number.isFinite(at) && at > 0;
}

function parseLine(line: string): PlanWindow | undefined {
  const [group, window, percent, reset] = columns(line);
  if (!group || !window || !percent) return undefined;
  const duration = windowLabel(window);
  const used = usedPercent(percent);
  if (!duration || used === undefined) return undefined;
  return groupWindow(group, undefined, duration, used, reset);
}

/** The text form: one tab-separated line per window. */
function parseText(stdout: string): PlanWindow[] {
  const windows: PlanWindow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const window = parseLine(line);
    if (window) windows.push(window);
  }
  return windows;
}

interface RawBucket {
  name?: unknown;
  window?: unknown;
  remaining_fraction?: unknown;
  reset_time?: unknown;
}

interface RawGroup {
  name?: unknown;
  description?: unknown;
  buckets?: unknown;
}

const BUCKET_PERIODS: Record<string, string> = {
  weekly: "7d",
  daily: "1d",
  "5h": "5h",
};

/**
 * The models a group lists in its description, without the orchestrator
 * roles, which name a model already in the list.
 */
function groupModels(description: unknown): string[] | undefined {
  if (typeof description !== "string") return undefined;
  const list = /models within this group:\s*(.+)$/i.exec(description.trim());
  if (!list) return undefined;
  const models = (list[1] as string)
    .split(",")
    .map((m) => m.trim().replace(/\.$/, ""))
    .filter((m) => m.length > 0 && !/^orchestrator\b/i.test(m));
  return models.length > 0 ? models : undefined;
}

/** The JSON form's groups, or undefined when the output is not that report. */
function parseJson(stdout: string): PlanWindow[] | undefined {
  let report: unknown;
  try {
    report = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  const result = report as {
    response?: unknown;
    command?: { name?: unknown; data?: { groups?: unknown } };
  } | null;
  const groups = result?.command?.data?.groups;
  if (!Array.isArray(groups)) {
    // An agy that answers in JSON but carries no structured report.
    return typeof result?.response === "string"
      ? parseText(result.response)
      : undefined;
  }
  const windows: PlanWindow[] = [];
  for (const group of groups as RawGroup[]) {
    if (typeof group?.name !== "string" || !Array.isArray(group.buckets))
      continue;
    const models = groupModels(group.description);
    for (const bucket of group.buckets as RawBucket[]) {
      const period =
        (typeof bucket?.window === "string" &&
          BUCKET_PERIODS[bucket.window.toLowerCase()]) ||
        (typeof bucket?.name === "string"
          ? windowLabel(bucket.name)
          : undefined) ||
        (typeof bucket?.window === "string" ? bucket.window : undefined);
      const left = bucket?.remaining_fraction;
      if (!period || typeof left !== "number" || !Number.isFinite(left))
        continue;
      const used = Math.max(0, Math.min(100, Math.round((1 - left) * 100)));
      const reset =
        typeof bucket.reset_time === "string" ? bucket.reset_time : undefined;
      windows.push(groupWindow(group.name, models, period, used, reset));
    }
  }
  return windows;
}

/**
 * Parse `agy /usage` output, JSON or text. Malformed or unknown entries are
 * skipped; `undefined` when nothing yields a window.
 */
export function parseAgyUsage(stdout: string): PlanUsage | undefined {
  const windows = parseJson(stdout) ?? parseText(stdout);
  if (windows.length === 0) return undefined;
  return { windows, fetchedAt: Date.now() };
}

// ── Running ─────────────────────────────────────────────────────────────────

/**
 * Spawn `agy -p /usage` once and parse what it prints. Non-zero exit,
 * spawn error, timeout or unparseable output all resolve `undefined`.
 */
export function runAgyUsage(
  binary: string = agyBinary(),
  timeoutMs: number = RUN_TIMEOUT_MS,
): Promise<PlanUsage | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (value: PlanUsage | undefined, why?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (why) logWarn("agent", `agy usage: ${why}`);
      resolve(value);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(binary, [...AGY_USAGE_ARGS], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve(undefined);
      logWarn(
        "agent",
        `agy usage: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const timer = setTimeout(() => {
      finish(undefined, `timed out after ${timeoutMs}ms`);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
        }
      }, AGY_KILL_GRACE_MS).unref?.();
    }, timeoutMs);

    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-500);
    });
    proc.on("error", (err) => {
      // No `agy` installed: nothing to report, and nothing worth a warning.
      if (isMissingBinary(err)) {
        logDebug("agent", `agy usage skipped: ${err.message}`);
        finish(undefined);
        return;
      }
      finish(undefined, err.message);
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").pop() ?? "";
        finish(undefined, `exited ${code}${tail ? `: ${tail}` : ""}`);
        return;
      }
      const usage = parseAgyUsage(stdout);
      finish(usage, usage ? undefined : "no quota windows in output");
    });
  });
}

// ── Cache ───────────────────────────────────────────────────────────────────

let cache: { value: PlanUsage; fetchedAt: number } | undefined;
let lastFailureAt: number | undefined;
let inFlight: Promise<PlanUsage | undefined> | undefined;

/**
 * Plan windows, cached for a minute with concurrent callers sharing one
 * spawn. A failed refresh serves the last good value (its `fetchedAt`
 * lets renderers age it) and is not retried for {@link FAILURE_BACKOFF_MS},
 * so a busy router cannot turn a broken `agy` into a spawn storm.
 */
export async function getAgyPlanUsage(): Promise<PlanUsage | undefined> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  if (lastFailureAt !== undefined && now - lastFailureAt < FAILURE_BACKOFF_MS)
    return cache?.value;

  inFlight ??= runAgyUsage().finally(() => {
    inFlight = undefined;
  });
  const loaded = await inFlight;
  if (loaded) {
    cache = { value: loaded, fetchedAt: loaded.fetchedAt };
    lastFailureAt = undefined;
  } else {
    lastFailureAt = Date.now();
  }
  return loaded ?? cache?.value;
}

/** Drop the cached reading — backend cleanup and test isolation. */
export function resetAgyPlanUsage(): void {
  cache = undefined;
  lastFailureAt = undefined;
  inFlight = undefined;
}
