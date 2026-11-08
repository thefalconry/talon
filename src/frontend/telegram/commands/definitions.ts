/**
 * User-facing command menu — the single source for Telegram's command menu
 * (setMyCommands in index.ts) and the unknown-command suggester. Admin-only
 * commands (/admin) stay off the menu and out of suggestions deliberately.
 *
 * Conditionally-wired commands (/update) are appended by
 * {@link telegramCommandMenu} under the same gate their handlers use —
 * a static entry for a command that isn't registered would put a dead
 * item in every non-dev deployment's menu.
 */

import { getRepoRoot } from "../../../core/update/self-update.js";

export const TELEGRAM_COMMANDS: ReadonlyArray<{
  command: string;
  description: string;
}> = [
  { command: "start", description: "Introduction" },
  {
    command: "settings",
    description: "View and change all chat settings",
  },
  { command: "status", description: "Session info, usage, and stats" },
  { command: "ping", description: "Health check with latency" },
  {
    command: "mesh",
    description: "Mesh devices; /mesh link pairs a new one",
  },
  { command: "model", description: "Show or change model" },
  { command: "effort", description: "Set thinking effort level" },
  { command: "pulse", description: "Conversation engagement settings" },
  { command: "stop", description: "Stop the current response" },
  { command: "reset", description: "Clear session and start fresh" },
  { command: "restart", description: "Restart the bot (admin)" },
  { command: "whatsapp", description: "WhatsApp link status / pair (admin)" },
  {
    command: "auth",
    description: "Backend logins — sign in to Claude/Codex (admin)",
  },
  { command: "usage", description: "Plan limits across every backend" },
  { command: "metrics", description: "Aggregate performance metrics" },
  {
    command: "doctor",
    description: "Environment and native-module health",
  },
  { command: "dream", description: "Force memory consolidation" },
  {
    command: "memory",
    description: "What Talon remembers — list, search, why <id>",
  },
  {
    command: "backup",
    description: "Snapshots and checkpoints; /backup restore <id> (admin)",
  },
  {
    command: "secret",
    description: "Store a password via a one-time link, not the chat (admin)",
  },
  { command: "plugins", description: "List loaded plugins" },
  { command: "help", description: "All commands and features" },
];

/**
 * The menu actually registered with Telegram for this deployment.
 *
 * `/update` only exists on developer builds running from a git checkout
 * (see the handler gate in commands/admin.ts — packaged binaries have no
 * source tree to pull into), so it joins the menu under the same
 * condition, slotted next to /restart.
 */
export function telegramCommandMenu(config: {
  devBuild?: boolean;
}): Array<{ command: string; description: string }> {
  const menu = [...TELEGRAM_COMMANDS];
  if (config.devBuild && getRepoRoot()) {
    const restartIdx = menu.findIndex((c) => c.command === "restart");
    menu.splice(restartIdx + 1, 0, {
      command: "update",
      description: "Pull latest, reinstall, restart (admin)",
    });
  }
  return menu;
}
