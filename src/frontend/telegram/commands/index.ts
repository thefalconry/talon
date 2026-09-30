/**
 * All /command handlers for the Telegram bot.
 *
 * Split by category:
 *   - `definitions` — the TELEGRAM_COMMANDS menu (single source of truth)
 *   - `state`       — shared admin-id holder + admin guard
 *   - `info`        — /start /help /ping /plugins
 *   - `memory`      — /memory (read-only view of the typed memory store)
 *   - `session`     — /reset /status
 *   - `settings`    — /model /effort /pulse /settings
 *   - `admin`       — /admin /metrics /doctor /dream /restart /update
 *                     + the unknown-command suggester
 *
 * `registerCommands` wires every group onto the bot in an order that ends
 * with `admin`, because admin owns the unknown-command catch-all and that
 * must be the last handler to see a bare /command.
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../../core/config/index.js";
import type { Backend } from "../../../core/agent-runtime/capabilities.js";
import { registerInfoCommands } from "./info.js";
import { registerMemoryCommand } from "./memory.js";
import { registerSessionCommands } from "./session.js";
import { registerSettingsCommands } from "./settings.js";
import { registerAdminCommands } from "./admin.js";
import { registerWhatsAppPairingCommand } from "./whatsapp-pairing.js";
import { registerAuthCommand } from "./auth.js";
import { registerBackupCommand } from "./backup.js";

export { telegramCommandMenu } from "./definitions.js";
export { setAdminUserId } from "./state.js";

export function registerCommands(
  bot: Bot,
  config: TalonConfig,
  gateway?: { backend: Backend | null; isListening?: () => boolean },
): void {
  const deps = { config, gateway };
  const isListening = gateway?.isListening?.bind(gateway);
  registerInfoCommands(bot, { bridgeListening: isListening });
  registerMemoryCommand(bot);
  registerSessionCommands(bot, deps);
  registerSettingsCommands(bot, deps);
  registerWhatsAppPairingCommand(bot);
  registerAuthCommand(bot);
  registerBackupCommand(bot);
  // admin LAST: it owns the unknown-command catch-all, which must only
  // be reached after every real command has had its chance to match.
  // Registering anything after it makes that command look unknown
  // ("Unknown command /whatsapp — did you mean /whatsapp?").
  registerAdminCommands(bot, deps);
}
