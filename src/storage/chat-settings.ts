/**
 * Per-chat runtime settings. Overrides global config on a per-chat basis.
 *
 * Backed by SQLite as one JSON document per chat (see
 * repositories/chat-settings-repo.ts for the statements; this module
 * holds the domain API — no SQL here) with an in-memory write-through
 * cache: reads serve the cached objects, every setter commits the
 * chat's row immediately. Compared to the JsonStore this replaces,
 * there is no dirty flag and no 10s autosave timer — SQLite commits
 * per write.
 *
 * The legacy ~/.talon/data/chat-settings.json (JsonStore envelope or
 * bare pre-envelope shape) is imported once on first load, then
 * renamed to chat-settings.json.imported. The two intra-data
 * migrations — legacy `maxThinkingTokens` → `effort` and single-slot
 * `model` → `modelByBackend` — still run in `loadChatSettings` /
 * `migrateLegacyModelField` and remain idempotent.
 */

import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { files } from "../util/paths.js";
import { importLegacyJson } from "./legacy-import.js";
import { dbErrorFields } from "./db.js";
import * as repo from "./repositories/chat-settings-repo.js";
import type { ReasoningEffortLevel } from "../types/effort.js";

export type EffortLevel = ReasoningEffortLevel;

export type { ChatSettings } from "./repositories/chat-settings-repo.js";
import type { ChatSettings } from "./repositories/chat-settings-repo.js";

// In-memory cache over the chat_settings table. Reads serve live
// references from here; writes go through persist() so each mutation
// commits its chat's row.
const cache = new Map<string, ChatSettings>();

// ── Persistence lifecycle ───────────────────────────────────────────────────

/**
 * Run the one-time import of the legacy JSON store, prime the cache
 * from SQLite, then apply the idempotent `maxThinkingTokens` → `effort`
 * migration. Called once at boot.
 */
export function loadChatSettings(): void {
  cache.clear();
  try {
    importLegacyChatSettings();
    for (const { chatId, settings } of repo.all()) {
      cache.set(chatId, settings);
    }
  } catch (err) {
    logError("settings", "Failed to load chat settings", err);
  }

  // Migrate legacy maxThinkingTokens → effort.
  let migrated = 0;
  for (const [chatId, settings] of cache) {
    const raw = settings as Record<string, unknown>;
    if ("maxThinkingTokens" in raw && !settings.effort) {
      const tokens = Number(raw.maxThinkingTokens);
      let effort: EffortLevel;
      if (tokens === 0) effort = "off";
      else if (tokens <= 2000) effort = "low";
      else if (tokens <= 8000) effort = "medium";
      else if (tokens <= 16000) effort = "high";
      else effort = "max";
      settings.effort = effort;
      delete raw.maxThinkingTokens;
      migrated++;
      persist(chatId);
      log(
        "settings",
        `Migrated chat ${chatId}: maxThinkingTokens=${tokens} to effort=${effort}`,
      );
    } else if ("maxThinkingTokens" in raw) {
      // Has effort already, just clean up the old field
      delete raw.maxThinkingTokens;
      migrated++;
      persist(chatId);
    }
  }
  if (migrated > 0) {
    log(
      "settings",
      `Migrated ${migrated} chat(s) from maxThinkingTokens to effort`,
    );
  }
  // The legacy `model` field is not destructively migrated here — that
  // requires knowing the chat's effective backend, which isn't available
  // at load time (backend pool initialises later). Instead `setChatModel`
  // mirrors writes into `modelByBackend` and the active-model resolver
  // reads both, preferring the per-backend slot.
}

/**
 * Legacy shape: Record<chatId, ChatSettings>. Settings objects are
 * imported verbatim — the intra-data migrations above run against the
 * cache afterwards.
 */
function importLegacyChatSettings(): void {
  importLegacyJson({
    path: files.chatSettings,
    category: "settings",
    what: "chat setting(s)",
    ingest: (data) => {
      const entries: Array<{ chatId: string; settings: ChatSettings }> = [];
      for (const [chatId, settings] of Object.entries(
        (data ?? {}) as Record<string, ChatSettings>,
      )) {
        if (
          !settings ||
          typeof settings !== "object" ||
          Array.isArray(settings)
        )
          continue;
        entries.push({ chatId, settings });
      }
      return repo.upsertMany(entries);
    },
  });
}

/**
 * Migrate the legacy single-slot `model` field into the per-backend
 * map. Idempotent. Call this once the global backend id is known
 * (typically right after config + backend pool initialise) so the
 * legacy value lands in the right per-backend slot.
 *
 * For each chat with a legacy `model` set: copy it into
 * `modelByBackend[chat's effective backend]` if no entry exists there
 * yet, then delete the legacy field. Chats whose effective backend
 * isn't in the runtime registry (e.g. user removed it from
 * `enabledBackends`) keep the legacy field — the resolver still uses
 * it as the lowest-precedence fallback so behaviour doesn't regress.
 */
