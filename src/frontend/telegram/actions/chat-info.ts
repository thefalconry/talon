/**
 * Chat-info, history (userbot-enhanced), sticker-pack management, polls, and
 * media downloads.
 *
 * The history actions OVERRIDE the shared in-memory history when the userbot
 * client is connected; otherwise they return null to fall through to the
 * shared gateway handler.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { dirs } from "../../../util/paths.js";
import { expandFsPath } from "../../../util/fs-path.js";
import {
  isUserClientReady,
  searchMessages as userbotSearch,
  getHistory as userbotHistory,
  getParticipantDetails as userbotParticipantDetails,
  getUserInfo as userbotGetUserInfo,
  getMessage as userbotGetMessage,
  getPinnedMessages as userbotPinnedMessages,
  getOnlineCount as userbotOnlineCount,
} from "../userbot.js";
import { getMediaForMessage } from "../../../storage/media-index.js";
import { savePackToLibrary } from "../sticker-library.js";
import { toPositiveId } from "./coerce.js";
import type { TelegramActionHandlers } from "./types.js";

export const chatInfoHandlers: TelegramActionHandlers = {
  get_chat_info: async (_body, chatId, { bot }) => {
    const chat = await bot.api.getChat(chatId);
    const count = await bot.api.getChatMemberCount(chatId).catch(() => null);
    return {
      ok: true,
      id: chat.id,
      type: chat.type,
      title: "title" in chat ? chat.title : undefined,
      member_count: count,
    };
  },

  get_chat_member: async (body, chatId, { bot }) => {
    const m = await bot.api.getChatMember(chatId, Number(body.user_id));
    return {
      ok: true,
      status: m.status,
      user: {
        id: m.user.id,
        first_name: m.user.first_name,
        username: m.user.username,
      },
    };
  },

  get_chat_admins: async (_body, chatId, { bot }) => {
    const admins = await bot.api.getChatAdministrators(chatId);
    const text = admins
      .map((a) => {
        const name = [a.user.first_name, a.user.last_name]
          .filter(Boolean)
          .join(" ");
        const title =
          "custom_title" in a && a.custom_title ? ` "${a.custom_title}"` : "";
        return `${name}${title} (${a.status}) id:${a.user.id}`;
      })
      .join("\n");
    return { ok: true, text };
  },

  get_chat_member_count: async (_body, chatId, { bot }) => ({
    ok: true,
    count: await bot.api.getChatMemberCount(chatId),
  }),

  set_chat_title: async (body, chatId, { bot }) => {
    await bot.api.setChatTitle(chatId, String(body.title));
    return { ok: true };
  },

  set_chat_description: async (body, chatId, { bot }) => {
    await bot.api.setChatDescription(chatId, String(body.description ?? ""));
    return { ok: true };
  },

  // ── History (userbot-enhanced) — OVERRIDE shared history when available ──
  read_history: async (body, chatId) => {
    if (isUserClientReady()) {
      return {
        ok: true,
        text: await userbotHistory({
          chatId,
          limit: Math.min(100, Number(body.limit ?? 30)),
          offsetId: toPositiveId(body.offset_id),
          before: body.before as string | undefined,
        }),
      };
    }
    return null; // fall through to shared handler
  },

  search_history: async (body, chatId) => {
    if (isUserClientReady()) {
      return {
        ok: true,
        text: await userbotSearch({
          chatId,
          query: String(body.query ?? ""),
          limit: Math.min(100, Number(body.limit ?? 20)),
        }),
      };
    }
    return null;
  },

  get_user_messages: async (body, chatId) => {
    if (isUserClientReady()) {
      return {
        ok: true,
        text: await userbotSearch({
          chatId,
          query: String(body.user_name ?? ""),
          limit: Math.min(50, Number(body.limit ?? 20)),
        }),
      };
    }
    return null;
  },

  list_known_users: async (body, chatId) => {
    if (isUserClientReady()) {
      return {
        ok: true,
        text: await userbotParticipantDetails({
          chatId,
          limit: Number(body.limit ?? 50),
        }),
      };
    }
    return null;
  },

  get_member_info: async (body, chatId) => {
    if (isUserClientReady()) {
      return {
        ok: true,
        text: await userbotGetUserInfo({
          chatId,
          userId: Number(body.user_id),
        }),
      };
    }
    return { ok: false, error: "User client not connected." };
  },

  get_message_by_id: async (body, chatId) => {
    if (isUserClientReady()) {
      return {
        ok: true,
        text: await userbotGetMessage({
          chatId,
          messageId: Number(body.message_id),
        }),
      };
    }
    return { ok: false, error: "User client not connected." };
  },

  get_pinned_messages: async (_body, chatId) => {
    if (isUserClientReady())
      return { ok: true, text: await userbotPinnedMessages({ chatId }) };
    return { ok: false, error: "User client not connected." };
  },

  online_count: async (_body, chatId) => {
    if (isUserClientReady())
      return { ok: true, text: await userbotOnlineCount({ chatId }) };
    return { ok: false, error: "User client not connected." };
  },

  save_sticker_pack: async (body, _chatId, { bot }) => {
    try {
      const text = await savePackToLibrary(bot, String(body.set_name ?? ""));
      return { ok: true, text };
    } catch (err) {
      return {
        ok: false,
        error: `Failed to save sticker pack: ${err instanceof Error ? err.message : err}`,
      };
    }
  },

  get_sticker_pack: async (body, _chatId, { bot }) => {
    const stickerSet = await bot.api.getStickerSet(String(body.set_name ?? ""));
    const lines = stickerSet.stickers.map(
      (s, i) =>
        `${i + 1}. ${s.emoji ?? ""} [${s.is_animated ? "animated" : s.is_video ? "video" : "static"}] file_id: ${s.file_id}`,
    );
    return {
      ok: true,
      text: `Sticker pack: "${stickerSet.title}" (${stickerSet.stickers.length} stickers)\nSet name: ${stickerSet.name}\n\n${lines.join("\n")}`,
    };
  },

  download_sticker: async (body, _chatId, { bot, botToken }) => {
    const file = await bot.api.getFile(String(body.file_id ?? ""));
    if (!file.file_path) return { ok: false, error: "Could not get file path" };
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok)
      return { ok: false, error: `Download failed: ${resp.status}` };
    const buffer = Buffer.from(await resp.arrayBuffer());
    const ext = file.file_path.split(".").pop() ?? "webp";
    const uploadsDir = dirs.uploads;
    if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
    const filePath = resolve(uploadsDir, `${Date.now()}-sticker.${ext}`);
    writeFileSync(filePath, buffer);
    return {
      ok: true,
      text: `Downloaded sticker to: ${filePath} (${buffer.length} bytes).`,
    };
  },

  create_sticker_set: async (body, _chatId, { bot, InputFileClass }) => {
    const userId = Number(body.user_id);
    const name = String(body.name ?? "");
    const title = String(body.title ?? "");
    const filePath = expandFsPath(String(body.file_path ?? ""));
    const emojis = (body.emoji_list as string[]) ?? ["🎨"];
    const format = (body.format as "static" | "animated" | "video") ?? "static";
    if (!userId || !name || !title || !filePath) {
      return {
        ok: false,
        error: "Required: user_id, name, title, file_path",
      };
    }
    // Sticker set names must end with _by_<bot_username>
    const botUsername = bot.botInfo?.username ?? "";
    const fullName = name.endsWith(`_by_${botUsername}`)
      ? name
      : `${name}_by_${botUsername}`;
    const data = readFileSync(filePath);
    const sticker = {
      sticker: new InputFileClass(data, basename(filePath)),
      format,
      emoji_list: emojis,
    };
    await bot.api.createNewStickerSet(userId, fullName, title, [sticker]);
    return {
      ok: true,
      text: `Created sticker pack "${title}" (${fullName}) with 1 sticker.`,
    };
  },

  add_sticker_to_set: async (body, _chatId, { bot, InputFileClass }) => {
    const userId = Number(body.user_id);
    const name = String(body.name ?? "");
    const filePath = expandFsPath(String(body.file_path ?? ""));
    const emojis = (body.emoji_list as string[]) ?? ["🎨"];
    const format = (body.format as "static" | "animated" | "video") ?? "static";
    if (!userId || !name || !filePath) {
      return { ok: false, error: "Required: user_id, name, file_path" };
    }
    const data = readFileSync(filePath);
    const sticker = {
      sticker: new InputFileClass(data, basename(filePath)),
      format,
      emoji_list: emojis,
    };
    await bot.api.addStickerToSet(userId, name, sticker);
    return { ok: true, text: `Added sticker to pack "${name}".` };
  },

  delete_sticker_from_set: async (body, _chatId, { bot }) => {
    const stickerId = String(body.sticker_file_id ?? "");
    if (!stickerId) return { ok: false, error: "Required: sticker_file_id" };
    await bot.api.deleteStickerFromSet(stickerId);
    return { ok: true, text: "Sticker deleted from pack." };
  },

  set_sticker_set_title: async (body, _chatId, { bot }) => {
    const name = String(body.name ?? "");
    const title = String(body.title ?? "");
    if (!name || !title) return { ok: false, error: "Required: name, title" };
    await bot.api.setStickerSetTitle(name, title);
    return { ok: true, text: `Pack title updated to "${title}".` };
  },

  delete_sticker_set: async (body, _chatId, { bot }) => {
    const name = String(body.name ?? "");
    if (!name) return { ok: false, error: "Required: name" };
    await bot.api.deleteStickerSet(name);
    return { ok: true, text: `Deleted sticker pack "${name}".` };
  },

  stop_poll: async (body, chatId, { bot }) => {
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "Required: message_id" };
    const poll = await bot.api.stopPoll(chatId, msgId);
    const results = poll.options
      .map(
        (o) =>
          `  ${o.text}: ${o.voter_count} vote${o.voter_count === 1 ? "" : "s"}`,
      )
      .join("\n");
    return {
      ok: true,
      text: `Poll closed: "${poll.question}"\nTotal voters: ${poll.total_voter_count}\n\nResults:\n${results}`,
    };
  },

  download_media: async (body, chatId) => {
    const msgId = toPositiveId(body.message_id);
    if (!msgId) return { ok: false, error: "Required: message_id" };
    // Media the bot received is already on disk and indexed. Answer from
    // the index first: the userbot can't see messages in the bot's own
    // DMs (message ids there are per-account), so asking it for an
    // inbound photo by id reports "not found".
    const indexed = getMediaForMessage(String(chatId), msgId);
    if (indexed && existsSync(indexed.filePath)) {
      return {
        ok: true,
        text: `Saved at: ${indexed.filePath} (${indexed.type}). Use the Read tool on this path to view the content.`,
        file_path: indexed.filePath,
      };
    }
    if (isUserClientReady()) {
      const { downloadMessageMedia } = await import("../userbot.js");
      return {
        ok: true,
        text: await downloadMessageMedia({ chatId, messageId: msgId }),
      };
    }
    return {
      ok: false,
      error: indexed
        ? `Media for message ${msgId} is no longer on disk and the user client is not connected to re-download it.`
        : "User client not connected.",
    };
  },
};
