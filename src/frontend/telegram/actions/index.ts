/**
 * Telegram-specific action handlers.
 *
 * Handles MCP tool actions that require the Telegram Bot API. Platform-agnostic
 * actions (cron, fetch_url, history) are handled by
 * core/engine/gateway-actions before this is called.
 *
 * Split by responsibility:
 *   - `shared`    — replyParams + sendText
 *   - `messaging` — send/reply/edit/delete/pin/forward/react/schedule/buttons
 *   - `media`     — files/photos/videos/stickers/polls/locations/contacts/dice
 *   - `chat-info` — chat metadata, userbot history, sticker-pack mgmt, downloads
 *
 * `createTelegramActionHandler` merges the per-domain handler maps into one
 * registry and dispatches on `body.action`, preserving the original factory's
 * signature and per-instance `scheduledMessages` timer state.
 */

import type { Bot, InputFile as GrammyInputFile } from "grammy";
import type { Gateway } from "../../../core/engine/gateway.js";
import type { ActionResult } from "../../../core/types.js";
import { messagingHandlers, restoreScheduledMessages } from "./messaging.js";
import { mediaHandlers } from "./media.js";
import { chatInfoHandlers } from "./chat-info.js";
import { moderationHandlers } from "./moderation/index.js";
import type { TelegramActionContext, TelegramActionHandlers } from "./types.js";
import { trackDeliveries } from "../../health/delivery.js";
import { telegramDelivery } from "./send.js";

export { sendText } from "./send.js";

// Null-prototype so a request `action` of "toString" / "constructor" / etc.
// can't resolve an inherited Object.prototype method via `handlers[action]`.
const handlers: TelegramActionHandlers = Object.assign(Object.create(null), {
  ...messagingHandlers,
  ...mediaHandlers,
  ...chatInfoHandlers,
  ...moderationHandlers,
});

/**
 * Create a Telegram action handler bound to a specific bot instance.
 * Returns a FrontendActionHandler that the gateway calls for Telegram-specific actions.
 */
export function createTelegramActionHandler(
  bot: Bot,
  InputFileClass: typeof GrammyInputFile,
  botToken: string,
  gateway: Gateway,
) {
  const ctx: TelegramActionContext = {
    bot,
    InputFileClass,
    botToken,
    gateway,
    scheduledMessages: new Map<string, ReturnType<typeof setTimeout>>(),
  };

  // Re-arm scheduled sends that were persisted before the last
  // shutdown — the timers died with the process, the store didn't.
  restoreScheduledMessages(bot, ctx.scheduledMessages);

  const dispatch = async (
    body: Record<string, unknown>,
    chatId: number,
  ): Promise<ActionResult | null> => {
    const action = body.action as string;
    const handler = handlers[action];
    if (!handler) return null; // not a Telegram action
    return handler(body, chatId, ctx);
  };
  return trackDeliveries(telegramDelivery, dispatch);
}
