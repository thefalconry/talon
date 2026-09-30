/**
 * `effort:select` — the standalone /effort select menu.
 */

import type { StringSelectMenuInteraction } from "discord.js";
import {
  setChatEffort,
  type EffortLevel,
} from "../../../../storage/chat-settings.js";
import {
  getBackendIdForChat,
  resolveChatBackend,
} from "../../../../core/engine/backend-controller/index.js";
import {
  getActiveReasoningLevels,
  supportsReasoningLevel,
} from "../../../presentation/reasoning-levels.js";
import type { ComponentContext, ComponentInteraction } from "./types.js";

async function selectEffort(
  interaction: StringSelectMenuInteraction,
  { config, gateway, chatId }: ComponentContext,
): Promise<void> {
  const level = interaction.values[0];
  const be = resolveChatBackend(chatId, gateway?.backend);
  const beId = getBackendIdForChat(chatId);
  const reasoning = await getActiveReasoningLevels({
    chatId,
    backend: be,
    backendId: beId,
    config,
  });
  // Adaptive needs no model levels — reachable even when the model has none.
  if (level === "adaptive") setChatEffort(chatId, undefined);
  else if (reasoning.levels.length === 0) {
    await interaction.update({
      content: "No valid reasoning levels found for this model.",
      components: [],
    });
    return;
  } else if (supportsReasoningLevel(level, reasoning.levels))
    setChatEffort(chatId, level as EffortLevel);
  else {
    await interaction.update({
      content: "Invalid reasoning level for this model.",
      components: [],
    });
    return;
  }
  try {
    await interaction.update({
      content: `**Effort:** ${level}`,
      components: [],
    });
  } catch {
    /* ignore */
  }
}

export async function handleEffortComponent(
  interaction: ComponentInteraction,
  context: ComponentContext,
): Promise<boolean> {
  if (
    interaction.customId === "effort:select" &&
    interaction.isStringSelectMenu()
  ) {
    await selectEffort(interaction, context);
    return true;
  }
  return false;
}
