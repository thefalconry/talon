/**
 * Outbound Telegram sends: reply-parameter extraction, delivery modifiers,
 * and text delivery with native Rich Markdown and legacy HTML / plain-text
 * fallbacks.
 */

import type { Bot } from "grammy";
import { markdownToTelegramHtml } from "../formatting.js";
import { logWarn } from "../../../util/log.js";
import { ambientThreadId, resolveThreadId } from "../topics.js";
import { TELEGRAM_MAX_TEXT } from "./types.js";
import { toPositiveId } from "./coerce.js";
import {
  noteRichMessageFailure,
  richMessagesAvailable,
} from "./rich-messages.js";
import { createDeliveryTracker } from "../../health/delivery.js";
import { recordOutgoingText } from "./outgoing-log.js";

/** Reply delivery streaks — shared by the reply actions and text blocks. */
export const telegramDelivery = createDeliveryTracker(
  "telegram",
  "Telegram",
  "bot",
);

export function replyParams(
  body: Record<string, unknown>,
): ReplyParams | undefined {
  return replyParamsFor(
    toPositiveId(body.reply_to ?? body.reply_to_message_id),
  );
}

export type ReplyParams = {
  message_id: number;
  allow_sending_without_reply: true;
};

/**
 * Build `reply_parameters` for an outbound send. Always allows sending
 * without the reply: the target message may have been deleted by the time
 * we send (fast-moving groups, cleanup bots), and without this flag
 * Telegram 400s the whole send — every formatting-level fallback then
 * fails identically and the message is lost. A send that arrives
 * un-linked beats one that never arrives.
 */
export function replyParamsFor(
  replyTo: number | undefined,
): ReplyParams | undefined {
  return replyTo !== undefined && replyTo > 0
    ? { message_id: replyTo, allow_sending_without_reply: true }
    : undefined;
}

/** Delivery modifiers shared by every outbound send. */
export type ExtraSendOptions = {
  message_thread_id?: number;
  disable_notification?: boolean;
  protect_content?: boolean;
  link_preview_options?: { is_disabled: boolean };
};

/**
 * Extract the delivery modifiers from an action body: forum topic (explicit
 * `thread_id` beats the chat's ambient one), `silent` (no notification sound),
 * and `protect` (no forwarding/saving). Spread into any Bot API send options.
 */
export function sendOpts(
  body: Record<string, unknown>,
  chatId: number,
): ExtraSendOptions {
  return {
    message_thread_id: resolveThreadId(body, chatId),
    disable_notification: body.silent === true || undefined,
    protect_content: body.protect === true || undefined,
  };
}

export async function sendText(
  bot: Bot,
  chatId: number,
  text: string,
  replyTo?: number,
  replyMarkup?: NonNullable<
    Parameters<Bot["api"]["sendRichMessage"]>[2]
  >["reply_markup"],
  extra?: ExtraSendOptions,
): Promise<number> {
  if (text.length > TELEGRAM_MAX_TEXT) {
    throw new Error(
      `Message too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT}).`,
    );
  }

  // Default to the chat's ambient forum topic so every text path — commands,
  // menus, scheduled replays — stays in the topic the conversation is in.
  // An explicit `extra` (from sendOpts) already resolved this.
  const opts: ExtraSendOptions = extra ?? {
    message_thread_id: ambientThreadId(chatId),
  };

  if (richMessagesAvailable()) {
    try {
      const sent = await bot.api.sendRichMessage(
        chatId,
        { markdown: text },
        {
          reply_parameters: replyParamsFor(replyTo),
          reply_markup: replyMarkup,
          ...opts,
        },
      );
      recordOutgoingText(chatId, sent.message_id, text);
      return sent.message_id;
    } catch (err) {
      noteRichMessageFailure(err, `send chat=${chatId}`);
    }
  }

  const html = markdownToTelegramHtml(text);
  try {
    const sent = await bot.api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      reply_parameters: replyParamsFor(replyTo),
      reply_markup: replyMarkup,
      ...opts,
    });
    recordOutgoingText(chatId, sent.message_id, text);
    return sent.message_id;
  } catch (err) {
    logWarn(
      "bot",
      `Legacy HTML send failed; retrying as plain text (chat=${chatId}): ${err instanceof Error ? err.message : err}`,
    );
    const sent = await bot.api.sendMessage(chatId, text, {
      reply_parameters: replyParamsFor(replyTo),
      reply_markup: replyMarkup,
      ...opts,
    });
    recordOutgoingText(chatId, sent.message_id, text);
    return sent.message_id;
  }
}
