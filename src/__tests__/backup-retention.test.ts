/**
 * Tiered snapshot retention (core/backup/retention/policy.ts).
 *
 * The failure this guards against: something silently damages memory,
 * the schedule keeps backing up the damage, and a newest-N policy ages
 * every good copy out within days. Daily and weekly tiers keep older
 * copies around; checkpoints and the last verified snapshot are kept
 * whatever the scheduled tiers decide.
 */

import { describe, it, expect } from "vitest";
import {
  localRetention,
  planRetention,
  remoteRetention,
  type RetentionEntry,
  type RetentionPolicy,
} from "../core/backup/retention/policy.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Wednesday 2026-09-30 18:00 UTC. */
const NOW = Date.UTC(2026, 8, 30, 18);

const policy = (patch: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  keepLast: 12,
  keepDaily: 7,
  keepWeekly: 4,
  keepCheckpoints: 10,
  ...patch,
});

/** A six-hourly schedule running for `days`, newest at NOW. */
function schedule(days: number): RetentionEntry[] {
  const out: RetentionEntry[] = [];
  for (let i = 0; i < days * 4; i++) {
    out.push({
      id: `s${i}`,
      createdAt: NOW - i * 6 * HOUR,
      pinned: false,
      kind: "backup",
    });
  }
  return out;
}

const kept = (entries: RetentionEntry[], p: RetentionPolicy) => {
  const plan = planRetention(entries, p);
  const pruned = new Set(plan.prune.map((e) => e.id));
  return entries.filter((e) => !pruned.has(e.id));
};

describe("planRetention", () => {
  it("keeps the newest N, plus one a day and one a week beyond them", () => {
    const entries = schedule(60);
    const survivors = kept(entries, policy());
    const ages = survivors.map((e) => Math.floor((NOW - e.createdAt) / DAY));

    // Newest 12 (three days) all survive.
    for (const e of entries.slice(0, 12)) {
      expect(survivors).toContain(e);
    }
    // Daily tier: one snapshot on each of the last seven days.
    for (let day = 0; day < 7; day++) {
      const dayStart = Date.UTC(2026, 8, 30 - day);
      expect(
        survivors.some(
          (e) => e.createdAt >= dayStart && e.createdAt < dayStart + DAY,
        ),
      ).toBe(true);
    }
    // Weekly tier reaches back beyond the daily one: the newest snapshot
    // of each of the last four ISO weeks, so the end of the week three
    // weeks back (Sunday 2026-09-13) is the oldest survivor.
    expect(Math.max(...ages)).toBeGreaterThanOrEqual(17);
    // And the whole set stays bounded: 12 + up to 7 daily + up to 4 weekly.
    expect(survivors.length).toBeLessThanOrEqual(12 + 7 + 4);
    // Everything older than four weeks is gone.
    expect(Math.max(...ages)).toBeLessThan(28);
  });

  it("maps keepLocal/keepRemote onto the newest-N tier", () => {
    const settings = {
      keepLocal: 3,
      keepRemote: 5,
      keepDaily: 0,
      keepWeekly: 0,
      keepCheckpoints: 2,
    };
    const entries = schedule(2);
    expect(kept(entries, localRetention(settings))).toHaveLength(3);
    expect(kept(entries, remoteRetention(settings))).toHaveLength(5);
  });

  it("with the daily and weekly tiers off, behaves like the old newest-N rule", () => {
    const entries = [
      { id: "e", createdAt: 5, pinned: false },
      { id: "d", createdAt: 4, pinned: true },
      { id: "c", createdAt: 3, pinned: false },
      { id: "b", createdAt: 2, pinned: false },
      { id: "a", createdAt: 1, pinned: true },
    ];
    const p = (keepLast: number) =>
      policy({ keepLast, keepDaily: 0, keepWeekly: 0 });
    expect(planRetention(entries, p(2)).prune.map((s) => s.id)).toEqual(["b"]);
    expect(planRetention(entries, p(99)).prune).toEqual([]);
    expect(planRetention(entries, p(1)).prune.map((s) => s.id)).toEqual([
      "c",
      "b",
    ]);
  });

  it("gives checkpoints their own cap, apart from scheduled snapshots", () => {
    const entries: RetentionEntry[] = [
      ...schedule(1),
      ...[1, 2, 3].map((n) => ({
        id: `cp${n}`,
        createdAt: NOW + n, // newer than every scheduled snapshot
        pinned: false,
        kind: "checkpoint",
      })),
      { id: "cp-pinned", createdAt: 1_000, pinned: true, kind: "checkpoint" },
    ];
    const plan = planRetention(
      entries,
      policy({ keepLast: 2, keepDaily: 0, keepWeekly: 0, keepCheckpoints: 2 }),
    );
    const survivors = entries
      .filter((e) => !plan.prune.includes(e))
      .map((e) => e.id);
    // Two newest checkpoints, two newest scheduled, and the pinned one:
    // the checkpoints did not push scheduled snapshots out, nor vice versa.
    expect(survivors.sort()).toEqual(["cp-pinned", "cp2", "cp3", "s0", "s1"]);
    expect(plan.keep.get("cp-pinned")).toEqual(["pinned"]);
  });

  it("never prunes the newest snapshot that verified", () => {
    const entries = schedule(10).map((e, i) =>
      // Only one old snapshot verified; everything newer did not.
      i === 30 ? { ...e, verifiedAt: e.createdAt + 1 } : e,
    );
    const plan = planRetention(
      entries,
      policy({ keepLast: 1, keepDaily: 0, keepWeekly: 0 }),
    );
    expect(plan.prune.map((e) => e.id)).not.toContain("s30");
    expect(plan.keep.get("s30")).toEqual(["verified"]);
    expect(plan.prune).toHaveLength(entries.length - 2);
  });

  it("skips, and never prunes, entries without a usable createdAt", () => {
    const entries: RetentionEntry[] = [
      { id: "good", createdAt: NOW, pinned: false },
      { id: "old", createdAt: NOW - DAY, pinned: false },
      {
        id: "no-date",
        createdAt: undefined as unknown as number,
        pinned: false,
      },
      { id: "zero", createdAt: 0, pinned: false },
      { id: "nan", createdAt: Number.NaN, pinned: false },
    ];
    const plan = planRetention(
      entries,
      policy({ keepLast: 1, keepDaily: 0, keepWeekly: 0 }),
    );
    expect(plan.prune.map((e) => e.id)).toEqual(["old"]);
    expect(plan.skipped.map((e) => e.id).sort()).toEqual([
      "nan",
      "no-date",
      "zero",
    ]);
  });

  it("counts days that have snapshots, not calendar days", () => {
    // The machine was off for a month: the old snapshots must not age out
    // just because the clock moved on.
    const entries: RetentionEntry[] = [
      { id: "today", createdAt: NOW, pinned: false },
      { id: "month-ago-1", createdAt: NOW - 30 * DAY, pinned: false },
      { id: "month-ago-2", createdAt: NOW - 31 * DAY, pinned: false },
    ];
    const plan = planRetention(
      entries,
      policy({ keepLast: 1, keepDaily: 3, keepWeekly: 0 }),
    );
    expect(plan.prune).toEqual([]);
  });
});
