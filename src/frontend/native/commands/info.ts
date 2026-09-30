/**
 * Read-only commands — `/help`, `/ping`, `/usage`, `/mesh`, `/plugins`,
 * `/memory`. Each report is the one Telegram and Discord print, in the
 * native Markdown dialect (presentation/reports.ts, memory-report.ts).
 *
 * `/memory` is not operator-gated here, unlike Telegram's admin-only
 * `/memory`: the bridge already serves the same rows on `GET /memory` to
 * any `client` credential, and a native chat is always a private one.
 */

import { getLoadedPlugins } from "../../../core/plugin/index.js";
import { collectPlanUsage } from "../../presentation/plan-usage-report.js";
import { renderMemoryReport } from "../../presentation/memory-report.js";
import {
  renderMeshReport,
  renderUsageMessage,
} from "../../presentation/reports.js";
import { formatDuration } from "../../presentation/format.js";
import { NATIVE_COMMANDS } from "./definitions.js";
import { NATIVE_REPORTS } from "./format.js";
import type { NativeCommandContext, NativeCommandHandler } from "./types.js";

/** `/help` — generated from the definitions, so it can never drift. */
function renderNativeHelp(operator: boolean): string {
  const lines = ["**Commands**"];
  for (const cmd of NATIVE_COMMANDS) {
    const args = "args" in cmd ? ` ${cmd.args}` : "";
    const admin =
      "admin" in cmd
        ? operator
          ? " (admin)"
          : " (admin — not available to this device)"
        : "";
    lines.push(`\`/${cmd.name}${args}\` — ${cmd.description}${admin}`);
  }
  lines.push(
    "",
    "Anything else starting with a slash goes to the model as a normal message.",
  );
  return lines.join("\n");
}

async function help(ctx: NativeCommandContext): Promise<void> {
  ctx.reply(renderNativeHelp(ctx.operator));
}

async function ping(ctx: NativeCommandContext): Promise<void> {
  const uptime = formatDuration(process.uptime() * 1000);
  ctx.reply(
    `Pong! Bridge ✓ · ${ctx.runtime.chats.count()} chat(s) · uptime ${uptime}`,
  );
}

async function usage(ctx: NativeCommandContext): Promise<void> {
  const entries = await collectPlanUsage(ctx.runtime.config);
  ctx.reply(renderUsageMessage(entries, NATIVE_REPORTS));
}

async function mesh(ctx: NativeCommandContext): Promise<void> {
  try {
    const results = await ctx.runtime.mesh.pingAll();
    ctx.reply(renderMeshReport(results, NATIVE_REPORTS));
  } catch {
    ctx.reply("Could not reach the mesh service.");
  }
}

async function plugins(ctx: NativeCommandContext): Promise<void> {
  const loaded = getLoadedPlugins();
  if (loaded.length === 0) {
    ctx.reply("No plugins loaded.");
    return;
  }
  const lines = loaded.map((p) => {
    const ver = p.plugin.version ? ` v${p.plugin.version}` : "";
    const desc = p.plugin.description ? ` — ${p.plugin.description}` : "";
    const mcp = p.plugin.mcpServerPath ? " [MCP]" : "";
    const fe = p.plugin.frontends?.length
      ? ` (${p.plugin.frontends.join(", ")})`
      : "";
    return `• **${p.plugin.name}**${ver}${mcp}${fe}${desc}`;
  });
  ctx.reply(`**Plugins (${loaded.length})**\n\n${lines.join("\n")}`);
}

async function memory(ctx: NativeCommandContext): Promise<void> {
  ctx.reply(renderMemoryReport(ctx.arg, NATIVE_REPORTS));
}

export const infoCommands = {
  help,
  ping,
  usage,
  mesh,
  plugins,
  memory,
} satisfies Record<string, NativeCommandHandler>;
