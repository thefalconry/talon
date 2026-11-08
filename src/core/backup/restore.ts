/**
 * Restore — turning a snapshot back into a running Talon.
 *
 * The rules that make this safe to run on a live home directory:
 *
 *   1. Verify before you touch anything. The manifest's signature is
 *      checked (restore/guard.ts), then every part's sha256 and — for
 *      encrypted parts — every record's tag; a part that fails is a
 *      stopped restore, not a half-applied one.
 *   2. Stage, then swap. The archive is extracted into a staging
 *      directory beside the snapshot (same filesystem, so the swap is
 *      renames), and only then do the live paths change.
 *   3. Take a checkpoint first. A pinned `pre-restore <id>` checkpoint
 *      of the current state is made before anything is replaced, so
 *      "restore the wrong snapshot" is itself undoable.
 *   4. Replace only what the snapshot covers. Each include root is
 *      brought to exactly the snapshot's state — files the rules would
 *      have captured are removed, files the rules deliberately skip
 *      (traces, the live WAL, uploads) are left alone.
 *
 * The daemon must not be running: the CLI refuses while it is, and the
 * chat path stages a request that the next boot applies BEFORE the
 * database opens (see `applyPendingRestore`).
 */

import { createReadStream } from "node:fs";
import { pipeline } from "node:stream";
import type { Readable } from "node:stream";
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  copyFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { dirs } from "../../util/paths.js";
import { log, logWarn } from "../../util/log.js";
import { TalonError } from "../errors.js";
import {
  isEncryptedFile,
  openDecrypted,
  verifyDecryptable,
} from "./archive/crypt.js";
import { sha256File } from "./archive/digest.js";
import { extractTar } from "./archive/tar.js";
import { createDecompressor } from "./archive/zstd.js";
import { passphraseFilePath, requirePassphrase } from "./passphrase.js";
import { collectTree, excludeForRoot } from "./plan.js";
import {
  authenticateManifest,
  makePrivate,
  type ManifestTrust,
} from "./restore/guard.js";
import { buildSnapshot } from "./snapshot.js";
import {
  relocateRoot,
  rewriteConfigForClone,
  type CloneTarget,
} from "./sources/relocate.js";
import { pathExists } from "./sources/sessions.js";
import {
  DB_MEMBER,
  isSnapshotId,
  partPath,
  readManifest,
  snapshotDir,
} from "./store.js";
import type { BackupTarget } from "./targets.js";
import type {
  BackupSettings,
  Manifest,
  SnapshotOrigin,
  SnapshotPart,
} from "./types.js";
import { userHome } from "../../util/fs-path.js";

/** A staged request older than this is stale and ignored. */
export const RESTORE_PENDING_MAX_AGE_MS = 10 * 60_000;

export type RestorePending = {
  id: string;
  targetId?: string;
  /** Epoch ms. */
  requestedAt: number;
  /** Chat key that asked, so the boot can report back. */
  requestedBy?: string;
  /**
   * Frontend the request came from ("telegram", "discord", "native"), so
   * the report goes back the way it came. Absent in files staged before
   * it was recorded — the boot then infers it from `requestedBy`.
   */
  frontend?: string;
};

export type RestoreReport = {
  id: string;
  checkpointId?: string;
  /** Include root → files written. */
  written: Record<string, number>;
  removed: number;
  databaseReplaced: boolean;
  /** A clone rewrote config.json's paths for this machine. */
  configRewritten?: boolean;
};

export function restorePendingPath(home: string = dirs.root): string {
  return join(home, "restore-pending.json");
}

// ── The staged request ──────────────────────────────────────────────────────

export async function writeRestorePending(
  request: RestorePending,
  home: string = dirs.root,
): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFileAtomic(
    restorePendingPath(home),
    JSON.stringify(request) + "\n",
  );
}

export async function clearRestorePending(
  home: string = dirs.root,
): Promise<void> {
  await rm(restorePendingPath(home), { force: true });
}

/**
 * Read the staged request, if there is a usable one. A malformed file, a
 * bad id or a request older than ten minutes is deleted and ignored — a
 * restore that fires days later because a file was left behind would be
 * the most destructive bug this subsystem could have.
 */
