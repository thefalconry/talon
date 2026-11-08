/**
 * Messaging actions — send/reply/edit/delete/pin/forward/copy/react,
 * inline-button messages, chat actions, and scheduled messages.
 */

import type { Bot } from "grammy";
import { markdownToTelegramHtml } from "../formatting.js";
import { withRetry } from "../../../core/engine/gateway.js";
import { log, logError, logWarn } from "../../../util/log.js";
import {
  saveScheduled,
  deleteScheduled,
  listScheduled,
  listScheduledForChat,
  MAX_OVERDUE_MS,
  type ScheduledMessage,
} from "../../../storage/scheduled.js";
import { sendOpts, sendText } from "./send.js";
import {
  noteRichMessageFailure,
  richMessagesAvailable,
} from "./rich-messages.js";
import { toPositiveId } from "./coerce.js";
import { captionUnits, TELEGRAM_MAX_CAPTION } from "./media.js";
import { resolveThreadId } from "../topics.js";
import { TELEGRAM_MAX_TEXT, type TelegramActionHandlers } from "./types.js";

// ── Inline keyboards ─────────────────────────────────────────────────────────

/**
 * Telegram caps `callback_data` at 64 BYTES, not characters
 * (https://core.telegram.org/bots/api#inlinekeyboardbutton). Exceeding it
 * fails the whole sendMessage with BUTTON_DATA_INVALID — the message never
 * arrives, buttons and all.
 *
 * Bytes rather than chars matters: a 21-character Japanese label is already
 * over budget, so non-Latin keyboards break far sooner than English ones.
 */
const CALLBACK_DATA_MAX_BYTES = 64;

type ButtonSpec = { text: string; url?: string; callback_data?: string };

/** The two inline-button shapes this module emits. */
type BuiltButton =
  { text: string; url: string } | { text: string; callback_data: string };

/** Byte length of `text` when UTF-8 encoded. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Longest prefix of `text` that fits `maxBytes`, never splitting a code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = utf8Bytes(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * Resolve one button's callback data.
 *
 * An EXPLICIT `callback_data` is semantic — the model dispatches on the exact
 * value it chose — so an over-long one is reported rather than truncated;
 * handing the callback handler a different string than the model expects
 * would be a silent behaviour change. The `text` fallback carries no such
 * contract, so it is truncated to fit.
 */
function callbackDataFor(
  btn: ButtonSpec,
): { data: string } | { error: string } {
  if (btn.callback_data !== undefined) {
    const bytes = utf8Bytes(btn.callback_data);
    if (bytes > CALLBACK_DATA_MAX_BYTES) {
      return {
        error:
          `callback_data for button "${btn.text}" is ${bytes} bytes; ` +
          `Telegram allows at most ${CALLBACK_DATA_MAX_BYTES}. Use a short ` +
          `token (e.g. "opt_a") and keep the wording in the button text.`,
      };
    }
    return { data: btn.callback_data };
  }
  return { data: truncateUtf8(btn.text, CALLBACK_DATA_MAX_BYTES) };
}

/**
 * Build an inline keyboard from button rows, enforcing the callback_data
 * cap. Returns an error message instead of a keyboard when the model
 * supplied explicit data that cannot be sent.
 *
 * Exported as a unit seam — every button path in this module routes
 * through it, so the cap is testable without a live Bot.
 */
export function buildInlineKeyboard(
  rows: ButtonSpec[][],
): { keyboard: BuiltButton[][] } | { error: string } {
  const keyboard: BuiltButton[][] = [];
  for (const row of rows) {
    const built: BuiltButton[] = [];
    for (const btn of row) {
      if (btn.url) {
        built.push({ text: btn.text, url: btn.url });
        continue;
      }
      const resolved = callbackDataFor(btn);
      if ("error" in resolved) return { error: resolved.error };
      built.push({ text: btn.text, callback_data: resolved.data });
    }
    keyboard.push(built);
  }
  return { keyboard };
}

// ── Scheduled sends (persistent) ─────────────────────────────────────────────

