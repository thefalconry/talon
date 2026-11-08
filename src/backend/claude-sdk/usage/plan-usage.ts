/**
 * Claude.ai subscription rate-limit windows for /status.
 *
 * The 5-hour, weekly, and per-model utilisation percentages come from the
 * same OAuth endpoint Claude Code's own usage panel reads. The Agent SDK
 * also exposes them through a control request, but that path additionally
 * builds a local-session behaviour report and costs seconds per call; the
 * endpoint alone answers in well under a second.
 *
 * Everything degrades to `undefined`: no credentials, an API-key session
 * (plan limits don't apply), or any transport failure. /status hides the
 * section rather than rendering zeroes.
 *
 * Per account: every function takes the account's Claude config dir
 * (absent = the default account, `$CLAUDE_CONFIG_DIR` or `~/.claude`), reads
 * that account's credentials and keeps that account's cache, so two
 * subscriptions never report each other's windows.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logWarn } from "../../../util/log.js";
import { dirs } from "../../../util/paths.js";
import type {
  PlanUsage,
  PlanWindow,
} from "../../../core/agent-runtime/capabilities.js";
import { defaultClaudeConfigDir } from "../../../core/config/claude-accounts.js";

// `cedar_ember=1` asks the endpoint to include banked limit resets (the
// claude.ai "Reset for free" grants); `skip_spend=1` drops the spend block we
// don't render. Resets are only reported to the CLI surface — any other
// user agent gets `ineligible_reason: "surface"` — so the request identifies
// as the CLI, which is what the Agent SDK runs anyway.
export const USAGE_ENDPOINT =
  "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
export const CLI_USER_AGENT = "claude-cli/2.1.280 (external, cli)";
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;
/**
 * How long to leave the endpoint alone after it says 429 (or fails with a
 * 5xx) and gives no usable Retry-After. Polling a rate-limited endpoint
 * every minute is what keeps it rate-limited.
 */
export const DEFAULT_BACKOFF_MS = 5 * 60_000;
/** Ceiling on a server-supplied Retry-After, so one bad header can't mute an account for a day. */
const MAX_BACKOFF_MS = 30 * 60_000;

/** Config dir → last good reading. */
const cache = new Map<string, { value: PlanUsage; fetchedAt: number }>();
const inFlight = new Map<string, Promise<PlanUsage | undefined>>();
/** Config dir → epoch ms before which the endpoint is not asked again. */
const backoffUntil = new Map<string, number>();
/** Config dirs whose on-disk reading has already been loaded into `cache`. */
const restored = new Set<string>();

/**
 * Backoff for a failed response: the server's Retry-After (seconds or an
 * HTTP date) when it gives one, else {@link DEFAULT_BACKOFF_MS}; capped.
 */
export function backoffMs(
  retryAfter: string | null | undefined,
  now = Date.now(),
): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    const ms = Number.isFinite(secs)
      ? secs * 1000
      : Date.parse(retryAfter) - now;
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_BACKOFF_MS);
  }
  return DEFAULT_BACKOFF_MS;
}

/**
 * Where an account's last good reading is kept across restarts. Keyed by a
 * hash of the config dir so the file name carries no path.
 */
function snapshotPath(key: string): string {
  const id = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(dirs.data, "plan-usage", `claude-${id}.json`);
}

async function saveSnapshot(key: string, value: PlanUsage): Promise<void> {
  try {
    const path = snapshotPath(key);
    await mkdir(join(dirs.data, "plan-usage"), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, path);
  } catch {
    // Best effort: losing the snapshot only costs a blank panel after a restart.
  }
}

async function restoreSnapshot(key: string): Promise<void> {
  if (restored.has(key)) return;
  restored.add(key);
  if (cache.has(key)) return;
  try {
    const value = JSON.parse(
      await readFile(snapshotPath(key), "utf8"),
    ) as PlanUsage;
    if (Array.isArray(value?.windows) && typeof value.fetchedAt === "number")
      cache.set(key, { value, fetchedAt: value.fetchedAt });
  } catch {
    // No snapshot yet.
  }
}

/** The account's config dir; the default account's when absent. */
function accountDir(configDir?: string): string {
  return configDir ?? defaultClaudeConfigDir();
}

function credentialsPath(configDir?: string): string {
  return join(accountDir(configDir), ".credentials.json");
}

interface OAuthCredentials {
  accessToken?: string;
  subscriptionType?: string;
}

export async function readCredentials(
  configDir?: string,
): Promise<OAuthCredentials | undefined> {
  try {
    const path = credentialsPath(configDir);
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      claudeAiOauth?: OAuthCredentials;
    };
    const oauth = parsed.claudeAiOauth;
    return oauth?.accessToken ? oauth : undefined;
  } catch {
    return undefined;
  }
}

