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
import { basename, extname, join } from "node:path";
import {
  downloadMediaMessage,
  normalizeMessageContent,
  type WAMessage,
} from "baileys";
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
  /** The sender's own file name (documents). */
  fileName?: string;
  mimetype?: string;
  /** Bytes written. */
  size: number;
};

/** Extensions for MIME types whose subtype isn't one. */
const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.text": "odt",
  "text/plain": "txt",
  "text/markdown": "md",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "image/jpeg": "jpg",
};

type MediaContent = {
  mimetype?: string | null;
  fileName?: string | null;
  caption?: string | null;
};

/** A file extension for this media, from its name, its MIME type, or the kind. */
function extensionFor(content: MediaContent, defaultExt: string): string {
  const fromName = extname(content.fileName ?? "").slice(1);
  if (/^[a-z0-9]{1,8}$/i.test(fromName)) return fromName.toLowerCase();
  const mime = content.mimetype?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime];
  const subtype = mime.split("/")[1] ?? "";
  return /^[a-z0-9]{1,5}$/.test(subtype) ? subtype : defaultExt;
}

/**
 * Where a download is written: named after the chat and message so the
 * workspace stays traceable, plus the sender's own file name when there
 * is one (so "Essay.pdf" stays recognisable), always with an extension
 * the file tools and extractors can go by.
 */
export function inboundMediaFileName(
  chatId: string,
  msgId: number,
  content: MediaContent,
  defaultExt: string,
): string {
  const ext = extensionFor(content, defaultExt);
  const stem = basename(content.fileName ?? "", extname(content.fileName ?? ""))
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^[._]+/, "")
    .slice(0, 80);
  return `${chatId}_${msgId}${stem ? `-${stem}` : ""}.${ext}`;
}

/**
 * How to recover media WhatsApp's CDN no longer serves. Media URLs expire
 * (days to weeks); `reuploadRequest` — the socket's `updateMediaMessage`
 * — asks the sender's device to upload the file again and returns the
 * refreshed message, which Baileys then downloads.
 */
export type MediaRetrieval = {
  reuploadRequest: (message: WAMessage) => Promise<WAMessage>;
};

/**
 * The media kind carried by a message, if any, and its media content.
 * Looks through the wrappers WhatsApp puts around media — a document
 * with a caption arrives as `documentWithCaptionMessage`, and disappearing
 * or view-once chats wrap everything — the same way Baileys' downloader
 * does, so whatever it can fetch is recognised here too.
 */
function mediaKindOf(
  message: WAMessage,
): { kind: (typeof MEDIA_KINDS)[number]; content: MediaContent } | undefined {
  const inner = normalizeMessageContent(message.message);
  if (!inner) return undefined;
  const kind = MEDIA_KINDS.find(([field]) => inner[field]);
  if (!kind) return undefined;
  return { kind, content: inner[kind[0]] as MediaContent };
}

/** File name and MIME type of a message's media, as the sender gave them. */
export function inboundMediaMeta(message: WAMessage | undefined): {
  fileName?: string;
  mimetype?: string;
} {
  const content = message ? mediaKindOf(message)?.content : undefined;
  return {
    ...(content?.fileName ? { fileName: content.fileName } : {}),
    ...(content?.mimetype ? { mimetype: content.mimetype } : {}),
  };
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
  const found = mediaKindOf(message);
  if (!found) return undefined;
  const [, type, defaultExt] = found.kind;
  const { content } = found;

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

    mkdirSync(dirs.uploads, { recursive: true });
    const filePath = join(
      dirs.uploads,
      inboundMediaFileName(chatId, msgId, content, defaultExt),
    );
    writeFileSync(filePath, buffer);

    const caption = content.caption || undefined;
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
    return {
      filePath: savedPath,
      type,
      size: buffer.length,
      ...(caption ? { caption } : {}),
      ...(content.fileName ? { fileName: content.fileName } : {}),
      ...(content.mimetype ? { mimetype: content.mimetype } : {}),
    };
  } catch (err) {
    logWarn(
      "whatsapp",
      `Media download failed for msg ${msgId}: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}
