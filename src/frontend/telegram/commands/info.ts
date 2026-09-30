/**
 * Informational commands — /start, /help, /ping, /plugins.
 */

import type { Bot, Context } from "grammy";
import { isUserClientReady } from "../userbot.js";
import { escapeHtml } from "../formatting.js";
import { formatDuration } from "../../presentation/format.js";
import {
  renderMeshPairLink,
  renderMeshReport,
  type MeshReachability,
} from "../render/reports.js";
import { isAuthorizedAdmin } from "./state.js";
import { getLoadedPlugins } from "../../../core/plugin/index.js";
import { getMeshService } from "../../../core/mesh/index.js";
import type { MeshPingResult } from "../../../core/mesh/devices/service.js";

/**
 * `/ping` — Bot API round trip, plus live bridge and userbot state. The
 * reply landing at all is the Bot API check; its round trip is the
 * latency. The Bridge field is omitted when no health source is wired.
 */
function registerPingCommand(
  bot: Bot,
  bridgeListening: (() => boolean) | undefined,
): void {
  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const sent = await ctx.reply("...");
    const latency = Date.now() - start;

    const userbotOk = isUserClientReady();
    const uptime = formatDuration(process.uptime() * 1000);

    const statusLine = [
      ...(bridgeListening ? [`Bridge: ${bridgeListening() ? "✓" : "✗"}`] : []),
      `Userbot: ${userbotOk ? "✓" : "✗"}`,
      `Uptime: ${uptime}`,
    ].join(" | ");

    try {
      await bot.api.editMessageText(
        ctx.chat.id,
        sent.message_id,
        `Pong! ${latency}ms\n${statusLine}`,
      );
    } catch {
      // ignore edit failure
    }
  });
}

export type InfoCommandDeps = {
  /** Tool-bridge health; the Bridge field is omitted when absent. */
  bridgeListening?: () => boolean;
};

