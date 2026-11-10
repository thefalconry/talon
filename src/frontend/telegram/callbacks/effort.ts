/**
 * `effort:*` callbacks — set the reasoning effort and re-render the picker.
 */

import type { Context } from "grammy";
import {
  getChatSettings,
  setChatEffort,
  type EffortLevel,
} from "../../../storage/chat-settings.js";
import { getBackendIdForChat } from "../../../core/engine/backend-controller/index.js";
import { renderEffortRows } from "../render/menu.js";
import { resolveBackendForChat } from "../model-menu.js";
import {
  displayReasoningEffort,
  getActiveReasoningLevels,
  supportsReasoningLevel,
} from "../../presentation/reasoning-levels.js";
import { answerCallbackQuerySafe, type CallbackDeps } from "./query.js";

export async function handleEffortCallback(
  ctx: Context,
  data: string,
  cid: string,
  { config, gateway }: CallbackDeps,
): Promise<void> {
  const level = data.slice(7);
  const be = resolveBackendForChat(cid, gateway);
  const beId = getBackendIdForChat(cid);
  const reasoning = await getActiveReasoningLevels({
    chatId: cid,
    backend: be,
    backendId: beId,
    config,
  });
  if (level === "adaptive") {
    // Needs no model levels — reachable even when the model has none.
    setChatEffort(cid, undefined);
    await answerCallbackQuerySafe(ctx, { text: "Effort: adaptive" });
  } else if (reasoning.levels.length === 0) {
    await answerCallbackQuerySafe(ctx, {
      text: "No valid reasoning levels found",
    });
    return;
  } else if (supportsReasoningLevel(level, reasoning.levels)) {
    setChatEffort(cid, level as EffortLevel);
    await answerCallbackQuerySafe(ctx, { text: `Effort: ${level}` });
  } else {
    await answerCallbackQuerySafe(ctx, {
      text: "Invalid reasoning level for this model",
    });
    return;
  }
  const current = displayReasoningEffort(
    getChatSettings(cid).effort,
    reasoning.levels,
  );
  try {
    await ctx.editMessageText(`<b>Effort:</b> ${current}`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: renderEffortRows(current, reasoning.levels, "effort:"),
      },
    });
  } catch {
    /* message unchanged */
  }
}
