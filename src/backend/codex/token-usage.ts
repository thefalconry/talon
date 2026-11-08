/**
 * Codex per-call token-usage reader.
 *
 * The Codex SDK only surfaces `Usage` via `turn.completed`, and that value
 * is **cumulative across every API call inside the turn** — for a 20-call
 * agentic turn the `input_tokens` field can hit 2–3M while the actual
 * last-call prompt size (= current context fill) sits around 150k.
 *
 * The Codex CLI writes a richer event stream to its rollout JSONL at
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`. Each
 * `token_count` event there carries:
 *
 *   - `total_token_usage`     — same cumulative figure the SDK gives us
 *   - `last_token_usage`      — the LAST API call's prompt + output sizes
 *   - `model_context_window`  — the model's actual context window
 *
 * For Talon's `/status` context display we want the per-call view, not the
 * cumulative one. This module tails the rollout file after a turn completes
 * and returns the last `token_count.last_token_usage.input_tokens` (which
 * IS the current context fill), the model's `context_window`, and an
 * inferred API-call count from usable `token_count` usage blocks.
 *
 * Why parse a file instead of fixing the SDK: the SDK ships a single
 * `Usage` shape and the Codex team isn't going to break it for a
 * Talon-shaped use case. The rollout JSONL is documented, stable across
 * Codex versions we've seen, and cheap to read — last `token_count` event
 * is usually the last line of the file, so reverse-scan is O(1) in the
 * common case.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { userHome } from "../../util/fs-path.js";

export interface CodexLastTokenUsage {
  /** Last API call's prompt size = current context fill in tokens. */
  contextTokens: number;
  /** Model's actual context window in tokens, if Codex reported it. */
  contextWindow?: number;
}

/**
 * Cumulative token totals from `token_count.info.total_token_usage`.
 *
 * Cumulative across the ENTIRE rollout file — i.e. every API call of
 * every turn in the session, not just the current turn. Callers that
 * want per-turn usage must snapshot before the turn and diff after
 * (see the terminator-abort fallback in `handler.ts`).
 */
