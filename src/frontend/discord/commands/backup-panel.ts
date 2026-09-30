/**
 * The /backup panel on Discord — the same views and custom-id grammar as
 * Telegram (frontend/presentation/backup-panel.ts), spelled in Discord
 * markdown and mapped onto button rows.
 *
 * Discord allows five action rows per message, so snapshot pages hold
 * three snapshots (three rows, navigation, Back). The staged restore
 * (`backup:restore:<id>`) and the confirmation's Cancel stay in
 * backup.ts; this module owns every other `backup:*` button, and every
 * one of them re-checks the admin before it runs (see
 * `handleBackupComponent`).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  collectBackupStatus,
  listSnapshots,
  readManifest,
  runBackup,
  setSnapshotPinned,
} from "../../../core/backup/index.js";
import { logError } from "../../../util/log.js";
import {
  GUIDE_BUTTONS,
  PANEL_BUTTONS,
  backupPanelView,
  renderRestoreGuide,
  restoreConfirmView,
  snapshotPageView,
  type BackupAction,
  type PanelButton,
  type PanelView,
} from "../../presentation/backup-panel.js";
import { DISCORD_REPORTS } from "../render.js";
import type { ComponentInteraction } from "../callbacks/components/types.js";

const DISCORD_PAGE_SIZE = 3;

function buttonRows(
  rows: readonly PanelButton[][],
): ActionRowBuilder<ButtonBuilder>[] {
  return rows.map((row) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      row.map((button) =>
        new ButtonBuilder()
          .setCustomId(button.data)
          .setLabel(button.label)
          .setStyle(
            button.data.startsWith("backup:restore:")
              ? ButtonStyle.Danger
              : ButtonStyle.Secondary,
          ),
      ),
    ),
  );
}

function payload(view: PanelView) {
  return {
    content: view.text,
    components: buttonRows(view.buttons).map((row) => row.toJSON()),
    allowedMentions: { parse: [] as never[] },
  };
}

/**
 * Run one snapshot; the outcome as one markdown line. Never throws. Shared
 * by `/backup now|checkpoint` and the panel's 📸 button.
 */
export async function runSnapshotLine(label?: string): Promise<string> {
  try {
    const manifest = await runBackup({
      kind: label ? "checkpoint" : "backup",
      label,
      pinned: Boolean(label),
      trigger: "command",
    });
    return (
      `✅ \`${manifest.id}\` — ${manifest.parts.length} part(s), ` +
      `${(manifest.sizeBytes / 1024 / 1024).toFixed(1)} MB` +
      (label ? " (pinned)" : "")
    );
  } catch (err) {
    logError("backup", "/backup now failed", err);
    return `⚠️ Backup failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function statusView(notice?: string): Promise<PanelView> {
  return backupPanelView(
    DISCORD_REPORTS,
    await collectBackupStatus(),
    Date.now(),
    notice,
  );
}

async function pageView(page: number): Promise<PanelView> {
  return snapshotPageView(
    DISCORD_REPORTS,
    await listSnapshots(),
    page,
    Date.now(),
    DISCORD_PAGE_SIZE,
  );
}

/** Bare `/backup`: the panel, ephemeral, with its buttons. */
export async function replyWithPanel(
  i: ChatInputCommandInteraction,
): Promise<void> {
  await i.reply({
    ...payload(await statusView()),
    flags: MessageFlags.Ephemeral,
  });
}

/** One panel snapshot at a time: a double tap must not take two. */
let panelSnapshotRunning = false;

/** Tests only. */
export function _resetDiscordBackupPanel(): void {
  panelSnapshotRunning = false;
}

async function backUpNow(interaction: ComponentInteraction): Promise<void> {
  if (panelSnapshotRunning) {
    await interaction.reply({
      content: "A snapshot is already running.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  panelSnapshotRunning = true;
  try {
    await interaction.update({
      content:
        "📸 **Taking a snapshot…**\nBuilding it, then pruning and uploading to any " +
        "targets. This can take a few minutes — this message updates when it is done.",
      components: [],
    });
    const line = await runSnapshotLine();
    const view = await statusView(line).catch((err: unknown) => {
      logError("backup", "Backup panel status read failed", err);
      return { text: line, buttons: PANEL_BUTTONS };
    });
    await interaction.editReply(payload(view));
  } finally {
    panelSnapshotRunning = false;
  }
}

async function viewFor(
  action: Exclude<BackupAction, { kind: "now" | "restore" | "cancel" }>,
): Promise<PanelView | null> {
  switch (action.kind) {
    case "panel":
      return statusView();
    case "list":
      return pageView(action.page);
    case "guide":
      return {
        text: renderRestoreGuide(DISCORD_REPORTS),
        buttons: GUIDE_BUTTONS,
      };
    case "pin":
    case "unpin":
      await setSnapshotPinned(action.id, action.kind === "pin");
      return pageView(action.page);
    case "ask": {
      // The confirmation only — the restore is its own, second tap.
      const manifest = await readManifest(action.id);
      return manifest
        ? restoreConfirmView(DISCORD_REPORTS, manifest, action.page)
        : null;
    }
  }
}

/**
 * Every panel button except the staged restore and Cancel. The caller has
 * already checked the admin.
 */
export async function handleBackupPanelAction(
  interaction: ComponentInteraction,
  action: Exclude<BackupAction, { kind: "restore" | "cancel" }>,
): Promise<void> {
  try {
    if (action.kind === "now") {
      await backUpNow(interaction);
      return;
    }
    const view = await viewFor(action);
    if (!view) {
      await interaction.reply({
        content: "That snapshot has no copy on this machine.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.update(payload(view));
  } catch (err) {
    logError("backup", `Backup panel action ${action.kind} failed`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "⚠️ That did not work — see the log.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }
}
