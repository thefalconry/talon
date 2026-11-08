/**
 * Settings commands — /model, /effort, /pulse, /settings.
 */

import {
  type ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} from "discord.js";
import type { TalonConfig } from "../../../core/config/index.js";
import type { Gateway } from "../../../core/engine/gateway.js";
import {
  getChatSettings,
  setChatModelForBackend,
  setChatBackend,
  setChatEffort,
  setChatPulseInterval,
  type EffortLevel,
} from "../../../storage/chat-settings.js";
import { resolveModelId as resolveModelName } from "../../../core/models/catalog.js";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
} from "../../../core/background/pulse/pulse.js";
import {
  formatModelLabel,
  formatDuration,
  parseInterval,
  renderSettingsText,
  EFFORT_DESCRIPTIONS,
} from "../render.js";
import {
  displayReasoningEffort,
  getActiveReasoningLevels,
  supportsReasoningLevel,
} from "../../presentation/reasoning-levels.js";
import {
  getBackendIdForChat,
  resolveChatBackend,
} from "../../../core/engine/backend-controller/index.js";
import { resolveActiveModelForChat } from "../../../core/models/active-model.js";
import { safeSlice } from "../formatting.js";
import { reply } from "./interaction.js";
import {
  buildModelPickerView,
  MODEL_NAV_PREFIX,
  MODEL_PAGE_SIZE,
} from "../model-picker.js";

export async function handleModel(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
  chatId: string,
): Promise<void> {
  // Defer immediately — getSettingsPresentation / resolveModel can hit a cold
  // backend and exceed the 3s interaction ACK window.
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const arg = i.options.getString("name")?.trim();
  // Per-chat backend — /model picks for the backend serving *this*
  // chat, override-aware. Without this, switching to openai-agents
  // in one channel and running /model in another would show the
  // wrong catalog.
  const be = resolveChatBackend(chatId, gateway?.backend);
  const beId = getBackendIdForChat(chatId);
  const { model: resolvedActive } = await resolveActiveModelForChat(
    chatId,
    be,
    beId,
    config,
  );
  const activeModel = resolvedActive ?? "";

  if (
    !arg ||
    arg.toLowerCase() === "reset" ||
    arg.toLowerCase() === "default"
  ) {
    if (arg) {
      setChatModelForBackend(chatId, beId, undefined);
      const { model: postResetModel } = await resolveActiveModelForChat(
        chatId,
        be,
        beId,
        config,
      );
      const msg = postResetModel
        ? `Model reset to default: \`${postResetModel}\``
        : `Model reset — no default available for backend \`${beId}\`. Use /model to pick one.`;
      await reply(i, msg, true);
      return;
    }
    if (be?.models?.getSettingsPresentation) {
      const pres = await be.models?.getSettingsPresentation(activeModel, {
        callbackPrefix: "model:",
        navCallbackPrefix: MODEL_NAV_PREFIX,
        pageSize: MODEL_PAGE_SIZE,
      });
      const modelInfo = activeModel
        ? await be.models?.getRawModelInfo?.(activeModel)
        : undefined;
      const displayName =
        modelInfo?.displayName ??
        (activeModel ? formatModelLabel(activeModel) : "_No model selected_");

      const view = buildModelPickerView(pres, displayName, beId);
      await i.editReply({
        content: view.content,
        components: view.components,
        allowedMentions: { parse: [] },
      });
    } else {
      await reply(i, `**Model:** \`${formatModelLabel(activeModel)}\``, true);
    }
    return;
  }

  if (be?.models?.resolveModelInfo) {
    const resolution = await be.models?.resolveModelInfo(arg);
    if (resolution.kind !== "exact") {
      const msg =
        be.models?.formatModelError?.(arg, resolution) ??
        `No model matched "${arg}".`;
      await reply(i, msg, true);
      return;
    }
    if (!resolution.model.selectable) {
      const msg =
        resolution.model.unavailableReason ??
        `${resolution.model.providerName} is not connected.`;
      await reply(i, msg, true);
      return;
    }
    setChatModelForBackend(chatId, beId, resolution.storedValue);
    setChatBackend(chatId, beId);
    await reply(
      i,
      `Model set to \`${resolution.storedValue}\` (${resolution.model.providerName}${resolution.model.free ? " · free" : ""}).`,
      true,
    );
  } else {
    const model = resolveModelName(arg);
    setChatModelForBackend(chatId, beId, model);
    setChatBackend(chatId, beId);
    await reply(i, `Model set to \`${formatModelLabel(model)}\`.`, true);
  }
}

