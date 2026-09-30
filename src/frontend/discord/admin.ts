/**
 * Admin subcommand handlers — invoked from /admin <sub> [args].
 *
 * Mirrors src/frontend/telegram/admin.ts. Output is delivered via the
 * `send` callback so the caller (commands.ts) can route it through the
 * proper interaction follow-up.
 */

import { readFileSync } from "node:fs";
import { files, dirs } from "../../util/paths.js";
import { tailFile } from "../../util/tail-file.js";
import type { TalonConfig } from "../../core/config/index.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { resetSession, getAllSessions } from "../../storage/sessions.js";
import { markContextCleared } from "../../storage/history.js";
import { todayLogDate } from "../../storage/daily-log.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import {
  getAllCronJobs,
  describeSchedule,
  nextRunAt,
} from "../../storage/cron.js";
import { getActiveCount } from "../../core/engine/dispatcher.js";
import { getPulseStatus } from "../../core/background/pulse/pulse.js";
import { getHealthStatus, getRecentErrors } from "../../util/watchdog.js";
import { formatDuration, formatModelLabel } from "./render.js";
import {
  DISCORD_MAX_TEXT,
  DISCORD_SAFE_RESERVE,
  escapeForCodeBlock,
} from "./formatting.js";

/**
 * Headroom for a fenced ```code``` block inside a 2000-char message: the
 * three-backtick fences (open + newline + close) eat ~8 chars; SAFE_RESERVE
 * covers headers/leading prose; we double it for daily output that prepends
 * a separate header line.
 */
const CODE_BLOCK_BUDGET = DISCORD_MAX_TEXT - DISCORD_SAFE_RESERVE - 100;
const DAILY_BUDGET = DISCORD_MAX_TEXT - DISCORD_SAFE_RESERVE - 200;

type Send = (text: string) => Promise<void>;

export async function handleAdminSubcommand(
  subcommand: string,
  argsRaw: string,
  config: TalonConfig,
  gateway: Gateway,
  send: Send,
): Promise<void> {
  const rest = argsRaw.split(/\s+/).filter(Boolean);

  switch (subcommand) {
    case "chats": {
      const sessions = getAllSessions();
      if (sessions.length === 0) return send("No active sessions.");
      sessions.sort(
        (a, b) => (b.info.lastActive || 0) - (a.info.lastActive || 0),
      );
      const lines = sessions.map((s) => {
        const age = s.info.lastActive
          ? `${Math.round((Date.now() - s.info.lastActive) / 60000)}m ago`
          : "?";
        const model = formatModelLabel(
          getChatSettings(s.chatId).model ?? config.model,
        );
        return `**\`${s.chatId}\`** — ${s.info.turns} turns | ${age} | ${model}`;
      });
      return send(
        `**Active chats (${sessions.length})**\n\n` + lines.join("\n"),
      );
    }

    case "broadcast": {
      const text = rest.join(" ");
      if (!text) return send("Usage: /admin broadcast <text>");
      // For Discord, broadcast iterates over registered chats and posts to
      // each. We don't pull a global send helper here to avoid coupling, so
      // we just report the count for the operator.
      const sessions = getAllSessions();
      return send(
        `Broadcast not wired in Discord yet. ${sessions.length} active sessions would receive: "${text.slice(0, 200)}"`,
      );
    }

    case "kill": {
      const target = rest[0];
      if (!target) return send("Usage: /admin kill <chatId>");
      resetSession(target);
      markContextCleared(target); // soft reset: history rows are kept
      gateway?.backend?.sessions?.resetChat?.(target);
      return send(`Session ${target} reset.`);
    }

    case "logs": {
      const logPath = files.log;
      try {
        const lines = tailFile(logPath);
        return send(
          "```\n" +
            escapeForCodeBlock(lines).slice(0, CODE_BLOCK_BUDGET) +
            "\n```",
        );
      } catch {
        return send(`Could not read ${logPath}`);
      }
    }

    case "stats": {
      const h = getHealthStatus();
      const sessions = getAllSessions();
      const turns = sessions.reduce((s, x) => s + x.info.turns, 0);
      const mem = process.memoryUsage();
      return send(
        [
          "**🦅 Talon Stats**",
          "",
          `**Uptime:** ${formatDuration(h.uptimeMs)}`,
          `**Messages:** ${h.totalMessagesProcessed}`,
          `**Sessions:** ${sessions.length}`,
          `**Turns:** ${turns}`,
          `**Last active:** ${h.msSinceLastMessage < 60000 ? "now" : formatDuration(h.msSinceLastMessage) + " ago"}`,
          "",
          `**Memory:** ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB heap / ${(mem.rss / 1024 / 1024).toFixed(1)}MB rss`,
          `**Queue:** ${getActiveCount()}`,
          `**Errors:** ${h.recentErrorCount}`,
        ].join("\n"),
      );
    }

    case "errors": {
      const errors = getRecentErrors(5);
      if (errors.length === 0) return send("No recent errors.");
      const lines = errors.map(
        (e) =>
          `\`[${new Date(e.timestamp).toISOString().slice(11, 19)}]\` ${e.message.slice(0, 200)}`,
      );
      return send(
        `**Recent Errors (${errors.length})**\n\n` + lines.join("\n\n"),
      );
    }

    case "cron": {
      const jobs = getAllCronJobs();
      if (jobs.length === 0) return send("No cron jobs.");
      const lines = jobs.map((j) => {
        const nextMs = nextRunAt(j);
        const last = j.lastRunAt
          ? new Date(j.lastRunAt).toISOString().slice(0, 16).replace("T", " ")
          : "never";
        const next = nextMs
          ? new Date(nextMs).toISOString().slice(0, 16).replace("T", " ")
          : "?";
        return `${j.enabled ? "✓" : "✗"} **${j.name}** — \`${describeSchedule(j)}\` | ${j.type} | runs: ${j.runCount} | last: ${last} | next: ${next}`;
      });
      return send(`**Cron Jobs (${jobs.length})**\n\n` + lines.join("\n\n"));
    }

    case "pulse": {
      const chats = getPulseStatus();
      if (chats.length === 0) return send("No pulse chats.");
      const lines = chats.map(
        (p) => `${p.enabled ? "✓" : "✗"} \`${p.chatId}\``,
      );
      return send(`**Pulse (${chats.length})**\n\n` + lines.join("\n"));
    }

    case "daily": {
      const today = todayLogDate();
      const logPath = `${dirs.logs}/${today}.md`;
      try {
        const content = readFileSync(logPath, "utf-8");
        const lines = content.trim().split("\n").slice(-30).join("\n");
        return send(
          `**Daily log (${today})**\n\n\`\`\`\n${escapeForCodeBlock(
            lines,
          ).slice(0, DAILY_BUDGET)}\n\`\`\``,
        );
      } catch {
        return send(`No daily log for ${today}.`);
      }
    }

    default:
      return send(
        [
          "**/admin subcommands**",
          "",
          "  stats    uptime, messages, memory",
          "  errors   last 5 errors",
          "  chats    list all active chats",
          "  daily    today's interaction log",
          "  pulse    pulse status per chat",
          "  cron     list all cron jobs",
          "  logs     last 20 lines of log",
        ].join("\n"),
      );
  }
}
