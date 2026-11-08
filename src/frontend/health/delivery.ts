/**
 * Reply delivery health — the worst silent failure is a turn that ran but
 * whose answer never reached the chat. The model sees a failed tool call;
 * the person who asked sees nothing, and so does the operator.
 *
 * Each frontend wraps its action handler with `trackDeliveries`. The
 * reply actions (`send_message`, `send_message_with_buttons`, `reply_to`)
 * are counted per chat: `DELIVERY_ALERT_AFTER` failures in a row for one
 * chat raise `delivery.<frontend>` with that chat and the error, and the
 * next success to it resolves the alert once no chat is still failing.
 */

import type { ActionResult } from "../../core/types.js";
import {
  raiseAlert,
  resolveAlert,
} from "../../core/frontend-runtime/alerts.js";
import { log, logWarn, type LogComponent } from "../../util/log.js";
import { errorText } from "./outage.js";

/** Consecutive failed replies to one chat before the operator hears of it. */
const DELIVERY_ALERT_AFTER = 3;

const REPLY_ACTIONS = new Set([
  "send_message",
  "send_message_with_buttons",
  "reply_to",
]);

export type DeliveryTracker = {
  failed(chat: string | number, err: unknown): void;
  delivered(chat: string | number): void;
};

/**
 * `label` is the operator-facing platform name ("Telegram"); the alert key
 * is `delivery.<frontend>`.
 */
export function createDeliveryTracker(
  frontend: string,
  label: string,
  component: LogComponent,
): DeliveryTracker {
  const key = `delivery.${frontend}`;
  const streaks = new Map<string, number>();
  /** Chats that crossed the threshold and have not delivered since. */
  const alerted = new Set<string>();

  return {
    failed(chat, err) {
      const id = String(chat);
      const streak = (streaks.get(id) ?? 0) + 1;
      streaks.set(id, streak);
      const error = errorText(err);
      logWarn(
        component,
        `delivery.fail frontend=${frontend} chat=${id} streak=${streak} err=${error}`,
      );
      if (streak < DELIVERY_ALERT_AFTER) return;
      alerted.add(id);
      raiseAlert(
        key,
        `${label} replies to chat ${id} have failed ${streak} times in a row: ${error}. ` +
          "Answers are not reaching that chat.",
      );
    },
    delivered(chat) {
      const id = String(chat);
      const streak = streaks.get(id);
      if (streak === undefined) return;
      streaks.delete(id);
      log(
        component,
        `delivery.recovered frontend=${frontend} chat=${id} after_failures=${streak}`,
      );
      if (alerted.delete(id) && alerted.size === 0) {
        resolveAlert(key, `${label} replies are being delivered again.`);
      }
    },
  };
}

type ActionHandler = (
  body: Record<string, unknown>,
  chatId: number,
) => Promise<ActionResult | null>;

/**
 * Wrap a frontend action handler so its reply actions feed `tracker`.
 * Results and thrown errors pass through untouched. `chatOf` names the
 * destination when an action can target a chat other than `chatId`.
 */
export function trackDeliveries(
  tracker: DeliveryTracker,
  handler: ActionHandler,
  chatOf: (body: Record<string, unknown>, chatId: number) => string | number = (
    _body,
    chatId,
  ) => chatId,
): ActionHandler {
  return async (body, chatId) => {
    if (!REPLY_ACTIONS.has(body.action as string)) return handler(body, chatId);
    const chat = chatOf(body, chatId);
    let result: ActionResult | null;
    try {
      result = await handler(body, chatId);
    } catch (err) {
      tracker.failed(chat, err);
      throw err;
    }
    if (result?.ok) tracker.delivered(chat);
    else if (result) tracker.failed(chat, result.error ?? "unknown error");
    return result;
  };
}
