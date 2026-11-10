/**
 * Admin + maintenance commands — /admin, /metrics, /doctor, /dream,
 * /restart, /update — plus the unknown-command "did you mean…?" suggester.
 *
 * Most commands here gate on the configured admin user id via
 * `isAuthorizedAdmin`.
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../../core/config/index.js";
import { respawnSelf } from "../../../core/daemon/respawn.js";
import { isStaleCommand } from "../polling/stale-command.js";
import {
  describeCheckpoint,
  getRepoRoot,
  runSelfUpdate,
  wantsForce,
} from "../../../core/update/self-update.js";
import { forceDream } from "../../../core/background/dream/index.js";
import { escapeHtml } from "../formatting.js";
import { closestMatch } from "../../../native/strsim.js";
import { formatDuration } from "../../presentation/format.js";
import {
  renderDoctorMessage,
  renderMetricsKeyboard,
  renderMetricsPanel,
  renderUsageMessage,
} from "../render/reports.js";
import { collectPlanUsage } from "../../presentation/plan-usage-report.js";
import {
  canUseReset,
  sendResetConfirmation,
  usageResetKeyboard,
} from "../callbacks/usage-reset.js";
import { collectDoctorReport } from "../../../core/doctor/index.js";
import { handleAdminCommand } from "../admin.js";
import { getTodayMetrics } from "../../../storage/metrics.js";
import { isAuthorizedAdmin, type RegisterDeps } from "./state.js";
import { telegramCommandMenu } from "./definitions.js";

function registerAdminCommand(
  bot: Bot,
  { config, gateway }: RegisterDeps,
): void {
  bot.command("admin", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    await handleAdminCommand(ctx, bot, config, gateway);
  });
}

function registerMetricsCommand(bot: Bot): void {
  bot.command("metrics", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    // One message, two grains. Today opens first — it is the smaller,
    // more actionable view; All time is a tap away on the same message.
    await ctx.reply(renderMetricsPanel(getTodayMetrics(), "today"), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: renderMetricsKeyboard("today") },
    });
  });
}

// /usage — plan limits across every exposed backend, not just this
// chat's. Not admin-gated: it says how close the shared account is to a
// wall, which is exactly what a user hitting one needs to know. Spending a
// banked reset is: the "Use a reset" button (and `/usage reset`) only ever
// reach the configured admin in a DM, and both end at a Confirm press.
function registerUsageCommand(bot: Bot, config: TalonConfig): void {
  bot.command("usage", async (ctx) => {
    const entries = await collectPlanUsage(config);
    if (ctx.match.trim().toLowerCase() === "reset") {
      if (!canUseReset(ctx)) {
        await ctx.reply(
          "Only the admin can use a usage-limit reset, in a private chat.",
        );
        return;
      }
      const target = entries.find((e) => (e.plan?.resetsAvailable ?? 0) > 0);
      if (!target) {
        await ctx.reply("No usage-limit reset is available to use right now.");
        return;
      }
      await sendResetConfirmation(ctx, target.id);
      return;
    }
    const keyboard = usageResetKeyboard(ctx, entries);
    await ctx.reply(renderUsageMessage(entries), {
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  });
}

function registerDoctorCommand(bot: Bot, config: TalonConfig): void {
  bot.command("doctor", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    const sent = await ctx.reply("🩺 Running checks...");
    try {
      // Same checks as `talon doctor` — config exists by definition
      // when the bot is processing this command.
      const report = await collectDoctorReport({ config, hasConfigFile: true });
      await bot.api.editMessageText(
        ctx.chat.id,
        sent.message_id,
        renderDoctorMessage(report),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await bot.api.editMessageText(
        ctx.chat.id,
        sent.message_id,
        `🩺 Doctor failed: ${escapeHtml(msg)}`,
        { parse_mode: "HTML" },
      );
    }
  });
}

function registerDreamCommand(bot: Bot): void {
  bot.command("dream", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    const sent = await ctx.reply("🌙 Dream mode starting...");
    const start = Date.now();
    // Fire-and-forget — don't await, so grammY can keep processing other updates
    forceDream()
      .then(async () => {
        const elapsed = formatDuration(Date.now() - start);
        await bot.api.editMessageText(
          ctx.chat.id,
          sent.message_id,
          `🌙 Dream complete — memory consolidated in ${elapsed}.`,
        );
      })
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        await bot.api.editMessageText(
          ctx.chat.id,
          sent.message_id,
          `🌙 Dream failed: ${escapeHtml(msg)}`,
          { parse_mode: "HTML" },
        );
      });
  });
}

function registerRestartCommand(bot: Bot): void {
  bot.command("restart", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    // A restart that predates this process is a redelivery (or an order
    // aimed at a daemon that is already gone) — obeying it would restart
    // us again, and again, on every boot.
    if (isStaleCommand(ctx.message?.date, "/restart")) return;
    await ctx.reply("♻️ Restarting...");
    respawnSelf("telegram /restart");
  });
}

// /update [force] — pull latest, reinstall, run setup, restart. Refused
// when the pre-update checkpoint fails unless "force" is given. Only wired
// up for developer builds running from a git checkout; packaged
// binaries have no source tree (getRepoRoot() === null) so the
// command stays absent entirely.
function registerUpdateCommand(
  bot: Bot,
  config: TalonConfig,
  updateRepoRoot: string,
): void {
  bot.command("update", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    // Same redelivery hazard as /restart — it also ends the process.
    if (isStaleCommand(ctx.message?.date, "/update")) return;
    const remote = config.update?.remote ?? "origin";
    const branch = config.update?.branch ?? "main";
    const force = wantsForce(typeof ctx.match === "string" ? ctx.match : "");
    const sent = await ctx.reply(
      `⏳ Updating from <code>${escapeHtml(remote)}/${escapeHtml(branch)}</code>` +
        (force ? " (forced: a failed checkpoint will not stop it)" : "") +
        "…",
      { parse_mode: "HTML" },
    );
    const edit = (text: string) =>
      bot.api
        .editMessageText(ctx.chat.id, sent.message_id, text, {
          parse_mode: "HTML",
        })
        .catch(() => {});

    // Fire-and-forget so grammY keeps processing other updates.
    runSelfUpdate({
      remote,
      branch,
      setup: config.update?.setup,
      repoRoot: updateRepoRoot,
      force,
    })
      .then(async (res) => {
        if (res.checkpointRefused) {
          await edit(
            `🛑 Update refused: ${escapeHtml(res.error ?? "the pre-update checkpoint failed")}\n\n` +
              `Send <code>/update force</code> to update without a checkpoint.`,
          );
          return;
        }
        const note = res.checkpoint
          ? `\n${escapeHtml(describeCheckpoint(res.checkpoint))}`
          : "";
        if (!res.ok) {
          const tail = res.steps[res.steps.length - 1]?.output ?? "";
          await edit(
            `⚠️ Update failed: ${escapeHtml(res.error ?? "unknown error")}` +
              note +
              (tail ? `\n\n<pre>${escapeHtml(tail.slice(-1500))}</pre>` : ""),
          );
          return;
        }
        if (!res.changed) {
          await edit(
            `✅ Already up to date at <code>${escapeHtml(res.before ?? "?")}</code> — no restart needed.`,
          );
          return;
        }
        await edit(
          `✅ Updated <code>${escapeHtml(res.before ?? "?")}</code> → <code>${escapeHtml(res.after ?? "?")}</code>.${note}\n♻️ Restarting…`,
        );
        // The successor documents any provisioning changes (plugin
        // runtime upgrades, migrations) back to this chat once it's up.
        const { armProvisionReport } =
          await import("../../../core/plugin/provision-journal.js");
        armProvisionReport("telegram", String(ctx.chat.id));
        respawnSelf("telegram /update");
      })
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        await edit(`⚠️ Update crashed: ${escapeHtml(msg)}`);
      });
  });
}

// Unknown /command → "did you mean ...?" via the C similarity core
// (native/strsim-wasm). Registered after every real command, so grammY
// only reaches this when nothing above matched. Only bare commands
// are intercepted — a close miss gets a suggestion, anything else
// keeps flowing to the agent as a normal message.
function registerUnknownCommandSuggester(bot: Bot, config: TalonConfig): void {
  const commandNames = telegramCommandMenu(config).map((c) => c.command);
  bot.on("message::bot_command", async (ctx, next) => {
    const typed = /^\/([a-zA-Z0-9_]+)(?:@(\w+))?\s*$/.exec(ctx.msg.text ?? "");
    if (!typed) return next();
    const [, name, mention] = typed;
    // In groups a command can be addressed to another bot — not ours
    // to answer.
    if (mention && mention.toLowerCase() !== ctx.me.username.toLowerCase()) {
      return next();
    }
    const suggestion = closestMatch(name.toLowerCase(), commandNames);
    if (!suggestion) return next();
    await ctx.reply(
      `Unknown command /${name} — did you mean /${suggestion.value}?`,
    );
  });
}

export function registerAdminCommands(bot: Bot, deps: RegisterDeps): void {
  const { config } = deps;
  registerAdminCommand(bot, deps);
  registerMetricsCommand(bot);
  registerUsageCommand(bot, config);
  registerDoctorCommand(bot, config);
  registerDreamCommand(bot);
  registerRestartCommand(bot);
  const updateRepoRoot = config.devBuild ? getRepoRoot() : null;
  if (updateRepoRoot) registerUpdateCommand(bot, config, updateRepoRoot);
  registerUnknownCommandSuggester(bot, config);
}
