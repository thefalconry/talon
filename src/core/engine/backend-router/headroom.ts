/**
 * Headroom — "how much of this backend is left?", answered the same way for
 * every backend regardless of what it can tell us about itself.
 *
 * Two sources, in precedence order:
 *
 *   - `plan`   — the backend's own subscription windows
 *                (`UsageTelemetry.getPlanUsage`). Authoritative: it is the
 *                provider's own count, including spend from outside Talon.
 *   - `ledger` — Talon's local rolling token count (see `ledger.ts`) against
 *                the operator's soft budget (`config.backendBudgets`). The
 *                fallback for backends with no account API.
 *
 * A backend with neither reports `source: "none"` and headroom 0: nothing
 * is known about it, so it is never *preferred*. It still clears the
 * ceiling (there is no window to be over), so it runs work when nothing
 * measured is available. It used to read as 1. That made a Codex install
 * with an expired login, and so no usage signal, the router's favourite
 * for 36 hours while every run on it failed.
 *
 * On top of either source sit two "this backend is not working" signals.
 * Either one zeroes the headroom and pins the limiting window at 100%, so
 * the ceiling drops the backend whenever anything else is left:
 *
 *   - the backend's own telemetry reports a rejected credential
 *     (`UsageTelemetry.getAuthFailure`, e.g. the Codex usage endpoint's 401);
 *   - the run breaker is open (`breaker.ts`): an auth failure or repeated
 *     failures on runs routed there.
 *
 * Reads are cached for 60s per backend: `/usage`, the router and the
 * `plan_usage` tool all ask, and a plan lookup can be a subprocess spawn. A
 * failed refresh keeps the last good value and flags it `stale` rather than
 * pretending the backend emptied.
 */

import type { PlanUsage } from "../../agent-runtime/capabilities.js";
import type { TalonConfig } from "../../config/index.js";
import {
  acquireBackendInstance,
  getPooledBackend,
  listAvailableBackends,
} from "../backend-controller/index.js";
import { ledgerUsage } from "./ledger.js";
import { openBreaker } from "./breaker.js";

/** How long a headroom reading is reused before the source is asked again. */
export const HEADROOM_CACHE_MS = 60_000;

/** Where a headroom figure came from. Also its ranking priority. */
export type HeadroomSource = "plan" | "ledger" | "none";

/** The window that is closest to its limit — what the ceiling is judged on. */
export interface LimitingWindow {
  readonly label: string;
  /** 0-100. */
  readonly percent: number;
  readonly resetsAt?: string;
}

export interface BackendHeadroom {
  readonly id: string;
  readonly label: string;
  /** 0..1 — 1 is empty, 0 is at the limit. */
  readonly headroom: number;
  readonly limiting?: LimitingWindow;
  readonly source: HeadroomSource;
  /** Epoch ms of the underlying read. */
  readonly fetchedAt: number;
  /** True when the last refresh failed and this is the previous value. */
  readonly stale?: boolean;
  /**
   * The raw plan reading this came from, when `source` is `"plan"`. Carried
   * so `/usage` and the `plan_usage` tool render the real windows off the
   * same (cached) fetch the router ranked on, instead of asking twice.
   */
  readonly plan?: PlanUsage;
  /**
   * Why the backend is treated as unusable right now (a rejected login, an
   * open breaker). Set means headroom 0 and a 100% limiting window.
   */
  readonly unavailable?: string;
}

