/**
 * Admin notification seam — a way for any subsystem to reach the human
 * operator on their primary chat (adminUserId, usually Telegram).
 *
 * Core cannot import frontends, so the composition root injects the
 * delivery function at boot (bootstrap.ts, next to the plan-alerts
 * wiring, which does the same thing privately). Alerts raised before that
 * — early boot is exactly when restore reports and security alerts fire —
 * are held in a small bounded queue and flushed, oldest first, the moment
 * a notifier is wired. With nothing ever wired (tests, terminal mode with
 * no admin) they stay a log line; nothing throws.
 *
 * First consumer: WhatsApp pairing. When WhatsApp unlinks the device,
 * recovery needs a human to type a pairing code into the phone — a code
 * that would otherwise only appear in the daemon log, which nobody
 * watches. Alerts about a dead frontend must travel over a LIVE one.
 */

import { log, logWarn } from "../../util/log.js";

type Deliver = (text: string) => Promise<void>;

let deliver: Deliver | null = null;

/** Most alerts held while no notifier is wired; the oldest are dropped past it. */
export const ADMIN_NOTIFY_QUEUE_MAX = 20;

type Pending = { text: string; at: number };
const pending: Pending[] = [];
let droppedWhileUnwired = 0;
let flushing: Promise<void> | null = null;

/**
 * Wire (or clear) the delivery function. Called by the composition root.
 * Wiring a notifier flushes anything queued before it existed, in the
 * background (the call itself stays synchronous).
 */
export function setAdminNotifier(fn: Deliver | null): void {
  deliver = fn;
  if (fn && (pending.length > 0 || droppedWhileUnwired > 0)) {
    flushing = flushPending(fn).finally(() => {
      flushing = null;
    });
  }
}

/** Resolves once any in-flight flush of queued alerts has finished. */
export function adminNotifyFlushed(): Promise<void> {
  return flushing ?? Promise.resolve();
}

/** Drop queued, undelivered alerts (tests; a notifier that will never come). */
export function clearPendingAdminNotifications(): void {
  pending.length = 0;
  droppedWhileUnwired = 0;
}

/** How many alerts are waiting for a notifier. */
export function pendingAdminNotificationCount(): number {
  return pending.length;
}

async function flushPending(fn: Deliver): Promise<void> {
  const batch = pending.splice(0, pending.length);
  const dropped = droppedWhileUnwired;
  droppedWhileUnwired = 0;
  if (dropped > 0) {
    batch.unshift({
      text: `${dropped} earlier admin alert(s) were dropped before a notifier was wired (queue holds ${ADMIN_NOTIFY_QUEUE_MAX}); see the daemon log.`,
      at: Date.now(),
    });
  }
  log("notify", `Flushing ${batch.length} queued admin alert(s)`);
  for (const item of batch) {
    // The notifier was swapped or cleared mid-flush: requeue the rest for
    // whichever notifier comes next rather than sending on a stale one.
    if (deliver !== fn) {
      enqueue(item);
      continue;
    }
    const ageS = Math.round((Date.now() - item.at) / 1000);
    const text = ageS >= 5 ? `(delayed ${ageS}s) ${item.text}` : item.text;
    try {
      await fn(text);
      log("notify", `Admin notified (queued): ${preview(item.text)}`);
    } catch (err) {
      // No requeue: a notifier that just failed would fail again, and a
      // retry loop on the alert path is worse than one lost alert.
      logWarn(
        "notify",
        `Queued admin notification failed: ${err instanceof Error ? err.message : err}; dropping: ${item.text.slice(0, 120)}`,
      );
    }
  }
}

function enqueue(item: Pending): void {
  pending.push(item);
  while (pending.length > ADMIN_NOTIFY_QUEUE_MAX) {
    const lost = pending.shift();
    droppedWhileUnwired++;
    if (lost)
      logWarn(
        "notify",
        `Admin alert queue full; dropping oldest: ${lost.text.slice(0, 120)}`,
      );
  }
}

function preview(text: string): string {
  return text.slice(0, 80).replace(/\n/g, " ");
}

/**
 * Send `text` to the admin chat. Never throws; returns whether it was
 * delivered now (false = failed, or queued because no notifier is wired
 * yet — it is sent when one is).
 */
export async function notifyAdmin(text: string): Promise<boolean> {
  if (!deliver) {
    enqueue({ text, at: Date.now() });
    logWarn(
      "notify",
      `No admin notifier wired yet; queued (${pending.length}/${ADMIN_NOTIFY_QUEUE_MAX}): ${text.slice(0, 120)}`,
    );
    return false;
  }
  try {
    await deliver(text);
    log("notify", `Admin notified: ${preview(text)}`);
    return true;
  } catch (err) {
    log(
      "notify",
      `Admin notification failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}
