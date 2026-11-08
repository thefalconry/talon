/**
 * Antigravity subscription quota windows for `/usage`, `/status` and the
 * plan-aware router.
 *
 * `agy` has no account API, but its `/usage` slash command also runs
 * headlessly: `agy -p /usage --output-format text` prints one
 * tab-separated line per quota window and exits without a model call:
 *
 *   Gemini Models  Weekly Limit Remaining     60%   2026-09-26T17:40:26Z
 *   Gemini Models  Five Hour Limit Remaining  100%  2026-09-23T21:23:05Z
 *
 * Columns are the model group, the window, the percent REMAINING, and the
 * next reset (ISO-8601 UTC). Talon speaks percent used, so the figure is
 * flipped on the way in.
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
  "text",
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

function parseLine(line: string): PlanWindow | undefined {
  const [group, window, percent, reset] = columns(line);
  if (!group || !window || !percent) return undefined;
  const duration = windowLabel(window);
  const used = usedPercent(percent);
  if (!duration || used === undefined) return undefined;
  return {
    label: `${groupLabel(group)} · ${duration}`,
    percent: used,
    ...(reset && Number.isFinite(Date.parse(reset)) ? { resetsAt: reset } : {}),
  };
}

/**
 * Parse `agy /usage` text output. Malformed or unknown lines are skipped;
 * `undefined` when no line yields a window.
 */
export function parseAgyUsage(stdout: string): PlanUsage | undefined {
  const windows: PlanWindow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const window = parseLine(line);
    if (window) windows.push(window);
  }
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