interface CodexTokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Subset of the rollout `token_count.rate_limits` payload Talon cares
 * about. The CLI writes this on every `token_count` event regardless of
 * whether anything is exhausted; we read the latest one to decide
 * whether a silent exit was caused by quota rather than oauth-incompat.
 *
 * Two shapes have been observed in the wild:
 *
 *   Healthy (codex tier, plan_type "plus"):
 *     {
 *       "limit_id": "codex",
 *       "primary": { "used_percent": 3, ... },
 *       "secondary": { "used_percent": 18, ... },
 *       "credits": null,
 *       "plan_type": "plus",
 *       "rate_limit_reached_type": null
 *     }
 *
 *   Exhausted (the silent-exit case on Ada's free ChatGPT OAuth):
 *     {
 *       "limit_id": "premium",
 *       "primary": null,
 *       "secondary": null,
 *       "credits": { "has_credits": false, "balance": "0", ... },
 *       "plan_type": null,
 *       "rate_limit_reached_type": null
 *     }
 *
 * The differentiator is `credits.has_credits === false`. `rate_limit_reached_type`
 * appears reserved for an explicit "you hit limit X" signal but has been
 * null in every sample we've captured — we read it for forward-compat
 * anyway.
 */
export interface CodexRateLimitsSnapshot {
  limitId?: string;
  planType?: string;
  hasCredits?: boolean;
  creditsBalance?: string;
  rateLimitReachedType?: string;
  primaryUsedPercent?: number;
  secondaryUsedPercent?: number;
}

/**
 * Combined snapshot returned from `readLastRolloutSnapshot()` — both the
 * last per-call usage AND the latest rate-limits payload from the same
 * rollout file. Either field may be `undefined` if the rollout didn't
 * carry that info (e.g. a turn that died before the first `token_count`).
 */
export interface CodexRolloutSnapshot {
  usage?: CodexLastTokenUsage;
  rateLimits?: CodexRateLimitsSnapshot;
  /** Inferred number of Codex model API calls represented in the rollout. */
  numApiCalls?: number;
  /**
   * Latest cumulative session-wide token totals found in the rollout.
   * Backfilled from an earlier `token_count` event when the newest one
   * carries `info: null` (the exhausted-account / preflight shape).
   */
  totals?: CodexTokenTotals;
}

/**
 * Resolve `$CODEX_HOME`, falling back to `~/.codex`. Mirrors how the
 * Codex CLI resolves its data directory.
 */
function codexHome(): string {
  return process.env.CODEX_HOME ?? join(userHome(), ".codex");
}

/**
 * Find the rollout JSONL for a given `thread_id` by walking the most-recent
 * date directories under `$CODEX_HOME/sessions/`. Rollouts are filed under
 * `YYYY/MM/DD/rollout-<iso>-<thread_id>.jsonl`. Returns `null` if no
 * matching file is found (e.g. first run, or thread predates the date
 * window we walk).
 */
async function findRolloutFile(threadId: string): Promise<string | null> {
  const sessionsRoot = join(codexHome(), "sessions");

  let years: string[];
  try {
    years = (await readdir(sessionsRoot)).filter((y) => /^\d{4}$/.test(y));
  } catch {
    return null;
  }
  years.sort().reverse();

  for (const y of years) {
    let months: string[];
    try {
      months = (await readdir(join(sessionsRoot, y))).filter((m) =>
        /^\d{2}$/.test(m),
      );
    } catch {
      continue;
    }
    months.sort().reverse();

    for (const m of months) {
      let days: string[];
      try {
        days = (await readdir(join(sessionsRoot, y, m))).filter((d) =>
          /^\d{2}$/.test(d),
        );
      } catch {
        continue;
      }
      days.sort().reverse();

      for (const d of days) {
        const dir = join(sessionsRoot, y, m, d);
        let files: string[];
        try {
          files = await readdir(dir);
        } catch {
          continue;
        }
        const match = files.find((f) => f.endsWith(`-${threadId}.jsonl`));
        if (match) return join(dir, match);
      }
    }
  }
  return null;
}

/**
 * Read the last `token_count` event from the rollout JSONL for `threadId`.
 *
 * Returns `null` if the file can't be located, can't be read, or contains
 * no `token_count` events with valid `info.last_token_usage`. Never
 * throws — all failure modes degrade silently to "no context info" so
 * the caller can fall back to whatever its old behaviour was.
 *
 * Walks backwards past malformed `token_count` events (e.g. ones with
 * `info: null` — the shape Codex writes when a turn dies before usage
 * is computed) to find the most recent event that DOES have a usable
 * `last_token_usage`. That's how the original implementation worked
 * before the rollout-snapshot refactor; keeping the contract identical
 * means `/status` context-fill display doesn't regress for users on
 * exhausted accounts.
 */
export async function readLastTokenCount(
  threadId: string,
): Promise<CodexLastTokenUsage | null> {
  const file = await findRolloutFile(threadId);
  if (!file) return null;

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = (obj as { payload?: { type?: string } })?.payload;
    if (payload?.type !== "token_count") continue;
    const snap = extractSnapshotFromTokenCountPayload(payload);
    if (snap.usage) return snap.usage;
    // Keep walking: this token_count event had `info: null` (or no
    // last_token_usage), which is what the exhausted-account shape
    // looks like. Earlier events in the same turn might still have
    // valid usage.
  }
  return null;
}

/**
 * Pull the latest `rate_limits` payload (and matching last usage block,
 * if present) from the rollout JSONL for `threadId`.
 *
 * Reverse-scans the file looking for the most recent `token_count`
 * event. The payload contains BOTH `info.last_token_usage` and
 * `rate_limits` together, so a single scan answers both questions and
 * also lets us infer how many model API calls happened in the turn.
 *
 * Returns `null` only when the file can't be found or no `token_count`
 * event exists in it. Returns `{ usage: undefined, rateLimits: {...} }`
 * when a usage-exhausted turn writes a `token_count` event with
 * `info: null` but populated rate_limits (the literal shape on Ada's
 * exhausted OAuth account, 2026-05-21).
 */
export async function readLastRolloutSnapshot(
  threadId: string,
): Promise<CodexRolloutSnapshot | null> {
  const file = await findRolloutFile(threadId);
  if (!file) return null;

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  // Reverse-scan: the latest token_count event is almost always the last
  // non-empty line, so this typically loops once or twice.
  const lines = raw.split("\n");
  let snapshot: CodexRolloutSnapshot | null = null;
  let totals: CodexTokenTotals | undefined;
  let numApiCalls = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = (obj as { payload?: { type?: string } })?.payload;
    if (payload?.type !== "token_count") continue;
    const extracted = extractSnapshotFromTokenCountPayload(payload);
    if (isApiCallTokenCount(extracted)) numApiCalls++;
    if (!totals) totals = extracted.totals;
    if (!snapshot) {
      snapshot = extracted;
    }
  }
  if (!snapshot) return null;
  snapshot.numApiCalls = numApiCalls;
  snapshot.totals = totals;
  return snapshot;
}

