/**
 * Informational commands — /start, /help, /ping, /plugins.
 */

import {
  type ChatInputCommandInteraction,
  type Client,
  MessageFlags,
  Status,
} from "discord.js";
import {
  formatDuration,
  renderMeshReport,
  renderUsageMessage,
} from "../render.js";
import type { TalonConfig } from "../../../core/config/index.js";
import { collectPlanUsage } from "../../presentation/plan-usage-report.js";
import { getLoadedPlugins } from "../../../core/plugin/index.js";
import { getMeshService } from "../../../core/mesh/index.js";
import type { MeshPingResult } from "../../../core/mesh/devices/service.js";
import { reply } from "./interaction.js";

export async function handleStart(
  i: ChatInputCommandInteraction,
): Promise<void> {
  await reply(
    i,
    [
      "**🦅 Talon**",
      "",
      "Agentic AI harness for Discord.",
      "",
      "Mention me, reply to me, or DM me. Attach files, photos, voice notes — I'll read them.",
      "",
      "/status  /stop  /reset  /help",
    ].join("\n"),
  );
}

export async function handleHelp(
  i: ChatInputCommandInteraction,
  c: Client,
): Promise<void> {
  const botMention = c.user ? `<@${c.user.id}>` : "@bot";
  await reply(
    i,
    [
      "**🦅 Talon — Help**",
      "",
      "**Settings**",
      "  /settings — view and change all chat settings",
      "  /model — show or change model",
      "  /effort — set thinking effort (off, low, medium, high, max)",
      "  /pulse — toggle periodic check-ins (on/off)",
      "",
      "**Session**",
      "  /status — session info, usage, and stats",
      "  /stop — stop the current response",
      "  /metrics — aggregate performance metrics (admin)",
      "  /dream — force memory consolidation now (admin)",
      "  /ping — health check with latency",
      "  /reset — clear session and start fresh",
      "  /restart — restart the bot process (admin)",
      "  /plugins — list loaded plugins",
      "  /help — this message",
      "",
      "**Input**",
      "  Text, photos, documents, voice notes, audio, videos, GIFs, replies, attachments.",
      "",
      "**Servers**",
      `  In a server, mention ${botMention} or reply to me to activate.`,
      "",
      "**DM**",
      "  Whitelisted users can DM me directly.",
    ].join("\n"),
    true,
  );
}

/**
 * /usage — plan limits across every exposed backend, not just this chat's.
 * Not admin-gated: it says how close the shared account is to a wall, which
 * is exactly what a user hitting one needs to know.
 */
export async function handleUsage(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const entries = await collectPlanUsage(config);
  await i.editReply(renderUsageMessage(entries));
}

export async function handleMesh(
  i: ChatInputCommandInteraction,
): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply("Pinging mesh devices…");
  let results: MeshPingResult[];
  try {
    results = await getMeshService().pingAll();
  } catch {
    await i.editReply("Could not reach the mesh service.");
    return;
  }
  await i.editReply(renderMeshReport(results));
}

export async function handlePing(
  i: ChatInputCommandInteraction,
): Promise<void> {
  const start = Date.now();
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const apiLatency = Date.now() - start;
  await i.editReply(renderPingReply(i.client.ws, apiLatency));
}

/**
 * The /ping body. `ws.ping` is the gateway heartbeat RTT (-1 until the
 * first heartbeat is acknowledged); `ws.status` is the live connection
 * state, reported by name when it isn't Ready.
 */
export function renderPingReply(
  ws: { ping: number; status: Status },
  restLatencyMs: number,
): string {
  const wsPing = ws.ping >= 0 ? `${Math.round(ws.ping)}ms` : "n/a";
  const gateway =
    ws.status === Status.Ready ? "✓" : `✗ (${Status[ws.status] ?? ws.status})`;
  const uptime = formatDuration(process.uptime() * 1000);
  return `Pong! WS: ${wsPing} · REST: ${restLatencyMs}ms\nGateway: ${gateway} | Uptime: ${uptime}`;
}

export async function handlePlugins(
  i: ChatInputCommandInteraction,
): Promise<void> {
  const plugins = getLoadedPlugins();
  if (plugins.length === 0) {
    await reply(i, "No plugins loaded.", true);
    return;
  }
  const lines = plugins.map((p) => {
    const ver = p.plugin.version ? ` v${p.plugin.version}` : "";
    const desc = p.plugin.description ? ` — ${p.plugin.description}` : "";
    const mcp = p.plugin.mcpServerPath ? " [MCP]" : "";
    const fe = p.plugin.frontends?.length
      ? ` (${p.plugin.frontends.join(", ")})`
      : "";
    return `• **${p.plugin.name}**${ver}${mcp}${fe}${desc}`;
  });
  await reply(
    i,
    `**Plugins (${plugins.length})**\n\n${lines.join("\n")}`,
    true,
  );
}
