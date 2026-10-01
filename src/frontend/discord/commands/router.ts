/**
 * Interaction routing — the `interactionCreate` listener that dispatches
 * slash commands, autocomplete, component interactions, and modal submits.
 */

import {
  type Client,
  type ChatInputCommandInteraction,
  type Interaction,
  MessageFlags,
} from "discord.js";
import type { TalonConfig } from "../../../core/config/index.js";
import type { Gateway } from "../../../core/engine/gateway.js";
import { logError } from "../../../util/log.js";
import {
  isInteractionAllowed,
  registerDiscordChat,
} from "../handlers/index.js";
import {
  handleAutocomplete,
  handleComponentInteraction,
  handleModalSubmit,
} from "../callbacks/index.js";
import { chatIdFromInteraction, reply, client } from "./interaction.js";
import {
  handleStart,
  handleHelp,
  handlePing,
  handlePlugins,
  handleMesh,
  handleUsage,
} from "./info.js";
import { handleReset, handleStatus, handleStop } from "./session.js";
import {
  handleModel,
  handleEffort,
  handlePulse,
  handleSettings,
} from "./settings.js";
import { handleBackup } from "./backup.js";
import { handleSecret } from "./secret.js";
import {
  handleRestart,
  handleMetrics,
  handleDream,
  handleAdmin,
  handleDoctor,
  handleUpdate,
} from "./admin.js";

export function registerInteractionRouter(
  client: Client,
  config: TalonConfig,
  gateway: Gateway,
): void {
  client.on("interactionCreate", async (interaction: Interaction) => {
    try {
      // Slash commands
      if (interaction.isChatInputCommand()) {
        await routeSlashCommand(interaction, config, gateway);
        return;
      }
      // Autocomplete for /model name:
      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction, gateway);
        return;
      }
      // Buttons & select menus → callbacks.ts handler
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        await handleComponentInteraction(interaction, config, gateway);
        return;
      }
      // Modal submissions (pulse interval)
      if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction, config, gateway);
        return;
      }
    } catch (err) {
      logError("discord", "Interaction handling failed", err);
      try {
        if (
          interaction.isRepliable() &&
          !interaction.replied &&
          !interaction.deferred
        ) {
          await interaction.reply({
            content: "Something went wrong handling that interaction.",
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        /* ignore */
      }
    }
  });
}

async function routeSlashCommand(
  interaction: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
): Promise<void> {
  // Access control — same as message handler, but synchronous decision.
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

  // Register chat in the registry so action handler can resolve channel later.
  const { chatId, numericChatId } = chatIdFromInteraction(interaction);
  registerDiscordChat({
    channelId: interaction.channelId!,
    guildId: interaction.guildId,
    userId: interaction.guildId ? null : interaction.user.id,
    numericChatId,
    chatId,
  });

  switch (interaction.commandName) {
    case "start":
      return handleStart(interaction);
    case "help":
      return handleHelp(interaction, client(interaction));
    case "settings":
      return handleSettings(interaction, config, gateway, chatId);
    case "status":
      return handleStatus(interaction, config, gateway, chatId);
    case "ping":
      return handlePing(interaction);
    case "model":
      return handleModel(interaction, config, gateway, chatId);
    case "effort":
      return handleEffort(interaction, config, gateway, chatId);
    case "pulse":
      return handlePulse(interaction, chatId);
    case "reset":
      return handleReset(interaction, gateway, chatId);
    case "stop":
      return handleStop(interaction, chatId);
    case "restart":
      return handleRestart(interaction);
    case "metrics":
      return handleMetrics(interaction);
    case "dream":
      return handleDream(interaction);
    case "plugins":
      return handlePlugins(interaction);
    case "usage":
      return handleUsage(interaction, config);
    case "doctor":
      return handleDoctor(interaction, config);
    case "mesh":
      return handleMesh(interaction);
    case "update":
      return handleUpdate(interaction, config);
    case "backup":
      return handleBackup(interaction);
    case "secret":
      return handleSecret(interaction, chatId);
    case "admin":
      return handleAdmin(interaction, config, gateway);
    default:
      await reply(interaction, "Unknown command.", true);
  }
}