export async function handleEffort(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
  chatId: string,
): Promise<void> {
  const level = i.options.getString("level")?.toLowerCase();
  const settings = getChatSettings(chatId);
  const be = resolveChatBackend(chatId, gateway?.backend);
  const beId = getBackendIdForChat(chatId);
  const reasoning = await getActiveReasoningLevels({
    chatId,
    backend: be,
    backendId: beId,
    config,
  });

  // Reset first: adaptive needs no model levels, so it must stay
  // reachable on a model that registers none.
  if (level === "adaptive" || level === "reset" || level === "default") {
    setChatEffort(chatId, undefined);
    await reply(
      i,
      "Effort reset to **adaptive** (model decides when to think)",
      true,
    );
    return;
  }

  if (reasoning.levels.length === 0) {
    await reply(
      i,
      `No valid reasoning levels found for the active model on backend \`${beId}\`.`,
      true,
    );
    return;
  }

  if (!level) {
    const current = displayReasoningEffort(settings.effort, reasoning.levels);
    const options = [...reasoning.levels, "adaptive"].map((v) => ({
      label: v,
      value: v,
      description: EFFORT_DESCRIPTIONS[v],
      default: current === v,
    }));
    const menu = new StringSelectMenuBuilder()
      .setCustomId("effort:select")
      .setPlaceholder(`Current: ${current}`)
      .addOptions(options);
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      menu,
    );
    await i.reply({
      content: `**Effort:** ${current}`,
      components: [row],
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (supportsReasoningLevel(level, reasoning.levels)) {
    setChatEffort(chatId, level as EffortLevel);
    await reply(i, `Effort set to **${level}**`, true);
    return;
  }
  await reply(
    i,
    `Unknown level for this model. Valid: ${reasoning.levels.join(", ")}, or adaptive.`,
    true,
  );
}

export async function handlePulse(
  i: ChatInputCommandInteraction,
  chatId: string,
): Promise<void> {
  const arg = i.options.getString("arg")?.trim().toLowerCase();

  if (!arg || arg === "status") {
    const enabled = isPulseEnabled(chatId);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("pulse:on")
        .setLabel(enabled ? "✓ On" : "On")
        .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("pulse:off")
        .setLabel(!enabled ? "✓ Off" : "Off")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("pulse:interval")
        .setLabel("Set interval…")
        .setStyle(ButtonStyle.Secondary),
    );
    await i.reply({
      content: [
        `**🔔 Pulse:** ${enabled ? "on" : "off"}`,
        "",
        "Reads along every few minutes and jumps in when there's something to add.",
      ].join("\n"),
      components: [row],
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (arg === "on" || arg === "enable") {
    enablePulse(chatId);
    registerChat(chatId);
    await reply(i, "🔔 Pulse enabled.", true);
    return;
  }
  if (arg === "off" || arg === "disable") {
    disablePulse(chatId);
    await reply(i, "🔔 Pulse disabled.", true);
    return;
  }
  const intervalMs = parseInterval(arg);
  if (intervalMs && intervalMs >= 5 * 60 * 1000) {
    setChatPulseInterval(chatId, intervalMs);
    enablePulse(chatId);
    registerChat(chatId);
    await reply(
      i,
      `🔔 Pulse cooldown set to **${formatDuration(intervalMs)}**`,
      true,
    );
    return;
  }
  if (intervalMs) {
    await reply(i, "Minimum interval is 5 minutes.", true);
    return;
  }
  await reply(i, "Use: /pulse on, /pulse off, /pulse 30m, /pulse 2h", true);
}

export async function handleSettings(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
  chatId: string,
): Promise<void> {
  // Defer immediately — getSettingsPresentation hits the backend.
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const chatSets = getChatSettings(chatId);
  const settingsBe = resolveChatBackend(chatId, gateway?.backend);
  const settingsBeId = getBackendIdForChat(chatId);
  const { model: resolvedActive } = await resolveActiveModelForChat(
    chatId,
    settingsBe,
    settingsBeId,
    config,
  );
  const activeModel = resolvedActive ?? "No model selected";
  const pulseOn = isPulseEnabled(chatId);
  const reasoning = await getActiveReasoningLevels({
    chatId,
    backend: settingsBe,
    backendId: settingsBeId,
    config,
  });
  const effortName = displayReasoningEffort(chatSets.effort, reasoning.levels);

  let modelDetails: Array<string> | undefined;
  let modelButtons: Array<{ text: string; callback_data: string }> | undefined;
  // `settingsBe` already resolved above for the activeModel lookup;
  // reuse it for the catalog snapshot. Pass the raw resolved id (or
  // empty string) — never the "No model selected" sentinel.
  if (settingsBe?.models?.getSettingsPresentation) {
    const presModelId = resolvedActive ?? "";
    const presentation =
      await settingsBe.models?.getSettingsPresentation(presModelId);
    modelDetails = presentation.modelDetails;
    modelButtons = presentation.modelButtons;
  }

  // Build components: model select menu, effort select menu, pulse toggle, done.
  const components: ActionRowBuilder<
    StringSelectMenuBuilder | ButtonBuilder
  >[] = [];

  if (modelButtons?.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("settings:model")
      .setPlaceholder("Select a model")
      .addOptions(
        modelButtons.slice(0, 25).map((b) => ({
          label: safeSlice(b.text.replace(/^✓ /, ""), 100),
          value: safeSlice(
            b.callback_data.replace(/^settings:model:/, ""),
            100,
          ),
          default: b.text.startsWith("✓"),
        })),
      );
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    );
  }

  if (reasoning.levels.length > 0) {
    const effortMenu = new StringSelectMenuBuilder()
      .setCustomId("settings:effort:select")
      .setPlaceholder(`Effort: ${effortName}`)
      .addOptions(
        [...reasoning.levels, "adaptive"].map((v) => ({
          label: v,
          value: v,
          description: EFFORT_DESCRIPTIONS[v],
          default: effortName === v,
        })),
      );
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(effortMenu),
    );
  }

  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`settings:proactive:${pulseOn ? "off" : "on"}`)
        .setLabel(pulseOn ? "Pulse: ON" : "Pulse: OFF")
        .setStyle(pulseOn ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("settings:done")
        .setLabel("Done")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  await i.editReply({
    content: renderSettingsText(
      activeModel,
      effortName,
      pulseOn,
      chatSets.pulseIntervalMs,
      modelDetails,
    ),
    components,
    allowedMentions: { parse: [] },
  });
}
