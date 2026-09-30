/**
 * Media actions — sending files/photos/videos/animations/voice/audio,
 * stickers, polls, locations, contacts, and dice.
 */

import type { Bot } from "grammy";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { expandFsPath } from "../../../util/fs-path.js";
import { markdownToTelegramHtml, splitMessage } from "../formatting.js";
import { withRetry } from "../../../core/engine/gateway.js";
import { logWarn } from "../../../util/log.js";
import { resolveStickerByEmoji } from "../sticker-library.js";
import { replyParams, sendOpts, sendText } from "./send.js";
import { TELEGRAM_MAX_TEXT, type TelegramActionHandlers } from "./types.js";

type MediaSource = {
  file_path?: unknown;
  url?: unknown;
  file_id?: unknown;
};

/**
 * Resolve one media input to what the Bot API accepts. Three sources, in
 * priority order: a public URL or a Telegram file_id (both passed as a plain
 * string — Telegram fetches/reuses server-side, no local bytes involved),
 * else a workspace file path uploaded as multipart.
 */
export function resolveMediaInput(
  src: MediaSource,
  label: string,
  InputFileClass: typeof import("grammy").InputFile,
): { file: string | import("grammy").InputFile } | { error: string } {
  const remote = src.url ?? src.file_id;
  if (remote) return { file: String(remote) };
  // Fail with guidance the model can act on, not a raw ENOENT: a
  // mistyped path is the most common media-send error, and naming
  // the alternatives (url / file_id) teaches the recovery path.
  if (!src.file_path)
    return {
      error: `${label}: provide file_path (workspace file), url (public), or file_id (seen in chat)`,
    };
  const filePath = expandFsPath(String(src.file_path));
  if (!existsSync(filePath))
    return {
      error: `File not found: ${filePath} — check the workspace path, or send by url/file_id instead`,
    };
  const stat = statSync(filePath);
  if (stat.size > 49 * 1024 * 1024)
    return { error: "File too large (max 49MB)" };
  const data = readFileSync(filePath);
  return { file: new InputFileClass(data, basename(filePath)) };
}

/** Telegram's hard limit on media captions, counted after entity parsing. */
export const TELEGRAM_MAX_CAPTION = 1024;
/** Visible length a truncated caption is cut to, leaving room for the "…". */
const TRUNCATED_CAPTION_LEN = 1000;

/** The text Telegram will display for an HTML caption: tags gone, entities decoded. */
export function visibleCaptionText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, ent: string) => {
      const e = ent.toLowerCase();
      if (e === "lt") return "<";
      if (e === "gt") return ">";
      if (e === "amp") return "&";
      if (e === "quot") return '"';
      if (e === "apos") return "'";
      const code = e.startsWith("#x")
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    });
}

export type FittedCaption = {
  caption?: string;
  parse_mode?: "HTML";
  /** Full caption text to deliver as a follow-up message when it was cut. */
  overflow?: string;
};

/**
 * Convert a markdown caption to what Telegram accepts. Captions over 1024
 * visible characters are rejected outright ("message caption is too long"),
 * losing the media along with them — so an oversized caption is cut to a
 * plain-text preview (no parse_mode: a cut through HTML could strand a tag
 * or entity) and the full text is returned as `overflow` for the caller to
 * send as a normal, chunked text message.
 */
export function fitCaption(raw: unknown): FittedCaption {
  if (!raw) return {};
  const text = String(raw);
  const html = markdownToTelegramHtml(text);
  const visible = visibleCaptionText(html);
  // Telegram counts UTF-16 code units, which is what .length measures.
  if (visible.length <= TELEGRAM_MAX_CAPTION)
    return { caption: html, parse_mode: "HTML" };
  let cut = visible.slice(0, TRUNCATED_CAPTION_LEN);
  // Don't strand half a surrogate pair at the cut.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { caption: `${cut.trimEnd()}…`, overflow: text };
}

/**
 * Deliver the full text of a caption that did not fit, threaded as a reply
 * to the media it belongs to. Best-effort: the media already landed, so a
 * failure here is reported as a warning rather than failing the send.
 */