/** Longest schedulable delay: 24h. Timers re-arm from the store on boot. */
const MAX_DELAY_SEC = 24 * 60 * 60;

/** Deliver one scheduled entry (shared by the live timer and restore). */
async function fireScheduled(bot: Bot, entry: ScheduledMessage): Promise<void> {
  const chatId = Number(entry.chatId);
  // `replyTo` is stored in the owning frontend's native shape (Discord keeps
  // snowflake strings there); Telegram's API wants a number.
  const replyTo = toPositiveId(entry.replyTo);
  if (entry.rows) {
    // Validated at schedule time; rebuilt here so entries persisted by an
    // older build (or edited on disk) still can't fail the send.
    const built = buildInlineKeyboard(entry.rows);
    if ("error" in built) {
      logWarn(
        "bot",
        `Scheduled message ${entry.id} has bad buttons: ${built.error}`,
      );
      await sendText(bot, chatId, entry.text, replyTo);
      return;
    }
    const keyboard = built.keyboard;
    await sendText(bot, chatId, entry.text, replyTo, {
      inline_keyboard: keyboard,
    });
  } else {
    await sendText(bot, chatId, entry.text, replyTo);
  }
}

/** Arm a timer for a stored entry; fires, then cleans up store + map. */
function armScheduled(
  bot: Bot,
  entry: ScheduledMessage,
  timers: Map<string, ReturnType<typeof setTimeout>>,
): void {
  const delayMs = Math.max(0, entry.fireAt - Date.now());
  const timer = setTimeout(async () => {
    try {
      await fireScheduled(bot, entry);
    } catch (err) {
      logError("bot", `Scheduled message failed (chat=${entry.chatId})`, err);
    }
    deleteScheduled(entry.id);
    timers.delete(entry.id);
  }, delayMs);
  timers.set(entry.id, timer);
}

/**
 * Re-arm persisted scheduled sends after a restart. Called once when
 * the action handler is created. Overdue entries fire immediately —
 * late beats never — unless they are stale past MAX_OVERDUE_MS, which
 * drops them (a day-late reminder is noise, not delivery).
 */
export function restoreScheduledMessages(
  bot: Bot,
  timers: Map<string, ReturnType<typeof setTimeout>>,
): void {
  const entries = listScheduled("telegram");
  if (entries.length === 0) return;
  let restored = 0;
  let dropped = 0;
  for (const entry of entries) {
    if (Date.now() - entry.fireAt > MAX_OVERDUE_MS) {
      deleteScheduled(entry.id);
      dropped++;
      continue;
    }
    armScheduled(bot, entry, timers);
    restored++;
  }
  log(
    "bot",
    `Restored ${restored} scheduled message(s) from store${dropped > 0 ? `, dropped ${dropped} stale` : ""}`,
  );
}

