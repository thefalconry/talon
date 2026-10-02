/**
 * Frontend-agnostic `/model`, `/effort` and backend-switch operations.
 *
 * Telegram and Discord drive these through inline buttons and select
 * menus; a text-only frontend (WhatsApp) has to do the same work from a
 * typed argument — "the third model in the list", "switch to codex",
 * "effort high". The state changes are identical either way, so they
 * live here, shaped as plain data + plain-text outcomes that every
 * frontend can wrap in its own markup. Nothing in this module knows
 * about a socket, a bot API, or a keyboard.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { Backend } from "../../core/agent-runtime/capabilities.js";
import type { ReasoningEffortLevel } from "../../core/types.js";
import {
  getChatSettings,
  setChatBackend,
  setChatEffort,
  setChatModelForBackend,
  type EffortLevel,
} from "../../storage/chat-settings.js";
import { resolveModelId as resolveModelName } from "../../core/models/catalog.js";
import { resolveActiveModelForChat } from "../../core/models/active-model.js";
import {
  getBackendIdForChat,
  hasBackendPool,
  hasChatBackendOverride,
  listAvailableBackends,
  rebindChat,
  releaseChat,
  resolveChatBackend,
} from "../../core/engine/backend-controller/index.js";
import { resetSession } from "../../storage/sessions.js";
import { sharesSessionStore } from "../../core/agent-runtime/backend-registry.js";
import { resetPulseCheckpoint } from "../../core/background/pulse/pulse.js";
import { logWarn } from "../../util/log.js";
import {
  displayReasoningEffort,
  getActiveReasoningLevels,
  supportsReasoningLevel,
} from "./reasoning-levels.js";

export type ModelCommandDeps = {
  config: TalonConfig;
  gateway?: { backend: Backend | null };
};

/** Outcome of a state-changing command, ready to be sent as-is. */
export type CommandOutcome = { ok: boolean; text: string };

/** One selectable catalog entry, numbered for text pickers. */
type ModelChoice = {
  /** 1-based position in the listing — what `/model <n>` refers to. */
  index: number;
  id: string;
  displayName: string;
  providerName: string;
  free: boolean;
};

export type ModelOverview = {
  backendId: string;
  backendLabel: string;
  hasBackendOverride: boolean;
  backends: Array<{ id: string; label: string }>;
  /** Resolved active model id, or null when the chat has none to run on. */
  activeModel: string | null;
  activeDisplay: string | null;
  /** True when the chat pins a model other than the backend's default. */
  hasModelOverride: boolean;
  choices: ModelChoice[];
};

/** The backend + id serving a chat right now (pool-aware, test-safe). */
export function resolveChatBackendPair(
  chatId: string,
  deps: ModelCommandDeps,
): { backend: Backend | null; backendId: string } {
  return {
    backend: resolveChatBackend(chatId, deps.gateway?.backend ?? null),
    backendId: hasBackendPool()
      ? getBackendIdForChat(chatId)
      : deps.config.backend,
  };
}

/**
 * The selectable catalog of the chat's backend, numbered in catalog
 * order. Same call on the listing and on the pick, so `/model 3` names
 * the same entry the user just read. Empty for fixed-model backends.
 */
