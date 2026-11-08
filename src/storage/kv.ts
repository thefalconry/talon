/**
 * Namespaced key → JSON singleton store, backed by the `kv` table.
 *
 * For the small state blobs that used to live as hand-rolled JSON
 * files (heartbeat/dream run state, learned Codex OAuth
 * incompatibilities): shapes too small and too private to justify a
 * table each, but that still deserve transactional writes and test
 * isolation via TALON_DB_PATH. Keys are dot-namespaced by owner
 * ("heartbeat.state", "dream.state", "codex.oauth-incompat").
 *
 * Reads validate nothing beyond JSON-parsability — the owning module
 * keeps the schema, exactly as with the files this replaces. A corrupt
 * value reads as undefined rather than throwing into the caller.
 */

import * as repo from "./repositories/kv-repo.js";
import { dbErrorFields } from "./db.js";
import { logError } from "../util/log.js";

export function kvGet<T>(key: string): T | undefined {
  let raw: string | undefined;
  try {
    raw = repo.get(key);
  } catch (err) {
    logError("kv", `Failed to read ${key}${dbErrorFields(err)}`, err);
    return undefined;
  }
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logError("kv", `Corrupt JSON at ${key} — treating as unset`, err);
    return undefined;
  }
}

/**
 * Persist a JSON-serialisable value. Storage failure logs (with the
 * SQLite result code, so a full disk reads as errcode=13) and never
 * throws; the return says whether the write landed.
 */
export function kvSet(key: string, value: unknown): boolean {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
    repo.set(key, json, Date.now());
    return true;
  } catch (err) {
    logError(
      "kv",
      `Failed to write ${key} bytes=${json?.length ?? "?"}${dbErrorFields(err)}`,
      err,
    );
    return false;
  }
}

export function kvDelete(key: string): boolean {
  try {
    return repo.remove(key);
  } catch (err) {
    logError("kv", `Failed to delete ${key}${dbErrorFields(err)}`, err);
    return false;
  }
}