export function migrateLegacyModelField(
  fallbackBackendId: string,
  isRecognisedBackend: (id: string) => boolean,
): void {
  let migrated = 0;
  for (const [chatId, settings] of cache) {
    if (typeof settings.model !== "string" || !settings.model) continue;
    const effectiveBackend =
      settings.backend && isRecognisedBackend(settings.backend)
        ? settings.backend
        : isRecognisedBackend(fallbackBackendId)
          ? fallbackBackendId
          : null;
    if (!effectiveBackend) continue;
    if (!settings.modelByBackend) settings.modelByBackend = {};
    if (settings.modelByBackend[effectiveBackend] === undefined) {
      settings.modelByBackend[effectiveBackend] = settings.model;
    }
    delete settings.model;
    migrated++;
    persist(chatId);
    log(
      "settings",
      `Migrated chat ${chatId}: legacy model → modelByBackend[${effectiveBackend}]`,
    );
  }
  if (migrated > 0) {
    log(
      "settings",
      `Migrated ${migrated} chat(s) from legacy model → modelByBackend`,
    );
  }
}

/** Commit one chat's row (or its deletion, after cleanupEmpty). */
function persist(chatId: string): void {
  try {
    const entry = cache.get(chatId);
    if (entry) repo.upsert(chatId, entry);
    else repo.remove(chatId);
  } catch (err) {
    logError(
      "settings",
      `Failed to persist chat settings chat=${chatId}${dbErrorFields(err)}`,
      err,
    );
    recordError(
      `Settings save failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Snapshot of every persisted chat's settings, keyed by chat id.
 * Returns a shallow copy of the in-memory store — callers should
 * NOT mutate the returned object or its values (use the typed
 * setters instead).
 */
export function getAllChatSettings(): Record<string, ChatSettings> {
  return Object.fromEntries(cache);
}

export function getChatSettings(chatId: string): ChatSettings {
  return cache.get(chatId) ?? {};
}

// ── Setters ─────────────────────────────────────────────────────────────────

function cleanupEmpty(chatId: string): void {
  const s = cache.get(chatId);
  if (!s) return;
  const modelByBackendEmpty =
    !s.modelByBackend || Object.keys(s.modelByBackend).length === 0;
  if (
    !s.model &&
    modelByBackendEmpty &&
    !s.backend &&
    !s.effort &&
    s.pulse === undefined &&
    s.pulseIntervalMs === undefined &&
    s.pulseLastCheckMsgId === undefined &&
    s.freeOnly === undefined
  ) {
    cache.delete(chatId);
  }
}

/** Get-or-create a settings entry in the cache. */
function ensureEntry(chatId: string): ChatSettings {
  let entry = cache.get(chatId);
  if (!entry) {
    entry = {};
    cache.set(chatId, entry);
  }
  return entry;
}

export function setPulseLastCheckMsgId(
  chatId: string,
  msgId: number | undefined,
): void {
  const entry = ensureEntry(chatId);
  if (msgId !== undefined) {
    entry.pulseLastCheckMsgId = msgId;
  } else {
    delete entry.pulseLastCheckMsgId;
    cleanupEmpty(chatId);
  }
  // Per-pulse-check row commit — the JSON-era "defer to the autosave
  // timer" dance is gone; a single-row SQLite write is cheap.
  persist(chatId);
}

/**
 * Set the per-chat model override for a specific backend. Pass
 * `undefined` to clear that backend's slot only. Other backends'
 * persisted picks are left intact — switching backends and back
 * restores each side's prior choice.
 */
export function setChatModelForBackend(
  chatId: string,
  backendId: string,
  model: string | undefined,
): void {
  const entry = ensureEntry(chatId);
  if (model) {
    if (!entry.modelByBackend) entry.modelByBackend = {};
    entry.modelByBackend[backendId] = model;
  } else if (entry.modelByBackend) {
    delete entry.modelByBackend[backendId];
    if (Object.keys(entry.modelByBackend).length === 0) {
      delete entry.modelByBackend;
    }
  }
  cleanupEmpty(chatId);
  persist(chatId);
}

/**
 * Get the per-chat model override for a specific backend. Returns
 * `undefined` when no per-chat pick exists for that backend; callers
 * (typically the active-model resolver) fall through to the backend's
 * own default + config in that case.
 */
export function getChatModelForBackend(
  chatId: string,
  backendId: string,
): string | undefined {
  const settings = cache.get(chatId);
  if (!settings) return undefined;
  const fromMap = settings.modelByBackend?.[backendId];
  if (fromMap) return fromMap;
  // Legacy fallback: pre-migration stores hold a single `model` field
  // with no backend tag. Treat it as the value for the chat's current
  // backend (or the global default backend if no per-chat binding).
  // Once `migrateLegacyModelField` runs this branch becomes dead.
  if (typeof settings.model === "string" && settings.model) {
    if (settings.backend ? settings.backend === backendId : true) {
      return settings.model;
    }
  }
  return undefined;
}

/**
 * Clear every per-backend model override on a chat. Used by `/reset`
 * and admin tooling. Equivalent to deleting `modelByBackend` whole.
 */
export function clearAllChatModels(chatId: string): void {
  const entry = cache.get(chatId);
  if (!entry) return;
  delete entry.modelByBackend;
  delete entry.model;
  cleanupEmpty(chatId);
  persist(chatId);
}

/**
 * Drop only the legacy single-slot `model` field, keeping every
 * per-backend pick. The boot reconcile uses it: a stale legacy value must
 * go, but the picks the chat made on other backends are still good.
 */
export function clearLegacyChatModel(chatId: string): void {
  const entry = cache.get(chatId);
  if (!entry || entry.model === undefined) return;
  delete entry.model;
  cleanupEmpty(chatId);
  persist(chatId);
}

/**
 * @deprecated Prefer `setChatModelForBackend(chatId, backendId, model)`
 * which is explicit about which backend's slot is being mutated.
 *
 * Legacy single-slot setter. Writes to the chat's currently bound
 * backend's slot when a binding exists, otherwise to the legacy
 * `model` field (typical only on fresh / pre-migration chats).
 *
 * Pass `undefined` to clear the model state. The clear semantic
 * matches legacy expectations: removes EVERY per-backend slot AND
 * the legacy field — equivalent to "user hit reset on this chat".
 * For per-backend granularity use `setChatModelForBackend` with
 * `undefined` instead.
 */
export function setChatModel(chatId: string, model: string | undefined): void {
  if (model === undefined) {
    // Legacy "reset everything" semantic. Matches what existing
    // callers / tests expect when they call setChatModel(cid, undefined).
    const entry = ensureEntry(chatId);
    delete entry.modelByBackend;
    delete entry.model;
    cleanupEmpty(chatId);
    persist(chatId);
    return;
  }

  const existing = cache.get(chatId);
  const targetBackend = existing?.backend;
  if (targetBackend) {
    setChatModelForBackend(chatId, targetBackend, model);
    return;
  }
  // No backend binding — write to the legacy slot. The next backend
  // switch / migration will pick it up into modelByBackend.
  const entry = ensureEntry(chatId);
  entry.model = model;
  persist(chatId);
}

/**
 * Per-chat backend override. Pass `undefined` to clear the override
 * (chat reverts to `config.backend`). The backend pool's per-chat
 * acquire/release happens separately via `rebindChat` / `releaseChat`
 * — this setter only persists the choice.
 */
export function setChatBackend(
  chatId: string,
  backend: string | undefined,
): void {
  const entry = ensureEntry(chatId);
  if (backend) {
    entry.backend = backend;
  } else {
    delete entry.backend;
    cleanupEmpty(chatId);
  }
  persist(chatId);
}

export function setChatEffort(
  chatId: string,
  effort: EffortLevel | undefined,
): void {
  const entry = ensureEntry(chatId);
  if (effort) {
    entry.effort = effort;
  } else {
    delete entry.effort;
    cleanupEmpty(chatId);
  }
  persist(chatId);
}

export function setChatFreeOnly(chatId: string, on: boolean | undefined): void {
  const entry = ensureEntry(chatId);
  if (on) {
    entry.freeOnly = true;
  } else {
    delete entry.freeOnly;
    cleanupEmpty(chatId);
  }
  persist(chatId);
}

export function setChatPulse(
  chatId: string,
  enabled: boolean | undefined,
): void {
  const entry = ensureEntry(chatId);
  if (enabled !== undefined) {
    entry.pulse = enabled;
  } else {
    delete entry.pulse;
    cleanupEmpty(chatId);
  }
  persist(chatId);
}

export function setChatPulseInterval(
  chatId: string,
  intervalMs: number | undefined,
): void {
  const entry = ensureEntry(chatId);
  if (intervalMs !== undefined) {
    entry.pulseIntervalMs = intervalMs;
  } else {
    delete entry.pulseIntervalMs;
    cleanupEmpty(chatId);
  }
  persist(chatId);
}

/** Get all chat IDs that have pulse enabled in settings. */
export function getRegisteredPulseChats(): string[] {
  return [...cache.entries()]
    .filter(([, s]) => s.pulse === true)
    .map(([id]) => id);
}

/** Valid effort levels. */
export const EFFORT_LEVELS: EffortLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
];