interface CacheEntry {
  value: BackendHeadroom;
  /** Epoch ms the value was computed (not the same as a stale `fetchedAt`). */
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

/** headroom = 1 − (tightest window) / 100. */
function headroomFor(percent: number): number {
  return Math.max(0, Math.min(1, 1 - clampPercent(percent) / 100));
}

/**
 * The tightest of a plan's windows. `undefined` when the plan reports none,
 * which is how a backend that answers but has nothing to say is told apart
 * from one that never answered.
 */
export function limitingWindowOf(
  usage: PlanUsage | undefined,
): LimitingWindow | undefined {
  if (!usage || usage.windows.length === 0) return undefined;
  let worst = usage.windows[0] as NonNullable<(typeof usage.windows)[0]>;
  for (const window of usage.windows) {
    if (window.percent > worst.percent) worst = window;
  }
  return {
    label: worst.label,
    percent: clampPercent(worst.percent),
    ...(worst.resetsAt ? { resetsAt: worst.resetsAt } : {}),
  };
}

/** Headroom from a `PlanUsage`, or `undefined` when it carries no windows. */
export function headroomFromPlan(
  id: string,
  label: string,
  usage: PlanUsage | undefined,
): BackendHeadroom | undefined {
  const limiting = limitingWindowOf(usage);
  if (!limiting || !usage) return undefined;
  return {
    id,
    label,
    headroom: headroomFor(limiting.percent),
    limiting,
    source: "plan",
    fetchedAt: usage.fetchedAt,
    plan: usage,
  };
}

/** The soft budget an operator declared for a backend, if any. */
function budgetFor(
  config: TalonConfig | undefined,
  id: string,
): { tokensPer5h?: number; tokensPerDay?: number } | undefined {
  const budget = config?.backendBudgets?.[id];
  if (!budget) return undefined;
  if (budget.tokensPer5h === undefined && budget.tokensPerDay === undefined) {
    return undefined;
  }
  return budget;
}

/** Whether the operator gave this backend a local budget to measure against. */
export function hasBudget(
  config: TalonConfig | undefined,
  id: string,
): boolean {
  return budgetFor(config, id) !== undefined;
}

/**
 * Headroom from the local ledger. The tighter of the two configured windows
 * wins, so a backend that is fine on the day but has just burned its 5h
 * allowance still reads as full.
 */
export function headroomFromLedger(
  id: string,
  label: string,
  config: TalonConfig | undefined,
  now = Date.now(),
): BackendHeadroom | undefined {
  const budget = budgetFor(config, id);
  if (!budget) return undefined;
  const used = ledgerUsage(id, now);
  const windows: LimitingWindow[] = [];
  if (budget.tokensPer5h !== undefined) {
    windows.push({
      label: "5h (local budget)",
      percent: clampPercent((used.tokens5h / budget.tokensPer5h) * 100),
    });
  }
  if (budget.tokensPerDay !== undefined) {
    windows.push({
      label: "24h (local budget)",
      percent: clampPercent((used.tokensDay / budget.tokensPerDay) * 100),
    });
  }
  let worst = windows[0] as LimitingWindow;
  for (const window of windows)
    if (window.percent > worst.percent) worst = window;
  return {
    id,
    label,
    headroom: headroomFor(worst.percent),
    limiting: worst,
    source: "ledger",
    fetchedAt: now,
  };
}

/** The "nothing to measure" reading: headroom 0, but under any ceiling. */
function unknownHeadroom(
  id: string,
  label: string,
  now: number,
): BackendHeadroom {
  return { id, label, headroom: 0, source: "none", fetchedAt: now };
}

/** What a backend's telemetry said: its plan windows and any auth failure. */
interface PlanRead {
  usage?: PlanUsage;
  authFailure?: string;
}

function authFailureOf(
  usage: { getAuthFailure?(): string | undefined } | undefined,
): string | undefined {
  try {
    return usage?.getAuthFailure?.call(usage) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask a backend for its plan windows. Rejects like the backend does.
 *
 * A pooled instance is used as-is. An idle backend (no chat bound to it) is
 * booted transiently for the read and released again: its quota is just as
 * real when nothing is routed to it, and reporting "not running" there made
 * `/usage` hide exactly the headroom the router needs to pick a backend that
 * is *not* currently in use. The read is the backend's own cached one, so at
 * most one boot per cache window.
 */
async function readPlanUsage(id: string): Promise<PlanRead> {
  const pooled = getPooledBackend(id);
  if (pooled) {
    const usage = pooled.usage?.getPlanUsage
      ? await pooled.usage.getPlanUsage.call(pooled.usage)
      : undefined; // pooled, but reports no plan windows
    // Read after the plan fetch: that fetch is what discovers a 401.
    const authFailure = authFailureOf(pooled.usage);
    return {
      ...(usage ? { usage } : {}),
      ...(authFailure ? { authFailure } : {}),
    };
  }
  let acquired;
  try {
    acquired = await acquireBackendInstance(id);
  } catch {
    return {}; // can't boot it (not configured, no auth) — stay quiet
  }
  try {
    const telemetry = acquired.backend.usage;
    const usage = telemetry?.getPlanUsage
      ? await telemetry.getPlanUsage.call(telemetry)
      : undefined;
    const authFailure = authFailureOf(telemetry);
    return {
      ...(usage ? { usage } : {}),
      ...(authFailure ? { authFailure } : {}),
    };
  } finally {
    await acquired.release().catch(() => {});
  }
}

/**
 * Headroom for one backend, cached for {@link HEADROOM_CACHE_MS}.
 *
 * `force` skips the cache — the `plan_usage` tool asks for a fresh read
 * because the operator is looking at the number right now.
 */
export async function getBackendHeadroom(
  id: string,
  label: string,
  config: TalonConfig | undefined,
  options?: { force?: boolean; now?: number },
): Promise<BackendHeadroom> {
  const now = options?.now ?? Date.now();
  const cached = cache.get(id);
  if (!options?.force && cached && now - cached.cachedAt < HEADROOM_CACHE_MS) {
    return withBreaker(cached.value, now);
  }

  let value: BackendHeadroom;
  try {
    const read = await readPlanUsage(id);
    const plan = headroomFromPlan(id, label, read.usage);
    value =
      plan ??
      headroomFromLedger(id, label, config, now) ??
      unknownHeadroom(id, label, now);
    if (read.authFailure) value = unavailable(value, read.authFailure);
  } catch {
    // The source is unreachable this minute. Keeping the last good reading
    // is the conservative answer: forgetting it would read as "empty" and
    // send the next background run straight at a backend near its ceiling.
    value = cached
      ? { ...cached.value, stale: true }
      : unknownHeadroom(id, label, now);
  }
  cache.set(id, { value, cachedAt: now });
  return withBreaker(value, now);
}

/** Mark a reading unusable: zero headroom, limiting window pinned at 100%. */
function unavailable(value: BackendHeadroom, why: string): BackendHeadroom {
  return {
    ...value,
    headroom: 0,
    limiting: { label: why, percent: 100 },
    unavailable: why,
  };
}

/**
 * Overlay the run breaker. Applied on every read rather than cached: the
 * breaker opens and closes on run outcomes, not on the headroom clock.
 */
function withBreaker(value: BackendHeadroom, now: number): BackendHeadroom {
  if (value.unavailable) return value;
  const breaker = openBreaker(value.id, now);
  if (!breaker) return value;
  const mins = Math.max(1, Math.ceil((breaker.until - now) / 60_000));
  return unavailable(value, `breaker open ${mins}m — ${breaker.reason}`);
}

/** Headroom for every backend the config exposes, in config order. */
export async function collectBackendHeadroom(
  config: TalonConfig | undefined,
  options?: { force?: boolean; now?: number },
): Promise<BackendHeadroom[]> {
  const backends = listAvailableBackends(config);
  return Promise.all(
    backends.map(({ id, label }) =>
      getBackendHeadroom(id, label, config, options),
    ),
  );
}

/** One-line rendering shared by `/usage`, `plan_usage` and the router log. */
export function formatHeadroom(entry: BackendHeadroom): string {
  if (entry.unavailable) return `0% — unavailable: ${entry.unavailable}`;
  if (entry.source === "none") return "unmeasured — no usage signal";
  const pct = `${Math.round(entry.headroom * 100)}%`;
  const detail = `${entry.limiting?.label ?? "window"} ${Math.round(entry.limiting?.percent ?? 0)}% used`;
  const tag = entry.source === "ledger" ? " (local budget)" : "";
  const stale = entry.stale ? " (stale)" : "";
  return `${pct} — ${detail}${tag}${stale}`;
}

/** Test seam — drop every cached reading. */
export function resetHeadroomCacheForTest(): void {
  cache.clear();
}
