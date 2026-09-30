/**
 * The boot-time upgrade checkpoint: a pinned snapshot taken the first time
 * a new version boots, before anything in that version touches the data.
 *
 * `/update` on a git checkout takes its own pre-update checkpoint, but
 * that is the only install shape that does. A Docker or TrueNAS update is
 * a new image started against the old volume; npm and binary installs are
 * the same story. The first code of the new version to run is this boot,
 * so this boot is where the safety net has to be.
 *
 * The last version that booted is kept in a small marker file beside the
 * Talon home's config (not in the database: the check runs before the
 * database is opened, and a restore that rolls the database back should
 * not also roll back the fact that a newer version ran). The database is
 * captured through a read-only handle, so the checkpoint holds it exactly
 * as the previous version left it — before this boot's schema setup.
 *
 * Never throws and never blocks boot: a daemon that refuses to start is
 * worse than one that starts carefully. A failure is logged loudly,
 * raised as a critical operator alert, and reported to the caller so the
 * boot can skip its destructive steps. The marker is only advanced on
 * success, so the next boot tries again.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dirs } from "../../../util/paths.js";
import { log, logError } from "../../../util/log.js";
import {
  databasePath,
  snapshotDatabase,
  snapshotSqliteFile,
} from "../../../storage/backup/index.js";
import { raiseAlert } from "../../frontend-runtime/alerts.js";
import { buildSnapshot } from "../snapshot.js";
import type { BackupSettings } from "../types.js";

/** File (under the Talon home) recording the last version that booted. */
const BOOT_VERSION_MARKER = "last-boot-version.json";

/** Alert key for a failed upgrade checkpoint. */
export const UPGRADE_CHECKPOINT_ALERT = "backup.upgrade-checkpoint";

export type VersionCheckpointResult =
  /** Same version as last boot — nothing to do. */
  | { status: "unchanged"; version: string }
  /** No marker and no database: a brand-new install, nothing to protect. */
  | { status: "fresh-install"; version: string }
  /** Version changed but `backup.checkpointBeforeUpdate` is off. */
  | { status: "disabled"; from: string; to: string }
  | { status: "taken"; id: string; from: string; to: string }
  | { status: "failed"; from: string; to: string; error: string };

type MarkerFile = { version: string; bootedAt: string };

export type VersionCheckpointOptions = {
  settings: BackupSettings;
  /** The version now booting. */
  version: string;
  /** Talon home; tests point this at a scratch directory. */
  home?: string;
  /** The database file to capture; defaults to the daemon's. */
  databaseFile?: string;
  /** Snapshot builder — a test seam. */
  build?: typeof buildSnapshot;
  /** Operator alert — a test seam. */
  alert?: typeof raiseAlert;
  /** Clock, for tests. */
  now?: Date;
};

export function bootVersionMarkerPath(home: string = dirs.root): string {
  return join(home, BOOT_VERSION_MARKER);
}

/** The last version that booted, or null when none is recorded (or readable). */
export async function readLastBootVersion(
  home: string = dirs.root,
): Promise<string | null> {
  try {
    const raw = await readFile(bootVersionMarkerPath(home), "utf8");
    const parsed = JSON.parse(raw) as Partial<MarkerFile>;
    return typeof parsed.version === "string" && parsed.version
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

async function writeLastBootVersion(
  home: string,
  version: string,
  now: Date,
): Promise<void> {
  const path = bootVersionMarkerPath(home);
  const marker: MarkerFile = { version, bootedAt: now.toISOString() };
  try {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    await writeFile(temp, `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, path);
  } catch (err) {
    // Worst case the next boot takes one more checkpoint than needed.
    logError("backup", `Could not record boot version ${version}`, err);
  }
}

/**
 * Copy the database through a read-only handle; fall back to the regular
 * (opening) copy when SQLite refuses a read-only open, e.g. a WAL file
 * whose shared-memory index can't be created on a read-only handle.
 */
function copyDatabaseReadOnly(dbFile: string): (dest: string) => void {
  return (dest) => {
    try {
      snapshotSqliteFile(dbFile, dest);
    } catch (err) {
      logError(
        "backup",
        "Read-only database copy failed; copying through the daemon handle",
        err,
      );
      snapshotDatabase(dest);
    }
  };
}

/**
 * Take a pinned `pre-upgrade <old>→<new>` checkpoint when the version
 * booting differs from the last one that did. See the module comment.
 */
export async function checkpointOnVersionChange(
  options: VersionCheckpointOptions,
): Promise<VersionCheckpointResult> {
  const home = options.home ?? dirs.root;
  const now = options.now ?? new Date();
  const to = options.version;
  const previous = await readLastBootVersion(home);
  if (previous === to) return { status: "unchanged", version: to };

  const dbFile = options.databaseFile ?? databasePath();
  const hasDatabase = existsSync(dbFile);
  if (previous === null && !hasDatabase) {
    await writeLastBootVersion(home, to, now);
    return { status: "fresh-install", version: to };
  }

  // No marker but a database: an install from before the marker existed.
  const from = previous ?? "unknown";
  if (!options.settings.checkpointBeforeUpdate) {
    log(
      "backup",
      `Version changed ${from}→${to}; pre-upgrade checkpoint disabled (backup.checkpointBeforeUpdate=false)`,
    );
    await writeLastBootVersion(home, to, now);
    return { status: "disabled", from, to };
  }

  const build = options.build ?? buildSnapshot;
  try {
    const manifest = await build({
      kind: "checkpoint",
      label: `pre-upgrade ${from}→${to}`,
      pinned: true,
      settings: options.settings,
      ...(options.home === undefined ? {} : { home, userHome: null }),
      // Read-only: the copy is the database exactly as the previous
      // version left it, before this boot opens it and sets up its schema.
      ...(hasDatabase ? { copyDatabase: copyDatabaseReadOnly(dbFile) } : {}),
      now,
    });
    await writeLastBootVersion(home, to, now);
    log(
      "backup",
      `Pre-upgrade checkpoint ${manifest.id} taken (${from}→${to}, pinned)`,
    );
    return { status: "taken", id: manifest.id, from, to };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logError(
      "backup",
      `PRE-UPGRADE CHECKPOINT FAILED (${from}→${to}) — booting without a safety snapshot; destructive boot steps are skipped`,
      err,
    );
    (options.alert ?? raiseAlert)(
      UPGRADE_CHECKPOINT_ALERT,
      `Talon upgraded ${from}→${to} but the pre-upgrade checkpoint failed: ${error}\n` +
        "The daemon booted anyway and skipped its boot-time cleanup. " +
        "Fix the backup setup (e.g. a missing backup key) and restart; " +
        "the checkpoint is retried on every boot until it succeeds.",
      { severity: "critical" },
    );
    return { status: "failed", from, to, error };
  }
}
