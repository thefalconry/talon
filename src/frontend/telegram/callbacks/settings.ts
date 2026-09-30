/**
 * `settings:*` callbacks — effort + proactive toggles, plus stale-payload
 * handling for old model-picker buttons. Re-renders the /settings panel.
 */

import type { Context } from "grammy";
import {
  getChatSettings,
  setChatEffort,
  type EffortLevel,
} from "../../../storage/chat-settings.js";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
} from "../../../core/background/pulse/pulse.js";
import { getBackendIdForChat } from "../../../core/engine/backend-controller/index.js";
import { renderSettingsText, renderSettingsKeyboard } from "../render/menu.js";
import { resolveBackendForChat } from "../model-menu.js";
import { resolveActiveModelForChat } from "../../../core/models/active-model.js";
import {
  displayReasoningEffort,
  getActiveReasoningLevels,
  supportsReasoningLevel,
} from "../../presentation/reasoning-levels.js";
import { answerCallbackQuerySafe, type CallbackDeps } from "./query.js";

export async function handleSettingsCallback(
  ctx: Context,
  data: string,
  cid: string,
  { config, gateway }: CallbackDeps,
): Promise<void> {
  const parts = data.split(":");
  if (!parts[1]) {
    await answerCallbackQuerySafe(ctx, { text: "Invalid callback data" });
    return;
  }
  const category = parts[1];
  const value = parts[2] ?? "";

  if (category === "noop") {
    await answerCallbackQuerySafe(ctx);
    return;
  }

  // Stale `settings:done` payloads from older bot versions that
  // shipped a Done button. Quietly ack — the user can dismiss the
  // message via Telegram's UI now.
  if (category === "done") {
    await answerCallbackQuerySafe(ctx);
    return;
  }

  // Stale model-picker callbacks (`settings:model:*`, `settings:models:*`)
  // emitted by older Talon builds. Quietly ack — the user can re-open
  // /model to get the current picker.
  if (category === "model" || category === "models") {
    await answerCallbackQuerySafe(ctx, {
      text: "Picker moved — use /model",
    });
    return;
  }

  if (category === "effort") {
    const settingsBe = resolveBackendForChat(cid, gateway);
    const settingsBeId = getBackendIdForChat(cid);
    const reasoning = await getActiveReasoningLevels({
      chatId: cid,
      backend: settingsBe,
      backendId: settingsBeId,
      config,
    });
    if (value === "adaptive") {
      setChatEffort(cid, undefined);
    } else if (supportsReasoningLevel(value, reasoning.levels)) {
      setChatEffort(cid, value as EffortLevel);
    } else {
      await answerCallbackQuerySafe(ctx, {
        text: "No valid reasoning level for this model",
      });
      return;
    }
    await answerCallbackQuerySafe(ctx, {
      text: `Effort: ${getChatSettings(cid).effort ?? "adaptive"}`,
    });
  } else if (category === "proactive") {
    if (value === "on") {
      enablePulse(cid);
      registerChat(cid);
    } else {
      disablePulse(cid);
    }
    await answerCallbackQuerySafe(ctx, { text: `Pulse: ${value}` });
  }

  const chatSets = getChatSettings(cid);
  const settingsBe = resolveBackendForChat(cid, gateway);
  const settingsBeId = getBackendIdForChat(cid);
  const { model: resolvedSettingsModel } = await resolveActiveModelForChat(
    cid,
    settingsBe,
    settingsBeId,
    config,
  );
  const activeModel = resolvedSettingsModel ?? "No model selected";
  const pulseOn = isPulseEnabled(cid);
  const reasoning = await getActiveReasoningLevels({
    chatId: cid,
    backend: settingsBe,
    backendId: settingsBeId,
    config,
  });
  const effortName = displayReasoningEffort(chatSets.effort, reasoning.levels);
  try {
    await ctx.editMessageText(
      renderSettingsText(
        activeModel,
        effortName,
        pulseOn,
        chatSets.pulseIntervalMs,
      ),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: renderSettingsKeyboard(
            resolvedSettingsModel,
            effortName,
            pulseOn,
            reasoning.levels,
            Boolean(settingsBe?.models?.getSettingsPresentation),
          ),
        },
      },
    );
  } catch {
    /* message unchanged */
  }
}
