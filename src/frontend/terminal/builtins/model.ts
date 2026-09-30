/** `/model` and `/effort` — the per-chat model settings. */

import { getModels } from "../../../core/models/catalog.js";
import { resolveModelId as resolveModelName } from "../../../core/models/catalog.js";
import {
  getChatSettings,
  setChatModel,
} from "../../../storage/chat-settings.js";
import {
  describeChatEffort,
  setChatEffortLevel,
} from "../../presentation/model-commands.js";
import type { Command, CommandContext } from "../command-registry.js";

type BackendRef = CommandContext["backend"];

async function showCurrentModel(
  ctx: CommandContext,
  be: BackendRef,
  currentModel: string,
): Promise<void> {
  const modelInfo = await be?.models?.getRawModelInfo?.(currentModel);
  const displayName = modelInfo?.displayName ?? currentModel;
  const details = modelInfo
    ? [
        modelInfo.providerName,
        modelInfo.free ? "free" : undefined,
        modelInfo.selectable
          ? "ready"
          : (modelInfo.unavailableReason ?? "not connected"),
      ].filter(Boolean)
    : [];
  ctx.renderer.writeSystem(
    `Model: ${displayName}${details.length ? ` · ${details.join(" · ")}` : ""}`,
  );
  if (modelInfo?.contextWindow) {
    ctx.renderer.writeln(
      `  Context window: ${modelInfo.contextWindow.toLocaleString()}`,
    );
  }
  if (be?.models?.getProviders) {
    const providers = await be.models?.getProviders();
    const connected = providers.filter((p) => p.connected);
    if (connected.length > 0) {
      ctx.renderer.writeln(
        `  Providers: ${connected.map((p) => `${p.name} (${p.modelCount})`).join(", ")}`,
      );
    }
  }
  ctx.renderer.writeln(
    `  Use /model free, /model all, /model providers, or /model <name>.`,
  );
  ctx.reprompt();
}

async function listModels(
  ctx: CommandContext,
  be: BackendRef,
  lowerArgs: string,
): Promise<void> {
  if (be?.models?.listModels) {
    const filter = lowerArgs === "free" ? "free" : "all";
    const { models, total } = await be.models.listModels(filter);
    const list = models.slice(0, 20);
    ctx.renderer.writeSystem(
      `${filter === "free" ? "Free" : "Available"} models (${total})`,
    );
    for (const model of list) {
      ctx.renderer.writeln(
        `  ${model.displayName}  ·  ${model.providerName}${model.contextWindow ? `  ·  ${model.contextWindow.toLocaleString()} ctx` : ""}${model.free ? "  ·  free" : ""}`,
      );
    }
    if (total > list.length) {
      ctx.renderer.writeln(`  …and ${total - list.length} more`);
    }
  } else {
    const names = getModels()
      .map((m) => m.aliases[0] ?? m.id)
      .join(", ");
    ctx.renderer.writeSystem(`Available: ${names}`);
  }
  ctx.reprompt();
}

async function listProviders(
  ctx: CommandContext,
  be: BackendRef,
): Promise<void> {
  if (be?.models?.getProviders) {
    const providers = await be.models?.getProviders();
    ctx.renderer.writeSystem(`Providers (${providers.length})`);
    for (const p of providers.slice(0, 20)) {
      ctx.renderer.writeln(
        `  ${p.name}  ·  ${p.connected ? "connected" : "not connected"}  ·  ${p.modelCount} models`,
      );
    }
  } else {
    ctx.renderer.writeSystem("Provider listing not supported.");
  }
  ctx.reprompt();
}

/** Resolve model query via backend (falling back to the static catalog). */
async function selectModel(
  ctx: CommandContext,
  be: BackendRef,
  trimmedArgs: string,
): Promise<void> {
  if (be?.models?.resolveModelInfo) {
    const resolution = await be.models?.resolveModelInfo(trimmedArgs);
    if (resolution.kind === "missing") {
      const msg =
        be.models?.formatModelError?.(trimmedArgs, resolution) ??
        `No model matched "${trimmedArgs}".`;
      ctx.renderer.writeError(msg);
      ctx.reprompt();
      return;
    }
    if (resolution.kind === "ambiguous") {
      const preview = resolution.matches
        .map((m) => `${m.displayName} (${m.providerName})`)
        .join(", ");
      ctx.renderer.writeError(`Ambiguous: "${trimmedArgs}" matches ${preview}`);
      ctx.reprompt();
      return;
    }
    if (!resolution.model.selectable) {
      ctx.renderer.writeError(
        resolution.model.unavailableReason ??
          `${resolution.model.providerName} is not connected.`,
      );
      ctx.reprompt();
      return;
    }
    setChatModel(ctx.chatId(), resolution.storedValue);
    ctx.renderer.writeSystem(
      `Model → ${resolution.model.displayName} (${resolution.model.providerName}${resolution.model.free ? " · free" : ""})`,
    );
  } else {
    setChatModel(ctx.chatId(), resolveModelName(trimmedArgs));
    ctx.renderer.writeSystem(`Model → ${resolveModelName(trimmedArgs)}`);
  }
  ctx.reprompt();
}

export const modelCommand: Command = {
  name: "model",
  argHint: "[name]",
  description: "Switch model",
  async handler(args, ctx) {
    const currentModel =
      getChatSettings(ctx.chatId()).model ?? ctx.config.model;
    const be = ctx.backend;

    const trimmedArgs = args.trim();
    const lowerArgs = trimmedArgs.toLowerCase();

    if (!trimmedArgs) {
      return showCurrentModel(ctx, be, currentModel);
    }

    if (lowerArgs === "reset" || lowerArgs === "default") {
      setChatModel(ctx.chatId(), undefined);
      ctx.renderer.writeSystem(`Model → ${ctx.config.model}`);
      ctx.reprompt();
      return;
    }

    if (lowerArgs === "free" || lowerArgs === "list" || lowerArgs === "all") {
      return listModels(ctx, be, lowerArgs);
    }

    if (lowerArgs === "providers") {
      return listProviders(ctx, be);
    }

    return selectModel(ctx, be, trimmedArgs);
  },
};

export const effortCommand: Command = {
  name: "effort",
  argHint: "[lvl]",
  description: "Thinking effort for the active model",
  async handler(args, ctx) {
    // Same resolution and validation as every chat frontend: the levels
    // the active model registers, plus adaptive/reset/default.
    const deps = {
      config: ctx.config,
      gateway: { backend: ctx.backend ?? null },
    };
    const arg = args.trim();
    if (!arg) {
      const { current, levels } = await describeChatEffort(ctx.chatId(), deps);
      ctx.renderer.writeSystem(
        levels.length
          ? `Effort: ${current} (${levels.join(", ")}, adaptive)`
          : `Effort: ${current}`,
      );
    } else {
      const outcome = await setChatEffortLevel(ctx.chatId(), arg, deps);
      if (outcome.ok) ctx.renderer.writeSystem(outcome.text);
      else ctx.renderer.writeError(outcome.text);
    }
    ctx.reprompt();
  },
};
