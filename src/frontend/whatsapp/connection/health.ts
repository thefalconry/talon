/**
 * Connection health — the operator hears when the WhatsApp socket keeps
 * dropping instead of staying up.
 *
 * Every unexpected close is logged with its attempt number, the time the
 * connection has been unstable, the backoff before the next socket, and
 * the reason. Closes that keep coming for `CONNECTION_OUTAGE_MS` raise
 * `whatsapp.connection`. An open alone does not end the outage — a socket
 * that opens and dies again is exactly the flapping this watches for — so
 * the outage ends only once a socket has stayed open for `STABLE_OPEN_MS`.
 *
 * Unlinking is not a connection fault: the loop parks and the
 * `whatsapp.linked` alert speaks for it (connection.ts).
 */

import { log, logWarn } from "../../../util/log.js";
import { createOutage } from "../../health/outage.js";

const CONNECTION_OUTAGE_MS = 10 * 60_000;
/** How long a socket must stay open before the connection counts as stable. */
const STABLE_OPEN_MS = 60_000;

export type ConnectionHealth = {
  /** Record why the socket just closed; `reconnecting` counts it. */
  noteClose(detail: string): void;
  /** The loop will build a new socket after `backoffMs`. */
  reconnecting(backoffMs: number): void;
  opened(): void;
  /** Forget the outage without resolving it — park or shutdown. */
  dispose(): void;
};

export function createConnectionHealth(
  thresholdMs = CONNECTION_OUTAGE_MS,
  stableMs = STABLE_OPEN_MS,
): ConnectionHealth {
  const outage = createOutage({
    key: "whatsapp.connection",
    thresholdMs,
    describe: (err, mins) =>
      `The WhatsApp connection has kept dropping for ${mins} min: ${err}. ` +
      "Messages may not be received or delivered.",
    recovered: "The WhatsApp connection is stable again.",
  });
  let pending: string | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStable = (): void => {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
  };

  return {
    noteClose(detail) {
      clearStable();
      pending = detail;
    },
    reconnecting(backoffMs) {
      // A close nobody noted (515 finishing a pairing) is not a fault.
      if (pending === null) return;
      const detail = pending;
      pending = null;
      const { attempt, downMs } = outage.fail(detail);
      logWarn(
        "whatsapp",
        `connection.reconnect attempt=${attempt} down_ms=${downMs} backoff_ms=${backoffMs} err=${detail}`,
      );
    },
    opened() {
      clearStable();
      if (!outage.down) return;
      stableTimer = setTimeout(() => {
        stableTimer = null;
        const ended = outage.ok();
        if (ended) {
          log(
            "whatsapp",
            `connection.stable failed_attempts=${ended.attempts} down_ms=${ended.downMs}`,
          );
        }
      }, stableMs);
      stableTimer.unref?.();
    },
    dispose() {
      clearStable();
      pending = null;
      outage.dispose();
    },
  };
}
