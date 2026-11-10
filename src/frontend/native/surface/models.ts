/**
 * Per-chat model, backend and effort selection — the pickers behind the
 * companion app's model sheet. The persisted per-chat setting is always
 * consulted before the live pool binding (see `toClientChat` for why).
 */

import {
  getChatSettings,
  setChatEffort,
  setChatModelForBackend,
  getChatModelForBackend,
  setChatBackend,
  EFFORT_LEVELS,
  type EffortLevel,
} from "../../../storage/chat-settings.js";
import {
  getBackendForChat,
  getBackendIdForChat,
  getPooledBackend,
  acquireBackendInstance,
  listAvailableBackends,
  rebindChat,
} from "../../../core/engine/backend-controller/index.js";
import { getActiveReasoningLevels } from "../../presentation/reasoning-levels.js";
import { broadcastChatUpdated } from "../chats/chat-wire.js";
import { emitSystem } from "../turn/emit.js";
import type { BackendOption, ModelOption } from "../protocol.js";
import { handOffChatBackend } from "../chats/reset.js";
import type { NativeRuntime } from "../runtime.js";
import { broadcastStatus } from "./status.js";

export async function listModels(
  runtime: NativeRuntime,
  chatId?: string,
): Promise<{ active: string; models: ModelOption[] }> {
  const { config } = runtime;
  // Resolve the chat's *own* backend so the model list tracks whatever
  // backend the chat is currently bound to, not the one before a switch.
  // Fall back to the global default backend when there's no chat / the
  // pool isn't ready yet.
  let backendId: string = config.backend;
  let active = config.model;
  if (chatId) {
    try {
      // Persisted setting first — see toClientChat.
      backendId =
        getChatSettings(chatId).backend ?? getBackendIdForChat(chatId);
      active = getChatModelForBackend(chatId, backendId) ?? config.model;
    } catch {
      /* pool not ready — keep global defaults */
    }
  }

  // Pull the models dynamically from the gateway for that backend. Prefer
  // an already-pooled instance of the *resolved* backend (the persisted
  // choice — the chat's live binding can lag it after a failed boot-time
  // rebind, and listing the live binding's catalog here showed the wrong
  // backend's models); otherwise boot the backend transiently to read its
  // catalog, then release it so we never leak an instance — mirroring the
  // shared `list_models` action.
  let instance:
    | Awaited<ReturnType<typeof acquireBackendInstance>>["backend"]
    | null
    | undefined = getPooledBackend(backendId);
  let release: (() => Promise<void>) | null = null;
  if (!instance) {
    try {
      const acquired = await acquireBackendInstance(backendId);
      instance = acquired.backend;
      release = acquired.release;
    } catch {
      return { active, models: [] };
    }
  }

  try {
    const catalog = instance.models;
    if (!catalog?.listModels) return { active, models: [] };
    const { models } = await catalog.listModels("all");
    const options: ModelOption[] = models
      .filter((m) => m.selectable)
      .map((m) => ({
        id: m.id,
        displayName: m.displayName,
        provider: m.provider,
        reasoning:
          Boolean(m.supportedReasoningLevels?.length) || Boolean(m.reasoning),
      }));
    return { active, models: options };
  } catch {
    return { active, models: [] };
  } finally {
    if (release) await release();
  }
}

export function setModel(
  runtime: NativeRuntime,
  chatId: string,
  model: string,
): void {
  const entry = runtime.chats.get(chatId);
  if (!entry) return;
  // Persisted setting first — see toClientChat. Writing the pick under the
  // live binding's key would attach it to the wrong backend whenever the
  // boot-time rebind to the persisted backend is still pending.
  let backendId: string;
  try {
    backendId = getChatSettings(chatId).backend ?? getBackendIdForChat(chatId);
  } catch {
    // Pool not ready — the same fallback listModels uses in this state, so
    // the pick lands under the backend whose catalog the client was shown.
    // Letting this throw would 400 the route and drop the pick entirely.
    backendId = runtime.config.backend;
  }
  setChatModelForBackend(chatId, backendId, model.trim() || undefined);
  broadcastChatUpdated(runtime, entry);
}

