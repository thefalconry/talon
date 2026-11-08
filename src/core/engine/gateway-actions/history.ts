/**
 * In-memory history queries — only used when a richer userbot-backed
 * implementation isn't available. Frontends may override these.
 */

import {
  getRecentFormatted,
  getFormattedBefore,
  getFormattedBeforeTime,
  searchHistory,
  getMessagesByUser,
  getKnownUsers,
} from "../../../storage/history.js";
import { formatMediaIndex } from "../../../storage/media-index.js";
import type { SharedActionHandlers } from "./types.js";

export const historyHandlers: SharedActionHandlers = {
  read_history: (body, chatId, _backend, chatKey) => {
    const limit = Math.min(100, Number(body.limit ?? 30));
    const cid = chatKey;
    // The tool schema advertises `offset_id` and `before` for paging back;
    // ignoring them here would make "go further back" a silent no-op on
    // frontends without a platform history API (WhatsApp, native).
    const offsetId = Number(body.offset_id);
    if (Number.isFinite(offsetId) && offsetId > 0) {
      return { ok: true, text: getFormattedBefore(cid, offsetId, limit) };
    }
    if (body.before !== undefined) {
      const ts = Date.parse(String(body.before));
      if (Number.isFinite(ts)) {
        return { ok: true, text: getFormattedBeforeTime(cid, ts, limit) };
      }
    }
    return { ok: true, text: getRecentFormatted(cid, limit) };
  },

  search_history: (body, chatId, _backend, chatKey) => {
    const limit = Math.min(100, Number(body.limit ?? 20));
    // Optional ISO date bounds; an unparseable one is ignored rather
    // than silently narrowing the search to nothing.
    const bound = (value: unknown): number | undefined => {
      if (value === undefined || value === null || value === "")
        return undefined;
      const ts = Date.parse(String(value));
      return Number.isFinite(ts) ? ts : undefined;
    };
    return {
      ok: true,
      text: searchHistory(chatKey, String(body.query ?? ""), limit, {
        after: bound(body.after),
        before: bound(body.before),
      }),
    };
  },

  get_user_messages: (body, chatId, _backend, chatKey) => {
    const limit = Math.min(50, Number(body.limit ?? 20));
    return {
      ok: true,
      text: getMessagesByUser(chatKey, String(body.user_name ?? ""), limit),
    };
  },

  list_known_users: (body, chatId, _backend, chatKey) => ({
    ok: true,
    text: getKnownUsers(chatKey),
  }),

  list_media: (body, chatId, _backend, chatKey) => ({
    ok: true,
    text: formatMediaIndex(chatKey, Math.min(20, Number(body.limit ?? 10))),
  }),
};
