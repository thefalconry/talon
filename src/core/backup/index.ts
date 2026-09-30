/**
 * Backups and checkpoints — the subsystem's public surface.
 *
 * A snapshot is everything that makes this deployment itself: config,
 * prompts, keys, sessions, the database (via `VACUUM INTO`, never a
 * byte-wise copy), the agent's memory and skills, and the memory palace
 * as its own content-addressed part. Scheduled snapshots are pruned by
 * retention; checkpoints are labelled, optionally pinned, and taken
 * before anything risky (a self-update, a restore).
 *
 * This barrel is what the surfaces above use — the CLI, the `/backup`
 * commands, the gateway actions, bootstrap and app. Inside the
 * subsystem the modules import each other directly.
 *
 * Read them in this order: `plan` (what goes in), `archive/` (how it is
 * written), `snapshot` (the build), `store` (the local store and its
 * index), `targets` + `upload` (getting it off the machine), `scheduler`
 * (when), `restore` (getting it back), `status` (what every surface
 * renders). docs/backups.md has the operator's view and the plugin
 * protocol.
 */

export {
  initBackup,
  runBackup,
  stopBackupScheduler,
  checkpointBeforeUpdate,
  type UpdateCheckpoint,
} from "./scheduler.js";

export {
  isSnapshotId,
  listSnapshots,
  readManifest,
  setSnapshotPinned,
} from "./store.js";

export {
  applyPendingRestore,
  readRestorePending,
  restoreSnapshot,
  writeRestorePending,
} from "./restore.js";

export { discoverTargets, type BackupTarget } from "./targets.js";

export {
  collectBackupStatus,
  formatBackupStatus,
  formatBytes,
  formatRelative,
  formatSnapshotList,
  type BackupStatus,
} from "./status.js";

export type { SnapshotSummary } from "./types.js";