/**
 * Not every `token_count` line is a model call. Codex commonly writes a
 * healthy preflight/rate-limit token_count with `info: null`; counting it
 * would double the apparent calls for simple turns. A valid usage block is a
 * completed model call. An exhausted rate-limit block is a denied attempted
 * call, so count that too.
 */
function isApiCallTokenCount(snapshot: CodexRolloutSnapshot): boolean {
  return Boolean(
    snapshot.usage || classifyRateLimits(snapshot.rateLimits) === "exhausted",
  );
}

/**
 * Extract the usage + rate-limits snapshot from a single `token_count`
 * payload. Split out so tests can drive it with a hand-crafted payload
 * without writing a rollout file.
 */
export function extractSnapshotFromTokenCountPayload(
  payload: unknown,
): CodexRolloutSnapshot {
  const p = payload as {
    info?: {
      last_token_usage?: { input_tokens?: number };
      total_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
      };
      model_context_window?: number;
    } | null;
    rate_limits?: {
      limit_id?: string;
      plan_type?: string | null;
      credits?: {
        has_credits?: boolean;
        unlimited?: boolean;
        balance?: string;
      } | null;
      rate_limit_reached_type?: string | null;
      primary?: { used_percent?: number } | null;
      secondary?: { used_percent?: number } | null;
    };
  };

  const result: CodexRolloutSnapshot = {};

  const total = p.info?.total_token_usage;
  if (
    typeof total?.input_tokens === "number" &&
    Number.isFinite(total.input_tokens)
  ) {
    const cached = total.cached_input_tokens;
    const output = total.output_tokens;
    result.totals = {
      inputTokens: total.input_tokens,
      cachedInputTokens:
        typeof cached === "number" && Number.isFinite(cached) ? cached : 0,
      outputTokens:
        typeof output === "number" && Number.isFinite(output) ? output : 0,
    };
  }

  const lastInput = p.info?.last_token_usage?.input_tokens;
  if (typeof lastInput === "number" && Number.isFinite(lastInput)) {
    const window = p.info?.model_context_window;
    result.usage = {
      contextTokens: lastInput,
      contextWindow:
        typeof window === "number" && Number.isFinite(window) && window > 0
          ? window
          : undefined,
    };
  }

  const rl = p.rate_limits;
  if (rl) {
    result.rateLimits = {
      limitId: typeof rl.limit_id === "string" ? rl.limit_id : undefined,
      planType: typeof rl.plan_type === "string" ? rl.plan_type : undefined,
      hasCredits:
        typeof rl.credits?.has_credits === "boolean"
          ? rl.credits.has_credits
          : undefined,
      creditsBalance:
        typeof rl.credits?.balance === "string"
          ? rl.credits.balance
          : undefined,
      rateLimitReachedType:
        typeof rl.rate_limit_reached_type === "string"
          ? rl.rate_limit_reached_type
          : undefined,
      primaryUsedPercent:
        typeof rl.primary?.used_percent === "number"
          ? rl.primary.used_percent
          : undefined,
      secondaryUsedPercent:
        typeof rl.secondary?.used_percent === "number"
          ? rl.secondary.used_percent
          : undefined,
    };
  }

  return result;
}

/**
 * Classify a rate-limits snapshot for the silent-exit recovery path.
 *
 * Returns `"exhausted"` when the snapshot positively indicates the
 * account has no remaining usage budget — explicit `has_credits: false`
 * is the canonical free-tier OAuth signal, and a populated
 * `rate_limit_reached_type` (rare in samples we have, but documented in
 * the CLI surface) is the explicit any-tier signal.
 *
 * Returns `"healthy"` when the snapshot proves there ARE remaining
 * credits — `has_credits: true`, `unlimited: true`, or a populated
 * `primary` block with non-100% usage.
 *
 * Returns `"unknown"` when the snapshot is missing or genuinely
 * ambiguous (no rollout yet, all fields null, etc). Callers MUST treat
 * `"unknown"` as "don't fire the usage-exhausted code path" — the
 * silent-exit oauth-incompat heuristic remains the right fallback.
 */
export function classifyRateLimits(
  rl: CodexRateLimitsSnapshot | undefined,
): "exhausted" | "healthy" | "unknown" {
  if (!rl) return "unknown";
  if (rl.hasCredits === false) return "exhausted";
  if (
    typeof rl.rateLimitReachedType === "string" &&
    rl.rateLimitReachedType.length > 0
  ) {
    return "exhausted";
  }
  if (rl.hasCredits === true) return "healthy";
  if (
    typeof rl.primaryUsedPercent === "number" &&
    rl.primaryUsedPercent < 100
  ) {
    return "healthy";
  }
  return "unknown";
}
