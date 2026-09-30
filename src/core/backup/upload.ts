/**
 * Getting a snapshot off this machine — and keeping the remote tidy.
 *
 * Targets run in parallel (they are independent networks) but the parts
 * of one snapshot go up sequentially, manifest last. That order is the
 * completeness marker: a remote snapshot with no manifest.json is an
 * interrupted upload, and nothing will ever mistake it for a restorable
 * backup.
 *
 * One target failing is not a failed backup. The snapshot is already on
 * local disk by the time we get here, so a target that errors records
 * `failed` with its reason and the run carries on — the next run retries
 * it. The manifest keeps the per-target state alongside the parts, so a
 * snapshot restored onto a new machine still knows where its copies are.
 *
 * Plaintext never leaves the box: before any target is contacted, every
 * part's own bytes (not the manifest's say-so) must carry the encryption
 * header. A snapshot taken without `backup.encryption` stays local, and
 * each target records why. Parts marked `localOnly` (login sessions, by
 * default) are never offered to a target at all; the manifest still lists
 * them, so a restore from the remote copy knows what it is missing.
 */

import { bus } from "../bus/index.js";
import { log, logWarn } from "../../util/log.js";
import { dirs } from "../../util/paths.js";
import {
  deleteBackupRemote,
  recordBackupRemote,
} from "../../storage/backup/index.js";
import { isEncryptedFile } from "./archive/crypt.js";
import {
  describeRetention,
  planRetention,
  type RetentionPolicy,
} from "./retention.js";
import { partPath, reindexSnapshot, writeManifest } from "./store.js";
import type { BackupTarget } from "./targets.js";
import type { Manifest, RemoteState, SnapshotPart } from "./types.js";

function recordState(id: string, targetId: string, state: RemoteState): void {
  recordBackupRemote({
    backupId: id,
    targetId,
    status: state.status,
    remoteId: state.remoteId,
    uploadedAt: state.uploadedAt,
    error: state.error,
  });
}

/** The parts a remote target may receive: everything not marked local-only. */
function remoteParts(manifest: Manifest): SnapshotPart[] {
  return manifest.parts.filter((part) => part.localOnly !== true);
}

/** Push every part, then the manifest. Throws with the target's own words. */
async function sendSnapshot(
  target: BackupTarget,
  manifest: Manifest,
  home: string,
): Promise<{ state: RemoteState; deduplicated: boolean }> {
  const parts = remoteParts(manifest);
  let deduplicated = parts.length > 0;
  for (const part of parts) {
    const result = await target.upload(
      manifest.id,
      { ...part, path: partPath(manifest.id, part.name, home) },
      manifest,
    );
    if (!result.deduplicated) deduplicated = false;
  }
  const { remoteId } = await target.uploadManifest(manifest.id, manifest);
  return {
    state: { status: "uploaded", remoteId, uploadedAt: Date.now() },
    deduplicated,
  };
}

/** The refusal every target records for an unencrypted snapshot. */
export const PLAINTEXT_REFUSAL =
  "remote backup targets require backup.encryption";

/** The first part whose file is not encrypted (or is missing), if any. */
async function firstPlaintextPart(
  manifest: Manifest,
  home: string,
): Promise<string | undefined> {
  for (const part of remoteParts(manifest)) {
    const encrypted = await isEncryptedFile(
      partPath(manifest.id, part.name, home),
    ).catch(() => false);
    if (!encrypted) return part.name;
  }
  return undefined;
}

/** Mark every target failed without contacting any of them. */
function refuseAll(
  manifest: Manifest,
  targets: readonly BackupTarget[],
  partName: string,
): void {
  const error = `${PLAINTEXT_REFUSAL} (part ${partName} is not encrypted; the snapshot stays local)`;
  for (const target of targets) {
    const state: RemoteState = { status: "failed", error };
    manifest.remote[target.id] = state;
    recordState(manifest.id, target.id, state);
  }
  logWarn("backup", `Not uploading ${manifest.id}: ${error}`);
}

