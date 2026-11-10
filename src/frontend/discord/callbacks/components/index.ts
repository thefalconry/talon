/**
 * Component (button + select menu) interaction router.
 *
 * Custom ids are namespaced by a `:`-terminated prefix; the table below maps
 * each prefix to the module that owns it. A handler returns `false` for an
 * id under its prefix it doesn't recognise (a stale button from an older
 * panel, a select-menu id arriving from a button), and the router acks
 * those exactly as it acks a prefix with no handler.
 *
 * Custom-id namespace:
 *   settings:done
 *   settings:model              (select menu, value=modelId)
 *   settings:effort:select      (select menu)
 *   settings:proactive:on|off
 *   pulse:on | pulse:off | pulse:interval (button → opens modal)
 *   effort:select               (select menu, standalone /effort)
 *   model:select                (select menu, standalone /model)
 *   model:nav:*                 (pager)
 *   model:backend-select        (select menu)
 *   metrics:today | metrics:all
 *   backup:panel|now|guide|list:<p>|pin:<p>:<id>|unpin:<p>:<id>|ask:<p>:<id>
 *                               (the /backup panel, admin only)
 *   backup:restore:<id> | backup:cancel  (restore confirmation, admin only)
 *   ai:<id>                     (AI-generated buttons — forwarded to agent)
 */

import { MessageFlags } from "discord.js";
import type { TalonConfig } from "../../../../core/config/index.js";
import type { Gateway } from "../../../../core/engine/gateway.js";
import { deriveNumericChatId } from "../../../../core/frontend-runtime/chat-id.js";
import { logError } from "../../../../util/log.js";
import {
  isInteractionAllowed,
  registerDiscordChat,
} from "../../handlers/index.js";
import { forwardToAgent } from "./agent-buttons.js";
import { handleEffortComponent } from "./effort.js";
import { handleMetricsComponent } from "./metrics.js";
import { handleModelComponent } from "./model.js";
import { handlePulseComponent } from "./pulse.js";
import { handleSettingsComponent } from "./settings.js";
import { handleBackupComponent } from "../../commands/backup.js";
import type { ComponentHandlers, ComponentInteraction } from "./types.js";

// Null-prototype so a custom id of "toString:" / "constructor:" / etc.
// can't resolve an inherited Object.prototype method via `handlers[key]`.
export const COMPONENT_HANDLERS: ComponentHandlers = Object.assign(
  Object.create(null),
  {
    "settings:": handleSettingsComponent,
    "pulse:": handlePulseComponent,
    "effort:": handleEffortComponent,
    "model:": handleModelComponent,
    "metrics:": handleMetricsComponent,
    "backup:": handleBackupComponent,
    "ai:": forwardToAgent,
  } satisfies ComponentHandlers,
);

/**
 * The table key for a custom id: its first segment, colon included
 * (`"settings:done"` → `"settings:"`). An id with no colon keys to `""`,
 * which no handler claims.
 */
export function componentRouteKey(customId: string): string {
  return customId.slice(0, customId.indexOf(":") + 1);
}

function chatIdFromInteraction(interaction: ComponentInteraction): {
  chatId: string;
  numericChatId: number;
} {
  const chatId = interaction.guildId
    ? `discord_guild_${interaction.guildId}_${interaction.channelId}`
    : `discord_dm_${interaction.user.id}`;
  return { chatId, numericChatId: deriveNumericChatId(chatId) };
}

export async function handleComponentInteraction(
  interaction: ComponentInteraction,
  config: TalonConfig,
  gateway: Gateway,
): Promise<void> {
  // Access control
  const access = isInteractionAllowed(
    interaction.inGuild(),
    interaction.user.id,
    interaction.guildId,
    interaction.channelId,
  );
  if (!access.ok) {
    await interaction.reply({
      content: `⚠️ ${access.reason}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { chatId, numericChatId } = chatIdFromInteraction(interaction);
  registerDiscordChat({
    channelId: interaction.channelId!,
    guildId: interaction.guildId,
    userId: interaction.guildId ? null : interaction.user.id,
    numericChatId,
    chatId,
  });

  const customId = interaction.customId;
  const handler = COMPONENT_HANDLERS[componentRouteKey(customId)];
  if (
    handler &&
    (await handler(interaction, { config, gateway, chatId, numericChatId }))
  ) {
    return;
  }

  // Unknown custom_id — log + silently ack so Discord doesn't show
  // "Interaction failed". This catches stale buttons from older panels.
  logError("discord", `Unknown custom_id: ${customId}`);
  try {
    await interaction.deferUpdate();
  } catch {
    /* ignore */
  }
}
