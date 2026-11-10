/**
 * History retrieval actions — the WhatsApp side of `get_message_by_id`
 * and `download_media`.
 *
 * Reading and searching history need nothing WhatsApp-specific: the
 * core's shared handlers serve `read_history` / `search_history` from
 * the persistent store every inbound and outbound message lands in.
 * Fetching one message by id and pulling its media do: the id has to
 * resolve to a WhatsApp key, and a file that was never saved (or has
 * since expired from the workspace) has to come back down from
 * WhatsApp — via the sender's re-upload when the CDN copy is gone.
 */

import { existsSync, statSync } from "node:fs";
import {
  getHistoryMessage,
  getMessageById,
  setMessageFilePath,
} from "../../../storage/history.js";
import { documentNote } from "../messages/attachment-note.js";
import {
  inboundMediaMeta,
  saveInboundMedia,
  type SavedMedia,
} from "../messages/media-store.js";
import { lookupMessage, resolveKey } from "../messages/message-store.js";
import { tryAction } from "./try-action.js";
import type { WhatsAppActionHandlers } from "./types.js";

/**
 * download_media's answer: the path, and for a document its extracted
 * text too — a turn without file tools can't open the path itself.
 */
async function mediaAnswer(
  media: { filePath: string; type: string } & Partial<Omit<SavedMedia, "type">>,
  message: Parameters<typeof inboundMediaMeta>[0],
): Promise<{ ok: true; text: string; file_path: string }> {
  const { filePath } = media;
  if (media.type !== "document") {
    return { ok: true, text: filePath, file_path: filePath };
  }
  const note = await documentNote({
    ...inboundMediaMeta(message),
    ...media,
    type: "document",
    size: media.size ?? statSync(filePath).size,
  });
  return { ok: true, text: note, file_path: filePath };
}

function toMsgId(raw: unknown): number {
  return typeof raw === "number" ? raw : Number(raw);
}

export const historyHandlers: WhatsAppActionHandlers = {
  get_message_by_id: (body, _chatId, ctx) =>
    tryAction("get_message_by_id", async () => {
      const chatId = ctx.chat!.chatId;
      const msgId = toMsgId(body.message_id);
      if (!Number.isFinite(msgId)) {
        return {
          ok: false,
          error: `Invalid message_id: ${String(body.message_id)}`,
        };
      }
      const row = getHistoryMessage(chatId, msgId);
      const stored = lookupMessage(msgId);
      if (!row && (!stored || stored.chatId !== chatId)) {
        return { ok: false, error: `Message ${msgId} not found in this chat.` };
      }
      const lines = [
        row
          ? getMessageById(chatId, msgId)
          : `[${new Date(stored!.timestamp).toISOString()}] ${stored!.senderName}: ${stored!.text}`,
      ];
      if (row?.replyToMsgId) lines.push(`reply to: msg_id ${row.replyToMsgId}`);
      if (row?.mediaType) {
        const saved = row.filePath && existsSync(row.filePath);
        lines.push(
          saved
            ? `${row.mediaType}: ${row.filePath}`
            : `${row.mediaType}: not on disk — download_media ${msgId} fetches it`,
        );
      }
      return { ok: true, text: lines.join("\n") };
    }),

  /**
   * Media for a message by id. Inbound media is saved as it arrives, so
   * the saved file is answered first; otherwise the retained proto is
   * downloaded again, asking the sender to re-upload when WhatsApp's
   * CDN copy has expired.
   */
  download_media: (body, _chatId, ctx) =>
    tryAction("download_media", async () => {
      const chatId = ctx.chat!.chatId;
      const resolved = resolveKey(body.message_id, chatId);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      const { stored } = resolved;
      const row = getHistoryMessage(chatId, stored.msgId);
      if (row?.filePath && existsSync(row.filePath)) {
        return mediaAnswer(
          { filePath: row.filePath, type: row.mediaType ?? "" },
          stored.message,
        );
      }
      if (!stored.message) {
        return {
          ok: false,
          error: `Message ${stored.msgId} was not retained in full, so its media cannot be re-downloaded`,
        };
      }
      const saved = await saveInboundMedia(
        stored.message,
        chatId,
        stored.msgId,
        stored.senderName,
        { reuploadRequest: ctx.sock.updateMediaMessage },
      );
      if (!saved) {
        return {
          ok: false,
          error: `Message ${stored.msgId} carries no downloadable media`,
        };
      }
      setMessageFilePath(chatId, stored.msgId, saved.filePath);
      return mediaAnswer(saved, stored.message);
    }),
};
