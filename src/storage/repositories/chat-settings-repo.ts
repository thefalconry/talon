/**
 * Chat-settings repository — executes the statements in
 * sql/chat-settings.sql against the `chat_settings` table; no SQL text
 * lives here. The public store (storage/chat-settings.ts) holds the
 * domain API and the in-memory write-through cache; this module owns
 * statement execution.
 *
 * One JSON document per chat (see sql/schema.sql): the
 * access pattern is whole-record get/set, so a keyed JSON value column
 * is the right shape — settings evolve frequently and no field is
 * queried independently in SQL.
 */

import { logWarn } from "../../util/log.js";
import { getDatabase, inTransaction } from "../db.js";
import { chatSettingsSql } from "../sql/statements.generated.js";
import type { ReasoningEffortLevel } from "../../types/effort.js";

export type ChatSettings = {
  /**
   * Per-backend model overrides for this chat. Keyed by backend id
   * (`"claude"`, `"codex"`, `"openai-agents"`, etc). Each entry is the
   * model id the user picked on that backend.
   *
   * Switching backends preserves each side's last pick — your Codex
   * chat remembers `gpt-5.5`, your OpenRouter chat remembers
   * `meta-llama/...`. Replaces the single legacy `model` field which
   * couldn't differentiate per-backend choices and produced the
   * orphan-bug class (model from backend X persisting when switching
   * to backend Y).
   *
   * Resolution order (see `core/models/active-model.ts`):
   *   1. `modelByBackend[activeBackend]` if it validates on the catalog
   *   2. `backend.getDefaultModel()` (canonical for backends that have one)
   *   3. `config.backendDefaults[activeBackend]` (operator override)
   *   4. `config.model` (only when activeBackend === config.backend)
   *   5. null → "No model selected" UI + send guard refuses.
   */
  modelByBackend?: Record<string, string>;
  /**
   * @deprecated Single-slot model field. Retained for back-compat with
   * old stores; migrated into `modelByBackend` on load. New writes go
   * through `setChatModelForBackend` instead.
   */
  model?: string;
  /**
   * Backend override for this chat. When set, queries from this chat
   * route to the override backend instead of the global `config.backend`.
   * The backend controller refcounts pool instances, so two chats on
   * two different backends keep both alive concurrently.
   *
   * Stored as the registry id (e.g. `"claude"`, `"openai-agents"`).
   * Cleared via `setChatBackend(cid, undefined)` — chat reverts to
   * the global default.
   */
  backend?: string;
  /** Effort level override (maps to SDK thinking + effort options). */
  effort?: ReasoningEffortLevel;
  /** Whether pulse is enabled for this chat. */
  pulse?: boolean;
  /** Per-chat pulse check interval in milliseconds. */
  pulseIntervalMs?: number;
  /** Last message ID checked by pulse (persisted to avoid reprocessing on restart). */
  pulseLastCheckMsgId?: number;
  /**
   * When true, the model picker filters to free-tier models by default.
   * Only meaningful for backends that report free-tier metadata (currently
   * `openai-agents` against OpenRouter); other backends ignore the flag.
   */
  freeOnly?: boolean;
};

export function upsert(chatId: string, settings: ChatSettings): void {
  getDatabase()
    .prepare(chatSettingsSql.upsert)
    .run(chatId, JSON.stringify(settings));
}

/** Bulk-upsert inside one transaction (legacy JSON import). */
export function upsertMany(
  entries: Array<{ chatId: string; settings: ChatSettings }>,
): number {
  return inTransaction(() => {
    for (const { chatId, settings } of entries) upsert(chatId, settings);
    return entries.length;
  });
}

/**
 * Every persisted chat's settings — used to prime the in-memory cache.
 * Rows whose JSON fails to parse are skipped (defensive; nothing
 * should ever write malformed JSON through upsert()).
 */
export function all(): Array<{ chatId: string; settings: ChatSettings }> {
  const rows = getDatabase().prepare(chatSettingsSql.all).all() as Array<{
    chat_id: string;
    settings: string;
  }>;
  const result: Array<{ chatId: string; settings: ChatSettings }> = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.settings) as ChatSettings;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        result.push({ chatId: row.chat_id, settings: parsed });
      }
    } catch (err) {
      // Skip the unparseable row; the chat silently falls back to
      // defaults otherwise.
      logWarn(
        "settings",
        `Skipped corrupt chat settings chat=${row.chat_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

export function remove(chatId: string): void {
  getDatabase().prepare(chatSettingsSql.remove).run(chatId);
}
