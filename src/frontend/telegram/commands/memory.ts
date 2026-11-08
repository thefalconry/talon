/**
 * `/memory` — a read-only window on the typed memory store.
 *
 * Four shapes, all reads: the ranked listing, a full-text search, one
 * row's provenance (`why <id>`) and a per-kind listing — rendered by
 * frontend/presentation/memory-report.ts, which the native bridge shares.
 *
 * Admin only, and only in a private chat. The store holds the operator's
 * private notes — people, places, health, relationships — so a read of it
 * is not a low-privilege action: in a group every member would see the
 * reply, and anyone else who can reach the bot must not see it at all.
 *
 * Every line is model- or user-authored text reaching an HTML-parsed
 * send, so the report escapes it with the HTML dialect; the reply is
 * chunked because a listing of 15 rows can outgrow Telegram's 4096-char
 * cap on its own.
 */

import type { Bot, Context } from "grammy";
import { replyHtmlChunked } from "../admin/chunked-reply.js";
import { TELEGRAM_REPORTS } from "../render/html.js";
import { renderMemoryReport } from "../../presentation/memory-report.js";
import { isAuthorizedAdmin } from "./state.js";

export function registerMemoryCommand(bot: Bot): void {
  bot.command("memory", async (ctx: Context) => {
    const verdict = memoryAccess(ctx);
    if (verdict !== "ok") {
      await ctx.reply(
        verdict === "not-private"
          ? "Memory is private — ask me in a DM."
          : "Not authorized.",
      );
      return;
    }
    const arg = (ctx.match ?? "").toString().trim();
    await replyHtmlChunked(ctx, renderMemoryReport(arg, TELEGRAM_REPORTS));
  });
}

/**
 * Who may read memory here: the admin, in a private chat.
 * Order matters — a non-admin in a group gets "not authorized", not
 * a hint that a DM would work.
 */
function memoryAccess(ctx: Context): "ok" | "not-admin" | "not-private" {
  if (!isAuthorizedAdmin(ctx)) return "not-admin";
  if (ctx.chat?.type !== "private") return "not-private";
  return "ok";
}
