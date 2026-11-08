/**
 * Media index — tracks downloaded media files with metadata and expiry.
 *
 * Provides fast lookup of recent photos/files by chat, sender, or type.
 * Auto-expires entries older than RETENTION_MS.
 *
 * Backed by SQLite (see repositories/media-index-repo.ts for the
 * statements; this module holds the domain API, formatting and the
 * expiry sweep's file deletion — no SQL here). Reads are indexed
 * queries instead of in-memory scans, writes are per-row commits
 * instead of a 30s autosave timer rewriting the whole file.
 *
 * The legacy ~/.talon/data/media-index.json (JsonStore envelope or
 * bare pre-envelope array) is imported once on first load, then
 * renamed to media-index.json.imported.
 */

import { existsSync, unlinkSync } from "node:fs";
import { blake3HexFile } from "../native/blake3.js";
import { log, logError, logWarn } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { files } from "../util/paths.js";
import { importLegacyJson } from "./legacy-import.js";
import { setMessageFilePath } from "./history.js";
import { dbErrorFields } from "./db.js";
import * as repo from "./repositories/media-index-repo.js";

export type { MediaEntry } from "./repositories/media-index-repo.js";
import type { MediaEntry } from "./repositories/media-index-repo.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isMediaEntry(value: unknown): value is MediaEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.chatId === "string" &&
    typeof e.msgId === "number" &&
    typeof e.senderName === "string" &&
    typeof e.type === "string" &&
    typeof e.filePath === "string" &&
    typeof e.timestamp === "number"
  );
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Run the one-time import of the legacy JSON store, then sweep
 * expired entries (unless `purgeExpired: false` — a boot with no safety
 * checkpoint deletes nothing). Idempotent; called once at boot.
 */
export function loadMediaIndex(options: { purgeExpired?: boolean } = {}): void {
  try {
    importLegacyMediaIndex();
  } catch (err) {
    logError("media", "Media index load failed", err);
  }
  if (options.purgeExpired !== false) purgeExpired();
}

/** Legacy shape: bare MediaEntry[]. */
function importLegacyMediaIndex(): void {
  importLegacyJson({
    path: files.mediaIndex,
    category: "media",
    what: "media entr(ies)",
    ingest: (data) =>
      repo.upsertMany(Array.isArray(data) ? data.filter(isMediaEntry) : []),
  });
}

// ── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Index a downloaded file and dedupe it against identical content.
 *
 * Resolves to the path the message's media now lives at — the
 * canonical copy when the download duplicated one already on disk
 * (the fresh file is then deleted), otherwise `entry.filePath`.
 * Callers MUST use the resolved path for anything they show the
 * model: the original path may no longer exist once this settles.
 *
 * The row is written synchronously, so it is queryable before the
 * hash finishes.
 */
export async function addMedia(entry: Omit<MediaEntry, "id">): Promise<string> {
  try {
    repo.upsert(entry);
  } catch (err) {
    logError(
      "media",
      `Media index save failed chat=${entry.chatId} msg=${entry.msgId} path=${entry.filePath}${dbErrorFields(err)}`,
      err,
    );
    recordError(
      `Media index write failed: ${err instanceof Error ? err.message : err}`,
    );
    return entry.filePath;
  }
  // Serialize dedupe: two identical files hashed concurrently (e.g. an
  // album) could otherwise each pick the other as canonical and both
  // get unlinked.
  const run = dedupeChain.then(() => hashAndDedupe(entry));
  dedupeChain = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await run;
  } catch (err) {
    logError("media", `Media content hash failed for ${entry.filePath}`, err);
    return entry.filePath;
  }
}

let dedupeChain: Promise<void> = Promise.resolve();

/** The indexed entry for a message, if any. */
export function getMediaForMessage(
  chatId: string,
  msgId: number,
): MediaEntry | undefined {
  return repo.byMessage(chatId, msgId);
}

/**
 * BLAKE3-hash a downloaded file (native/blake3-wasm) and record the
 * digest. If another entry already holds identical content, repoint
 * this entry — and the history row for the same message — at the
 * canonical copy and drop the duplicate file, so re-posted media costs
 * one copy on disk no matter how many messages carry it.
 */
async function hashAndDedupe(entry: Omit<MediaEntry, "id">): Promise<string> {
  if (!existsSync(entry.filePath)) return entry.filePath; // gone already (expiry, tests)
  const hash = await blake3HexFile(entry.filePath);
  repo.setContentHash(entry.chatId, entry.msgId, hash);

  const canonical = repo.firstByContentHash(hash, entry.chatId, entry.msgId);
  if (!canonical) return entry.filePath;
  if (canonical.filePath === entry.filePath) return entry.filePath; // re-download of the same path
  if (!existsSync(canonical.filePath)) return entry.filePath; // canonical copy lost — keep ours

  repo.setFilePath(entry.chatId, entry.msgId, canonical.filePath);
  setMessageFilePath(entry.chatId, entry.msgId, canonical.filePath);
  // The fresh download is unreferenced once repointed — but check, in
  // case earlier rows (pre-hash legacy imports) still claim the path.
  if (repo.countByFilePath(entry.filePath) === 0) {
    try {
      unlinkSync(entry.filePath);
      log(
        "media",
        `Deduped ${entry.filePath} -> ${canonical.filePath} (blake3 ${hash.slice(0, 12)}…)`,
      );
    } catch (err) {
      // Dedupe is best-effort — the entry already points at the canonical
      // copy — but the duplicate now sits on disk unreferenced.
      logWarn(
        "media",
        `Dedupe unlink failed path=${entry.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return canonical.filePath;
}

/** Get recent media for a chat, newest first. */
export function getRecentMedia(chatId: string, limit = 10): MediaEntry[] {
  return repo.recentByChat(chatId, limit);
}

/** Get all media matching a type in a chat. */
export function getMediaByType(
  chatId: string,
  type: MediaEntry["type"],
  limit = 10,
): MediaEntry[] {
  return repo.byType(chatId, type, limit);
}

/** Format media index as text for Claude. */
export function formatMediaIndex(chatId: string, limit = 10): string {
  const media = getRecentMedia(chatId, limit);
  if (media.length === 0) return "No recent media in this chat.";
  return media
    .map((m) => {
      const time = new Date(m.timestamp)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ");
      const cap = m.caption ? ` "${m.caption.slice(0, 50)}"` : "";
      return `[${m.type}] msg:${m.msgId} by ${m.senderName} at ${time}${cap}\n  file: ${m.filePath}`;
    })
    .join("\n");
}

// ── Expiry ──────────────────────────────────────────────────────────────────

function purgeExpired(): void {
  const cutoff = Date.now() - RETENTION_MS;
  try {
    const expired = repo.olderThan(cutoff);
    const removed = repo.deleteOlderThan(cutoff);
    // Rows first, files second: content dedupe means several entries can
    // share one file, so only unlink paths no surviving row references.
    let unlinkFailures = 0;
    let firstFailure = "";
    for (const path of new Set(expired.map((e) => e.filePath))) {
      if (repo.countByFilePath(path) > 0) continue;
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (err) {
        // Skip it, but count: files left behind are disk that the purge
        // thinks it reclaimed.
        if (unlinkFailures++ === 0) {
          firstFailure = `${path}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
    if (removed > 0) {
      log("media", `Purged ${removed} expired media entries`);
    }
    if (unlinkFailures > 0) {
      logWarn(
        "media",
        `Media purge left ${unlinkFailures} expired file(s) on disk; first=${firstFailure}`,
      );
    }
  } catch (err) {
    logError("media", "Media index purge failed", err);
  }
}
