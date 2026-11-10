/**
 * Update-level middleware — runs for ALL messages, before handlers.
 * Records every message into the in-memory history buffer, keeps the
 * update offset / forum topic / userbot access current, and wires the
 * per-message-type handlers. `registerMiddleware` binds each piece in the
 * order grammY must see them.
 */

import type { Bot, Context, Filter, NextFunction } from "grammy";
import type { Message } from "grammy/types";
import type { TalonConfig } from "../../core/config/index.js";
import { pushMessage } from "../../storage/history.js";
import type { HistoryMessage } from "../../storage/repositories/history-repo.js";
import { allowChat, revokeChat } from "./userbot.js";
import { registerChat } from "../../core/background/pulse/pulse.js";
import { log, logWarn } from "../../util/log.js";
import { getSenderName } from "./handlers/index.js";
import { noteUpdateId } from "./polling/update-offset.js";
import { noteInboundThread } from "./topics.js";
import { recordJoinRequest } from "./join-requests.js";
import { applyInboundRedaction } from "../../core/secrets/redact.js";
import {
  handleTextMessage,
  handlePhotoMessage,
  handleDocumentMessage,
  handleVoiceMessage,
  handleStickerMessage,
  handleVideoMessage,
  handleAnimationMessage,
  handleAudioMessage,
  handleVideoNoteMessage,
} from "./handlers/index.js";

// ── Update-offset tracking (every update, before anything else) ──────────
// Telegram redelivers any update whose id was never confirmed; the
// shutdown path confirms this one so a process-ending command can't be
// served twice. See polling/update-offset.ts.
function trackUpdateOffset(ctx: Context, next: NextFunction): Promise<void> {
  noteUpdateId(ctx.update.update_id);
  return next();
}

type HistoryEntry = Pick<
  HistoryMessage,
  "text" | "mediaType" | "stickerFileId"
>;

/** The media kinds history records, checked in this order. */
function mediaHistoryEntry(message: Message): HistoryEntry | undefined {
  if ("photo" in message && message.photo) {
    return { text: message.caption || "(photo)", mediaType: "photo" };
  }
  if ("document" in message && message.document) {
    const name = message.document.file_name || "file";
    return { text: message.caption || `(sent ${name})`, mediaType: "document" };
  }
  if ("voice" in message && message.voice) {
    return { text: "(voice message)", mediaType: "voice" };
  }
  if ("sticker" in message && message.sticker) {
    return {
      text: message.sticker.emoji || "(sticker)",
      mediaType: "sticker",
      stickerFileId: message.sticker.file_id,
    };
  }
  if ("video" in message && message.video) {
    return { text: message.caption || "(video)", mediaType: "video" };
  }
  if ("animation" in message && message.animation) {
    return { text: message.caption || "(GIF)", mediaType: "animation" };
  }
  if ("audio" in message && message.audio) {
    const title = message.audio.title || message.audio.file_name || "audio";
    return {
      text: message.caption || `(audio: ${title})`,
      mediaType: "document", // treat audio like documents in history
    };
  }
  if ("video_note" in message && message.video_note) {
    return { text: "(video note)", mediaType: "video" };
  }
  return undefined;
}

/** The history row's content for one inbound message; nothing for kinds
 * history doesn't record. */
function historyEntryFor(message: Message): HistoryEntry | undefined {
  if ("text" in message && message.text) {
    return { text: message.text };
  }
  const media = mediaHistoryEntry(message);
  if (media) return media;
  if ("location" in message && message.location) {
    return {
      text: `(shared location: ${message.location.latitude}, ${message.location.longitude})`,
    };
  }
  if ("contact" in message && message.contact) {
    const name = [message.contact.first_name, message.contact.last_name]
      .filter(Boolean)
      .join(" ");
    return { text: `(shared contact: ${name})` };
  }
  return undefined;
}