async function sendCaptionOverflow(
  bot: Bot,
  chatId: number,
  text: string,
  replyTo: number,
  body: Record<string, unknown>,
): Promise<{ message_ids: number[] } | { warning: string }> {
  const ids: number[] = [];
  try {
    for (const chunk of splitMessage(text, TELEGRAM_MAX_TEXT)) {
      ids.push(
        await withRetry(() =>
          sendText(
            bot,
            chatId,
            chunk,
            replyTo,
            undefined,
            sendOpts(body, chatId),
          ),
        ),
      );
    }
    return { message_ids: ids };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      "bot",
      `Caption overflow follow-up failed (chat=${chatId}): ${msg}`,
    );
    return {
      warning: `Media sent with a truncated caption, but sending the full caption text failed: ${msg}`,
    };
  }
}

function overflowResult(
  r: { message_ids: number[] } | { warning: string },
): Record<string, unknown> {
  return "warning" in r
    ? { caption_truncated: true, warning: r.warning }
    : { caption_truncated: true, caption_message_ids: r.message_ids };
}

const sendMediaFile: TelegramActionHandlers[string] = async (
  body,
  chatId,
  { bot, InputFileClass, gateway },
) => {
  // Routed for send_file / send_photo / send_video / send_animation /
  // send_voice / send_audio — branch on the action name in the body.
  const action = String(body.action);
  const {
    caption,
    parse_mode: captionParseMode,
    overflow,
  } = fitCaption(body.caption);
  gateway.incrementMessages(chatId);
  const resolved = resolveMediaInput(body, action, InputFileClass);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const file = resolved.file;
  const rp = replyParams(body);
  const opts = sendOpts(body, chatId);
  // Spoiler blur only exists for visual media; Telegram rejects it elsewhere.
  const spoiler = body.spoiler === true || undefined;
  let sent;
  switch (action) {
    case "send_file":
      sent = await withRetry(() =>
        bot.api.sendDocument(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          ...opts,
        }),
      );
      break;
    case "send_photo":
      sent = await withRetry(() =>
        bot.api.sendPhoto(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          has_spoiler: spoiler,
          ...opts,
        }),
      );
      break;
    case "send_video":
      sent = await withRetry(() =>
        bot.api.sendVideo(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          has_spoiler: spoiler,
          ...opts,
        }),
      );
      break;
    case "send_animation":
      sent = await withRetry(() =>
        bot.api.sendAnimation(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          has_spoiler: spoiler,
          ...opts,
        }),
      );
      break;
    case "send_audio":
      sent = await withRetry(() =>
        bot.api.sendAudio(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          title: body.title as string | undefined,
          performer: body.performer as string | undefined,
          ...opts,
        }),
      );
      break;
    default:
      sent = await withRetry(() =>
        bot.api.sendVoice(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          ...opts,
        }),
      );
      break;
  }
  if (overflow) {
    const r = await sendCaptionOverflow(
      bot,
      chatId,
      overflow,
      sent.message_id,
      body,
    );
    return { ok: true, message_id: sent.message_id, ...overflowResult(r) };
  }
  return { ok: true, message_id: sent.message_id };
};