export async function readRestorePending(
  home: string = dirs.root,
  now: number = Date.now(),
): Promise<RestorePending | null> {
  let parsed: RestorePending;
  try {
    parsed = JSON.parse(
      await readFile(restorePendingPath(home), "utf8"),
    ) as RestorePending;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logWarn(
        "backup",
        `Unreadable restore-pending.json, ignoring: ${String(err)}`,
      );
      await clearRestorePending(home);
    }
    return null;
  }
  const age = now - (parsed.requestedAt ?? 0);
  if (!isSnapshotId(parsed.id ?? "")) {
    logWarn(
      "backup",
      "restore-pending.json names no valid snapshot — discarded",
    );
    await clearRestorePending(home);
    return null;
  }
  if (
    !Number.isFinite(parsed.requestedAt) ||
    age > RESTORE_PENDING_MAX_AGE_MS ||
    age < 0
  ) {
    logWarn(
      "backup",
      `restore-pending.json is stale (${Math.round(age / 1000)}s old) — discarded`,
    );
    await clearRestorePending(home);
    return null;
  }
  return parsed;
}

// ── Parts ───────────────────────────────────────────────────────────────────

/** The parts of this snapshot that are not on local disk. */
async function missingParts(
  manifest: Manifest,
  home: string,
): Promise<SnapshotPart[]> {
  const missing: SnapshotPart[] = [];
  for (const part of manifest.parts) {
    if (!(await pathExists(partPath(manifest.id, part.name, home)))) {
      missing.push(part);
    }
  }
  return missing;
}

/**
 * Fetch every missing part from the given target and return the parts
 * the restore will use. A missing local-only part (login sessions kept
 * off remotes) is skipped with a warning — the restore goes on without it.
 */