/**
 * Upload one snapshot to every target. Returns the manifest with its
 * `remote` map filled in; it is rewritten on disk and reindexed so the
 * status surfaces can answer without asking the network.
 */
export async function uploadSnapshot(
  manifest: Manifest,
  targets: readonly BackupTarget[],
  home: string = dirs.root,
): Promise<Manifest> {
  if (targets.length === 0) return manifest;
  const plaintext = await firstPlaintextPart(manifest, home);
  if (plaintext !== undefined) {
    refuseAll(manifest, targets, plaintext);
  } else {
    await uploadToAll(manifest, targets, home);
  }
  await writeManifest(manifest, home);
  reindexSnapshot(manifest);
  return manifest;
}

async function uploadToAll(
  manifest: Manifest,
  targets: readonly BackupTarget[],
  home: string,
): Promise<void> {
  await Promise.all(
    targets.map(async (target) => {
      if (!target.ready) {
        const state: RemoteState = {
          status: "pending",
          error: target.detail ?? "target not ready",
        };
        manifest.remote[target.id] = state;
        recordState(manifest.id, target.id, state);
        logWarn("backup", `Target ${target.id} not ready: ${state.error}`);
        return;
      }
      try {
        const { state, deduplicated } = await sendSnapshot(
          target,
          manifest,
          home,
        );
        manifest.remote[target.id] = state;
        recordState(manifest.id, target.id, state);
        bus.publish({
          type: "backup.uploaded",
          snapshotId: manifest.id,
          targetId: target.id,
          bytes: manifest.sizeBytes,
          deduplicated,
        });
        log(
          "backup",
          `Uploaded ${manifest.id} to ${target.id}${deduplicated ? " (deduplicated)" : ""}`,
        );
      } catch (err) {
        const state: RemoteState = {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
        manifest.remote[target.id] = state;
        recordState(manifest.id, target.id, state);
        logWarn("backup", `Upload to ${target.id} failed: ${state.error}`);
      }
    }),
  );
}

/**
 * Apply the remote retention policy on each target — the same tiers as
 * local (see retention.ts), with `keepRemote` as the newest-N tier.
 *
 * Two refusals keep a retention pass from turning into data loss:
 *   - A target that cannot list is skipped: deleting on a partial
 *     listing is how that happens.
 *   - An entry whose manifest is missing, unreadable, or has no
 *     createdAt is never pruned. Without an age it cannot be ranked,
 *     and treating it as the oldest would delete it first.
 */
export async function pruneRemote(
  targets: readonly BackupTarget[],
  policy: RetentionPolicy,
): Promise<void> {
  for (const target of targets) {
    if (!target.ready) continue;
    let snapshots;
    try {
      snapshots = await target.list();
    } catch (err) {
      logWarn(
        "backup",
        `Cannot list ${target.id}, skipping remote prune: ${String(err)}`,
      );
      continue;
    }
    const plan = planRetention(
      snapshots.map((entry) => {
        const manifest = entry.manifest as Partial<Manifest> | undefined;
        return {
          id: entry.snapshotId,
          createdAt: manifest?.createdAt as number,
          pinned: manifest?.pinned === true,
          kind: manifest?.kind,
          verifiedAt: manifest?.verifiedAt,
        };
      }),
      policy,
    );
    if (plan.skipped.length > 0) {
      logWarn(
        "backup",
        `Not pruning ${plan.skipped.length} snapshot(s) on ${target.id} whose manifest ` +
          `is unreadable or has no createdAt: ${plan.skipped.map((s) => s.id).join(", ")}`,
      );
    }
    for (const victim of plan.prune) {
      try {
        await target.remove(victim.id);
        deleteBackupRemote(victim.id, target.id);
      } catch (err) {
        logWarn(
          "backup",
          `Could not delete ${victim.id} from ${target.id}: ${String(err)}`,
        );
      }
    }
    if (plan.prune.length > 0) {
      log(
        "backup",
        `Pruned ${plan.prune.length} snapshot(s) from ${target.id} (${describeRetention(policy)})`,
      );
    }
  }
}