export const messagingHandlers: TelegramActionHandlers = {
  send_message: async (body, chatId, { bot, gateway }) => {
    const text = String(body.text ?? "");
    const replyTo = toPositiveId(body.reply_to_message_id);
    gateway.incrementMessages(chatId);
    const extra = {
      ...sendOpts(body, chatId),
      link_preview_options:
        body.no_link_preview === true ? { is_disabled: true } : undefined,
    };
    const msgId = await withRetry(() =>
      sendText(bot, chatId, text, replyTo, undefined, extra),
    );
    return { ok: true, message_id: msgId };
  },

  reply_to: async (body, chatId, { bot, gateway }) => {
    const msgId = Number(body.message_id);
    gateway.incrementMessages(chatId);
    const sentId = await withRetry(() =>
      sendText(bot, chatId, String(body.text ?? ""), msgId),
    );
    return { ok: true, message_id: sentId };
  },

  react: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const emoji = String(body.emoji ?? "👍");
    try {
      await withRetry(() =>
        bot.api.setMessageReaction(chatId, Number(body.message_id), [
          { type: "emoji", emoji: emoji as "👍" },
        ]),
      );
    } catch (err) {
      logWarn(
        "bot",
        `Custom emoji reaction failed, falling back to 👍: ${err instanceof Error ? err.message : err}`,
      );
      try {
        await bot.api.setMessageReaction(chatId, Number(body.message_id), [
          { type: "emoji", emoji: "👍" },
        ]);
      } catch (e) {
        return {
          ok: false,
          error: `Reaction failed: ${e instanceof Error ? e.message : e}`,
        };
      }
    }
    return { ok: true };
  },

  edit_message: async (body, chatId, { bot }) => {
    const text = String(body.text ?? "");
    if (text.length > TELEGRAM_MAX_TEXT)
      return {
        ok: false,
        error: `Text too long (max ${TELEGRAM_MAX_TEXT})`,
      };
    // Media messages have captions, not text — editMessageText on them fails
    // with "there is no text in the message to edit".
    if (body.is_caption === true) {
      // An edit cannot spill into a follow-up message the way a send does,
      // so refuse up front with guidance rather than a raw Bot API 400.
      const units = captionUnits(text);
      if (units > TELEGRAM_MAX_CAPTION)
        return {
          ok: false,
          error: `Caption too long (${units} chars, max ${TELEGRAM_MAX_CAPTION}) — shorten it, or send the rest as a separate message`,
        };
      await withRetry(async () => {
        try {
          await bot.api.editMessageCaption(chatId, Number(body.message_id), {
            caption: markdownToTelegramHtml(text),
            parse_mode: "HTML",
          });
        } catch {
          await bot.api.editMessageCaption(chatId, Number(body.message_id), {
            caption: text,
          });
        }
      });
      return { ok: true };
    }
    await withRetry(async () => {
      if (richMessagesAvailable()) {
        try {
          await bot.api.editMessageText(chatId, Number(body.message_id), {
            markdown: text,
          });
          return;
        } catch (richErr) {
          noteRichMessageFailure(richErr, `edit chat=${chatId}`);
        }
      }
      try {
        await bot.api.editMessageText(
          chatId,
          Number(body.message_id),
          markdownToTelegramHtml(text),
          { parse_mode: "HTML" },
        );
      } catch {
        await bot.api.editMessageText(chatId, Number(body.message_id), text);
      }
    });
    return { ok: true };
  },

  delete_message: async (body, chatId, { bot }) => {
    // Bulk form: deleteMessages takes up to 100 ids per call and skips ids
    // it can't delete instead of failing the batch.
    if (Array.isArray(body.message_ids) && body.message_ids.length > 0) {
      const ids = body.message_ids
        .map(toPositiveId)
        .filter((n): n is number => n !== undefined);
      if (ids.length === 0)
        return { ok: false, error: "message_ids contains no valid ids" };
      for (let i = 0; i < ids.length; i += 100) {
        await bot.api.deleteMessages(chatId, ids.slice(i, i + 100));
      }
      return { ok: true, deleted: ids.length };
    }
    await bot.api.deleteMessage(chatId, Number(body.message_id));
    return { ok: true };
  },

  pin_message: async (body, chatId, { bot }) => {
    await bot.api.pinChatMessage(chatId, Number(body.message_id));
    return { ok: true };
  },

  unpin_message: async (body, chatId, { bot }) => {
    await bot.api.unpinChatMessage(
      chatId,
      body.message_id ? Number(body.message_id) : undefined,
    );
    return { ok: true };
  },

  forward_message: async (body, chatId, { bot }) => {
    // Cross-chat by explicit override; both ends default to the current
    // chat. The bot can only ever read from / deliver to chats it is in —
    // Telegram enforces membership on both ids.
    const from = Number(body.from_chat_id ?? chatId);
    const to = Number(body.to_chat_id ?? chatId);
    const ids = Array.isArray(body.message_ids)
      ? body.message_ids
          .map(toPositiveId)
          .filter((n): n is number => n !== undefined)
      : [];
    if (ids.length > 0) {
      // forwardMessages keeps album grouping and skips unfindable ids.
      const sent = await bot.api.forwardMessages(to, from, ids);
      return { ok: true, message_ids: sent.map((m) => m.message_id) };
    }
    const sent = await bot.api.forwardMessage(
      to,
      from,
      Number(body.message_id),
    );
    return { ok: true, message_id: sent.message_id };
  },

  copy_message: async (body, chatId, { bot }) => {
    const from = Number(body.from_chat_id ?? chatId);
    const to = Number(body.to_chat_id ?? chatId);
    const ids = Array.isArray(body.message_ids)
      ? body.message_ids
          .map(toPositiveId)
          .filter((n): n is number => n !== undefined)
      : [];
    if (ids.length > 0) {
      const sent = await bot.api.copyMessages(to, from, ids);
      return { ok: true, message_ids: sent.map((m) => m.message_id) };
    }
    const sent = await bot.api.copyMessage(to, from, Number(body.message_id));
    return { ok: true, message_id: sent.message_id };
  },

  send_chat_action: async (body, chatId, { bot }) => {
    await bot.api.sendChatAction(
      chatId,
      String(body.chat_action ?? "typing") as "typing",
      { message_thread_id: resolveThreadId(body, chatId) },
    );
    return { ok: true };
  },

  send_message_with_buttons: async (body, chatId, { bot, gateway }) => {
    const text = String(body.text ?? "");
    if (text.length > TELEGRAM_MAX_TEXT)
      return { ok: false, error: `Text too long` };
    const rows = body.rows as ButtonSpec[][];
    const built = buildInlineKeyboard(rows);
    if ("error" in built) return { ok: false, error: built.error };
    const keyboard = built.keyboard;
    gateway.incrementMessages(chatId);
    const messageId = await sendText(
      bot,
      chatId,
      text,
      toPositiveId(body.reply_to_message_id),
      { inline_keyboard: keyboard },
      sendOpts(body, chatId),
    );
    return { ok: true, message_id: messageId };
  },

  schedule_message: (body, chatId, { bot, scheduledMessages }) => {
    const text = String(body.text ?? "");
    const replyTo = toPositiveId(body.reply_to_message_id);
    const rows = body.rows as ScheduledMessage["rows"];
    // Validate buttons now rather than at fire time — a rejection minutes
    // later, with the turn long over, is invisible to the model.
    if (rows) {
      const built = buildInlineKeyboard(rows);
      if ("error" in built) return { ok: false, error: built.error };
    }
    // NaN (e.g. delay_seconds: "5m") must fall back to the default, not
    // propagate: setTimeout(fn, NaN) fires immediately.
    const requested = Number(body.delay_seconds ?? 60);
    const delaySec = Math.max(
      1,
      Math.min(MAX_DELAY_SEC, Number.isFinite(requested) ? requested : 60),
    );
    const entry: ScheduledMessage = {
      id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      frontend: "telegram",
      chatId: String(chatId),
      text,
      fireAt: Date.now() + delaySec * 1000,
      createdAt: Date.now(),
      replyTo,
      rows,
    };
    // Persist before arming: if we crash between the two, the restore
    // path delivers it; the reverse order could lose it forever.
    saveScheduled(entry);
    armScheduled(bot, entry, scheduledMessages);
    return { ok: true, schedule_id: entry.id, delay_seconds: delaySec };
  },

  cancel_scheduled: (body, _chatId, { scheduledMessages }) => {
    const id = String(body.schedule_id ?? "");
    const timer = scheduledMessages.get(id);
    if (timer) {
      clearTimeout(timer);
      scheduledMessages.delete(id);
    }
    // The store is the source of truth — an entry can exist without a
    // live timer (scheduled before a restart, not yet re-armed here).
    const existed = deleteScheduled(id) || Boolean(timer);
    return existed
      ? { ok: true, cancelled: true }
      : { ok: false, error: "Schedule not found" };
  },

  list_scheduled: (body, chatId) => {
    const pending = listScheduledForChat("telegram", String(chatId)).map(
      (e) => ({
        schedule_id: e.id,
        fires_in_seconds: Math.max(
          0,
          Math.round((e.fireAt - Date.now()) / 1000),
        ),
        text: e.text.length > 200 ? `${e.text.slice(0, 200)}…` : e.text,
      }),
    );
    return { ok: true, scheduled: pending, count: pending.length };
  },
};
