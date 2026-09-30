/**
 * Turn-meta store — persists what each assistant turn *did* (tool
 * calls, duration, token usage) keyed by chat + message id, so a
 * frontend's tool timeline and stats footer survive a history reload
 * or daemon restart.
 *
 * Storage is domain-agnostic: the meta shape belongs to the frontend
 * that writes it, so this layer only ever sees an opaque JSON object.
 * SQLite-backed (see repositories/turn-meta-repo.ts for the
 * statements; no SQL here). Every write commits — there is no dirty
 * buffer to flush — so a crash can lose at most the in-flight turn.
 * Each chat keeps a bounded window of the newest turns, matching the
 * /history page ceiling so hydration covers everything a client can
 * actually fetch.
 */

import { dbErrorFields, inTransaction } from "./db.js";
import * as repo from "./repositories/turn-meta-repo.js";
import { importLegacyJson } from "./legacy-import.js";
import { files } from "../util/paths.js";
import { logError, logWarn } from "../util/log.js";

/** Per-chat cap — matches the /history page ceiling. */
const MAX_PER_CHAT = 500;

let imported = false;

/**
 * One-shot import of the legacy native-turn-meta.json sidecar on first
 * use. The legacy file is the un-enveloped nested shape
 * Record<chatId, Record<msgId, meta>>; flatten it into rows and apply
 * the per-chat cap that used to be enforced in memory.
 */
function ensureLoaded(): void {
  if (imported) return;
  imported = true; // set first: a failed import must not retry every call
  importLegacyJson({
    path: files.nativeTurnMeta,
    category: "db",
    what: "turn meta row(s)",
    ingest: (data) => {
      if (!data || typeof data !== "object" || Array.isArray(data)) return 0;
      let rows = 0;
      for (const [chatId, turns] of Object.entries(
        data as Record<string, unknown>,
      )) {
        if (!turns || typeof turns !== "object" || Array.isArray(turns)) {
          continue;
        }
        for (const [msgId, meta] of Object.entries(
          turns as Record<string, unknown>,
        )) {
          repo.upsert(chatId, msgId, JSON.stringify(meta));
          rows++;
        }
        repo.prune(chatId, MAX_PER_CHAT);
      }
      return rows;
    },
  });
}

/**
 * Record (or extend) the meta for one assistant message: read the
 * existing row, shallow-merge the patch over it, write it back, then
 * trim the chat to its window — all in one transaction. A storage
 * failure must never break a turn, so it is logged and swallowed
 * (matching sessions.persist).
 */
export function recordTurnMeta(
  chatId: string,
  msgId: string,
  patch: object,
): void {
  ensureLoaded();
  try {
    inTransaction(() => {
      const existing = repo.get(chatId, msgId);
      const merged = existing
        ? { ...(JSON.parse(existing) as object), ...patch }
        : patch;
      repo.upsert(chatId, msgId, JSON.stringify(merged));
      repo.prune(chatId, MAX_PER_CHAT);
    });
  } catch (err) {
    logError(
      "db",
      `Failed to persist turn meta chat=${chatId} msg=${msgId}${dbErrorFields(err)}`,
      err,
    );
  }
}

/** Look up the meta for one message, typed by the caller, or null. */
export function getTurnMeta<T>(chatId: string, msgId: string): T | null {
  ensureLoaded();
  let raw: string | undefined;
  try {
    raw = repo.get(chatId, msgId);
  } catch (err) {
    // Reads are hydration-only — a storage fault must degrade to
    // "no meta", not break the caller (matching recordTurnMeta).
    logError(
      "db",
      `Failed to read turn meta chat=${chatId} msg=${msgId}${dbErrorFields(err)}`,
      err,
    );
    return null;
  }
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // Corrupt row — treat as absent rather than throw, but say so: the
    // caller sees "no meta" and can't tell it from a message never tagged.
    logWarn(
      "db",
      `Corrupt turn meta chat=${chatId} msg=${msgId} bytes=${raw.length}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Forget a chat's turn meta — only the operator's history purge does. */
export function clearTurnMeta(chatId: string): void {
  ensureLoaded();
  try {
    repo.removeChat(chatId);
  } catch (err) {
    logError(
      "db",
      `Failed to clear turn meta chat=${chatId}${dbErrorFields(err)}`,
      err,
    );
  }
}
