/**
 * Antigravity authentication.
 *
 * There is no API key. agy authenticates through a consumer Google
 * OAuth flow run once interactively, and caches the result at
 * `~/.gemini/antigravity-cli/antigravity-oauth-token`. Headless runs
 * reuse that cache; an unauthenticated non-interactive run exits with
 * an `authentication required` error on stderr rather than hanging.
 *
 * Subscription-backed access with no key to configure is the entire
 * point of this backend, so the only thing Talon can do about auth is
 * read the cache, report it in `talon doctor`, and — when a turn
 * fails for it — say plainly that the fix is running `agy` once on
 * the host.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { userHome } from "../../util/fs-path.js";

/** Where the CLI caches its OAuth token. Env override for tests. */
function agyTokenPath(override?: string): string {
  return (
    override ||
    process.env.TALON_AGY_TOKEN_FILE ||
    join(userHome(), ".gemini", "antigravity-cli", "antigravity-oauth-token")
  );
}

export interface AgyAuthInfo {
  /** The token file was found and parsed. */
  present: boolean;
  /** `auth_method` from the file — `consumer` on a personal account. */
  method?: string;
  /** Access-token expiry, when the file records one. */
  expiry?: Date;
  /** True when `expiry` is in the past. */
  expired: boolean;
  /** A refresh token is cached, so an expired access token self-heals. */
  refreshable: boolean;
  /** Why the file could not be read / parsed. */
  problem?: string;
  path: string;
}

function readExpiry(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Read the cached OAuth token.
 *
 * The 1.2.x file nests the credential under `token`
 * (`{access_token, refresh_token, expiry}`) with `auth_method` at the
 * top level, but older builds wrote `expiry` / `refresh_token` flat.
 * Both shapes are accepted so a doctor check doesn't go red on a
 * layout change.
 */
export function detectAgyAuth(tokenPath?: string): AgyAuthInfo {
  const path = agyTokenPath(tokenPath);
  const base: AgyAuthInfo = {
    present: false,
    expired: false,
    refreshable: false,
    path,
  };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { ...base, problem: "no cached credentials" };
  }
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("not an object");
    parsed = value as Record<string, unknown>;
  } catch (err) {
    return {
      ...base,
      problem: `token file is not valid JSON (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }

  const nested =
    parsed.token && typeof parsed.token === "object"
      ? (parsed.token as Record<string, unknown>)
      : {};
  const expiry = readExpiry(nested.expiry ?? parsed.expiry);
  const refreshToken = nested.refresh_token ?? parsed.refresh_token;
  return {
    present: true,
    ...(typeof parsed.auth_method === "string"
      ? { method: parsed.auth_method }
      : {}),
    ...(expiry ? { expiry } : {}),
    expired: expiry ? expiry.getTime() <= Date.now() : false,
    refreshable: typeof refreshToken === "string" && refreshToken.length > 0,
    path,
  };
}

/** True for the stderr text an unauthenticated headless run produces. */
export function isAgyAuthFailure(text: string): boolean {
  return /authentication required|not (?:yet )?authenticated|please (?:run|sign in|log in)/i.test(
    text,
  );
}

/**
 * Turn an auth failure into an error that names the fix. The raw CLI
 * text is a bare `authentication required` with no hint that the
 * remedy is an interactive login on the host.
 */
export function agyAuthError(cause?: unknown): Error {
  const err = new Error(
    "Antigravity is not authenticated. Run `agy` once interactively on " +
      "this host and complete the Google sign-in; headless runs then reuse " +
      "the cached credentials at " +
      `${agyTokenPath()}. There is no API key for this backend.`,
  );
  if (cause !== undefined) (err as Error & { cause?: unknown }).cause = cause;
  return err;
}
