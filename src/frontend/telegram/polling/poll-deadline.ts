/**
 * Long-poll deadline — the reason the bot went deaf until restarted.
 *
 * grammY's client aborts an API call only after `timeoutSeconds`, which
 * defaults to 500. A getUpdates whose TCP connection is silently dropped
 * (no FIN, no RST — the peer or a middlebox just stops answering) sits in
 * kernel retransmit backoff for that whole window, and nothing else polls
 * meanwhile: every incoming message queues at Telegram. Observed live on
 * 2026-09-24 — an IPv6 socket to api.telegram.org stalled with 312 bytes
 * unacked while fresh connections worked instantly.
 *
 * A healthy getUpdates answers within its own `timeout` (the long-poll
 * window, grammY default 30s), so anything well past that is a dead
 * connection. This transformer gives each getUpdates attempt a deadline of
 * that window plus a grace; on expiry the fetch aborts, grammY treats it as
 * a network error, and re-polls on a fresh connection 3s later. Other
 * methods keep the client default — uploads can legitimately run long.
 */

import type { Transformer } from "grammy";
import { logWarn } from "../../../util/log.js";

/** grammY's long-poll window when bot.start() is given none. */
const DEFAULT_POLL_TIMEOUT_S = 30;
/** Slack past the poll window before a connection is declared dead. */
const POLL_GRACE_S = 15;

export function pollDeadline(graceSeconds = POLL_GRACE_S): Transformer {
  return (prev, method, payload, signal) => {
    if (method !== "getUpdates") return prev(method, payload, signal);
    const window =
      (payload as { timeout?: number } | undefined)?.timeout ??
      DEFAULT_POLL_TIMEOUT_S;
    const deadlineMs = (window + graceSeconds) * 1000;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const combined = signal
      ? AbortSignal.any([signal as globalThis.AbortSignal, deadline.signal])
      : deadline.signal;
    return prev(method, payload, combined as typeof signal)
      .catch((err: unknown) => {
        if (deadline.signal.aborted && !signal?.aborted) {
          logWarn(
            "bot",
            `getUpdates got no answer within ${deadlineMs / 1000}s — dropping the connection and re-polling`,
          );
        }
        throw err;
      })
      .finally(() => clearTimeout(timer));
  };
}
