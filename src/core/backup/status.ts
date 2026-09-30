/**
 * The status report every surface renders.
 *
 * One collector and one formatter, shared by `talon backup`, `/backup`,
 * the `backup_status` tool and the gateway action — so the CLI, the chat
 * panel and the model all describe the same machine in the same words.
 * Rendering is plain text (no HTML, no markdown): the frontends escape
 * and wrap it as their platform needs.
 */

import { dirs } from "../../util/paths.js";
import { listSnapshots } from "./store.js";
import {
  discoverTargets,
  selectTargets,
  type BackupTarget,
} from "./targets.js";
import { backupSettings, schedulerStatus } from "./scheduler.js";
import { PASSPHRASE_ENV } from "./passphrase.js";
import type { BackupSettings, SnapshotSummary } from "./types.js";

type TargetStatus = {
  id: string;
  name: string;
  ready: boolean;
  detail?: string;
  /** Snapshots this target holds, when it could be listed. */
  snapshots?: number;
  error?: string;
};

export type BackupStatus = {
  schedule: ReturnType<typeof schedulerStatus>;
  local: {
    count: number;
    sizeBytes: number;
    pinned: number;
    newest?: SnapshotSummary;
  };
  targets: TargetStatus[];
  snapshots: SnapshotSummary[];
  /** Retention and encryption, when the subsystem is initialised. */
  policy?: BackupPolicy;
};

/** The settings a status panel renders alongside the numbers. */
type BackupPolicy = {
  keepLocal: number;
  keepRemote: number;
  /**
   * Snapshots are written encrypted: `backup.encryption` is configured or
   * the passphrase comes from the environment (see passphrase.ts). Off
   * means they stay on this machine — upload refuses plaintext.
   */
  encrypted: boolean;
};

function describePolicy(
  settings: BackupSettings | null,
  env: NodeJS.ProcessEnv = process.env,
): BackupPolicy | undefined {
  if (!settings) return undefined;
  return {
    keepLocal: settings.keepLocal,
    keepRemote: settings.keepRemote,
    encrypted:
      settings.encryption !== undefined || Boolean(env[PASSPHRASE_ENV]?.trim()),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** "in 4h 10m" / "12m ago" — relative, so a stale panel is obviously stale. */
export function formatRelative(
  at: number | undefined,
  now: number = Date.now(),
): string {
  if (!at) return "never";
  const deltaMs = at - now;
  const ahead = deltaMs >= 0;
  const minutes = Math.round(Math.abs(deltaMs) / 60_000);
  const text =
    minutes < 60
      ? `${minutes}m`
      : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return ahead ? `in ${text}` : `${text} ago`;
}

async function describeTargets(
  targets: readonly BackupTarget[],
): Promise<TargetStatus[]> {
  return Promise.all(
    targets.map(async (target) => {
      const base: TargetStatus = {
        id: target.id,
        name: target.name,
        ready: target.ready,
        detail: target.detail,
      };
      if (!target.ready) return base;
      try {
        return { ...base, snapshots: (await target.list()).length };
      } catch (err) {
        return {
          ...base,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/**
 * Gather everything the status surfaces need. `withTargets: false` keeps
 * it local-only — the agent tool and the chat panel use that when the
 * answer must be instant, because listing a remote is a network call.
 */
export async function collectBackupStatus(
  options: {
    home?: string;
    withTargets?: boolean;
  } = {},
): Promise<BackupStatus> {
  const home = options.home ?? dirs.root;
  const snapshots = await listSnapshots(home);
  const local = snapshots.filter((snapshot) => snapshot.local);
  const settings = backupSettings();
  const targets =
    options.withTargets === false
      ? []
      : await describeTargets(
          selectTargets(await discoverTargets(), settings?.targets),
        );
  return {
    schedule: schedulerStatus(),
    local: {
      count: local.length,
      sizeBytes: local.reduce((sum, snapshot) => sum + snapshot.sizeBytes, 0),
      pinned: snapshots.filter((snapshot) => snapshot.pinned).length,
      newest: local[0],
    },
    targets,
    snapshots,
    policy: describePolicy(settings),
  };
}

/** One line per snapshot: `<id>  checkpoint  12.4 MB  pinned  "label"  → drive`. */
function formatSnapshotLine(snapshot: SnapshotSummary): string {
  const remote = Object.entries(snapshot.remote)
    .map(([id, entry]) => `${id}:${entry.status}`)
    .join(" ");
  return [
    snapshot.id,
    snapshot.kind === "checkpoint" ? "checkpoint" : "backup",
    formatBytes(snapshot.sizeBytes),
    snapshot.pinned ? "pinned" : "",
    snapshot.local ? "" : "(no local copy)",
    snapshot.label ? `"${snapshot.label}"` : "",
    remote ? `→ ${remote}` : "",
  ]
    .filter(Boolean)
    .join("  ");
}

export function formatSnapshotList(
  snapshots: readonly SnapshotSummary[],
  limit = 20,
): string {
  if (snapshots.length === 0) return "No snapshots yet.";
  const lines = snapshots.slice(0, limit).map(formatSnapshotLine);
  if (snapshots.length > limit) {
    lines.push(`… and ${snapshots.length - limit} more`);
  }
  return lines.join("\n");
}

/** The status panel, as text. */
export function formatBackupStatus(
  status: BackupStatus,
  now: number = Date.now(),
): string {
  const { schedule, local } = status;
  const lines: string[] = [];
  lines.push(
    schedule.enabled
      ? `Schedule: every ${schedule.intervalHours}h — next ${formatRelative(schedule.nextRunAt, now)}` +
          (schedule.running ? " (a snapshot is running now)" : "")
      : "Schedule: disabled (manual checkpoints only)",
  );
  lines.push(
    `Last run: ${formatRelative(schedule.lastRunAt, now)}` +
      (schedule.lastSnapshotId ? ` — ${schedule.lastSnapshotId}` : ""),
  );
  if (schedule.consecutiveFailures > 0) {
    lines.push(
      `Failing: ${schedule.consecutiveFailures} consecutive — ${schedule.lastError ?? "unknown error"}`,
    );
  }
  lines.push(
    `Local: ${local.count} snapshot(s), ${formatBytes(local.sizeBytes)}` +
      (local.pinned > 0 ? `, ${local.pinned} pinned` : ""),
  );
  if (status.targets.length === 0) {
    lines.push("Targets: none registered (local only)");
  } else {
    for (const target of status.targets) {
      const state = target.ready
        ? target.error
          ? `unreachable — ${target.error}`
          : `ready, ${target.snapshots ?? 0} snapshot(s)`
        : `not ready${target.detail ? ` — ${target.detail}` : ""}`;
      lines.push(`Target ${target.name} (${target.id}): ${state}`);
    }
  }
  return lines.join("\n");
}
