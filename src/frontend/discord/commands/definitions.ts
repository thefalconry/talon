/**
 * Slash command definitions + per-guild / global registration.
 *
 * Registration strategy (the heart of access control for slash commands):
 *  - Slash commands are registered as guild-specific in every guild on
 *    config.discord.allowedGuilds → instant propagation, hidden everywhere else.
 *  - When config.discord.enableDmCommands is true, the same set is ALSO
 *    registered globally with dm_permission, so users on allowedUsers can run
 *    them in DMs. We still enforce allowedUsers at execution time so a global
 *    registration leak can't be abused.
 *  - For guilds the bot is in but which are NOT on allowedGuilds, we wipe their
 *    guild commands on startup (and on guildCreate).
 */

import { type Client, REST, Routes, SlashCommandBuilder } from "discord.js";
import type { TalonConfig } from "../../../core/config/index.js";
import { log, logError, logWarn } from "../../../util/log.js";
import { getRepoRoot } from "../../../core/update/self-update.js";

/** /secret — one-time paste link for a password (admin, DMs). */
function secretCommand(): unknown {
  return new SlashCommandBuilder()
    .setName("secret")
    .setDescription("Store a password via a one-time link (admin, DMs)")
    .addStringOption((o) =>
      o
        .setName("name")
        .setDescription("File name under ~/.talon/secrets")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("purpose")
        .setDescription("What it's for (shown on the form)")
        .setRequired(false),
    )
    .toJSON();
}

/**
 * /backup — its own builder: the definitions list is one long literal and
 * this is the only entry with two options and seven choices.
 */
function backupCommand(): unknown {
  return new SlashCommandBuilder()
    .setName("backup")
    .setDescription("Snapshots and checkpoints (admin only)")
    .addStringOption((o) =>
      o
        .setName("command")
        .setDescription("What to do (default: status)")
        .setRequired(false)
        .addChoices(
          { name: "status", value: "status" },
          { name: "now", value: "now" },
          { name: "checkpoint", value: "checkpoint" },
          { name: "list", value: "list" },
          { name: "pin", value: "pin" },
          { name: "unpin", value: "unpin" },
          { name: "restore", value: "restore" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("arg")
        .setDescription(
          "Checkpoint label, or snapshot id for pin/unpin/restore",
        )
        .setRequired(false),
    )
    .toJSON();
}

function buildCommandDefinitions(devBuild = false): unknown[] {
  return [
    new SlashCommandBuilder()
      .setName("start")
      .setDescription("Introduction to Talon")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("All commands and features")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("settings")
      .setDescription("View and change all chat settings")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Session info, usage, and stats")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Health check with latency")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Show or change the model")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Model name or 'reset'")
          .setRequired(false)
          .setAutocomplete(true),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("effort")
      .setDescription("Set thinking effort level")
      .addStringOption((o) =>
        o
          .setName("level")
          .setDescription("Effort level")
          .setRequired(false)
          .addChoices(
            { name: "off", value: "off" },
            { name: "low", value: "low" },
            { name: "medium", value: "medium" },
            { name: "high", value: "high" },
            { name: "max", value: "max" },
            { name: "adaptive", value: "adaptive" },
          ),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("pulse")
      .setDescription("Toggle periodic check-ins")
      .addStringOption((o) =>
        o
          .setName("arg")
          .setDescription("on, off, or interval (e.g. 30m, 2h)")
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reset")
      .setDescription("Clear session and start fresh")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("stop")
      .setDescription("Stop the current response")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("restart")
      .setDescription("Restart the bot (admin only)")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("metrics")
      .setDescription("Aggregate performance metrics (admin)")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("dream")
      .setDescription("Force memory consolidation (admin)")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("plugins")
      .setDescription("List loaded plugins")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("usage")
      .setDescription("Plan limits across every backend")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("doctor")
      .setDescription("Environment and native-module health (admin)")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("mesh")
      .setDescription("Ping and list mesh devices")
      .toJSON(),
    // /update only exists on developer builds running from a git checkout —
    // a packaged binary has no source tree to pull into, so the command is
    // never registered there (same gate as the Telegram handler).
    ...(devBuild && getRepoRoot()
      ? [
          new SlashCommandBuilder()
            .setName("update")
            .setDescription("Pull latest, reinstall, restart (admin)")
            .addBooleanOption((o) =>
              o
                .setName("force")
                .setDescription(
                  "Update even if the pre-update checkpoint fails",
                ),
            )
            .toJSON(),
        ]
      : []),
    backupCommand(),
    secretCommand(),
    new SlashCommandBuilder()
      .setName("admin")
      .setDescription("Admin operations (admin only)")
      .addStringOption((o) =>
        o
          .setName("sub")
          .setDescription("Subcommand")
          .setRequired(true)
          .addChoices(
            { name: "stats", value: "stats" },
            { name: "errors", value: "errors" },
            { name: "chats", value: "chats" },
            { name: "daily", value: "daily" },
            { name: "pulse", value: "pulse" },
            { name: "cron", value: "cron" },
            { name: "logs", value: "logs" },
          ),
      )
      .addStringOption((o) =>
        o.setName("args").setDescription("Extra arguments").setRequired(false),
      )
      .toJSON(),
  ];
}

export async function registerCommandsForGuilds(
  client: Client,
  config: TalonConfig,
): Promise<void> {
  const dc = config.discord!;
  const rest = new REST({ version: "10" }).setToken(dc.botToken);
  const definitions = buildCommandDefinitions(config.devBuild);

  // Step 1: clear or set global commands depending on DM setting.
  try {
    if (dc.enableDmCommands) {
      // Add a dm_permission flag to the JSON before sending.
      const dmDefs = definitions.map((d) => ({
        ...(d as Record<string, unknown>),
        dm_permission: true,
      }));
      await rest.put(Routes.applicationCommands(dc.applicationId), {
        body: dmDefs,
      });
      log(
        "discord",
        `Registered ${dmDefs.length} global commands (DM-enabled)`,
      );
    } else {
      await rest.put(Routes.applicationCommands(dc.applicationId), {
        body: [],
      });
      log("discord", "Cleared global commands (DM commands disabled)");
    }
  } catch (err) {
    logError("discord", "Failed to register/clear global commands", err);
  }

  // Step 2: per-guild registration in allowedGuilds (instant propagation,
  // immediately visible only there). We do this even when global is enabled,
  // so users see the commands instantly inside whitelisted servers.
  for (const guildId of dc.allowedGuilds) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(dc.applicationId, guildId),
        { body: definitions },
      );
      log(
        "discord",
        `Registered ${definitions.length} commands in guild ${guildId}`,
      );
    } catch (err) {
      logError(
        "discord",
        `Failed to register commands in guild ${guildId}`,
        err,
      );
    }
  }

  // Step 3: in any guild the bot is currently in but NOT on allowedGuilds,
  // wipe guild-specific commands (defense in depth).
  for (const guild of client.guilds.cache.values()) {
    if (dc.allowedGuilds.includes(guild.id)) continue;
    try {
      await rest.put(
        Routes.applicationGuildCommands(dc.applicationId, guild.id),
        { body: [] },
      );
      log(
        "discord",
        `Cleared commands in non-whitelisted guild ${guild.id} (${guild.name})`,
      );
    } catch (err) {
      logWarn(
        "discord",
        `Failed to clear commands in guild ${guild.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
