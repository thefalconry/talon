/**
 * Messaging actions — text sends, replies, reactions, edits, deletes,
 * forwards, pins, presence, and scheduled sends.
 *
 * Every message-addressed action goes through the message store: the
 * model names a message by Talon's numeric id, WhatsApp needs the whole
 * key, and `resolveKey` is the single place that translation happens.
 */

import { randomUUID } from "node:crypto";
import { proto } from "baileys";
import { log } from "../../../util/log.js";
import { toWhatsAppText } from "../formatting.js";
import { lookupMessage, resolveKey } from "../messages/message-store.js";
import { recordPin, listPins, forgetPin } from "../messages/pins.js";
import { tryAction } from "./try-action.js";
import { resolveQuoted, sendContent, sendText, boundedSend } from "./send.js";
import type { WhatsAppActionHandlers } from "./types.js";

/** The tool schema's documented ceiling (1-86400), as telegram/discord clamp. */
const MAX_DELAY_SEC = 24 * 60 * 60;

/** WhatsApp keeps a pin for 24h, 7d, or 30d — no indefinite option. */
const PIN_DURATIONS = [86_400, 604_800, 2_592_000] as const;

/** Presence strings the `send_chat_action` verbs map onto. */
const PRESENCE_BY_ACTION: Record<string, "composing" | "recording" | "paused"> =
  {
    typing: "composing",
    upload_photo: "composing",
    upload_document: "composing",
    upload_video: "composing",
    record_voice: "recording",
    record_audio: "recording",
    upload_voice: "recording",
    upload_audio: "recording",
    cancel: "paused",
  };

