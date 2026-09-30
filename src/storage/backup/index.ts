/**
 * Snapshot index store — the listing/status view over the backups on
 * disk and on remote targets.
 *
 * Zero SQL by contract (see repo.ts). The domain rule this layer adds is
 * atomicity: a snapshot and its per-target rows move together, so a
 * pruned snapshot never leaves orphan remote rows behind to be counted
 * by the next retention pass.
 *
 * It lives in its own directory rather than as `storage/backups.ts`
 * because the flat `storage/` surface is at its documented ceiling
 * (docs/structure.md, tree baseline) — the store and its repository are
 * one concern with one entry, which is what the contract asks for.
 */

import { inTransaction } from "../db.js";
import * as repo from "./repo.js";

/**
 * Re-exported so the backup subsystem can ask SQLite for a consistent
 * copy of itself without importing the connection module: the database
 * handle stays inside storage/ (`db-handle-stays-in-storage`), and a
 * snapshot of the database is a storage concern with a storage API.
 */
export { databasePath, snapshotDatabase, snapshotSqliteFile } from "../db.js";

export type { BackupRecord, BackupRemoteRecord } from "./repo.js";
import type { BackupRecord, BackupRemoteRecord } from "./repo.js";

/** Insert or replace one snapshot row. */
export function recordBackup(record: BackupRecord): void {
  repo.upsert(record);
}

export function getBackup(id: string): BackupRecord | undefined {
  return repo.get(id);
}

/** Every indexed snapshot, newest first. */
export function listBackups(): BackupRecord[] {
  return repo.all();
}

/** Ids only — for reconciling the index against the directories on disk. */
export function backupIds(): Set<string> {
  return new Set(repo.ids());
}

/** Returns false when no such snapshot is indexed. */
export function pinBackup(id: string, pinned: boolean): boolean {
  return repo.setPinned(id, pinned);
}

/** Replace the stored manifest (after an upload, a pin, a remote prune). */
export function updateBackupManifest(
  id: string,
  manifestJson: string,
  pinned: boolean,
  sizeBytes: number,
): void {
  repo.setManifest(id, manifestJson, pinned, sizeBytes);
}

/** Drop a snapshot and every remote row that referenced it. */
export function deleteBackup(id: string): void {
  inTransaction(() => {
    repo.removeRemotes(id);
    repo.remove(id);
  });
}

export function recordBackupRemote(record: BackupRemoteRecord): void {
  repo.upsertRemote(record);
}

export function listBackupRemotes(backupId?: string): BackupRemoteRecord[] {
  return backupId === undefined ? repo.remotesAll() : repo.remotesFor(backupId);
}

export function deleteBackupRemote(backupId: string, targetId: string): void {
  repo.removeRemote(backupId, targetId);
}