async function listModelChoices(
  backend: Backend | null,
): Promise<ModelChoice[]> {
  if (!backend?.models?.listModels) return [];
  try {
    const { models } = await backend.models.listModels("all");
    return models
      .filter((m) => m.selectable)
      .map((m, i) => ({
        index: i + 1,
        id: m.id,
        displayName: m.displayName,
        providerName: m.providerName,
        free: m.free === true,
      }));
  } catch (err) {
    logWarn(
      "settings",
      `listModels failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/** Everything a text `/model` listing shows. */
export async function describeChatModels(
  chatId: string,
  deps: ModelCommandDeps,
): Promise<ModelOverview> {
  const { backend, backendId } = resolveChatBackendPair(chatId, deps);
  const backends = listAvailableBackends(deps.config);
  const backendLabel =
    backends.find((b) => b.id === backendId)?.label ??
    backend?.label ??
    backendId;
  const { model, ref, source } = await resolveActiveModelForChat(
    chatId,
    backend,
    backendId,
    deps.config,
  );
  return {
    backendId,
    backendLabel,
    hasBackendOverride: hasBackendPool() && hasChatBackendOverride(chatId),
    backends,
    activeModel: model,
    activeDisplay: ref?.displayName ?? model,
    hasModelOverride: source === "override-valid",
    choices: await listModelChoices(backend),
  };
}

/**
 * Pin a model for the chat. `query` is a catalog id, a fuzzy name the
 * backend resolves, or a 1-based number from `describeChatModels`.
 * Mirrors Telegram's `/model <arg>`: the pick lands in the backend's
 * own slot and the chat is pinned to that backend so a restart can't
 * orphan the id.
 */
export async function selectChatModel(
  chatId: string,
  query: string,
  deps: ModelCommandDeps,
): Promise<CommandOutcome> {
  const { backend, backendId } = resolveChatBackendPair(chatId, deps);
  let wanted = query.trim();
  if (/^\d+$/.test(wanted)) {
    const choices = await listModelChoices(backend);
    const choice = choices[Number(wanted) - 1];
    if (!choice) {
      return {
        ok: false,
        text: choices.length
          ? `No model #${wanted} — the list has ${choices.length} entries.`
          : `This backend has no numbered model list; give a model id instead.`,
      };
    }
    wanted = choice.id;
  }

  if (!backend?.models?.resolveModelInfo) {
    const model = resolveModelName(wanted);
    setChatModelForBackend(chatId, backendId, model);
    setChatBackend(chatId, backendId);
    return { ok: true, text: `Model set to ${model}.` };
  }
  const resolution = await backend.models.resolveModelInfo(wanted);
  if (resolution.kind !== "exact") {
    return {
      ok: false,
      text:
        backend.models.formatModelError?.(wanted, resolution) ??
        `No model matched "${wanted}".`,
    };
  }
  if (!resolution.model.selectable) {
    return {
      ok: false,
      text:
        resolution.model.unavailableReason ??
        `${resolution.model.providerName} is not connected.`,
    };
  }
  setChatModelForBackend(chatId, backendId, resolution.storedValue);
  setChatBackend(chatId, backendId);
  const tag = resolution.model.free ? " · free" : "";
  return {
    ok: true,
    text: `Model set to ${resolution.storedValue} (${resolution.model.providerName}${tag}).`,
  };
}

/** Clear the chat's pick on its current backend; other backends' picks stay. */
export async function resetChatModel(
  chatId: string,
  deps: ModelCommandDeps,
): Promise<CommandOutcome> {
  const { backend, backendId } = resolveChatBackendPair(chatId, deps);
  setChatModelForBackend(chatId, backendId, undefined);
  const { model } = await resolveActiveModelForChat(
    chatId,
    backend,
    backendId,
    deps.config,
  );
  return {
    ok: true,
    text: model
      ? `Model reset to default: ${model}.`
      : `Model reset — no default available for backend ${backendId}; pick one with /model.`,
  };
}

/** The backend an argument names, matched by id or label, else null. */
export function matchBackendArg(
  arg: string,
  config: TalonConfig,
): { id: string; label: string } | null {
  const wanted = arg.trim().toLowerCase();
  if (!wanted) return null;
  return (
    listAvailableBackends(config).find(
      (b) => b.id.toLowerCase() === wanted || b.label.toLowerCase() === wanted,
    ) ?? null
  );
}

/**
 * Drop the session state a backend switch invalidates. Session ids are
 * not portable across backends (the replaced id is archived by
 * resetSession); each backend's remembered model pick IS kept, so
 * switching back restores it. Chat history is never touched: a switch
 * changes who answers, not what was said, and the new backend reads the
 * same stored conversation through its history tools.
 */
