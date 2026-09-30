/**
 * /backup — snapshots and checkpoints (admin only), the Discord half.
 *
 * Same surface as Telegram's /backup: the panel (bare `/backup` — status
 * with Back up now / Snapshots / How restore works / Refresh buttons, see
 * backup-panel.ts), now, checkpoint, list, pin/unpin, restore. Restore is behind a button (`backup:restore:<id>`)
 * because it replaces the database, memory and identity of a running
 * agent — and even then it does not restore in place: the request is
 * staged to ~/.talon/restore-pending.json and applied by the next boot,
 * before anything opens the database.
 *
 * The button handler lives here rather than under callbacks/components/
 * so the whole command — prompt, confirmation and staging — reads as one
 * file.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  formatSnapshotList,
  isSnapshotId,
  listSnapshots,
  readManifest,
  setSnapshotPinned,
  writeRestorePending,
} from "../../../core/backup/index.js";
import {
  parseBackupAction,
  renderRestoreConfirm,
} from "../../presentation/backup-panel.js";
import { DISCORD_REPORTS } from "../render.js";
import {
  handleBackupPanelAction,
  replyWithPanel,
  runSnapshotLine,
} from "./backup-panel.js";
import { respawnSelf } from "../../../core/daemon/respawn.js";
import { logError } from "../../../util/log.js";
import { escapeForCodeBlock } from "../formatting.js";
import { isAdmin } from "../handlers/index.js";
import type { ComponentInteraction } from "../callbacks/components/types.js";
import { reply } from "./interaction.js";

function block(text: string): string {
  return `\`\`\`\n${escapeForCodeBlock(text)}\n\`\`\``;
}

function confirmRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`backup:restore:${id}`)
      .setLabel("Restore and restart")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("backup:cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

async function takeSnapshot(
  i: ChatInputCommandInteraction,
  label?: string,
): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply(await runSnapshotLine(label));
}

async function askToRestore(
  i: ChatInputCommandInteraction,
  id: string,
): Promise<void> {
  if (!isSnapshotId(id)) {
    await reply(i, "That is not a snapshot id.", true);
    return;
  }
  const manifest = await readManifest(id);
  if (!manifest) {
    await reply(i, `No snapshot \`${id}\` on this machine.`, true);
    return;
  }
  await i.reply({
    content: renderRestoreConfirm(DISCORD_REPORTS, manifest),
    components: [confirmRow(id).toJSON()],
    flags: MessageFlags.Ephemeral,
  });
}

/** `/backup <subcommand> [arg]`. */
export async function handleBackup(
  i: ChatInputCommandInteraction,
): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  const subcommand = i.options.getString("command") ?? "status";
  const argument = (i.options.getString("arg") ?? "").trim();
  switch (subcommand) {
    case "now":
      await takeSnapshot(i);
      return;
    case "checkpoint":
      if (!argument) {
        await reply(i, "Give the checkpoint a label.", true);
        return;
      }
      await takeSnapshot(i, argument);
      return;
    case "list":
      await reply(i, block(formatSnapshotList(await listSnapshots())), true);
      return;
    case "pin":
    case "unpin": {
      if (!isSnapshotId(argument)) {
        await reply(i, "That is not a snapshot id.", true);
        return;
      }
      const ok = await setSnapshotPinned(argument, subcommand === "pin");
      await reply(
        i,
        ok
          ? `${subcommand === "pin" ? "📌 Pinned" : "Unpinned"} \`${argument}\``
          : `No snapshot \`${argument}\``,
        true,
      );
      return;
    }
    case "restore":
      await askToRestore(i, argument);
      return;
    default:
      await replyWithPanel(i);
  }
}

/**
 * `backup:*` buttons. Returns false for ids this does not own, the way
 * every component handler does, so a stale button is acked not answered.
 */
export async function handleBackupComponent(
  interaction: ComponentInteraction,
): Promise<boolean> {
  const [prefix, action, id] = interaction.customId.split(":");
  if (prefix !== "backup") return false;
  if (!isAdmin(interaction.user.id)) {
    await interaction.update({ content: "Not authorized.", components: [] });
    return true;
  }
  if (action === "cancel") {
    await interaction.update({ content: "Restore cancelled.", components: [] });
    return true;
  }
  const panelAction = parseBackupAction(interaction.customId);
  if (
    panelAction &&
    panelAction.kind !== "restore" &&
    panelAction.kind !== "cancel"
  ) {
    await handleBackupPanelAction(interaction, panelAction);
    return true;
  }
  if (action !== "restore" || !id || !isSnapshotId(id)) return false;
  await interaction.update({
    content:
      `♻️ Restoring \`${id}\` — restarting now. The restore is applied during ` +
      "boot; I will report back when I am up.",
    components: [],
  });
  try {
    const chatId = interaction.guildId
      ? `discord_guild_${interaction.guildId}_${interaction.channelId}`
      : `discord_dm_${interaction.user.id}`;
    await writeRestorePending({
      id,
      requestedAt: Date.now(),
      requestedBy: chatId,
    });
    respawnSelf(`discord /backup restore ${id}`);
  } catch (err) {
    logError("backup", "Staging the restore failed", err);
    await interaction
      .editReply({
        content: `⚠️ Could not stage the restore: ${err instanceof Error ? err.message : String(err)}`,
      })
      .catch(() => {});
  }
  return true;
}
