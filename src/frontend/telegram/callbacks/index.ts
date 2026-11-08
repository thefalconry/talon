/**
 * All callback_query handlers (settings panel, model/effort selectors,
 * pulse toggle).
 *
 * Split by callback-data prefix:
 *   - `shared`   — editOrIgnoreSame + answerCallbackQuerySafe + deps type
 *   - `settings` — `settings:*` (effort/proactive + stale-picker handling)
 *   - `pulse`    — `pulse:*`
 *   - `effort`   — `effort:*`
 *   - `metrics`  — `metrics:*` (today ↔ all-time panel grain)
 *   - `model`    — `model:*` (menu / backend / browse controller)
 *   - `auth`     — `auth:*` (backend sign-in panel, admin only)
 *   - `whatsapp` — `whatsapp:*` (WhatsApp link panel, admin only)
 *   - `backup`   — `backup:*` (the /backup panel + restore confirmation, admin only)
 *   - `usage-reset` — `ureset:*` (spend a banked limit reset, admin DM only)
 *
 * `registerCallbacks` installs one `callback_query:data` listener that
 * dispatches on the data prefix, preserving the original order and the
 * fall-through to the agent backend for unrecognized callbacks.
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../../core/config/index.js";
import type { Backend } from "../../../core/agent-runtime/capabilities.js";
import { handleCallbackQuery } from "../handlers/index.js";
import type { CallbackDeps } from "./query.js";
import { handleSettingsCallback } from "./settings.js";
import { handlePulseCallback } from "./pulse.js";
import { handleEffortCallback } from "./effort.js";
import { handleMetricsCallback } from "./metrics.js";
import { handleModelCallback } from "./model.js";
import { handleAuthCallback } from "./auth.js";
import { handleWhatsAppCallback } from "./whatsapp.js";
import { handleBackupCallback } from "./backup.js";
import { handleUsageResetCallback } from "./usage-reset.js";

export { answerCallbackQuerySafe } from "./query.js";

export function registerCallbacks(
  bot: Bot,
  config: TalonConfig,
  gateway?: { backend: Backend | null },
): void {
  const deps: CallbackDeps = { config, gateway };

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const cid = String(ctx.chat?.id ?? ctx.from?.id);

    // Handle /settings callbacks (effort, pulse, done). Model selection
    // is intentionally NOT here — that lives entirely under /model now.
    if (data.startsWith("settings:")) {
      await handleSettingsCallback(ctx, data, cid, deps);
      return;
    }

    // The /backup panel. Restore, the destructive one, is behind its own tap.
    if (data.startsWith("backup:")) {
      await handleBackupCallback(ctx, data);
      return;
    }

    // Spending a banked limit reset — irreversible, so confirm-gated.
    if (data.startsWith("ureset:")) {
      await handleUsageResetCallback(ctx, data);
      return;
    }

    // Handle pulse callbacks
    if (data.startsWith("pulse:")) {
      await handlePulseCallback(ctx, data, cid);
      return;
    }

    // Handle effort callbacks
    if (data.startsWith("effort:")) {
      await handleEffortCallback(ctx, data, cid, deps);
      return;
    }

    // Handle /metrics grain switching (today ↔ all time).
    if (data.startsWith("metrics:")) {
      await handleMetricsCallback(ctx, data);
      return;
    }

    // Handle /model callbacks via the pure parser + menu controller.
    if (data.startsWith("model:")) {
      await handleModelCallback(ctx, data, cid, deps);
      return;
    }

    // Handle /auth (backend CLI sign-in) callbacks.
    if (data.startsWith("auth:")) {
      await handleAuthCallback(ctx, data, deps);
      return;
    }

    // Handle /whatsapp (link status / pairing) callbacks.
    if (data.startsWith("whatsapp:")) {
      await handleWhatsAppCallback(ctx, data);
      return;
    }

    // Forward other callbacks to the AI backend
    handleCallbackQuery(ctx, bot, config);
  });
}
