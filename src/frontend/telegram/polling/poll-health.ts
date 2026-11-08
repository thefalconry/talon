/**
 * Long-poll health — the operator hears when the bot stops receiving.
 *
 * grammY retries a failed getUpdates forever (3s apart, or Telegram's
 * `retry_after`) and logs nothing outside its debug channel, so a bot cut
 * off from api.telegram.org used to look exactly like a quiet day. This
 * transformer watches every getUpdates grammY makes:
 *
 *   - each failure is logged with its attempt number, the time down so far,
 *     grammY's backoff and the error; failures that persist for
 *     `POLL_OUTAGE_MS` raise `telegram.polling`, and the next successful
 *     poll resolves it;
 *   - 409 Conflict (another process polling the same token) and 401 (token
 *     rejected) end grammY's polling loop outright, so they alert at once
 *     and critically — nothing will retry them.
 *
 * Installed outermost, so it sees what grammY sees: one result per poll,
 * after the deadline and auto-retry layers have had their turn.
 */

import { GrammyError, type Transformer } from "grammy";
import {
  raiseAlert,
  resolveAlert,
} from "../../../core/frontend-runtime/alerts.js";
import { log, logError, logWarn } from "../../../util/log.js";
import { createOutage, errorText } from "../../health/outage.js";

/** Failed polls must persist this long before `telegram.polling` fires. */
const POLL_OUTAGE_MS = 5 * 60_000;
/** grammY's pause between failed getUpdates calls (bot.js handlePollingError). */
const GRAMMY_RETRY_MS = 3_000;

function backoffMs(err: unknown): number {
  if (err instanceof GrammyError && err.error_code === 429) {
    return (err.parameters.retry_after ?? 3) * 1000;
  }
  return GRAMMY_RETRY_MS;
}

export function pollHealth(thresholdMs = POLL_OUTAGE_MS): Transformer {
  const outage = createOutage({
    key: "telegram.polling",
    thresholdMs,
    describe: (err, mins) =>
      `Telegram polling has failed for ${mins} min: ${err}. Messages are not being received.`,
    recovered: "Telegram polling is working again.",
  });
  let conflict = false;

  const onFatal = (err: GrammyError): void => {
    const detail = errorText(err);
    logError(
      "bot",
      `telegram.poll.stopped code=${err.error_code} err=${detail}`,
    );
    if (err.error_code === 409) {
      conflict = true;
      raiseAlert(
        "telegram.conflict",
        `Another process is polling this Telegram bot token (${detail}). ` +
          "Talon has stopped receiving Telegram messages: stop the other instance, then restart Talon.",
        { severity: "critical" },
      );
    } else {
      outage.raiseNow(
        `Telegram rejected the bot token (${detail}). Talon has stopped receiving Telegram messages.`,
        "critical",
      );
    }
  };

  return async (prev, method, payload, signal) => {
    if (method !== "getUpdates") return prev(method, payload, signal);
    try {
      const res = await prev(method, payload, signal);
      const ended = outage.ok();
      if (ended) {
        log(
          "bot",
          `telegram.poll.recovered failed_attempts=${ended.attempts} down_ms=${ended.downMs}`,
        );
      }
      if (conflict) {
        conflict = false;
        resolveAlert(
          "telegram.conflict",
          "Telegram polling resumed — no other process is polling this bot token.",
        );
      }
      return res;
    } catch (err) {
      // bot.stop() cancelling the in-flight poll is a shutdown, not a fault.
      if (signal?.aborted) throw err;
      if (
        err instanceof GrammyError &&
        (err.error_code === 409 || err.error_code === 401)
      ) {
        onFatal(err);
        throw err;
      }
      const { attempt, downMs } = outage.fail(err);
      logWarn(
        "bot",
        `telegram.poll.fail attempt=${attempt} down_ms=${downMs} backoff_ms=${backoffMs(err)} err=${errorText(err)}`,
      );
      throw err;
    }
  };
}
