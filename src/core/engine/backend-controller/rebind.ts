/**
 * Rebind / release holders, plus the per-chat accessors that resolve a chat
 * to its override (or the chat-role default).
 */

import type { Backend } from "../../agent-runtime/capabilities.js";
import type { TalonConfig } from "../../config/index.js";
import {
  getBackend,
  listBackends,
} from "../../agent-runtime/backend-registry.js";
import { log, logWarn } from "../../../util/log.js";
import { chatHolder, roleHolder } from "./holders.js";
import {
  pool,
  bindings,
  ctx,
  ensurePoolEntry,
  releaseHolderFromEntry,
  notifyListeners,
  hasBackendPool,
  type PoolEntry,
} from "./state.js";
import { getBackendForRole, getBackendIdForRole } from "./pool.js";
import type { BackendHolder, BackendRole, RebindResult } from "./types.js";

/**
 * Rebind any holder to a different backend id.
 *
 * Pool semantics:
 *   - If the target id is already pooled (another holder uses it),
 *     the existing instance is reused — no double init.
 *   - The previous binding's instance loses a refcount; cleanup fires
 *     only if no other holder still references it.
 *   - Failed init leaves the previous binding in place.
 *
 * Use `rebindRole` / `rebindChat` for typed wrappers.
 */
async function rebindHolder(
  holder: BackendHolder,
  newId: string,
  config: TalonConfig,
): Promise<RebindResult> {
  if (!ctx.initCtx) {
    return { ok: false, error: "Backend pool not initialised" };
  }
  const currentId = bindings.get(holder);
  if (currentId === newId) {
    return {
      ok: false,
      error: `Holder "${holder}" already bound to "${newId}"`,
    };
  }

  const factory = getBackend(newId);
  if (!factory) {
    const known = listBackends()
      .map((b) => `"${b.id}"`)
      .join(", ");
    return {
      ok: false,
      error: `Unknown backend "${newId}" — known: ${known}`,
    };
  }

  const newReused = pool.has(newId);
  let newEntry: PoolEntry;
  try {
    newEntry = await ensurePoolEntry(newId, config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      "backend-controller",
      `rebindHolder(${holder}, ${newId}) init failed: ${msg} — binding unchanged`,
    );
    return { ok: false, error: `Failed to init ${factory.label}: ${msg}` };
  }
  newEntry.holders.add(holder);
  bindings.set(holder, newId);

  let previousReused = false;
  if (currentId) {
    const oldEntry = pool.get(currentId);
    if (oldEntry) {
      previousReused = oldEntry.holders.size > 1;
      await releaseHolderFromEntry(oldEntry, holder);
    }
  }

  log(
    "backend-controller",
    `Rebound ${holder}: ${currentId ?? "(unbound)"} → ${newId}` +
      (newReused ? " (reused pool instance)" : ""),
  );
  notifyListeners(holder, newEntry.backend, {
    id: newId,
    label: newEntry.label,
  });

  return {
    ok: true,
    from: currentId,
    to: newId,
    previousReused,
    newReused,
  };
}

/**
 * Release a holder. If the entry it was holding has no other holders,
 * the entry is cleaned up.
 *
 * No-op when the holder isn't bound — useful for "clear my override"
 * flows that don't want to care whether the override was ever set.
 */
async function releaseHolder(holder: BackendHolder): Promise<void> {
  const id = bindings.get(holder);
  if (!id) return;
  bindings.delete(holder);
  const entry = pool.get(id);
  if (entry) await releaseHolderFromEntry(entry, holder);
}

/** Rebind a role. Convenience wrapper over `rebindHolder`. */
export function rebindRole(
  role: BackendRole,
  newId: string,
  config: TalonConfig,
): Promise<RebindResult> {
  return rebindHolder(roleHolder(role), newId, config);
}

/**
 * Rebind a per-chat override.
 *
 * Pool refcounts the new backend in addition to whatever the role
 * holders already pin. Releasing the chat (`releaseChat`) reverts the
 * chat to whichever backend the chat-role is bound to.
 */
export function rebindChat(
  chatId: string,
  newId: string,
  config: TalonConfig,
): Promise<RebindResult> {
  return rebindHolder(chatHolder(chatId), newId, config);
}

/** Release a per-chat override — the chat reverts to the global default. */
export function releaseChat(chatId: string): Promise<void> {
  return releaseHolder(chatHolder(chatId));
}

/**
 * Resolve the backend a chat should use right now.
 *
 * If the chat has an override pooled, return that backend; otherwise
 * fall back to the global chat-role backend.
 */
export function getBackendForChat(chatId: string): Backend {
  const overrideId = bindings.get(chatHolder(chatId));
  if (overrideId) {
    const entry = pool.get(overrideId);
    if (entry) return entry.backend;
  }
  return getBackendForRole("chat");
}

/** Backend id the chat would resolve to (override → role default). */
export function getBackendIdForChat(chatId: string): string {
  return bindings.get(chatHolder(chatId)) ?? getBackendIdForRole("chat");
}

/** Chats whose per-chat override is bound to backend `id` right now. */
export function chatsBoundTo(id: string): string[] {
  const prefix = chatHolder("");
  const chats: string[] = [];
  for (const [holder, bound] of bindings) {
    if (bound === id && holder.startsWith(prefix))
      chats.push(holder.slice(prefix.length));
  }
  return chats;
}

/** Whether this chat has an override pinning a non-default backend. */
export function hasChatBackendOverride(chatId: string): boolean {
  return bindings.has(chatHolder(chatId));
}

/**
 * Safe variant of `getBackendForChat` that never throws — returns
 * the per-chat / role:chat backend when the pool is initialised, or
 * `fallback` (typically `gateway?.backend`) when it isn't.
 *
 * The pool is always initialised in production at bootstrap; this
 * helper exists so unit tests and legacy code paths that wire the
 * frontend before the pool can degrade gracefully instead of
 * throwing on every `/model` command. Frontends should call this
 * everywhere they previously read `gateway?.backend` for /model,
 * /status, and warmSession — otherwise per-chat backend overrides
 * silently lose effect.
 */
export function resolveChatBackend(
  chatId: string,
  fallback?: Backend | null,
): Backend | null {
  if (hasBackendPool()) {
    try {
      return getBackendForChat(chatId);
    } catch {
      // Pool initialised but the chat-role binding is somehow missing —
      // shouldn't happen in practice, but degrade to fallback rather
      // than crash a /model render.
    }
  }
  return fallback ?? null;
}
