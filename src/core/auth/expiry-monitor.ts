/**
 * Login-expiry monitor — the daemon-side version of the CLI's "you have
 * N days to log in again" banner, delivered to the admin chat.
 *
 * Checks every provider's credential file on an interval and alerts the
 * admin (via the core notify seam) when a login is within
 * {@link WARN_DAYS} of expiring, has expired, or is missing. Each distinct
 * state is announced once; the latch re-arms when the state changes (a
 * fresh login clears it, so the next expiry warns again).
 */

import { notifyAdmin } from "../frontend-runtime/admin-notify.js";
import { logWarn } from "../../util/log.js";
import {
  daysUntil,
  providerLabel,
  readAllProviderStatus,
  type ProviderAuthStatus,
} from "./status.js";

const WARN_DAYS = 7;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/** The alert key for a status, or undefined when nothing needs saying. */
export function alertKeyFor(
  s: ProviderAuthStatus,
  now = Date.now(),
): string | undefined {
  if (!s.loggedIn) return `${s.provider}:missing`;
  if (s.expired) return `${s.provider}:expired`;
  if (s.loginExpiresAt === undefined) return undefined;
  const days = daysUntil(s.loginExpiresAt, now);
  if (days > WARN_DAYS) return undefined;
  return `${s.provider}:expiring:${Math.max(days, 0)}`;
}

export function alertTextFor(s: ProviderAuthStatus, now = Date.now()): string {
  const label = providerLabel(s.provider);
  if (!s.loggedIn)
    return `🔑 ${label} is not signed in — send /auth to sign in from here.`;
  if (s.expired)
    return `🔑 ${label} login has expired — send /auth to sign in again.`;
  const days =
    s.loginExpiresAt === undefined ? 0 : daysUntil(s.loginExpiresAt, now);
  const when = days <= 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`;
  return `⏳ ${label} login expires ${when} — send /auth to renew it before it lapses.`;
}

const announced = new Map<string, string>();

/** One check pass; exported for tests and for the panel's refresh button. */
export async function runAuthExpiryCheck(
  now = Date.now(),
  notify: (text: string) => Promise<unknown> = notifyAdmin,
): Promise<string[]> {
  const sent: string[] = [];
  for (const status of await readAllProviderStatus()) {
    const key = alertKeyFor(status, now);
    const prev = announced.get(status.provider);
    if (key === undefined) {
      announced.delete(status.provider);
      continue;
    }
    if (prev === key) continue;
    announced.set(status.provider, key);
    const text = alertTextFor(status, now);
    sent.push(text);
    await notify(text);
  }
  return sent;
}

export function resetAuthExpiryAnnouncements(): void {
  announced.clear();
}

export function startAuthExpiryMonitor(): () => void {
  const tick = (): void => {
    void runAuthExpiryCheck().catch((err: unknown) => {
      // The alert is already marked announced, so a failed send is not
      // retried until the status changes — the log is its only trace.
      logWarn(
        "notify",
        `auth expiry check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  // First check shortly after boot so a lapsed login is surfaced right away.
  const first = setTimeout(tick, 30_000);
  const interval = setInterval(tick, CHECK_INTERVAL_MS);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