async function ensureParts(
  manifest: Manifest,
  home: string,
  missing: readonly SnapshotPart[],
  target?: BackupTarget,
): Promise<SnapshotPart[]> {
  const skipped = new Set<string>();
  for (const part of missing) {
    if (part.localOnly) {
      logWarn(
        "backup",
        `${part.name} was kept on the original machine only — restoring without it (re-link WhatsApp / the userbot afterwards)`,
      );
      skipped.add(part.name);
      continue;
    }
    if (!target) {
      throw new TalonError(
        `Part ${part.name} of ${manifest.id} is missing locally and no --from target was given`,
        { reason: "bad_request" },
      );
    }
    const path = partPath(manifest.id, part.name, home);
    log("backup", `Downloading ${part.name} from ${target.id}…`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Into a side file, renamed only once complete: a download cut short
    // under the part's own name would count as present next time, and
    // every later restore would fail its checksum instead of refetching.
    const partial = `${path}.partial`;
    await rm(partial, { force: true });
    try {
      await target.download(manifest.id, part.name, partial);
      await rename(partial, path);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
  }
  return manifest.parts.filter((part) => !skipped.has(part.name));
}

/** Who may read backups: only the settings' encryption block matters. */
type KeySettings = Pick<BackupSettings, "encryption">;

/**
 * Check every part against the manifest. Throws on the first mismatch.
 * An encrypted part is also decrypted end to end (and discarded), so a
 * wrong passphrase or a tampered byte stops the restore before a single
 * file is extracted — the manifest's digest alone cannot prove that, as
 * the manifest travels with the parts.
 */
export async function verifyParts(
  manifest: Manifest,
  home: string,
  settings: KeySettings = {},
  parts: readonly SnapshotPart[] = manifest.parts,
): Promise<void> {
  for (const part of parts) {
    const path = partPath(manifest.id, part.name, home);
    const actual = await sha256File(path);
    if (actual !== part.sha256) {
      throw new TalonError(
        `Part ${part.name} of ${manifest.id} is corrupt (sha256 mismatch) — restore aborted`,
        { reason: "bad_request" },
      );
    }
    if (!(await isEncryptedFile(path))) {
      // A signed manifest only ever lists encrypted parts; a plaintext
      // one here was swapped in.
      if (manifest.auth) {
        throw new TalonError(
          `Part ${part.name} of ${manifest.id} is not encrypted although its manifest is signed — restore aborted`,
          { reason: "bad_request" },
        );
      }
      continue;
    }
    const passphrase = await requirePassphrase(
      settings,
      `Snapshot ${manifest.id}`,
    );
    try {
      await verifyDecryptable(path, passphrase);
    } catch (err) {
      throw new TalonError(
        `Part ${part.name} of ${manifest.id} cannot be decrypted — ${err instanceof Error ? err.message : String(err)}; restore aborted`,
        { reason: "bad_request", cause: err },
      );
    }
  }
}

/** A part's archive bytes: decrypted when the file carries the header. */
async function openPart(
  path: string,
  settings: KeySettings,
): Promise<Readable> {
  if (!(await isEncryptedFile(path))) return createReadStream(path);
  return openDecrypted(path, await requirePassphrase(settings, path));
}

/** Unpack every part into one staging tree. */
async function extractParts(
  manifest: Manifest,
  home: string,
  staging: string,
  settings: KeySettings,
  parts: readonly SnapshotPart[],
): Promise<void> {
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const part of parts) {
    const source = await openPart(
      partPath(manifest.id, part.name, home),
      settings,
    );
    const archive = pipeline(source, createDecompressor(), () => {
      /* a failure surfaces through extractTar's read */
    });
    await extractTar(archive, staging);
  }
}

// ── Applying ────────────────────────────────────────────────────────────────

/** An external root and where it lands on this machine. */
export type ExternalDestination = {
  root: string;
  dest: string;
  sqlite?: boolean;
};

/** Where an archive path lands on this machine. */
export function destinationFor(
  archivePath: string,
  home: string,
  extras: readonly { n: number; source: string }[],
  external: readonly ExternalDestination[] = [],
): string | null {
  const segments = archivePath.split("/");
  if (segments[0] === "extra") {
    const extra = extras.find((entry) => String(entry.n) === segments[1]);
    if (!extra) return null; // an extra path this machine has no mapping for
    return join(extra.source, ...segments.slice(2));
  }
  const outside = external.find(
    (entry) =>
      archivePath === entry.root || archivePath.startsWith(`${entry.root}/`),
  );
  if (outside) {
    const rest = archivePath.slice(outside.root.length).split("/");
    return join(outside.dest, ...rest.filter(Boolean));
  }
  if (segments[0] === "sessions" || segments[0] === "plugin-src") return null;
  if (archivePath === DB_MEMBER) return join(home, "data", "talon.db");
  return join(home, ...segments);
}

/** True when `path` is the active backup passphrase file. */
function isKeyFile(path: string, keyFile: string | null): boolean {
  return keyFile !== null && resolve(path) === keyFile;
}

/**
 * Bring one include root to exactly the snapshot's state: remove what the
 * snapshot rules would have captured, keep what they deliberately skip.
 * Returns how many live files were removed.
 *
 * The active passphrase file is never removed. The snapshot builder leaves
 * it out of every part (a key inside the backup it unlocks is no key), so
 * when it sits inside an include root — `workspace/secrets/`, `keys/`, an
 * extra path — nothing in the snapshot would ever put it back.
 */
async function clearCovered(
  destRoot: string,
  archiveRoot: string,
  keyFile: string | null,
): Promise<number> {
  const existing = await collectTree(destRoot, archiveRoot, {
    exclude: excludeForRoot(archiveRoot),
  });
  let removed = 0;
  for (const entry of [...existing].reverse()) {
    if (isKeyFile(entry.source, keyFile)) continue;
    try {
      if (entry.type === "dir") await rmdir(entry.source).catch(() => {});
      else {
        await unlink(entry.source);
        removed += 1;
      }
    } catch (err) {
      logWarn("backup", `Could not remove ${entry.source}: ${String(err)}`);
    }
  }
  return removed;
}

/**
 * The roots to apply: the manifest's includes, plus the palace whenever a
 * palace part is present (older manifests did not always list it).
 */
function rootsToApply(manifest: Manifest): string[] {
  const roots = manifest.includes.filter((root) => root !== DB_MEMBER);
  const hasPalace = manifest.parts.some((part) =>
    part.name.startsWith("palace-"),
  );
  if (hasPalace && !roots.includes("workspace/palace")) {
    roots.push("workspace/palace");
  }
  return roots;
}

/** Move one staged file into place, falling back to a copy across devices. */
async function placeFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to);
  }
}

/**
 * Swap the staged tree in. Include roots are handled one at a time so a
 * report can say what changed, and the database is written last: it is
 * the one file whose sidecars must go with it.
 */