// ── Credential redaction (before history, handlers and the model) ───────
// Rewrites the message's text/caption in place, so every later reader —
// history, interaction logs, traces, the prompt — sees only the
// `[REDACTED:<kind>]` form. See core/secrets/redact.ts.
export function makeRedactCredentials(config: TalonConfig) {
  return async (
    ctx: Filter<Context, "message">,
    next: NextFunction,
  ): Promise<void> => {
    const message = ctx.message as { text?: string; caption?: string };
    const field = message.text !== undefined ? "text" : "caption";
    const original = message[field];
    if (original) {
      const r = applyInboundRedaction(original, {
        chatKey: String(ctx.chat.id),
        isDm: ctx.chat.type === "private",
        config: config.redaction,
      });
      if (r.redacted) {
        message[field] = r.text;
        log(
          "bot",
          `[${ctx.chat.id}] Redacted a credential from an inbound message`,
        );
        if (r.deleteOriginal) {
          await ctx.deleteMessage().catch((err: unknown) => {
            logWarn(
              "bot",
              `Could not delete a redacted message: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
        if (r.notice) await ctx.reply(r.notice).catch(() => {});
      }
    }
    return next();
  };
}

// ── History capture (runs for ALL messages, before handlers) ─────────────
function captureHistory(
  ctx: Filter<Context, "message">,
  next: NextFunction,
): Promise<void> {
  const chatId = String(ctx.chat.id);
  const sender = getSenderName(ctx.from);
  // Keep the ambient forum topic current so outbound sends (which have no
  // reply anchor — drafts, media, plain sends) land in the topic the
  // conversation is actually happening in, not General.
  noteInboundThread(ctx.chat.id, ctx.message);
  // The handle is the only addressable form of a user — persist it with
  // every row so later readers (history views, heartbeat-composed
  // messages) can mention someone instead of guessing.
  const senderHandle = ctx.from?.username;
  const senderId = ctx.from?.id ?? 0;
  const msgId = ctx.message.message_id;
  const replyToMsgId = ctx.message.reply_to_message?.message_id;

  // Register this chat for userbot access
  allowChat(ctx.chat.id);
  // Only register groups for pulse (DMs don't need it — bot always responds)
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  if (isGroup) registerChat(chatId);
  const timestamp = ctx.message.date * 1000;

  const entry = historyEntryFor(ctx.message);
  if (entry) {
    pushMessage(chatId, {
      msgId,
      senderId,
      senderName: sender,
      senderHandle,
      replyToMsgId,
      timestamp,
      ...entry,
    });
  }

  return next();
}

// ── Join requests — cache for moderate(op="list_join_requests") ─────────
// Delivered only when subscribed via allowed_updates (see index.ts) and
// the bot admins a chat whose invite link requires approval. Stored, not
// enqueued: a join request isn't a conversation turn.
function cacheJoinRequest(ctx: Filter<Context, "chat_join_request">): void {
  const req = ctx.chatJoinRequest;
  recordJoinRequest(ctx.chat.id, {
    userId: req.from.id,
    name: getSenderName(req.from),
    username: req.from.username,
    bio: req.bio,
    at: Date.now(),
  });
  log(
    "bot",
    `Join request for chat ${ctx.chat.id} from ${req.from.id} (@${req.from.username ?? "?"})`,
  );
}

// ── Bot removed from group — revoke userbot access ─────────────────────
function revokeOnRemoval(ctx: Filter<Context, "my_chat_member">): void {
  const newStatus = ctx.myChatMember.new_chat_member.status;
  if (newStatus === "left" || newStatus === "kicked") {
    const chatId = ctx.chat.id;
    revokeChat(chatId);
    log("bot", `Removed from chat ${chatId} — revoked userbot access`);
  }
}

// ── Message handlers (delegated to handlers.ts) ──────────────────────────
function registerMessageHandlers(bot: Bot, config: TalonConfig): void {
  bot.on("message:text", (ctx) => handleTextMessage(ctx, bot, config));
  bot.on("message:photo", (ctx) => handlePhotoMessage(ctx, bot, config));
  bot.on("message:document", (ctx) => handleDocumentMessage(ctx, bot, config));
  bot.on("message:voice", (ctx) => handleVoiceMessage(ctx, bot, config));
  bot.on("message:sticker", (ctx) => handleStickerMessage(ctx, bot, config));
  bot.on("message:video", (ctx) => handleVideoMessage(ctx, bot, config));
  bot.on("message:animation", (ctx) =>
    handleAnimationMessage(ctx, bot, config),
  );
  bot.on("message:audio", (ctx) => handleAudioMessage(ctx, bot, config));
  bot.on("message:video_note", (ctx) =>
    handleVideoNoteMessage(ctx, bot, config),
  );
}

export function registerMiddleware(bot: Bot, config: TalonConfig): void {
  bot.use(trackUpdateOffset);
  bot.on("message", makeRedactCredentials(config));
  bot.on("message", captureHistory);
  bot.on("chat_join_request", cacheJoinRequest);
  bot.on("my_chat_member", revokeOnRemoval);
  registerMessageHandlers(bot, config);
}
