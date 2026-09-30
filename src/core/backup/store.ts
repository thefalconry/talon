/**
 * The local snapshot store — layout on disk, manifest I/O, retention,
 * and the SQLite index that the listing surfaces read.
 *
 * Layout (relative to the Talon home):
 *
 *   backups/<id>/manifest.json          what this snapshot is
 *   backups/<id>/state.tar.zst          identity + state + database
 *   backups/<id>/logins.tar.zst         WhatsApp auth + userbot session
 *   backups/<id>/palace-<hash12>.tar.zst  the memory palace, when present
 *
 * The manifest on disk is authoritative. SQLite is a cache so `/backup`
 * and `talon backup list` answer without opening a file per snapshot —
 * `reconcileIndex` rebuilds rows from the directories on every boot, and
 * a row whose directory has gone is kept rather than deleted, because
 * the snapshot may still exist on a remote target.
 */

import { randomBytes } from "node:crypto";
import { link, copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { dirs } from "../../util/paths.js";
import { log, logWarn } from "../../util/log.js";
import {
  backupIds,
  deleteBackup,
  getBackup,
  listBackupRemotes,
  listBackups,
  pinBackup,
  recordBackup,
  updateBackupManifest,
} from "../../storage/backup/index.js";
import { pathExists } from "./sources/sessions.js";
import {
  describeRetention,
  planRetention,
  type RetentionPolicy,
} from "./retention.js";
import type {
  Manifest,
  RemoteState,
  SnapshotKind,
  SnapshotSummary,
} from "./types.js";

/** `20260918T233400Z-a1b2c3` — chronological and filesystem-safe. */
const SNAPSHOT_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const MANIFEST_NAME = "manifest.json";
export const STATE_PART = "state.tar.zst";
/** Where the database copy lands inside the state part. */
export const DB_MEMBER = "db/talon.db";

function backupsRoot(home: string = dirs.root): string {
  return join(home, "backups");
}

/** True for a well-formed snapshot id. Ids reach us from chat and CLI. */
export function isSnapshotId(id: string): boolean {
  return SNAPSHOT_ID_RE.test(id);
}

export function snapshotDir(id: string, home: string = dirs.root): string {
  return join(backupsRoot(home), id);
}

/** Mint a new id. Sorts chronologically; the suffix separates same-second runs. */
export function newSnapshotId(
  now: Date = new Date(),
  suffix: string = randomBytes(3).toString("hex"),
): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${suffix}`;
}

// ── Manifest I/O ────────────────────────────────────────────────────────────

export async function readManifest(
  id: string,
  home: string = dirs.root,
): Promise<Manifest | null> {
  if (!isSnapshotId(id)) return null;
  try {
    const body = await readFile(
      join(snapshotDir(id, home), MANIFEST_NAME),
      "utf8",
    );
    const parsed = JSON.parse(body) as Manifest;
    return parsed.id === id ? parsed : null;
  } catch {
    return null; // absent or unreadable — the caller reports "not found"
  }
}

export async function writeManifest(
  manifest: Manifest,
  home: string = dirs.root,
): Promise<void> {
  const dir = snapshotDir(manifest.id, home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    join(dir, MANIFEST_NAME),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
}

/** Every snapshot directory that holds a readable manifest, newest first. */
export async function listLocalManifests(
  home: string = dirs.root,
): Promise<Manifest[]> {
  let names: string[] = [];
  try {
    names = await readdir(backupsRoot(home));
  } catch {
    return []; // no backups taken yet
  }
  const manifests: Manifest[] = [];
  for (const name of names.filter(isSnapshotId)) {
    const manifest = await readManifest(name, home);
    if (manifest) manifests.push(manifest);
  }
  return manifests.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Hard-link `source` to `dest`, copying when the link cannot be made
 * (different filesystem, a host that refuses links). Content-addressed
 * parts are identical bytes, so a link is free and a copy is correct.
 */
export async function linkOrCopy(source: string, dest: string): Promise<void> {
  try {
    await link(source, dest);
  } catch {
    await copyFile(source, dest);
  }
}

// ── SQLite index ────────────────────────────────────────────────────────────

function toRecord(manifest: Manifest) {
  return {
    id: manifest.id,
    kind: manifest.kind,
    label: manifest.label,
    pinned: manifest.pinned,
    createdAt: manifest.createdAt,
    sizeBytes: manifest.sizeBytes,
    manifestJson: JSON.stringify(manifest),
  };
}

/** Record (or refresh) one snapshot in the index. */
export function indexSnapshot(manifest: Manifest): void {
  recordBackup(toRecord(manifest));
}

/** Replace the indexed manifest after it changed (pin, upload, prune). */
export function reindexSnapshot(manifest: Manifest): void {
  updateBackupManifest(
    manifest.id,
    JSON.stringify(manifest),
    manifest.pinned,
    manifest.sizeBytes,
  );
}

/**
 * Bring the index in line with the directories on disk. Snapshots present
 * on disk but missing from the index are added — that is how a restored
 * (or hand-copied) backup directory becomes visible, and how the snapshot
 * a staged restore took before the database was swapped comes back.
 */
export async function reconcileIndex(
  home: string = dirs.root,
): Promise<number> {
  const known = backupIds();
  let added = 0;
  for (const manifest of await listLocalManifests(home)) {
    if (known.has(manifest.id)) continue;
    indexSnapshot(manifest);
    added += 1;
  }
  if (added > 0) log("backup", `Indexed ${added} snapshot(s) found on disk`);
  return added;
}

/** The listing every surface renders, newest first. */
export async function listSnapshots(
  home: string = dirs.root,
): Promise<SnapshotSummary[]> {
  const remotes = listBackupRemotes();
  const summaries: SnapshotSummary[] = [];
  for (const record of listBackups()) {
    const remote: Record<string, RemoteState> = {};
    for (const row of remotes.filter((r) => r.backupId === record.id)) {
      remote[row.targetId] = {
        status: row.status as RemoteState["status"],
        remoteId: row.remoteId,
        uploadedAt: row.uploadedAt,
        error: row.error,
      };
    }
    summaries.push({
      id: record.id,
      kind: record.kind as SnapshotKind,
      label: record.label,
      pinned: record.pinned,
      createdAt: record.createdAt,
      sizeBytes: record.sizeBytes,
      local: await pathExists(
        join(snapshotDir(record.id, home), MANIFEST_NAME),
      ),
      remote,
    });
  }
  return summaries;
}

/** Pin or unpin a snapshot, on disk and in the index. Returns false if unknown. */
export async function setSnapshotPinned(
  id: string,
  pinned: boolean,
  home: string = dirs.root,
): Promise<boolean> {
  const manifest = await readManifest(id, home);
  if (manifest) {
    manifest.pinned = pinned;
    await writeManifest(manifest, home);
    if (getBackup(id)) reindexSnapshot(manifest);
    else indexSnapshot(manifest);
    return true;
  }
  // Remote-only snapshot: the index row is all we have.
  return pinBackup(id, pinned);
}

// ── Retention ───────────────────────────────────────────────────────────────

/** Delete a snapshot directory and its index rows. */
async function removeSnapshot(
  id: string,
  home: string = dirs.root,
): Promise<void> {
  if (!isSnapshotId(id)) return;
  await rm(snapshotDir(id, home), { recursive: true, force: true });
  deleteBackup(id);
}

/**
 * Apply the local retention policy (see retention.ts). Returns the ids
 * removed. A directory whose manifest cannot be read never reaches the
 * listing, so it is never pruned.
 */
export async function pruneLocal(
  policy: RetentionPolicy,
  home: string = dirs.root,
): Promise<string[]> {
  const plan = planRetention(await listLocalManifests(home), policy);
  for (const manifest of plan.skipped) {
    logWarn(
      "backup",
      `Not pruning ${manifest.id}: its manifest has no usable createdAt`,
    );
  }
  const removed: string[] = [];
  for (const manifest of plan.prune) {
    try {
      await removeSnapshot(manifest.id, home);
      removed.push(manifest.id);
    } catch (err) {
      logWarn("backup", `Could not prune ${manifest.id}: ${String(err)}`);
    }
  }
  if (removed.length > 0) {
    log(
      "backup",
      `Pruned ${removed.length} local snapshot(s) (${describeRetention(policy)})`,
    );
  }
  return removed;
}

/** Absolute path of one part inside a snapshot directory. */
export function partPath(
  id: string,
  name: string,
  home: string = dirs.root,
): string {
  const dir = snapshotDir(id, home);
  const abs = resolve(dir, name);
  return abs.startsWith(dir) ? abs : join(dir, "invalid-part");
}
