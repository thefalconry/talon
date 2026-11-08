/**
 * Message-context helpers — sender name, reply/forward context strings, and
 * Telegram file downloads (with image magic-byte validation).
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../../core/config/index.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { logWarn } from "../../../util/log.js";

export function getSenderName(
  from: { first_name?: string; last_name?: string } | undefined,
): string {
  return (
    [from?.first_name, from?.last_name].filter(Boolean).join(" ") || "User"
  );
}

export function getReplyContext(
  replyMsg:
    | {
        message_id?: number;
        from?: { id: number; first_name?: string; last_name?: string };
        text?: string;
        caption?: string;
        photo?: unknown[];
        document?: unknown;
        video?: unknown;
        voice?: unknown;
        audio?: unknown;
        sticker?: unknown;
        animation?: unknown;
      }
    | undefined,
  botId: number,
  quote?: { text?: string; is_manual?: boolean } | undefined,
): string {
  if (!replyMsg) return "";

  const author =
    replyMsg.from?.id === botId
      ? "bot"
      : [replyMsg.from?.first_name, replyMsg.from?.last_name]
          .filter(Boolean)
          .join(" ") || "User";
  const text = replyMsg.text || replyMsg.caption || "";
  const msgIdTag = replyMsg.message_id ? ` msg_id:${replyMsg.message_id}` : "";

  // Detect media type
  const mediaType = replyMsg.photo
    ? "photo"
    : replyMsg.video
      ? "video"
      : replyMsg.document
        ? "document"
        : replyMsg.voice
          ? "voice"
          : replyMsg.audio
            ? "audio"
            : replyMsg.sticker
              ? "sticker"
              : replyMsg.animation
                ? "animation"
                : null;
  const mediaPart = mediaType ? ` [${mediaType}]` : "";

  // Build context — always include if there's a message_id (even if no text)
  const textPart = text ? `: "${text.slice(0, 500)}"` : "";

  // Telegram lets users highlight a specific portion of a message when
  // replying (Bot API 7.0+). When present, surface it explicitly so the model
  // sees which part the user is pointing at, not just the whole replied-to
  // message. `is_manual=false` means Telegram chose the snippet automatically
  // (long messages) — still useful signal, so include either way.
  const quoteText = quote?.text?.trim();
  const quotePart = quoteText
    ? `\n[Quoted portion: "${quoteText.slice(0, 500)}"]`
    : "";

  if (!textPart && !mediaPart && !msgIdTag && !quotePart) return "";

  return `[Replying to ${author}${textPart}${mediaPart}${msgIdTag}]${quotePart}\n\n`;
}

/**
 * If the replied-to message contains a photo, download it and return a prompt
 * line pointing to the saved file so the model can see it. Returns "" if no photo.
 */
export async function downloadReplyPhoto(
  replyMsg:
    | {
        photo?: {
          file_id: string;
          file_unique_id: string;
          width?: number;
          height?: number;
        }[];
      }
    | undefined,
  bot: Bot,
  config: TalonConfig,
): Promise<string> {
  if (!replyMsg?.photo?.length) return "";
  try {
    // Pick the largest photo size (last in array)
    const bestPhoto = replyMsg.photo[replyMsg.photo.length - 1];
    const savedPath = await downloadTelegramFile(
      bot,
      config,
      bestPhoto.file_id,
      `reply_photo_${bestPhoto.file_unique_id}.jpg`,
    );
    return `[Replied-to message contains a photo saved to: ${savedPath} — read it to view]\n`;
  } catch (err) {
    logWarn(
      "bot",
      `Failed to download reply photo: ${err instanceof Error ? err.message : err}`,
    );
    return "";
  }
}

export function getForwardContext(msg: {
  forward_origin?: {
    type: string;
    sender_user?: { first_name?: string; last_name?: string };
    sender_user_name?: string;
    chat?: { title?: string };
  };
}): string {
  const origin = msg.forward_origin;
  if (!origin) return "";
  let from = "someone";
  if (origin.type === "user" && origin.sender_user) {
    from = [origin.sender_user.first_name, origin.sender_user.last_name]
      .filter(Boolean)
      .join(" ");
  } else if (origin.type === "hidden_user" && origin.sender_user_name) {
    from = origin.sender_user_name;
  } else if (
    (origin.type === "channel" || origin.type === "chat") &&
    origin.chat
  ) {
    from = origin.chat.title || "a chat";
  }
  return `[Forwarded from ${from}]\n`;
}

/**
 * Deadline for one whole download (getFile + body). Media handlers run in
 * grammY's update loop, which handles updates one at a time, so a download
 * stalled on a dead socket holds every later message behind it.
 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

export async function downloadTelegramFile(
  bot: Bot,
  config: TalonConfig,
  fileId: string,
  fileName: string,
): Promise<string> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const file = await bot.api.getFile(
    fileId,
    signal as Parameters<Bot["api"]["getFile"]>[1],
  );
  if (!file.file_path) throw new Error("Could not get file path from Telegram");

  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

  // Guard against excessively large files (50MB limit)
  const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
  const contentLength = resp.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `File too large (${Math.round(parseInt(contentLength, 10) / 1024 / 1024)}MB, max 50MB)`,
    );
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length === 0)
    throw new Error("Downloaded file is empty (0 bytes)");

  // Validate image files — prevent saving HTML/garbage as .jpg/.png
  // (corrupt "images" poison the session permanently on resume)
  const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
  const isImageExt = imageExts.some((ext) =>
    fileName.toLowerCase().endsWith(ext),
  );
  if (isImageExt) {
    const m = buffer.subarray(0, 16);
    const validImage =
      (m[0] === 0xff && m[1] === 0xd8) || // JPEG
      (m[0] === 0x89 && m[1] === 0x50 && m[2] === 0x4e && m[3] === 0x47) || // PNG
      (m[0] === 0x47 && m[1] === 0x49 && m[2] === 0x46) || // GIF
      (m[0] === 0x52 &&
        m[1] === 0x49 &&
        m[2] === 0x46 &&
        m[3] === 0x46 &&
        m[8] === 0x57 &&
        m[9] === 0x45 &&
        m[10] === 0x42 &&
        m[11] === 0x50); // WebP
    if (!validImage) {
      throw new Error(
        `File "${fileName}" has image extension but invalid content — not saving to prevent session corruption`,
      );
    }
  }

  const uploadsDir = resolve(config.workspace, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const destPath = resolve(uploadsDir, safeName);
  writeFileSync(destPath, buffer);
  return destPath;
}
