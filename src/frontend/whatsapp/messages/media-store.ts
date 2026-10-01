/**
 * Inbound media persistence.
 *
 * WhatsApp media arrives encrypted and is fetched over HTTP with keys
 * from the message itself; Baileys' `downloadMediaMessage` does that
 * exchange. Everything it yields is written into the workspace uploads
 * dir and indexed like Telegram's, so `list_media`, the media index, and
 * the model's file tools all see WhatsApp attachments as ordinary files.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadMediaMessage, type WAMessage } from "baileys";
import { makeWaLogger } from "../connection/wa-logger.js";
import { addMedia } from "../../../storage/media-index.js";
import { logWarn } from "../../../util/log.js";
import { dirs } from "../../../util/paths.js";

/** Media kinds Talon's index understands, keyed by WhatsApp message field. */
const MEDIA_KINDS = [
  ["imageMessage", "photo", "jpg"],
  ["videoMessage", "video", "mp4"],
  ["audioMessage", "voice", "ogg"],
  ["documentMessage", "document", "bin"],
  ["stickerMessage", "sticker", "webp"],
] as const;

export type SavedMedia = {
  filePath: string;
  type: "photo" | "video" | "voice" | "document" | "sticker";
  caption?: string;
};

/**
 * How to recover media WhatsApp's CDN no longer serves. Media URLs expire
 * (days to weeks); `reuploadRequest` — the socket's `updateMediaMessage`
 * — asks the sender's device to upload the file again and returns the
 * refreshed message, which Baileys then downloads.
 */
export type MediaRetrieval = {
  reuploadRequest: (message: WAMessage) => Promise<WAMessage>;
};

/** The media kind carried by a message, if any. */
function mediaKindOf(
  message: WAMessage,
): (typeof MEDIA_KINDS)[number] | undefined {
  const content = message.message;
  if (!content) return undefined;
  return MEDIA_KINDS.find(([field]) => field in content && content[field]);
}

/**
 * Download a message's media into the workspace and index it. Returns
 * undefined when the message carries none; a failed download logs and
 * returns undefined rather than throwing — a message whose picture
 * didn't fetch is still a message worth handling.
 */
export async function saveInboundMedia(
  message: WAMessage,
  chatId: string,
  msgId: number,
  senderName: string,
  retrieval?: MediaRetrieval,
): Promise<SavedMedia | undefined> {
  const kind = mediaKindOf(message);
  if (!kind) return undefined;
  const [field, type, defaultExt] = kind;

  try {
    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      retrieval
        ? { reuploadRequest: retrieval.reuploadRequest, logger: makeWaLogger() }
        : undefined,
    );
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return undefined;

    const content = message.message?.[field] as
      | {
          mimetype?: string | null;
          fileName?: string | null;
          caption?: string | null;
        }
      | undefined;
    // Prefer the sender's own filename for documents; otherwise name the
    // file after the message so the workspace stays traceable.
    const ext =
      content?.fileName?.includes(".") === true
        ? content.fileName.slice(content.fileName.lastIndexOf(".") + 1)
        : (content?.mimetype?.split("/")[1]?.split(";")[0] ?? defaultExt);
    mkdirSync(dirs.uploads, { recursive: true });
    const filePath = join(dirs.uploads, `wa_${chatId}_${msgId}.${ext}`);
    writeFileSync(filePath, buffer);

    const caption = content?.caption ?? undefined;
    // addMedia may dedupe onto an existing identical file and delete
    // this download — report the path it resolves to.
    const savedPath = await addMedia({
      chatId,
      msgId,
      senderName,
      type,
      filePath,
      timestamp: Date.now(),
      ...(caption ? { caption } : {}),
    });
    return { filePath: savedPath, type, ...(caption ? { caption } : {}) };
  } catch (err) {
    logWarn(
      "whatsapp",
      `Media download failed for msg ${msgId}: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}