export const messagingHandlers: WhatsAppActionHandlers = {
  send_message: (body, _chatId, ctx) =>
    tryAction("send_message", async () => {
      const text = String(body.text ?? "");
      if (!text.trim()) return { ok: true };
      return sendText(
        ctx,
        ctx.chat!,
        text,
        resolveQuoted(body, ctx.chat!.chatId),
      );
    }),

  /**
   * WhatsApp reserves interactive buttons for Business API senders, so a
   * personal account renders the choices as a numbered list. The user can
   * still answer ("2"), which is what the buttons were for.
   */
  send_message_with_buttons: (body, _chatId, ctx) =>
    tryAction("send_message_with_buttons", async () => {
      const text = String(body.text ?? "");
      const rows = (body.rows ?? body.buttons) as
        | Array<Array<{ text?: string; url?: string; callback_data?: string }>>
        | undefined;
      const options = (rows ?? [])
        .flat()
        .map((button, index) => {
          const label = String(button.text ?? "").trim();
          if (!label) return null;
          return button.url
            ? `${index + 1}. ${label} — ${button.url}`
            : `${index + 1}. ${label}`;
        })
        .filter((line): line is string => line !== null);
      const composed = options.length
        ? `${text}\n\n${options.join("\n")}`
        : text;
      if (!composed.trim()) return { ok: true };
      return sendText(
        ctx,
        ctx.chat!,
        composed,
        resolveQuoted(body, ctx.chat!.chatId),
      );
    }),

  react: (body, _chatId, ctx) =>
    tryAction("react", async () => {
      const resolved = resolveKey(body.message_id, ctx.chat!.chatId);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      // An empty emoji clears the reaction — WhatsApp's own semantics,
      // and the only way to take one back.
      await boundedSend("react", () =>
        ctx.sock.sendMessage(ctx.chat!.jid, {
          react: { text: String(body.emoji ?? ""), key: resolved.key },
        }),
      );
      return { ok: true };
    }),

  edit_message: (body, _chatId, ctx) =>
    tryAction("edit_message", async () => {
      const resolved = resolveKey(body.message_id, ctx.chat!.chatId);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      const text = String(body.text ?? "");
      if (!text.trim()) {
        return { ok: false, error: "edit_message: text is required" };
      }
      await boundedSend("edit", () =>
        ctx.sock.sendMessage(ctx.chat!.jid, {
          text: toWhatsAppText(text),
          edit: resolved.key,
        }),
      );
      return { ok: true, message_id: resolved.stored.msgId };
    }),

  delete_message: (body, _chatId, ctx) =>
    tryAction("delete_message", async () => {
      const resolved = resolveKey(body.message_id, ctx.chat!.chatId);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      await boundedSend("delete", () =>
        ctx.sock.sendMessage(ctx.chat!.jid, { delete: resolved.key }),
      );
      forgetPin(ctx.chat!.chatId, resolved.stored.msgId);
      return { ok: true };
    }),

  forward_message: (body, _chatId, ctx) =>
    tryAction("forward_message", async () => {
      const resolved = resolveKey(
        body.message_id ?? body.from_message_id,
        ctx.chat!.chatId,
      );
      if ("error" in resolved) return { ok: false, error: resolved.error };
      const message = resolved.stored.message;
      if (!message) {
        return {
          ok: false,
          error: `Message ${resolved.stored.msgId} is no longer retained in full — cannot forward`,
        };
      }
      return sendContent(ctx, ctx.chat!, { forward: message });
    }),

  /**
   * WhatsApp has no server-side copy, so a copy is a fresh send of the
   * stored text — which is what "copy without attribution" means anyway.
   */
  copy_message: (body, _chatId, ctx) =>
    tryAction("copy_message", async () => {
      const resolved = resolveKey(
        body.message_id ?? body.from_message_id,
        ctx.chat!.chatId,
      );
      if ("error" in resolved) return { ok: false, error: resolved.error };
      const text = String(body.caption ?? resolved.stored.text ?? "");
      if (!text.trim()) {
        return {
          ok: false,
          error: `Message ${resolved.stored.msgId} has no text to copy`,
        };
      }
      return sendText(ctx, ctx.chat!, text);
    }),

  pin_message: (body, _chatId, ctx) =>
    tryAction("pin_message", async () => {
      const resolved = resolveKey(body.message_id, ctx.chat!.chatId);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      // WhatsApp pins expire; pick the longest window unless asked for less.
      const requested = Number(body.seconds ?? 0);
      const time =
        PIN_DURATIONS.find((d) => d >= requested) ??
        PIN_DURATIONS[PIN_DURATIONS.length - 1];
      await boundedSend("pin", () =>
        ctx.sock.sendMessage(ctx.chat!.jid, {
          pin: resolved.key,
          type: proto.PinInChat.Type.PIN_FOR_ALL,
          time,
        }),
      );
      recordPin(ctx.chat!.chatId, resolved.stored);
      return { ok: true };
    }),

  unpin_message: (body, _chatId, ctx) =>
    tryAction("unpin_message", async () => {
      const resolved = resolveKey(body.message_id, ctx.chat!.chatId);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      await boundedSend("unpin", () =>
        ctx.sock.sendMessage(ctx.chat!.jid, {
          pin: resolved.key,
          type: proto.PinInChat.Type.UNPIN_FOR_ALL,
        }),
      );
      forgetPin(ctx.chat!.chatId, resolved.stored.msgId);
      return { ok: true };
    }),

  /**
   * WhatsApp exposes no "list pinned" query, so this reports the pins
   * this process placed — the ones the model itself is responsible for.
   */
  get_pinned_messages: (_body, _chatId, ctx) => {
    const pins = listPins(ctx.chat!.chatId);
    return {
      ok: true,
      text: pins.length
        ? pins
            .map(
              (pin) =>
                `[${pin.senderName || "?"}] msg_id:${pin.msgId}: ${pin.text.slice(0, 200)}`,
            )
            .join("\n")
        : "No messages pinned by Talon in this chat.",
    };
  },

  send_chat_action: (body, _chatId, ctx) =>
    tryAction("send_chat_action", async () => {
      const requested = String(
        body.action_type ?? body.chat_action ?? "typing",
      );
      const presence = PRESENCE_BY_ACTION[requested] ?? "composing";
      await ctx.sock.sendPresenceUpdate(presence, ctx.chat!.jid);
      return { ok: true };
    }),

  // ── Scheduled sends ──────────────────────────────────────────────────
  // WhatsApp has no server-side scheduling, so the daemon holds the timer
  // (same shape as the telegram/discord frontends).
  schedule_message: (body, _chatId, ctx) =>
    tryAction("schedule_message", async () => {
      const text = String(body.text ?? "");
      const requested = Number(body.delay_seconds ?? 0);
      if (!text.trim()) {
        return { ok: false, error: "schedule_message: text is required" };
      }
      if (!Number.isFinite(requested) || requested <= 0) {
        return {
          ok: false,
          error: "schedule_message: delay_seconds must be a positive number",
        };
      }
      // Past setTimeout's 2^31-1 ms (~24.8 days) the timer fires at once.
      const seconds = Math.min(MAX_DELAY_SEC, requested);
      const id = randomUUID();
      const chat = ctx.chat!;
      const timer = setTimeout(() => {
        ctx.scheduledMessages.delete(id);
        void sendText(ctx, chat, text).catch(() => {});
      }, seconds * 1000);
      timer.unref?.();
      ctx.scheduledMessages.set(id, timer);
      log(
        "whatsapp",
        `Scheduled message ${id} for ${chat.chatId} in ${seconds}s`,
      );
      return { ok: true, id, text: `Scheduled in ${seconds}s (id ${id})` };
    }),

  cancel_scheduled: (body, _chatId, ctx) => {
    const id = String(body.id ?? "");
    const timer = ctx.scheduledMessages.get(id);
    if (!timer) return { ok: false, error: `No scheduled message ${id}` };
    clearTimeout(timer);
    ctx.scheduledMessages.delete(id);
    return { ok: true };
  },

  list_scheduled: (_body, _chatId, ctx) => ({
    ok: true,
    text: ctx.scheduledMessages.size
      ? [...ctx.scheduledMessages.keys()].join("\n")
      : "No scheduled messages.",
  }),

  /** Served from the message store — WhatsApp has no fetch-by-id API. */
  get_message_by_id: (body, _chatId, ctx) => {
    const raw = body.message_id;
    const msgId = typeof raw === "number" ? raw : Number(raw);
    const stored = Number.isFinite(msgId) ? lookupMessage(msgId) : undefined;
    if (!stored || stored.chatId !== ctx.chat!.chatId) {
      return { ok: false, error: `Unknown message_id ${String(raw)}` };
    }
    return {
      ok: true,
      text: `[${stored.senderName || "?"}] msg_id:${stored.msgId}: ${stored.text}`,
    };
  },
};
