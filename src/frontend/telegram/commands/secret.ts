/**
 * /secret <name> [purpose] — a single-use link to paste a password into,
 * so it never has to be typed into this chat. The rules and the reply
 * text live in core/secrets; this only adapts Telegram's context.
 */

import type { Bot } from "grammy";
import { secretCommandReply } from "../../../core/secrets/index.js";
import { isAuthorizedAdmin } from "./state.js";

export function registerSecretCommand(bot: Bot): void {
  bot.command("secret", async (ctx) => {
    const text = secretCommandReply({
      arg: typeof ctx.match === "string" ? ctx.match : "",
      chatKey: String(ctx.chat.id),
      frontend: "telegram",
      isOperator: isAuthorizedAdmin(ctx),
      isGroup: ctx.chat.type !== "private",
    });
    // No preview: a preview fetch is harmless (GET doesn't spend the
    // grant) but there is no reason to hand Telegram the URL early.
    await ctx.reply(text, { link_preview_options: { is_disabled: true } });
  });
}