async function applyStaged(
  manifest: Manifest,
  staging: string,
  home: string,
  external: readonly ExternalDestination[],
  keyFile: string | null,
): Promise<RestoreReport> {
  const extras = manifest.extras ?? [];
  const report: RestoreReport = {
    id: manifest.id,
    written: {},
    removed: 0,
    databaseReplaced: false,
  };
  for (const root of rootsToApply(manifest)) {
    const stagedRoot = join(staging, ...root.split("/"));
    const staged = await collectTree(stagedRoot, root, {
      exclude: excludeForRoot(root),
    });
    if (staged.length === 0) continue;
    const destRoot = destinationFor(root, home, extras, external);
    if (!destRoot) {
      logWarn("backup", `No destination for ${root} on this machine — skipped`);
      continue;
    }
    report.removed += await clearCovered(destRoot, root, keyFile);
    // A session database's sidecars describe the file being replaced.
    if (external.some((entry) => entry.root === root && entry.sqlite)) {
      await rm(`${destRoot}-wal`, { force: true });
      await rm(`${destRoot}-shm`, { force: true });
    }
    let written = 0;
    for (const entry of staged) {
      const dest = destinationFor(entry.archivePath, home, extras, external);
      if (!dest) continue;
      // An older snapshot (or one from another machine) may carry a file
      // where this machine keeps its key. The key path is never written.
      if (entry.type !== "dir" && isKeyFile(dest, keyFile)) {
        logWarn(
          "backup",
          `Left the backup passphrase file ${dest} untouched — the snapshot's copy was not applied`,
        );
        continue;
      }
      if (entry.type === "dir") await mkdir(dest, { recursive: true });
      else {
        await placeFile(entry.source, dest);
        written += 1;
      }
      await makePrivate(dest, entry.type, entry.mode);
    }
    report.written[root] = written;
  }

  const stagedDb = join(staging, "db", "talon.db");
  try {
    await stat(stagedDb);
    const dbPath = join(home, "data", "talon.db");
    // The sidecars describe the OLD database; leaving them beside the new
    // file is how a restored database comes up as the one we replaced.
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await placeFile(stagedDb, dbPath);
    await makePrivate(dbPath, "file", 0o600);
    report.databaseReplaced = true;
  } catch {
    logWarn(
      "backup",
      "Snapshot carries no database copy — leaving the live one in place",
    );
  }
  return report;
}

// ── The operation ───────────────────────────────────────────────────────────