function handOffChatSession(
  chatId: string,
  previous: Backend | null,
  deps: ModelCommandDeps,
  move: { from: string; to: string },
): boolean {
  // Claude accounts share one transcript store: the session id stays valid.
  const kept = sharesSessionStore(move.from, move.to);
  if (!kept) resetSession(chatId, "backend-switch");
  resetPulseCheckpoint(chatId);
  previous?.sessions?.resetChat?.(chatId);
  const next = resolveChatBackend(chatId, deps.gateway?.backend ?? null);
  // Warming can take seconds on OpenCode/Kilo; the reply must not wait.
  if (!next || next === previous) return kept;
  void Promise.resolve(next.sessions?.warmSession?.(chatId)).catch((err) =>
    logWarn(
      "settings",
      `[${chatId}] warm after backend switch failed: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
  return kept;
}

/** Model line for the post-switch confirmation. */
async function describeModelAfterSwitch(
  chatId: string,
  backendId: string,
  deps: ModelCommandDeps,
): Promise<string> {
  const backend = resolveChatBackend(chatId, deps.gateway?.backend ?? null);
  const { model } = await resolveActiveModelForChat(
    chatId,
    backend,
    backendId,
    deps.config,
  );
  return model ? `model: ${model}` : "no default model — /model to pick one";
}

/**
 * Rebind the chat to another backend. Same sequence as Telegram's
 * backend submenu; re-selecting the backend already in use only pins
 * the choice and costs the session nothing.
 */
export async function switchChatBackend(
  chatId: string,
  target: { id: string; label: string },
  deps: ModelCommandDeps,
): Promise<CommandOutcome> {
  const { backend: previous, backendId: previousId } = resolveChatBackendPair(
    chatId,
    deps,
  );
  if (previousId === target.id) {
    setChatBackend(chatId, target.id);
    return {
      ok: true,
      text: `Already on ${target.label} (${await describeModelAfterSwitch(chatId, target.id, deps)}).`,
    };
  }
  const result = await rebindChat(chatId, target.id, deps.config);
  if (!result.ok) {
    return {
      ok: false,
      text: `Could not switch to ${target.label}: ${result.error ?? "rebind failed"}`,
    };
  }
  setChatBackend(chatId, target.id);
  const kept = handOffChatSession(chatId, previous, deps, {
    from: previousId,
    to: target.id,
  });
  return {
    ok: true,
    text: `Backend: ${target.label} (${await describeModelAfterSwitch(chatId, target.id, deps)}). ${kept ? "Session kept." : "Session started fresh."}`,
  };
}

/** Drop the per-chat backend override; the chat reverts to the default. */
export async function resetChatBackend(
  chatId: string,
  deps: ModelCommandDeps,
): Promise<CommandOutcome> {
  const { backend: previous, backendId: previousId } = resolveChatBackendPair(
    chatId,
    deps,
  );
  await releaseChat(chatId);
  setChatBackend(chatId, undefined);
  const { backendId } = resolveChatBackendPair(chatId, deps);
  handOffChatSession(chatId, previous, deps, {
    from: previousId,
    to: backendId,
  });
  return {
    ok: true,
    text: `Backend reset to default (${backendId}; ${await describeModelAfterSwitch(chatId, backendId, deps)}).`,
  };
}

export type EffortOverview = {
  current: string;
  levels: ReasoningEffortLevel[];
  activeModel: string | null;
  backendId: string;
};

/** Current effort and the levels the active model accepts. */
export async function describeChatEffort(
  chatId: string,
  deps: ModelCommandDeps,
): Promise<EffortOverview> {
  const { backend, backendId } = resolveChatBackendPair(chatId, deps);
  const reasoning = await getActiveReasoningLevels({
    chatId,
    backend,
    backendId,
    config: deps.config,
  });
  return {
    current: displayReasoningEffort(
      getChatSettings(chatId).effort,
      reasoning.levels,
    ),
    levels: reasoning.levels,
    activeModel: reasoning.activeModel,
    backendId,
  };
}

/** `/effort <level>` — validated against the active model's levels. */
export async function setChatEffortLevel(
  chatId: string,
  arg: string,
  deps: ModelCommandDeps,
): Promise<CommandOutcome> {
  const level = arg.trim().toLowerCase();
  if (level === "reset" || level === "default" || level === "adaptive") {
    setChatEffort(chatId, undefined);
    return {
      ok: true,
      text: "Effort reset to adaptive (model decides when to think).",
    };
  }
  const { levels, activeModel, backendId } = await describeChatEffort(
    chatId,
    deps,
  );
  if (levels.length === 0) {
    return {
      ok: false,
      text: `No reasoning levels available for ${activeModel ?? "the active model"} on backend ${backendId}.`,
    };
  }
  if (!supportsReasoningLevel(level, levels)) {
    return {
      ok: false,
      text: `Unknown level for this model. Valid: ${levels.join(", ")}, or adaptive.`,
    };
  }
  setChatEffort(chatId, level as EffortLevel);
  return { ok: true, text: `Effort set to ${level}.` };
}
