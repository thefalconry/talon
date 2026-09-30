/**
 * What a restore must check before it trusts a snapshot, and the file
 * modes it leaves behind.
 *
 * A manifest can come from anywhere — copied off a remote target, handed
 * over on a USB stick — and it decides what gets extracted where. So:
 *
 *   - A manifest with an `auth` block must verify under the configured
 *     passphrase, and then every part it lists must be encrypted: an
 *     authenticated manifest pointing at a plaintext part is a swap.
 *   - A manifest without one is a legacy (or plaintext) snapshot. It
 *     still restores — unless this install has a backup passphrase or
 *     the parts came from a remote target, because that is exactly what
 *     an attacker who stripped the MAC would hand us. Then the operator
 *     has to say so explicitly (`--allow-unauthenticated`).
 *
 * Everything a restore writes is owner-only: files keep their owner
 * bits (so scripts stay executable) and gain nothing for group/other;
 * directories are 0700. The snapshot carries config.json, keys and
 * sessions — whatever mode they had on the old machine, this one should
 * not publish them.
 */

import { chmod } from "node:fs/promises";
import { logWarn } from "../../../util/log.js";
import { TalonError } from "../../errors.js";
import { verifyManifest } from "../archive/manifest-auth.js";
import { resolvePassphrase } from "../passphrase.js";
import type { BackupSettings, Manifest } from "../types.js";

export type ManifestTrust = {
  /** Operator override for unauthenticated manifests. */
  allowUnauthenticated?: boolean;
  /** True when any part is being fetched from a remote target. */
  fromRemote?: boolean;
};

function refuse(message: string): TalonError {
  return new TalonError(message, { reason: "bad_request" });
}

/**
 * Throw unless this manifest may be trusted. Returns whether it was
 * authenticated, so the part check can insist on encryption.
 */
export async function authenticateManifest(
  manifest: Manifest,
  settings: Pick<BackupSettings, "encryption">,
  trust: ManifestTrust = {},
): Promise<boolean> {
  const passphrase = await resolvePassphrase(settings);
  if (manifest.auth) {
    if (!passphrase) {
      throw refuse(
        `Snapshot ${manifest.id} is signed with a backup passphrase — set backup.encryption.passphraseFile or TALON_BACKUP_PASSPHRASE to restore it`,
      );
    }
    if (!(await verifyManifest(manifest, passphrase))) {
      throw refuse(
        `Snapshot ${manifest.id}: manifest authentication failed — wrong passphrase, or the manifest was modified; restore aborted`,
      );
    }
    return true;
  }
  if (trust.allowUnauthenticated) {
    logWarn(
      "backup",
      `Restoring unauthenticated snapshot ${manifest.id} (--allow-unauthenticated)`,
    );
    return false;
  }
  if (passphrase || trust.fromRemote) {
    throw refuse(
      `Snapshot ${manifest.id} has no manifest signature` +
        (trust.fromRemote
          ? " and its parts come from a remote target"
          : " although this install has a backup passphrase") +
        ` — it may have been tampered with. If you know it is a snapshot from before backup encryption, re-run with --allow-unauthenticated`,
    );
  }
  return false;
}

/** Owner-only mode for a restored file, keeping the owner's execute bit. */
export function privateFileMode(mode: number): number {
  return (mode & 0o700) | 0o600;
}

/** Tighten one restored path. Failures are logged, not fatal. */
export async function makePrivate(
  path: string,
  type: "file" | "dir" | "symlink",
  mode: number,
): Promise<void> {
  if (type === "symlink" || process.platform === "win32") return;
  try {
    await chmod(path, type === "dir" ? 0o700 : privateFileMode(mode));
  } catch (err) {
    logWarn("backup", `Could not set mode on ${path}: ${String(err)}`);
  }
}