export type RestoreOptions = {
  id: string;
  settings: BackupSettings;
  home?: string;
  /** Where to fetch parts this machine does not have. */
  target?: BackupTarget;
  /**
   * Called after the pre-restore checkpoint and before anything is
   * replaced. The composition root passes `closeDatabase` here: the
   * handle must be shut before its file is swapped underneath it.
   */
  beforeApply?: () => void | Promise<void>;
  /** Skip the automatic pre-restore checkpoint (it has already been taken). */
  skipCheckpoint?: boolean;
  /** Restore a manifest that carries no signature (see restore/guard.ts). */
  allowUnauthenticated?: ManifestTrust["allowUnauthenticated"];
  /**
   * Restoring onto a different machine: relocate the session stores and
   * plugin checkouts to this user's home and rewrite config.json's paths
   * (see sources/relocate.ts). Without it, a snapshot from another home
   * is refused rather than written to paths this machine does not own.
   */
  clone?: boolean;
  /** This machine's user home; defaults to `os.homedir()`. */
  userHome?: string;
  /**
   * The user home the snapshot was taken under, for a clone of a manifest
   * that carries no `origin` (scheduler snapshots before the origin record
   * was decoupled from outside-store discovery). The Talon home is taken
   * to be `<originUserHome>/.talon`.
   */
  originUserHome?: string;
  /** Environment for locating stores (CLAUDE_CONFIG_DIR, …). */
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * Where each external root of `manifest` goes. A plain restore puts it
 * back where it came from; a clone relocates it to this machine.
 */
function externalDestinations(
  manifest: Manifest,
  clone: boolean,
  target: CloneTarget,
  origin: SnapshotOrigin | undefined,
): ExternalDestination[] {
  if (clone && !origin && (manifest.external ?? []).length > 0) {
    // Without an origin the roots would be written back to the paths of
    // the machine they came from — on another OS that fails halfway
    // through the apply, after the Talon home has already been replaced.
    throw new TalonError(
      `Snapshot ${manifest.id} does not record the home it was taken under, so ` +
        `--clone cannot relocate its ${(manifest.external ?? []).length} outside root(s). ` +
        `Re-run with --origin-user-home <the user's home on the source machine>, ` +
        `e.g. --origin-user-home /home/alice.`,
      { reason: "bad_request" },
    );
  }
  const foreign =
    origin !== undefined &&
    (origin.userHome !== target.userHome || origin.home !== target.home);
  if (foreign && !clone && (manifest.external ?? []).length > 0) {
    throw new TalonError(
      `Snapshot ${manifest.id} was taken for ${origin.home} (user home ${origin.userHome}); ` +
        `this machine is ${target.home}. Restore it with --clone to relocate its ` +
        `session stores and plugin paths.`,
      { reason: "bad_request" },
    );
  }
  return (manifest.external ?? []).map((root) => ({
    root: root.root,
    dest: clone && origin ? relocateRoot(root, origin, target) : root.source,
    ...(root.sqlite ? { sqlite: true } : {}),
  }));
}

/**
 * Restore a snapshot over this home directory. The daemon must already be
 * stopped — this does not check, because the two callers check in their
 * own way (the CLI refuses, the boot path runs before anything starts).
 */
export async function restoreSnapshot(
  options: RestoreOptions,
): Promise<RestoreReport> {
  const home = options.home ?? dirs.root;
  const manifest = await readManifest(options.id, home);
  if (!manifest) {
    throw new TalonError(`No snapshot ${options.id} on this machine`, {
      reason: "bad_request",
    });
  }
  // Same default rule as the builder: the real home looks at the real
  // user home; a caller that points at another Talon home (a test) must
  // say which user home goes with it.
  const realHome = options.home === undefined;
  const cloneTarget: CloneTarget = {
    home,
    userHome: options.userHome ?? userHome(),
    env: options.env ?? (realHome ? process.env : {}),
  };
  const missing = await missingParts(manifest, home);
  await authenticateManifest(manifest, options.settings, {
    allowUnauthenticated: options.allowUnauthenticated,
    fromRemote: options.target !== undefined && missing.length > 0,
  });
  // Decided before anything is fetched or replaced: a refused clone must
  // leave this machine exactly as it was.
  const origin: SnapshotOrigin | undefined =
    manifest.origin ??
    (options.clone && options.originUserHome
      ? {
          userHome: options.originUserHome,
          home: join(options.originUserHome, ".talon"),
        }
      : undefined);
  const external = externalDestinations(
    manifest,
    options.clone ?? false,
    cloneTarget,
    origin,
  );
  const parts = await ensureParts(manifest, home, missing, options.target);
  await verifyParts(manifest, home, options.settings, parts);

  let checkpointId: string | undefined;
  if (!options.skipCheckpoint) {
    const checkpoint = await buildSnapshot({
      kind: "checkpoint",
      label: `pre-restore ${manifest.id}`,
      pinned: true,
      settings: options.settings,
      home,
      userHome: options.userHome ?? (realHome ? userHome() : null),
      env: cloneTarget.env,
    });
    checkpointId = checkpoint.id;
    log("backup", `Pre-restore checkpoint ${checkpointId} taken`);
  }

  const staging = join(snapshotDir(manifest.id, home), "restore-staging");
  await extractParts(manifest, home, staging, options.settings, parts);
  await options.beforeApply?.();
  const report = await applyStaged(
    manifest,
    staging,
    home,
    external,
    passphraseFilePath(options.settings),
  );
  report.checkpointId = checkpointId;
  if (options.clone && origin) {
    report.configRewritten = await rewriteConfigForClone(origin, cloneTarget);
  }
  await rm(staging, { recursive: true, force: true });
  log(
    "backup",
    `Restored ${manifest.id}: ${Object.values(report.written).reduce((a, b) => a + b, 0)} ` +
      `file(s) written, ${report.removed} removed` +
      (report.databaseReplaced ? ", database replaced" : ""),
  );
  return report;
}

/**
 * The boot hook: apply a restore staged from chat, before the database is
 * opened. Returns the report when one ran, null otherwise. Never throws —
 * a failed restore must still let the daemon boot, with the failure loud
 * in the log and the request deleted so the next boot is normal.
 */
export async function applyPendingRestore(options: {
  settings: BackupSettings;
  home?: string;
  beforeApply?: () => void | Promise<void>;
}): Promise<
  (RestoreReport & { requestedBy?: string; frontend?: string }) | null
> {
  const home = options.home ?? dirs.root;
  const pending = await readRestorePending(home);
  if (!pending) return null;
  log("backup", `Applying staged restore of ${pending.id} requested at boot`);
  try {
    const report = await restoreSnapshot({
      id: pending.id,
      settings: options.settings,
      home,
      beforeApply: options.beforeApply,
    });
    await clearRestorePending(home);
    return {
      ...report,
      requestedBy: pending.requestedBy,
      frontend: pending.frontend,
    };
  } catch (err) {
    logWarn("backup", `Staged restore of ${pending.id} failed: ${String(err)}`);
    await clearRestorePending(home);
    return null;
  }
}