export const mediaHandlers: TelegramActionHandlers = {
  send_file: sendMediaFile,
  send_photo: sendMediaFile,
  send_video: sendMediaFile,
  send_animation: sendMediaFile,
  send_voice: sendMediaFile,
  send_audio: sendMediaFile,

  send_media_group: async (body, chatId, { bot, InputFileClass, gateway }) => {
    const items = Array.isArray(body.media) ? body.media : [];
    if (items.length < 2 || items.length > 10)
      return {
        ok: false,
        error: `Albums need 2–10 media items (got ${items.length}).`,
      };
    const spoiler = body.spoiler === true || undefined;
    type AlbumItem = {
      type: "photo" | "video" | "document" | "audio";
      media: string | import("grammy").InputFile;
      caption?: string;
      parse_mode?: "HTML";
      has_spoiler?: boolean;
    };
    const media: AlbumItem[] = [];
    const overflows: string[] = [];
    for (const [i, raw] of items.entries()) {
      const item = raw as MediaSource & { type?: unknown; caption?: unknown };
      // Telegram albums mix photos and videos; documents/audio group only
      // with their own kind. Pass the declared type through and let the API
      // reject invalid mixes with its own (clear) error.
      const type = String(item.type ?? "photo");
      if (!["photo", "video", "document", "audio"].includes(type))
        return {
          ok: false,
          error: `media[${i}]: type must be photo, video, document, or audio`,
        };
      const resolved = resolveMediaInput(item, `media[${i}]`, InputFileClass);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      const { caption, parse_mode, overflow } = fitCaption(item.caption);
      if (overflow) overflows.push(overflow);
      media.push({
        type: type as AlbumItem["type"],
        media: resolved.file,
        caption,
        parse_mode,
        ...(type === "photo" || type === "video"
          ? { has_spoiler: spoiler }
          : {}),
      });
    }
    gateway.incrementMessages(chatId);
    // The wrapper types each album as homogeneous; runtime validation above
    // plus Telegram's own mixed-group errors cover what the cast waives.
    const group = media as unknown as Parameters<
      import("grammy").Bot["api"]["sendMediaGroup"]
    >[1];
    const sent = await withRetry(() =>
      bot.api.sendMediaGroup(chatId, group, {
        reply_parameters: replyParams(body),
        ...sendOpts(body, chatId),
      }),
    );
    const messageIds = sent.map((m) => m.message_id);
    if (overflows.length > 0 && messageIds.length > 0) {
      const r = await sendCaptionOverflow(
        bot,
        chatId,
        overflows.join("\n\n"),
        messageIds[0],
        body,
      );
      return { ok: true, message_ids: messageIds, ...overflowResult(r) };
    }
    return { ok: true, message_ids: messageIds };
  },

  send_video_note: async (body, chatId, { bot, InputFileClass, gateway }) => {
    const resolved = resolveMediaInput(body, "send_video_note", InputFileClass);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    gateway.incrementMessages(chatId);
    // Round video bubbles take no caption; Telegram wants square video ≤60s.
    const sent = await withRetry(() =>
      bot.api.sendVideoNote(chatId, resolved.file, {
        reply_parameters: replyParams(body),
        ...sendOpts(body, chatId),
      }),
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_venue: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendVenue(
      chatId,
      Number(body.latitude),
      Number(body.longitude),
      String(body.title ?? ""),
      String(body.address ?? ""),
      { reply_parameters: replyParams(body), ...sendOpts(body, chatId) },
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_sticker: async (body, chatId, { bot, gateway }) => {
    // Three addressing modes: a concrete file_id, a public URL of a
    // .webp (Telegram fetches it server-side, like other media), or an
    // emoji resolved against the saved sticker library (optionally
    // pinned to one pack via set_name) — the low-friction path the
    // prompt teaches.
    let fileId = body.file_id
      ? String(body.file_id)
      : body.url
        ? String(body.url)
        : "";
    if (!fileId && body.emoji) {
      const resolved = await resolveStickerByEmoji(
        bot,
        String(body.emoji),
        body.set_name ? String(body.set_name) : undefined,
      );
      if (!resolved) {
        return {
          ok: false,
          error: `No saved sticker matches ${String(body.emoji)}${body.set_name ? ` in pack "${String(body.set_name)}"` : ""} — check the sticker library, or save a pack with save_sticker_pack.`,
        };
      }
      fileId = resolved.fileId;
    }
    if (!fileId)
      return { ok: false, error: "Required: file_id, url, or emoji" };
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendSticker(chatId, fileId, {
      reply_parameters: replyParams(body),
      ...sendOpts(body, chatId),
    });
    return { ok: true, message_id: sent.message_id };
  },

  send_poll: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendPoll(
      chatId,
      String(body.question ?? ""),
      ((body.options as string[]) ?? []).map((o) => ({ text: o })),
      {
        is_anonymous: body.is_anonymous as boolean | undefined,
        allows_multiple_answers: body.allows_multiple_answers as
          boolean | undefined,
        type: body.type as "regular" | "quiz" | undefined,
        correct_option_ids:
          body.correct_option_id != null
            ? [body.correct_option_id as number]
            : undefined,
        explanation: body.explanation as string | undefined,
        reply_parameters: replyParams(body),
        ...sendOpts(body, chatId),
      },
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_location: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendLocation(
      chatId,
      Number(body.latitude),
      Number(body.longitude),
      { reply_parameters: replyParams(body), ...sendOpts(body, chatId) },
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_contact: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendContact(
      chatId,
      String(body.phone_number),
      String(body.first_name),
      {
        last_name: body.last_name as string | undefined,
        reply_parameters: replyParams(body),
        ...sendOpts(body, chatId),
      },
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_dice: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendDice(
      chatId,
      (body.emoji as string) || "🎲",
      {
        reply_parameters: replyParams(body),
        ...sendOpts(body, chatId),
      },
    );
    return {
      ok: true,
      message_id: sent.message_id,
      value: sent.dice?.value,
    };
  },
};
