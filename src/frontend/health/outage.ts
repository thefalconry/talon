/**
 * Connection outages — the line between "a reconnect failed" (log it) and
 * "this chat channel is down" (tell the operator).
 *
 * A frontend reports every failed poll / reconnect with `fail` and every
 * healthy one with `ok`. The first failure arms a timer; if nothing healthy
 * arrives before `thresholdMs`, the alert is raised with the latest error.
 * The timer — not the next failure — decides, because a link that dies
 * silently (a gateway that never reconnects) produces no further events.
 * `ok` ends the outage and, when an alert went out, sends the recovery.
 */

import {
  raiseAlert,
  resolveAlert,
  type AlertSeverity,
} from "../../core/frontend-runtime/alerts.js";

export type OutageOptions = {
  /** Stable alert key, e.g. "telegram.polling". */
  key: string;
  /** How long failures must persist before the operator hears of it. */
  thresholdMs: number;
  severity?: AlertSeverity;
  /** Operator text for the raise, given the latest error and minutes down. */
  describe: (lastError: string, downMin: number) => string;
  /** Operator text for the recovery notice. */
  recovered: string;
};

export type Outage = {
  /** Record a failure. Returns the streak so the caller can log it. */
  fail(err: unknown): { attempt: number; downMs: number };
  /** Record a healthy round-trip. Returns the outage it ended, if any. */
  ok(): { attempts: number; downMs: number } | null;
  /** Raise immediately — for failures that will not heal on their own. */
  raiseNow(message: string, severity?: AlertSeverity): void;
  /** True between the first failure and the next `ok`. */
  readonly down: boolean;
  /** Forget the outage without resolving it — shutdown. */
  dispose(): void;
};

const MAX_ERROR_CHARS = 200;

/**
 * One-line error text fit for an alert or a log line: the message only,
 * bounded, with bot tokens and webhook signatures masked.
 */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw
    .replace(/bot\d+:[\w-]+/g, "bot<redacted>")
    .replace(/([?&]sig=)[^&\s]+/g, "$1<redacted>")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_ERROR_CHARS
    ? `${text.slice(0, MAX_ERROR_CHARS)}…`
    : text;
}

export function createOutage(opts: OutageOptions): Outage {
  let since = 0;
  let attempts = 0;
  let lastError = "";
  let raised = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const raise = (message: string, severity?: AlertSeverity): void => {
    raised = true;
    raiseAlert(opts.key, message, { severity: severity ?? opts.severity });
  };

  return {
    get down() {
      return attempts > 0;
    },
    fail(err) {
      const now = Date.now();
      if (attempts === 0) {
        since = now;
        timer = setTimeout(() => {
          timer = null;
          const mins = Math.max(1, Math.round((Date.now() - since) / 60_000));
          raise(opts.describe(lastError, mins));
        }, opts.thresholdMs);
        timer.unref?.();
      }
      attempts++;
      lastError = errorText(err);
      return { attempt: attempts, downMs: now - since };
    },
    ok() {
      if (attempts === 0 && !raised) return null;
      const ended = { attempts, downMs: attempts ? Date.now() - since : 0 };
      clearTimer();
      attempts = 0;
      if (raised) resolveAlert(opts.key, opts.recovered);
      raised = false;
      return ended;
    },
    raiseNow(message, severity) {
      clearTimer();
      raise(message, severity);
    },
    dispose() {
      clearTimer();
      attempts = 0;
      raised = false;
    },
  };
}
