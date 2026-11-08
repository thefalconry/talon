/**
 * Admin + maintenance commands — /restart, /metrics, /dream, /admin.
 * All gate on `isAdmin`.
 */

import {
  type ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import type { TalonConfig } from "../../../core/config/index.js";
import type { Gateway } from "../../../core/engine/gateway.js";
import { respawnSelf } from "../../../core/daemon/respawn.js";
import { forceDream } from "../../../core/background/dream/index.js";
import {
  formatDuration,
  renderMetricsMessages,
  renderDoctorMessages,
} from "../render.js";
import { collectDoctorReport } from "../../../core/doctor/index.js";
import { getMetrics, getTodayMetrics } from "../../../storage/metrics.js";
import { handleAdminSubcommand } from "../admin.js";
import { isAdmin } from "../handlers/index.js";
import {
  suppressMentions,
  DISCORD_MAX_TEXT,
  safeSlice,
  escapeForCodeBlock,
} from "../formatting.js";
import {
  getRepoRoot,
  runSelfUpdate,
  describeCheckpoint,
} from "../../../core/update/self-update.js";
import { reply } from "./interaction.js";

export async function handleRestart(
  i: ChatInputCommandInteraction,
): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  await reply(i, "♻️ Restarting...", true);
  respawnSelf("discord /restart");
}

export async function handleMetrics(
  i: ChatInputCommandInteraction,
): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  // Ephemeral — admin counters (token usage, latencies, errors) shouldn't leak
  // into a public channel where non-admins can read them. Both views are one
  // button apart rather than two bursts of messages.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const messages = renderMetricsMessages(
    getTodayMetrics(),
    undefined,
    "📊 Metrics — today (UTC)",
  );
  await i.editReply({
    content: messages[0]!,
    components: [metricsViewRow("today").toJSON()],
  });
  for (const extra of messages.slice(1)) {
    await i.followUp({ content: extra, flags: MessageFlags.Ephemeral });
  }
}

/** Today / all-time toggle under the metrics panel. */
export function metricsViewRow(
  view: MetricsView,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("metrics:today")
      .setLabel("Today")
      .setStyle(view === "today" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(view === "today"),
    new ButtonBuilder()
      .setCustomId("metrics:all")
      .setLabel("All time")
      .setStyle(view === "all" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(view === "all"),
  );
}

export type MetricsView = "today" | "all";

/** Panel body for one view — shared by the command and the toggle. */
export function renderMetricsView(view: MetricsView): string[] {
  return view === "today"
    ? renderMetricsMessages(
        getTodayMetrics(),
        undefined,
        "📊 Metrics — today (UTC)",
      )
    : renderMetricsMessages(getMetrics(), undefined, "📊 Metrics — all time");
}

export async function handleDoctor(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply("🩺 Running checks...");
  try {
    // Same checks as `talon doctor` — config exists by definition when the
    // bot is processing this command.
    const report = await collectDoctorReport({ config, hasConfigFile: true });
    const messages = renderDoctorMessages(report);
    await i.editReply(messages[0]!);
    for (const extra of messages.slice(1))
      await i.followUp({
        content: extra,
        flags: MessageFlags.Ephemeral,
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await i.editReply(`🩺 Doctor failed: ${msg}`);
  }
}

export async function handleDream(
  i: ChatInputCommandInteraction,
): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply("🌙 Dream mode starting...");
  const start = Date.now();
  forceDream()
    .then(async () => {
      const elapsed = formatDuration(Date.now() - start);
      await i.editReply(
        `🌙 Dream complete — memory consolidated in ${elapsed}.`,
      );
    })
    .catch(async (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      await i.editReply(`🌙 Dream failed: ${msg}`);
    });
}

/**
 * /update [force] — pull, reinstall, run setup, restart. Refused when the
 * pre-update checkpoint fails unless `force` is set. Only reachable on developer
 * builds running from a git checkout; the command is not registered at all
 * otherwise (see buildCommandDefinitions).
 */
export async function handleUpdate(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  const repoRoot = config.devBuild ? getRepoRoot() : null;
  if (!repoRoot) {
    await reply(i, "Update is only available on developer builds.", true);
    return;
  }
  const remote = config.update?.remote ?? "origin";
  const branch = config.update?.branch ?? "main";
  const force = i.options.getBoolean("force") ?? false;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply(
    `⏳ Updating from \`${remote}/${branch}\`` +
      (force ? " (forced: a failed checkpoint will not stop it)" : "") +
      "…",
  );
  const edit = (text: string) => i.editReply(safeSlice(text, DISCORD_MAX_TEXT));

  // Fire-and-forget so the gateway keeps processing other interactions.
  runSelfUpdate({
    remote,
    branch,
    setup: config.update?.setup,
    repoRoot,
    force,
  })
    .then(async (res) => {
      if (res.checkpointRefused) {
        await edit(
          `🛑 Update refused: ${res.error ?? "the pre-update checkpoint failed"}\n\n` +
            "Run `/update force:true` to update without a checkpoint.",
        );
        return;
      }
      const note = res.checkpoint
        ? `\n${describeCheckpoint(res.checkpoint)}`
        : "";
      if (!res.ok) {
        const tail = res.steps[res.steps.length - 1]?.output ?? "";
        await edit(
          `⚠️ Update failed: ${res.error ?? "unknown error"}` +
            note +
            (tail
              ? `\n\`\`\`\n${escapeForCodeBlock(tail.slice(-1200))}\n\`\`\``
              : ""),
        );
        return;
      }
      if (!res.changed) {
        await edit(
          `✅ Already up to date at \`${res.before ?? "?"}\` — no restart needed.`,
        );
        return;
      }
      await edit(
        `✅ Updated \`${res.before ?? "?"}\` → \`${res.after ?? "?"}\`.${note}\n♻️ Restarting…`,
      );
      // The successor documents any provisioning changes (plugin runtime
      // upgrades, migrations) back to this channel once it's up.
      const { armProvisionReport } =
        await import("../../../core/plugin/provision-journal.js");
      armProvisionReport("discord", String(i.channelId));
      respawnSelf("discord /update");
    })
    .catch(async (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      await edit(`⚠️ Update crashed: ${msg}`);
    });
}

export async function handleAdmin(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  const sub = i.options.getString("sub", true);
  const args = i.options.getString("args") ?? "";
  // Ephemeral — admin subcommands surface operational data (chat lists, logs,
  // cron, daily logs) that shouldn't leak into the channel for non-admins.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await handleAdminSubcommand(sub, args, config, gateway, async (text) => {
    await i.followUp({
      content: suppressMentions(text).slice(0, DISCORD_MAX_TEXT),
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
  });
}
