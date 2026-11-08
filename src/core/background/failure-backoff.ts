/**
 * Failure backoff for background agents (heartbeat, dream, …).
 *
 * A failed background run typically does NOT advance its `last_run` marker,
 * so whatever cadence check re-evaluates "is a run due?" re-fires the same
 * failing run on every tick — observed live as hundreds of identical
 * failures minutes apart (session-limit nights, model outages, auth
 * breakage). This module centralizes the cure:
 *
 *   - generic failures back off exponentially (5 → 10 → 20 → 40 → 60min cap)
 *   - session/rate-limit errors that state their own reset time
 *     ("… resets 12:20am (UTC)") wait until then (+buffer) instead of
 *     guessing
 *   - a success clears the window
 *
 * Backoff state is in-memory only: a process restart forgets it, which is
 * fine — the first post-restart attempt either works or re-arms the window.
 *
 * A holder built with an `alert` also tells the operator: once the streak
 * reaches its threshold (2 by default — one failure is a blip, a second in
 * a row after the backoff is a broken component) it raises `alert.key`
 * with the error, and the next success resolves it.
 */

import { faultText } from "../engine/fault-text.js";
import { raiseAlert, resolveAlert } from "../frontend-runtime/alerts.js";

const FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;
const FAILURE_BACKOFF_MAX_MS = 60 * 60 * 1000;
/** Safety margin added past a parsed limit-reset time (clock skew, rollout). */
const LIMIT_RESET_BUFFER_MS = 2 * 60 * 1000;

/**
 * Parse the reset wall-clock time out of a session/rate-limit error message,
 * e.g. "You've hit your session limit · resets 12:20am (UTC)" or
 * "… resets 3pm (UTC)". Returns the epoch ms of the NEXT occurrence of that
 * UTC time after `now`, or null when the message doesn't carry one.
 */
export function parseSessionLimitResetMs(
  message: string,
  now: number,
): number | null {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i.exec(
    message,
  );
  if (!m) return null;
  const rawHour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (rawHour < 1 || rawHour > 12 || minute > 59) return null;
  let hour = rawHour % 12;
  if (m[3].toLowerCase() === "pm") hour += 12;
  const d = new Date(now);
  d.setUTCHours(hour, minute, 0, 0);
  let t = d.getTime();
  if (t <= now) t += 24 * 60 * 60 * 1000;
  return t;
}

/**
 * When to next allow a run after the Nth consecutive failure (1-based).
 * Limit errors with a stated reset time wait until then (+buffer);
 * everything else doubles from 5min up to a 60min cap.
 */
export function failureBackoffUntil(
  err: unknown,
  consecutiveFailures: number,
  now: number,
): number {
  const message = err instanceof Error ? err.message : String(err);
  if (/session limit|rate limit/i.test(message)) {
    const reset = parseSessionLimitResetMs(message, now);
    if (reset !== null) return reset + LIMIT_RESET_BUFFER_MS;
  }
  const exp = Math.min(
    FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    FAILURE_BACKOFF_MAX_MS,
  );
  return now + exp;
}

/** Operator alert a backoff holder raises while its component keeps failing. */
type BackoffAlert = {
  /** Stable alert key, e.g. "heartbeat.failing". */
  key: string;
  /** What failed, for the message: "The heartbeat", "Dream (memory consolidation)". */
  label: string;
  /** Consecutive failures before raising. Default 2. */
  threshold?: number;
};

/**
 * Per-component backoff holder. Cadence checks gate on `active()`; run
 * completions call `succeed()` / `fail(err)`.
 */
export class FailureBackoff {
  private consecutiveFailures = 0;
  private until = 0;

  constructor(private readonly alert?: BackoffAlert) {}

  /** True while inside the backoff window — the caller should skip firing. */
  active(now = Date.now()): boolean {
    return now < this.until;
  }

  /** Record a failure; returns the epoch ms the window is armed until. */
  fail(err: unknown, now = Date.now()): number {
    this.consecutiveFailures += 1;
    this.until = failureBackoffUntil(err, this.consecutiveFailures, now);
    const alert = this.alert;
    if (alert && this.consecutiveFailures >= (alert.threshold ?? 2)) {
      const retryAt = new Date(this.until).toISOString().slice(11, 16);
      raiseAlert(
        alert.key,
        `${alert.label} has failed ${this.consecutiveFailures} times in a row: ${faultText(err)}. Next attempt after ${retryAt} UTC.`,
      );
    }
    return this.until;
  }

  /** Record a success — clears the window and the failure streak. */
  succeed(): void {
    this.consecutiveFailures = 0;
    this.until = 0;
    if (this.alert)
      resolveAlert(this.alert.key, `${this.alert.label} is running again.`);
  }

  get failures(): number {
    return this.consecutiveFailures;
  }
}
