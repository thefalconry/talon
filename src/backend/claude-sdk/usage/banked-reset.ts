/**
 * Spending a banked Claude usage-limit reset (the claude.ai "Reset for free"
 * grants, program `cedar_ember`).
 *
 * The same OAuth usage endpoint `/usage` reads lists the grants; a claim is a
 * POST to the organization's `reset_rate_limits` route, the one Claude Code's
 * own `/limit-reset` uses. The request and response shapes mirror the CLI:
 *
 *   POST /api/organizations/<org>/reset_rate_limits
 *   { program: "cedar_ember", grant_id, request_id }
 *   → { result, reason?, resets_left?, cleared?, weekly_resets_at?, cooldown_until? }
 *
 * `request_id` is an idempotency key. A retry of the same user action must
 * reuse it, so a claim whose answer was lost can't spend a second reset.
 *
 * A reset is one-off and irreversible. Nothing here is reachable from an
 * agent tool; the only caller is a confirm button a human presses.
 */

import { randomUUID } from "node:crypto";
import { logWarn } from "../../../util/log.js";
import type {
  BankedResetClaim,
  BankedResetGrant,
  BankedResetOffer,
  BankedResetResult,
} from "../../../core/agent-runtime/capabilities.js";
import {
  CLI_USER_AGENT,
  USAGE_ENDPOINT,
  invalidatePlanUsage,
  readCredentials,
} from "./plan-usage.js";

const API_BASE = "https://api.anthropic.com";
const PROFILE_ENDPOINT = `${API_BASE}/api/oauth/profile`;
const PROGRAM = "cedar_ember";
const READ_TIMEOUT_MS = 5_000;
// The CLI allows a claim 25s; the server may do real work before answering.
const CLAIM_TIMEOUT_MS = 25_000;

// Same patterns the CLI enforces before it will send a claim.
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ORG_ID = /^[A-Za-z0-9-]{1,64}$/;

const SERVER_RESULTS: ReadonlySet<string> = new Set([
  "reset",
  "already_used",
  "not_limited",
  "cooldown",
  "ineligible",
  "unavailable",
]);

export function isValidGrantId(id: string): boolean {
  return GRANT_ID.test(id);
}

export function isValidRequestId(id: string): boolean {
  return REQUEST_ID.test(id);
}

/** A fresh idempotency key for one user action. */
export function newResetRequestId(): string {
  return randomUUID().replace(/-/g, "");
}

export interface ResetStatus {
  atLimit: boolean;
  cooldownUntil?: string;
  nextGrantId?: string;
  grants: Array<BankedResetGrant & { paused: boolean; usableNow: boolean }>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function percents(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    if (typeof p === "number" && Number.isFinite(p))
      out[k] = Math.max(0, Math.min(100, Math.round(p)));
  }
  return out;
}

/** The `cedar_ember` block of a usage response, or undefined without one. */
export function parseResetStatus(body: unknown): ResetStatus | undefined {
  const raw = (body as { cedar_ember?: unknown } | null)?.cedar_ember as
    Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object" || raw.eligible === false)
    return undefined;
  const grants: ResetStatus["grants"] = [];
  for (const g of Array.isArray(raw.grants) ? raw.grants : []) {
    if (!g || typeof g !== "object") continue;
    const r = g as Record<string, unknown>;
    const id = str(r.id);
    // A malformed id is one the CLI would refuse to claim; skip it here too.
    if (!id || !isValidGrantId(id)) continue;
    const left = r.resets_left;
    const endsAt = str(r.ends_at);
    grants.push({
      id,
      label: str(r.label) ?? id,
      resetsLeft:
        typeof left === "number" && Number.isFinite(left)
          ? Math.max(0, Math.floor(left))
          : 0,
      ...(endsAt ? { endsAt } : {}),
      clears: strings(r.clears),
      percentUsed: percents(r.percent_used),
      // The CLI defaults an absent flag to the cautious reading.
      useRequiresLimit: r.use_requires_limit !== false,
      paused: r.paused === true,
      usableNow: r.usable_now === true,
    });
  }
  const cooldownUntil = str(raw.cooldown_until);
  const nextGrantId = str(raw.next_grant_id);
  return {
    atLimit: raw.at_limit === true,
    ...(cooldownUntil ? { cooldownUntil } : {}),
    ...(nextGrantId ? { nextGrantId } : {}),
    grants,
  };
}

function usable(grant: ResetStatus["grants"][number], now: number): boolean {
  if (!grant.usableNow || grant.paused || grant.resetsLeft <= 0) return false;
  const ends = grant.endsAt ? Date.parse(grant.endsAt) : NaN;
  return !(Number.isFinite(ends) && ends <= now);
}