export function listBackends(
  runtime: NativeRuntime,
  chatId: string,
): { active: string; backends: BackendOption[] } {
  const { config } = runtime;
  const backends = listAvailableBackends(config);
  let active: string = config.backend;
  try {
    if (chatId) {
      // Persisted setting first — see toClientChat.
      active = getChatSettings(chatId).backend ?? getBackendIdForChat(chatId);
    }
  } catch {
    /* pool not ready — report the global default backend */
  }
  return { active, backends };
}

/**
 * Switch a chat to another backend. Mirrors the Telegram `/model` backend
 * submenu: verify the target is enabled, rebind the chat's pool holder, pin
 * the override, and drop the previous backend's per-chat session state
 * (sessions aren't portable across backends). Per-backend model picks are
 * kept, so switching back restores the prior model automatically.
 */
export async function setBackend(
  runtime: NativeRuntime,
  chatId: string,
  backend: string,
): Promise<{ ok: boolean; error?: string }> {
  const { config } = runtime;
  const entry = runtime.chats.get(chatId);
  if (!entry) return { ok: false, error: "No such chat" };
  const target = backend.trim();
  const available = listAvailableBackends(config);
  if (!available.some((b) => b.id === target)) {
    return { ok: false, error: "Backend not available" };
  }
  const persisted = getChatSettings(chatId).backend;
  const previousId = getBackendIdForChat(chatId);
  if (previousId === target) {
    // Already live on the target — just make sure the choice is persisted.
    if (persisted !== target && target !== config.backend) {
      setChatBackend(chatId, target);
      broadcastChatUpdated(runtime, entry);
    }
    return { ok: true };
  }

  const result = await rebindChat(chatId, target, config);
  if (!result.ok) {
    return { ok: false, error: result.error ?? "Rebind failed" };
  }

  // Re-selecting the backend this chat is already persisted to is a
  // RE-ATTACH (e.g. the boot-time rebind failed transiently and the user —
  // or a client retry — picks it again). The conversation belongs to that
  // backend; resetting the session and wiping history here destroyed real
  // conversations and surfaced as a phantom "backend reset" in clients.
  if (persisted === target) {
    broadcastChatUpdated(runtime, entry);
    broadcastStatus(runtime);
    return { ok: true };
  }

  setChatBackend(chatId, target);
  const kept = handOffChatBackend(runtime, chatId, {
    from: previousId,
    to: target,
  });
  emitSystem(
    runtime,
    entry,
    kept
      ? `Switched to ${target} — session and chat history kept.`
      : `Switched to ${target} — new session, chat history kept.`,
  );
  broadcastChatUpdated(runtime, entry);
  broadcastStatus(runtime);
  return { ok: true };
}

export function setEffort(
  runtime: NativeRuntime,
  chatId: string,
  effort: string,
): void {
  const entry = runtime.chats.get(chatId);
  if (!entry) return;
  const level = EFFORT_LEVELS.includes(effort as EffortLevel)
    ? (effort as EffortLevel)
    : undefined;
  setChatEffort(chatId, level);
  broadcastChatUpdated(runtime, entry);
}

export async function effortLevels(
  runtime: NativeRuntime,
  chatId: string,
): Promise<{ active: string; levels: string[] }> {
  try {
    const backend = getBackendForChat(chatId);
    const backendId = getBackendIdForChat(chatId);
    const { levels } = await getActiveReasoningLevels({
      chatId,
      backend,
      backendId,
      config: runtime.config,
    });
    const active = getChatSettings(chatId).effort ?? "adaptive";
    return { active, levels };
  } catch {
    return { active: "adaptive", levels: [] };
  }
}