interface RawLimit {
  kind?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

/**
 * Short display label for one window, or undefined to skip the row.
 *
 * Only the three documented kinds are rendered. The response also carries
 * internal codenamed windows; skipping unknown kinds keeps those out of the
 * user-facing panel.
 */
function windowLabel(limit: RawLimit): string | undefined {
  if (limit.kind === "session") return "5h";
  if (limit.kind === "weekly_all") return "7d";
  if (limit.kind === "weekly_scoped") {
    const model = limit.scope?.model?.display_name?.trim();
    return model && model.length > 0 ? model : undefined;
  }
  return undefined;
}

interface RawResetGrant {
  resets_left?: number;
  ends_at?: string | null;
  paused?: boolean;
}

/**
 * Banked limit resets still usable: unpaused grants whose window hasn't
 * closed. Returns the count and the soonest deadline among grants that still
 * hold a reset, or undefined when there's nothing to offer.
 */
export function parseBankedResets(
  body: unknown,
  now = Date.now(),
): { count: number; expiresAt?: string } | undefined {
  const program = (body as { cedar_ember?: unknown } | null)?.cedar_ember as
    { eligible?: boolean; grants?: unknown } | null | undefined;
  if (!program || program.eligible === false || !Array.isArray(program.grants))
    return undefined;

  let count = 0;
  let expiresAt: string | undefined;
  for (const grant of program.grants as RawResetGrant[]) {
    const left = grant.resets_left;
    if (typeof left !== "number" || !Number.isFinite(left) || left <= 0)
      continue;
    if (grant.paused === true) continue;
    const ends =
      typeof grant.ends_at === "string" ? Date.parse(grant.ends_at) : NaN;
    if (Number.isFinite(ends) && ends <= now) continue;
    count += Math.floor(left);
    if (
      typeof grant.ends_at === "string" &&
      Number.isFinite(ends) &&
      (!expiresAt || ends < Date.parse(expiresAt))
    )
      expiresAt = grant.ends_at;
  }
  if (count <= 0) return undefined;
  return { count, ...(expiresAt ? { expiresAt } : {}) };
}

export function parsePlanUsage(
  body: unknown,
  subscriptionType?: string,
): PlanUsage | undefined {
  const limits = (body as { limits?: unknown } | null)?.limits;
  if (!Array.isArray(limits)) return undefined;

  const windows: PlanWindow[] = [];
  for (const limit of limits as RawLimit[]) {
    const label = windowLabel(limit);
    if (!label) continue;
    const raw = limit.percent;
    const percent =
      typeof raw === "number" && Number.isFinite(raw)
        ? Math.max(0, Math.min(100, Math.round(raw)))
        : 0;
    windows.push({
      label,
      percent,
      ...(typeof limit.resets_at === "string"
        ? { resetsAt: limit.resets_at }
        : {}),
    });
  }

  if (windows.length === 0) return undefined;
  const banked = parseBankedResets(body);
  return {
    ...(subscriptionType ? { plan: subscriptionType } : {}),
    windows,
    ...(banked
      ? {
          resetsAvailable: banked.count,
          ...(banked.expiresAt ? { resetsExpireAt: banked.expiresAt } : {}),
        }
      : {}),
    fetchedAt: Date.now(),
  };
}

async function load(configDir?: string): Promise<PlanUsage | undefined> {
  const creds = await readCredentials(configDir);
  if (!creds?.accessToken) return undefined;

  try {
    const res = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": CLI_USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        const wait = backoffMs(res.headers.get("retry-after"));
        backoffUntil.set(accountDir(configDir), Date.now() + wait);
        logWarn(
          "agent",
          `plan usage: endpoint returned ${res.status}; not asking again for ${Math.round(wait / 1000)}s`,
        );
      } else {
        logWarn("agent", `plan usage: endpoint returned ${res.status}`);
      }
      return undefined;
    }
    return parsePlanUsage(await res.json(), creds.subscriptionType);
  } catch (err) {
    logWarn(
      "agent",
      `plan usage: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Plan windows for /status, cached for a minute so a burst of commands
 * makes one request. A failed refresh falls back to the last known values
 * — `fetchedAt` lets the caller age them.
 */
export async function getPlanUsage(
  configDir?: string,
): Promise<PlanUsage | undefined> {
  // An API-key session bills against the key, not the subscription, so the
  // stored OAuth credentials would describe limits that don't apply here.
  if (process.env.ANTHROPIC_API_KEY) return undefined;

  const key = accountDir(configDir);
  await restoreSnapshot(key);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS)
    return cached.value;
  // Rate-limited or failing: serve the last reading (its fetchedAt ages it
  // in the panel) rather than adding to the requests that got us limited.
  if (Date.now() < (backoffUntil.get(key) ?? 0)) return cached?.value;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = load(configDir).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  const loaded = await pending;
  if (loaded) {
    cache.set(key, { value: loaded, fetchedAt: loaded.fetchedAt });
    backoffUntil.delete(key);
    void saveSnapshot(key, loaded);
  }
  return loaded ?? cache.get(key)?.value;
}

/**
 * Expire an account's cache after the SDK reports a rate-limit change, so
 * the next /status re-reads instead of showing figures from before the turn.
 */
export function invalidatePlanUsage(configDir?: string): void {
  const cached = cache.get(accountDir(configDir));
  if (cached) cached.fetchedAt = 0;
}

/** Test-only: forget every account's cached reading. */
export function resetPlanUsageCacheForTest(): void {
  cache.clear();
  inFlight.clear();
  backoffUntil.clear();
  restored.clear();
}