export function registerInfoCommands(
  bot: Bot,
  { bridgeListening }: InfoCommandDeps = {},
): void {
  bot.command("start", (ctx) =>
    ctx.reply(
      [
        "<b>🦅 Talon</b>",
        "",
        "Agentic AI harness for Telegram.",
        "",
        "Send a message, photo, doc, or voice note.",
        "In groups, @mention or reply to activate.",
        "",
        "/status  /stop  /reset  /help",
      ].join("\n"),
      { parse_mode: "HTML" },
    ),
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      [
        "<b>🦅 Talon -- Help</b>",
        "",
        "<b>🦅 Settings</b>",
        "  /settings -- view and change all chat settings",
        "  /model -- show or change model and backend",
        "  /effort -- set thinking effort (off, low, medium, high, max)",
        "  /pulse -- toggle periodic check-ins (on/off)",
        "",
        "<b>Session</b>",
        "  /status -- session info, usage, and stats",
        "  /stop -- stop the current response",
        "  /metrics -- aggregate performance metrics (admin)",
        "  /doctor -- environment and native-module health (admin)",
        "  /dream -- force memory consolidation now",
        // Entity-escaped: this whole message is sent with parse_mode HTML,
        // so a literal <id> would be read as a tag and 400 the reply.
        "  /memory -- what Talon remembers; /memory why &lt;id&gt; for provenance",
        "  /ping -- health check with latency",
        "  /mesh -- ping and list companion mesh devices",
        "  /reset -- clear session and start fresh",
        "  /restart -- restart the bot process",
        "  /plugins -- list loaded plugins",
        "  /help -- this message",
        "",
        "<b>Input</b>",
        "  Text, photos, documents, voice notes, audio, videos, GIFs, stickers, video notes, forwarded messages, reply context",
        "",
        "<b>Messaging</b>",
        "  Send, reply, edit, delete, forward, copy, pin/unpin messages. Inline keyboards with callback buttons. Scheduled messages.",
        "",
        "<b>Media</b>",
        "  Send photos, videos, GIFs, voice notes, stickers, files, polls, locations, contacts, dice.",
        "",
        "<b>Chat</b>",
        "  Read history, search messages, list members, get chat info, manage titles and descriptions.",
        "",
        "<b>Web</b>",
        "  Ask Talon to read a URL — it can fetch and summarize web pages.",
        "",
        "<b>Groups</b>",
        "  Mention @" +
          escapeHtml(ctx.me.username ?? "bot") +
          " or reply to activate.",
        "",
        "<b>Files</b>",
        "  Ask me to create a file and I'll send it as an attachment.",
      ].join("\n"),
      { parse_mode: "HTML" },
    ),
  );

  registerPingCommand(bot, bridgeListening);

  /** True only in a 1:1 chat with the bot — never a group or channel. */
  const isPrivate = (ctx: Context): boolean => ctx.chat?.type === "private";

  /**
   * The bridge footer `/mesh` prints for this caller.
   *
   * The admin gets the whole connection profile — URL, bearer token,
   * certificate — because an operator asking their own daemon how to reach
   * itself should get an answer rather than a scavenger hunt through config
   * files. Everyone else gets the address only: a group member reading the
   * fleet has no business holding the key to it.
   *
   * Being the admin is not enough on its own: the secrets are withheld in
   * any room that isn't a 1:1 with the bot. A group message is readable by
   * every member, forwardable out of the group, and retained in their
   * clients — so "the admin asked" says nothing about who ends up holding
   * the bearer token. The admin can re-run the command in a DM.
   */
  const bridgeFor = (ctx: Context): MeshReachability => {
    const reach = getMeshService().bridgeReachability();
    if (!reach.ok || (isAuthorizedAdmin(ctx) && isPrivate(ctx))) return reach;
    return {
      ok: true,
      url: reach.url,
      authRequired: reach.authRequired,
    };
  };

  bot.command("mesh", async (ctx) => {
    const arg = (ctx.match ?? "").toString().trim();
    // `/mesh link` mints a bridge credential and posts it into the chat, so
    // it is admin-gated even though plain `/mesh` is not — reading the fleet
    // is not the same act as handing out the keys to it.
    if (await handleMeshLinkCommand(bot, ctx, arg)) return;

    const sent = await ctx.reply("Pinging mesh devices…");
    let results: MeshPingResult[];
    try {
      results = await getMeshService().pingAll();
    } catch {
      await editOrReply(
        bot,
        ctx.chat.id,
        sent.message_id,
        "Could not reach the mesh service.",
      );
      return;
    }
    await editOrReply(
      bot,
      ctx.chat.id,
      sent.message_id,
      renderMeshReport(results, Date.now(), bridgeFor(ctx)),
    );
  });

  bot.command("plugins", async (ctx) => {
    const plugins = getLoadedPlugins();
    if (plugins.length === 0) {
      await ctx.reply("No plugins loaded.");
      return;
    }
    const lines = plugins.map((p) => {
      // Every field here is author-supplied manifest text, not just the
      // name. A description like "R&D tools" or "<beta>" would otherwise
      // reach Telegram as markup and 400 the whole listing, so `/plugins`
      // would look dead rather than show one odd line.
      const ver = p.plugin.version ? ` v${escapeHtml(p.plugin.version)}` : "";
      const desc = p.plugin.description
        ? ` — ${escapeHtml(p.plugin.description)}`
        : "";
      const mcp = p.plugin.mcpServerPath ? " [MCP]" : "";
      const fe = p.plugin.frontends?.length
        ? ` (${escapeHtml(p.plugin.frontends.join(", "))})`
        : "";
      return `• <b>${escapeHtml(p.plugin.name)}</b>${ver}${mcp}${fe}${desc}`;
    });
    await ctx.reply(
      `<b>Plugins (${plugins.length})</b>\n\n${lines.join("\n")}`,
      {
        parse_mode: "HTML",
      },
    );
  });
}

/**
 * `/mesh link [name]` — mint and deliver a companion pairing link. Returns
 * true when `arg` was a link request (handled here, reply sent), false when
 * the caller should treat the command as a plain `/mesh` fleet ping.
 */
async function handleMeshLinkCommand(
  bot: Bot,
  ctx: Context & { match?: unknown },
  arg: string,
): Promise<boolean> {
  if (!/^(link|pair)\b/i.test(arg)) return false;
  if (!isAuthorizedAdmin(ctx)) {
    await ctx.reply("Only the configured admin can mint a pairing link.");
    return true;
  }
  // `/mesh link Car` names the connection on the phone; with no name it
  // inherits the bot's, which is what the operator already calls this
  // daemon everywhere else.
  const named = arg.replace(/^(link|pair)\b/i, "").trim();
  const minted = getMeshService().makeCompanionPairLink(
    named || ctx.me.first_name,
  );
  const rendered = renderMeshPairLink(minted);
  // The pairing block is a live credential: a single-use grant plus the
  // bearer token and certificate for the manual fallback. In a group
  // that is a key handed to every member, so deliver it to the admin's
  // DM and leave only a receipt behind. The grant is minted either way,
  // so a failed DM must say so rather than look like it worked.
  if (ctx.chat?.type !== "private") {
    try {
      await bot.api.sendMessage(ctx.from!.id, rendered, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      await ctx.reply("Sent the pairing link to your DM.");
    } catch {
      await ctx.reply(
        "A pairing link carries the bridge token, so I won't post it in a group — and I couldn't DM you. Message me directly once, then run /mesh link there.",
      );
    }
    return true;
  }
  await ctx.reply(rendered, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  return true;
}

/** Edit the placeholder in place, falling back to a fresh reply. */
async function editOrReply(
  bot: Bot,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      parse_mode: "HTML",
    });
  } catch {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
  }
}
