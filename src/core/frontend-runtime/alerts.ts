/**
 * Operator alerts — "something is wrong" (and "it's fine again") on the
 * admin's chat, deduplicated so a flapping fault can't flood it.
 *
 * Every alert has a stable key naming the fault ("telegram.polling",
 * "backend.auth", "disk.low"). The first raise delivers; repeats inside
 * the cooldown only count, and the next delivery after it says how many
 * were folded in. `resolveAlert` sends one recovery notice for a key that
 * was delivered, and nothing for one that never was. Delivery rides
 * `notifyAdmin`, so alerts degrade to a log line when no frontend is up.
 *
 * Two exceptions to the cooldown: an escalation (warn → error → critical)
 * always delivers, and a delivery that failed (no notifier wired, the
 * admin's frontend down) doesn't count, so the next raise tries again.
 */

import { log, logWarn } from "../../util/log.js";
import { notifyAdmin, withdrawAdminNotification } from "./admin-notify.js";

export type AlertSeverity = "warn" | "error" | "critical";

type ActiveAlert = {
  severity: AlertSeverity;
  message: string;
  firstAt: number;
  lastSentAt: number;
  /** Raises folded into the cooldown since the last delivery. */
  suppressed: number;
};

const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const ICON: Record<AlertSeverity, string> = {
  warn: "⚠️",
  error: "🔴",
  critical: "🚨",
};
const RANK: Record<AlertSeverity, number> = { warn: 0, error: 1, critical: 2 };

const active = new Map<string, ActiveAlert>();
let cooldownMs = DEFAULT_COOLDOWN_MS;
let enabled = true;
type Send = (text: string, key?: string) => Promise<unknown>;
let send: Send = notifyAdmin;

/** Apply operator settings (config `alerts`). */
export function configureAlerts(opts: {
  enabled?: boolean;
  cooldownMs?: number;
}): void {
  if (opts.enabled !== undefined) enabled = opts.enabled;
  if (opts.cooldownMs !== undefined && opts.cooldownMs >= 0)
    cooldownMs = opts.cooldownMs;
}

/**
 * Report a fault. Always logged; delivered to the admin unless the same
 * key was delivered within the cooldown. Never throws.
 */
export function raiseAlert(
  key: string,
  message: string,
  opts: { severity?: AlertSeverity } = {},
): void {
  const severity = opts.severity ?? "error";
  const now = Date.now();
  logWarn("alert", `[${severity}] ${key}: ${message}`);
  const prior = active.get(key);
  const escalated =
    prior !== undefined && RANK[severity] > RANK[prior.severity];
  if (prior && !escalated && now - prior.lastSentAt < cooldownMs) {
    prior.suppressed++;
    prior.message = message;
    return;
  }
  const folded = prior?.suppressed ?? 0;
  const entry: ActiveAlert = {
    severity,
    message,
    firstAt: prior?.firstAt ?? now,
    lastSentAt: now,
    suppressed: 0,
  };
  active.set(key, entry);
  if (!enabled) return;
  const repeat = folded > 0 ? `\n(+${folded} more since the last alert)` : "";
  const undelivered = (): void => {
    // Nobody heard it: don't let the cooldown swallow the next raise.
    if (active.get(key) === entry) entry.lastSentAt = 0;
  };
  // The key lets a still-queued copy (no notifier wired yet) be replaced by
  // this raise rather than queued twice.
  void send(`${ICON[severity]} ${message}${repeat}`, key).then((ok) => {
    if (ok === false) undelivered();
  }, undelivered);
}

/** Clear a fault; announces recovery only if its alert was delivered. */
export function resolveAlert(key: string, message?: string): void {
  const prior = active.get(key);
  if (!prior) return;
  active.delete(key);
  const mins = Math.max(1, Math.round((Date.now() - prior.firstAt) / 60_000));
  log("alert", `resolved ${key} after ${mins} min`);
  if (!enabled) return;
  // Still queued for a notifier that never got to send it: withdraw it, and
  // there is nothing to announce a recovery from.
  if (withdrawAdminNotification(key)) return;
  void send(`✅ ${message ?? `Recovered: ${key}`} (after ${mins} min)`).catch(
    () => {},
  );
}

/** Keys currently raised — for status surfaces and doctor. */
export function activeAlerts(): ReadonlyArray<{
  key: string;
  severity: AlertSeverity;
  message: string;
  since: number;
}> {
  return [...active].map(([key, a]) => ({
    key,
    severity: a.severity,
    message: a.message,
    since: a.firstAt,
  }));
}

/** Test seam: reset state and swap the delivery function. */
export function resetAlertsForTest(deliver: Send = notifyAdmin): void {
  active.clear();
  cooldownMs = DEFAULT_COOLDOWN_MS;
  enabled = true;
  send = deliver;
}