/**
 * The grant a claim should spend: the server's `next_grant_id` when that
 * grant is usable, else the usable grant that expires soonest (a grant with
 * no deadline goes last).
 */
export function pickGrant(
  status: ResetStatus,
  now = Date.now(),
): ResetStatus["grants"][number] | undefined {
  const candidates = status.grants.filter((g) => usable(g, now));
  const next = candidates.find((g) => g.id === status.nextGrantId);
  if (next) return next;
  const deadline = (g: { endsAt?: string }) => {
    const t = g.endsAt ? Date.parse(g.endsAt) : NaN;
    return Number.isFinite(t) ? t : Infinity;
  };
  return candidates.sort((a, b) => deadline(a) - deadline(b))[0];
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": CLI_USER_AGENT,
  };
}

async function oauthToken(configDir?: string): Promise<string | undefined> {
  // An API-key session isn't on the subscription whose resets these are.
  if (process.env.ANTHROPIC_API_KEY) return undefined;
  return (await readCredentials(configDir))?.accessToken;
}

/** What a claim would spend right now, or undefined when there's nothing. */
export async function getBankedResetOffer(
  now = Date.now(),
  configDir?: string,
): Promise<BankedResetOffer | undefined> {
  const token = await oauthToken(configDir);
  if (!token) return undefined;
  try {
    const res = await fetch(USAGE_ENDPOINT, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) {
      logWarn("agent", `banked resets: usage returned ${res.status}`);
      return undefined;
    }
    const status = parseResetStatus(await res.json());
    if (!status) return undefined;
    const grant = pickGrant(status, now);
    if (!grant) return undefined;
    const { paused: _p, usableNow: _u, ...clean } = grant;
    const totalResetsLeft = status.grants
      .filter((g) => usable(g, now))
      .reduce((n, g) => n + g.resetsLeft, 0);
    return {
      grant: clean,
      atLimit: status.atLimit,
      ...(status.cooldownUntil ? { cooldownUntil: status.cooldownUntil } : {}),
      totalResetsLeft,
    };
  } catch (err) {
    logWarn(
      "agent",
      `banked resets: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function organizationId(token: string): Promise<string | undefined> {
  const res = await fetch(PROFILE_ENDPOINT, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { organization?: { uuid?: unknown } };
  const id = body?.organization?.uuid;
  return typeof id === "string" && ORG_ID.test(id) ? id : undefined;
}

const failed = (result: BankedResetResult): BankedResetClaim => ({
  result,
  cleared: [],
});

/** Map a claim response body onto a result; unknown results read as unavailable. */
export function parseClaimResponse(body: unknown): BankedResetClaim {
  const r = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  const result =
    typeof r.result === "string" && SERVER_RESULTS.has(r.result)
      ? (r.result as BankedResetResult)
      : "unavailable";
  const reason = str(r.reason);
  const left = r.resets_left;
  const weeklyResetsAt = str(r.weekly_resets_at);
  const cooldownUntil = str(r.cooldown_until);
  return {
    result,
    ...(reason ? { reason } : {}),
    ...(typeof left === "number" && Number.isInteger(left) && left >= 0
      ? { resetsLeft: left }
      : {}),
    cleared: strings(r.cleared),
    ...(weeklyResetsAt ? { weeklyResetsAt } : {}),
    ...(cooldownUntil ? { cooldownUntil } : {}),
  };
}

/**
 * Spend one reset from `grantId`. Never throws: every failure comes back as
 * a result the caller can put into words.
 */
export async function claimBankedReset(
  grantId: string,
  requestId: string = newResetRequestId(),
  configDir?: string,
): Promise<BankedResetClaim> {
  if (!isValidGrantId(grantId) || !isValidRequestId(requestId)) {
    logWarn("agent", "banked resets: refusing a malformed grant or request id");
    return failed("error");
  }
  const token = await oauthToken(configDir);
  if (!token) return failed("auth_error");

  try {
    const org = await organizationId(token);
    if (!org) return failed("auth_error");
    const res = await fetch(
      `${API_BASE}/api/organizations/${org}/reset_rate_limits`,
      {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          program: PROGRAM,
          grant_id: grantId,
          request_id: requestId,
        }),
        signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
      },
    );
    if (res.status === 429) return failed("rate_limited");
    if (res.status === 401 || res.status === 403) return failed("auth_error");
    if (!res.ok) {
      logWarn("agent", `banked resets: claim returned ${res.status}`);
      return failed("error");
    }
    const claim = parseClaimResponse(await res.json().catch(() => null));
    // Any settled answer changes what /usage should say; re-read next time.
    if (claim.result !== "unavailable") invalidatePlanUsage(configDir);
    return claim;
  } catch (err) {
    logWarn(
      "agent",
      `banked resets: claim failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return failed("error");
  }
}
