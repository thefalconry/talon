/**
 * `/admin chats` / `broadcast` / `kill` — the session-level subcommands.
 */

import type { Bot, Context } from "grammy";
import type { TalonConfig } from "../../../core/config/index.js";
import { escapeHtml } from "../formatting.js";
import { getAllSessions } from "../../../storage/sessions.js";
import { performSessionReset } from "../../presentation/session-status.js";
import { resolveBackendForChat } from "../model-menu.js";
import type { Backend } from "../../../core/agent-runtime/capabilities.js";
import { getChatSettings } from "../../../storage/chat-settings.js";
import { formatModelLabel } from "../../presentation/format.js";
import { replyHtmlChunked } from "./chunked-reply.js";

/** `/admin chats` — every active session, newest first, titled via getChat. */
export async function replyActiveChats(
  ctx: Context,
  _rest: string[],
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  const sessions = getAllSessions();
  if (sessions.length === 0) {
    await ctx.reply("No active sessions.");
    return;
  }
  sessions.sort((a, b) => (b.info.lastActive || 0) - (a.info.lastActive || 0));

  const titles = new Map<string, string>();
  await Promise.all(
    sessions.map(async (s) => {
      try {
        const id = parseInt(s.chatId, 10);
        if (isNaN(id)) return;
        const chat = await bot.api.getChat(id);
        titles.set(
          s.chatId,
          "title" in chat
            ? (chat.title ?? "DM")
            : "first_name" in chat
              ? (chat.first_name ?? "DM")
              : "DM",
        );
      } catch {
        /* inaccessible */
      }
    }),
  );

  const lines = sessions.map((s) => {
    const age = s.info.lastActive
      ? `${Math.round((Date.now() - s.info.lastActive) / 60000)}m ago`
      : "?";
    const title = titles.get(s.chatId) ?? s.chatId;
    const model = formatModelLabel(
      getChatSettings(s.chatId).model ?? config.model,
    );
    // `model` is a catalog id (OpenRouter/Kilo ids are free-form), so
    // it gets the same escaping the title already had.
    return `<b>${escapeHtml(title)}</b> <code>${s.chatId}</code>\n  ${s.info.turns} turns | ${age} | ${escapeHtml(model)}`;
  });
  await replyHtmlChunked(
    ctx,
    `<b>Active chats (${sessions.length})</b>\n\n` + lines.join("\n\n"),
  );
}

export async function broadcast(
  ctx: Context,
  rest: string[],
  bot: Bot,
): Promise<void> {
  const text = rest.join(" ");
  if (!text) {
    await ctx.reply("Usage: /admin broadcast <text>");
    return;
  }
  const sessions = getAllSessions();
  let sent = 0,
    failed = 0;
  for (const s of sessions) {
    const id = parseInt(s.chatId, 10);
    if (isNaN(id)) continue;
    try {
      await bot.api.sendMessage(id, text);
      sent++;
      await new Promise((r) => setTimeout(r, 40));
    } catch {
      failed++;
    }
  }
  await ctx.reply(
    `Broadcast: ${sent} sent, ${failed} failed (${sessions.length} total).`,
  );
}

/** The default backend; per-chat overrides are resolved from it. */
export type AdminGateway = { backend: Backend | null };

/**
 * `/admin kill <chatId>` — the same reset /reset performs in that chat:
 * session + history stores, pulse checkpoint, and the backend's own
 * per-chat session (resolved through the chat's backend override).
 */
export async function killSession(
  ctx: Context,
  rest: string[],
  _bot: Bot,
  _config: TalonConfig,
  gateway?: AdminGateway,
): Promise<void> {
  const target = rest[0];
  if (!target) {
    await ctx.reply("Usage: /admin kill <chatId>");
    return;
  }
  await performSessionReset(target, resolveBackendForChat(target, gateway));
  await ctx.reply(`Session ${target} reset.`);
}
