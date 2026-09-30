/**
 * Snapshot retention — which snapshots a prune pass may delete.
 *
 * Keeping only the newest N is not a safety net: if something silently
 * wipes memory, the next N scheduled snapshots faithfully back up the
 * damage and every good copy ages out within N × intervalHours (three
 * days at the defaults). So retention is tiered, the way restic and
 * borg do it:
 *
 *   - `keepLast`    the newest N scheduled snapshots (`keepLocal` /
 *                   `keepRemote` in config — their old meaning).
 *   - `keepDaily`   the newest snapshot of each of the last D days that
 *                   have one.
 *   - `keepWeekly`  the newest snapshot of each of the last W ISO weeks
 *                   that have one.
 *
 * Days and weeks are counted over snapshots that exist, not over the
 * calendar, so a machine that was off for a month does not lose its
 * history to the clock.
 *
 * Around the tiers sit three guard rails:
 *
 *   - Pinned snapshots are kept and count against nothing.
 *   - Checkpoints (manual, pre-update, pre-upgrade, pre-restore) have
 *     their own cap, `keepCheckpoints`, and never displace a scheduled
 *     snapshot — nor are they displaced by one.
 *   - The newest snapshot that passed verification is always kept, so a
 *     run of corrupt snapshots can never prune the last known-good one.
 *
 * Entries whose `createdAt` is not a real timestamp (an unreadable or
 * partial remote manifest) are never pruned: without an age there is no
 * honest way to rank them, and deleting what you cannot read is how a
 * retention pass becomes data loss. They are reported as `skipped` so
 * the caller can warn.
 *
 * Pure: no clock, no filesystem.
 */

/** The tiers one prune pass applies. */
export type RetentionPolicy = {
  /** Newest N scheduled snapshots. */
  keepLast: number;
  /** Newest snapshot per day, for the last N days that have one. 0 = off. */
  keepDaily: number;
  /** Newest snapshot per ISO week, for the last N weeks that have one. 0 = off. */
  keepWeekly: number;
  /** Newest N unpinned checkpoints, counted apart from scheduled snapshots. */
  keepCheckpoints: number;
};

/** What retention needs to know about one snapshot. */
export type RetentionEntry = {
  id: string;
  createdAt: number;
  pinned: boolean;
  /** "backup" | "checkpoint"; anything else is treated as "backup". */
  kind?: string;
  /** Epoch ms of a successful post-write verification, if there was one. */
  verifiedAt?: number;
};

/** Why a snapshot survived, for logs and tests. */
export type KeepReason =
  "pinned" | "last" | "daily" | "weekly" | "checkpoint" | "verified";

export type RetentionPlan<T> = {
  /** Snapshots to delete, newest first. */
  prune: T[];
  /** id → every reason it was kept. */
  keep: Map<string, KeepReason[]>;
  /** Entries without a usable createdAt — kept, and worth a warning. */
  skipped: T[];
};

/** Settings shape the policy is derived from (a subset of BackupSettings). */
type RetentionSettings = {
  keepLocal: number;
  keepRemote: number;
  keepDaily: number;
  keepWeekly: number;
  keepCheckpoints: number;
};

export function localRetention(settings: RetentionSettings): RetentionPolicy {
  return {
    keepLast: settings.keepLocal,
    keepDaily: settings.keepDaily,
    keepWeekly: settings.keepWeekly,
    keepCheckpoints: settings.keepCheckpoints,
  };
}

export function remoteRetention(settings: RetentionSettings): RetentionPolicy {
  return { ...localRetention(settings), keepLast: settings.keepRemote };
}

/** One-line description for logs: `last=12 daily=7 weekly=8 checkpoints=10`. */
export function describeRetention(policy: RetentionPolicy): string {
  return (
    `last=${policy.keepLast} daily=${policy.keepDaily} ` +
    `weekly=${policy.keepWeekly} checkpoints=${policy.keepCheckpoints}`
  );
}

/** A createdAt a snapshot can be ranked by. */
export function hasUsableTimestamp(entry: { createdAt: unknown }): boolean {
  return (
    typeof entry.createdAt === "number" &&
    Number.isFinite(entry.createdAt) &&
    entry.createdAt > 0
  );
}

/** `2026-09-30` in UTC. */
function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** ISO-8601 week, UTC: `2026-W40`. */
function weekKey(at: number): string {
  const date = new Date(at);
  const day = date.getUTCDay() || 7; // Mon=1 … Sun=7
  // The Thursday of this week decides which year the week belongs to.
  const thursday = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 4 - day,
  );
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.ceil(
    ((thursday - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Keep the newest entry of each of the first `limit` distinct buckets. */
function keepPerBucket<T extends RetentionEntry>(
  ordered: readonly T[],
  limit: number,
  bucketOf: (at: number) => string,
  reason: KeepReason,
  mark: (entry: T, reason: KeepReason) => void,
): void {
  if (limit <= 0) return;
  const seen = new Set<string>();
  for (const entry of ordered) {
    const bucket = bucketOf(entry.createdAt);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    mark(entry, reason);
    if (seen.size >= limit) return;
  }
}

/** Decide what survives. See the module comment for the rules. */
export function planRetention<T extends RetentionEntry>(
  snapshots: readonly T[],
  policy: RetentionPolicy,
): RetentionPlan<T> {
  const keep = new Map<string, KeepReason[]>();
  const mark = (entry: T, reason: KeepReason): void => {
    const reasons = keep.get(entry.id);
    if (reasons) reasons.push(reason);
    else keep.set(entry.id, [reason]);
  };

  const skipped = snapshots.filter((entry) => !hasUsableTimestamp(entry));
  const ranked = snapshots
    .filter(hasUsableTimestamp)
    .sort((a, b) => b.createdAt - a.createdAt);

  for (const entry of ranked) if (entry.pinned) mark(entry, "pinned");

  const unpinned = ranked.filter((entry) => !entry.pinned);
  const checkpoints = unpinned.filter((entry) => entry.kind === "checkpoint");
  const scheduled = unpinned.filter((entry) => entry.kind !== "checkpoint");

  for (const entry of checkpoints.slice(0, Math.max(0, policy.keepCheckpoints)))
    mark(entry, "checkpoint");
  for (const entry of scheduled.slice(0, Math.max(0, policy.keepLast)))
    mark(entry, "last");
  keepPerBucket(scheduled, policy.keepDaily, dayKey, "daily", mark);
  keepPerBucket(scheduled, policy.keepWeekly, weekKey, "weekly", mark);

  const lastVerified = ranked.find(
    (entry) => typeof entry.verifiedAt === "number" && entry.verifiedAt > 0,
  );
  if (lastVerified) mark(lastVerified, "verified");

  return {
    prune: ranked.filter((entry) => !keep.has(entry.id)),
    keep,
    skipped,
  };
}
