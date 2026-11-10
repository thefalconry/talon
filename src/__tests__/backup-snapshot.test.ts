/**
 * Snapshot builder — what lands in a part and what must never.
 *
 * The include/exclude rules are the whole value of a backup: capture the
 * agent's identity, skip the bulk that can be refetched, and never touch
 * ~/.talon/ns (a FUSE mount that may be dead). The palace cases pin the
 * content-addressing that makes a six-hourly backup of a big palace free.
 */

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  existsSync,
  createReadStream,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot } from "../core/backup/snapshot.js";
import { extractTar } from "../core/backup/archive/tar.js";
import { createDecompressor } from "../core/backup/archive/zstd.js";
import {
  isExcluded,
  matchesWorkspaceInclude,
  DEFAULT_WORKSPACE_INCLUDE,
} from "../core/backup/plan.js";
import {
  listLocalManifests,
  pruneLocal,
  snapshotDir,
  newSnapshotId,
} from "../core/backup/store.js";
import type { BackupSettings } from "../core/backup/types.js";

const SETTINGS: BackupSettings = {
  enabled: true,
  intervalHours: 6,
  keepLocal: 12,
  keepRemote: 30,
  keepDaily: 7,
  keepWeekly: 4,
  keepCheckpoints: 10,
  includePalace: true,
  loginSessions: "local",
  includeSessions: true,
  workspaceInclude: DEFAULT_WORKSPACE_INCLUDE,
  extraPaths: [],
  checkpointBeforeUpdate: true,
};

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "talon-backup-home-"));
  const write = (rel: string, body: string) => {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    writeFileSync(join(home, rel), body);
  };
  mkdirSync(join(home, "prompts"), { recursive: true });
  mkdirSync(join(home, "data", "traces"), { recursive: true });
  mkdirSync(join(home, "keys"), { recursive: true });
  mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  mkdirSync(join(home, "workspace", "uploads"), { recursive: true });
  mkdirSync(join(home, "workspace", "palace"), { recursive: true });
  mkdirSync(join(home, "ns"), { recursive: true });
  write("config.json", '{"botToken":"secret"}');
  write("prompts/system.md", "be good");
  write("data/traces/chat.jsonl", "trace");
  write("data/talon.db", "not-a-real-db");
  write("data/talon.db-wal", "wal");
  write("keys/bridge.key", "private");
  write("talon.log", "noise");
  write("workspace/identity.md", "I am Talon");
  write("workspace/memory/memory.md", "remembered");
  write("workspace/uploads/huge.bin", "x".repeat(1000));
  write("workspace/palace/node-1.json", "palace data");
  write("ns/should-never-be-read", "fuse");
  return home;
}

async function membersOf(part: string): Promise<string[]> {
  const entries = await extractTar(
    createReadStream(part).pipe(createDecompressor()),
    mkdtempSync(join(tmpdir(), "talon-backup-x-")),
  );
  return entries.map((e) => e.path);
}

const copyDatabase = (dest: string) =>
  writeFileSync(dest, "SQLite format 3\0fake");

describe("snapshot include/exclude rules", () => {
  it("keeps identity and drops the bulk", () => {
    expect(isExcluded("config.json")).toBe(false);
    expect(isExcluded("keys/bridge.key")).toBe(false);
    expect(isExcluded("workspace/memory/memory.md")).toBe(false);

    expect(isExcluded("ns")).toBe(true);
    expect(isExcluded("ns/anything")).toBe(true);
    expect(isExcluded("backups/20260918T000000Z-aaaaaa")).toBe(true);
    expect(isExcluded("talon.log")).toBe(true);
    expect(isExcluded("talon.log.old")).toBe(true);
    expect(isExcluded("errors.log")).toBe(true);
    expect(isExcluded("data/traces/chat.jsonl")).toBe(true);
    expect(isExcluded("data/talon.db")).toBe(true);
    expect(isExcluded("data/talon.db-wal")).toBe(true);
    expect(isExcluded("workspace/palace/node.json")).toBe(true);
    expect(isExcluded("agent-workspace/project/node_modules/x.js")).toBe(true);
    expect(isExcluded("agent-workspace/.venv/bin/python")).toBe(true);
    expect(isExcluded("config.json.tmp-1234")).toBe(true);
    // A file that merely mentions a rule elsewhere in its path stays in.
    expect(isExcluded("prompts/talon.log.md")).toBe(false);
  });

  it("matches the workspace include patterns exactly or by prefix", () => {
    const patterns = ["identity.md", "memory/**"];
    expect(matchesWorkspaceInclude("identity.md", patterns)).toBe(true);
    expect(matchesWorkspaceInclude("memory", patterns)).toBe(true);
    expect(
      matchesWorkspaceInclude("memory/daily/2026-09-18.md", patterns),
    ).toBe(true);
    expect(matchesWorkspaceInclude("uploads/a.png", patterns)).toBe(false);
    expect(matchesWorkspaceInclude("identity.md.bak", patterns)).toBe(false);
  });
});

describe("buildSnapshot", () => {
  it("archives identity, adds the database, and leaves the bulk out", async () => {
    const home = fakeHome();
    const manifest = await buildSnapshot({
      kind: "backup",
      settings: SETTINGS,
      home,
      copyDatabase,
    });

    expect(manifest.schema).toBe(1);
    expect(manifest.parts.map((p) => p.name)).toContain("state.tar.zst");
    expect(manifest.sizeBytes).toBeGreaterThan(0);
    expect(manifest.parts.every((p) => /^[0-9a-f]{64}$/.test(p.sha256))).toBe(
      true,
    );

    const members = await membersOf(
      join(snapshotDir(manifest.id, home), "state.tar.zst"),
    );
    expect(members).toContain("config.json");
    expect(members).toContain("prompts/system.md");
    expect(members).toContain("keys/bridge.key");
    expect(members).toContain("workspace/identity.md");
    expect(members).toContain("workspace/memory/memory.md");
    expect(members).toContain("db/talon.db");

    expect(members).not.toContain("data/traces/chat.jsonl");
    expect(members).not.toContain("data/talon.db");
    expect(members).not.toContain("data/talon.db-wal");
    expect(members).not.toContain("talon.log");
    expect(members).not.toContain("workspace/uploads/huge.bin");
    expect(members.some((m) => m.startsWith("ns"))).toBe(false);
    expect(members.some((m) => m.startsWith("workspace/palace"))).toBe(false);
  });

  it("puts the palace in its own part and reuses it while it is unchanged", async () => {
    const home = fakeHome();
    const first = await buildSnapshot({
      kind: "backup",
      settings: SETTINGS,
      home,
      copyDatabase,
    });
    const palacePart = first.parts.find((p) => p.name.startsWith("palace-"));
    expect(palacePart).toBeDefined();
    expect(first.palaceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await membersOf(join(snapshotDir(first.id, home), palacePart!.name)),
    ).toContain("workspace/palace/node-1.json");

    const second = await buildSnapshot({
      kind: "backup",
      settings: SETTINGS,
      home,
      copyDatabase,
    });
    const reused = second.parts.find((p) => p.name.startsWith("palace-"));
    expect(reused?.name).toBe(palacePart!.name);
    expect(reused?.contentAddressed).toBe(true);
    expect(reused?.sha256).toBe(palacePart!.sha256);
    // Hard-linked, not recompressed: same inode, one copy of the bytes.
    // Windows reports a file index rather than an inode and the link may
    // fall back to a copy, so the identity check is POSIX-only — the reuse
    // itself (same name, same digest, contentAddressed) is asserted above
    // on every platform.
    if (process.platform !== "win32") {
      const a = statSync(join(snapshotDir(first.id, home), palacePart!.name));
      const b = statSync(join(snapshotDir(second.id, home), reused!.name));
      expect(b.ino).toBe(a.ino);
    }

    // A changed palace gets a new fingerprint and a new part.
    writeFileSync(join(home, "workspace", "palace", "node-2.json"), "more");
    const third = await buildSnapshot({
      kind: "backup",
      settings: SETTINGS,
      home,
      copyDatabase,
    });
    expect(
      third.parts.find((p) => p.name.startsWith("palace-"))!.name,
    ).not.toBe(palacePart!.name);
  });

  it("carries extraPaths and skips ones inside the namespace mount", async () => {
    const home = fakeHome();
    const outside = mkdtempSync(join(tmpdir(), "talon-extra-"));
    writeFileSync(join(outside, "CLAUDE.md"), "external memory");
    const settings = { ...SETTINGS, extraPaths: [outside, join(home, "ns")] };
    const manifest = await buildSnapshot({
      kind: "checkpoint",
      label: "x",
      settings,
      home,
      copyDatabase,
    });

    expect(manifest.extras).toEqual([{ n: 0, source: outside }]);
    const members = await membersOf(
      join(snapshotDir(manifest.id, home), "state.tar.zst"),
    );
    expect(members).toContain("extra/0/CLAUDE.md");
    expect(members.some((m) => m.startsWith("extra/1"))).toBe(false);
  });

  it("skips a file that vanishes between the walk and the archive", async () => {
    const home = fakeHome();
    const manifest = await buildSnapshot({
      kind: "backup",
      settings: SETTINGS,
      home,
      // Runs after the walk, before the state part is written.
      copyDatabase: (dest) => {
        rmSync(join(home, "workspace", "memory", "memory.md"));
        copyDatabase(dest);
      },
    });
    const members = await membersOf(
      join(snapshotDir(manifest.id, home), "state.tar.zst"),
    );
    expect(members).not.toContain("workspace/memory/memory.md");
    expect(members).toContain("workspace/identity.md");
    expect(members).toContain("db/talon.db");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "skips an unreadable palace file instead of failing the snapshot",
    async () => {
      const home = fakeHome();
      writeFileSync(join(home, "workspace", "palace", "locked.bin"), "x");
      chmodSync(join(home, "workspace", "palace", "locked.bin"), 0o000);
      const manifest = await buildSnapshot({
        kind: "backup",
        settings: SETTINGS,
        home,
        copyDatabase,
      });
      const palace = manifest.parts.find((p) => p.name.startsWith("palace-"));
      expect(palace).toBeDefined();
      const members = await membersOf(
        join(snapshotDir(manifest.id, home), palace!.name),
      );
      expect(members).toContain("workspace/palace/node-1.json");
      expect(members).not.toContain("workspace/palace/locked.bin");
    },
  );

  it("leaves no directory behind when a build fails", async () => {
    const home = fakeHome();
    const before = (await listLocalManifests(home)).length;
    await expect(
      buildSnapshot({
        kind: "backup",
        settings: SETTINGS,
        home,
        copyDatabase: () => {
          throw new Error("database is locked");
        },
      }),
    ).rejects.toThrow(/database is locked/);
    expect((await listLocalManifests(home)).length).toBe(before);
  });
});

describe("retention", () => {
  const NEWEST_ONLY = {
    keepLast: 1,
    keepDaily: 0,
    keepWeekly: 0,
    keepCheckpoints: 10,
  };

  it("stamps verifiedAt on a snapshot whose parts read back", async () => {
    const home = fakeHome();
    const manifest = await buildSnapshot({
      kind: "backup",
      settings: { ...SETTINGS, includePalace: false },
      home,
      copyDatabase,
    });
    expect(manifest.verifiedAt).toBeGreaterThan(0);
    const [onDisk] = await listLocalManifests(home);
    expect(onDisk.verifiedAt).toBe(manifest.verifiedAt);
  });

  it("does not count an unpinned checkpoint against the scheduled budget", async () => {
    const home = fakeHome();
    const settings = { ...SETTINGS, includePalace: false };
    const older = await buildSnapshot({
      kind: "backup",
      settings,
      home,
      copyDatabase,
    });
    const newer = await buildSnapshot({
      kind: "backup",
      settings,
      home,
      copyDatabase,
    });
    const checkpoint = await buildSnapshot({
      kind: "checkpoint",
      label: "manual",
      settings,
      home,
      copyDatabase,
    });
    const removed = await pruneLocal(NEWEST_ONLY, home);
    expect(removed).toEqual([older.id]);
    expect(existsSync(snapshotDir(newer.id, home))).toBe(true);
    expect(existsSync(snapshotDir(checkpoint.id, home))).toBe(true);
  });

  it("deletes the pruned directories and keeps pinned ones", async () => {
    const home = fakeHome();
    const settings = { ...SETTINGS, includePalace: false };
    const first = await buildSnapshot({
      kind: "backup",
      settings,
      home,
      copyDatabase,
    });
    const pinned = await buildSnapshot({
      kind: "checkpoint",
      label: "keep me",
      pinned: true,
      settings,
      home,
      copyDatabase,
    });
    const newest = await buildSnapshot({
      kind: "backup",
      settings,
      home,
      copyDatabase,
    });

    const removed = await pruneLocal(NEWEST_ONLY, home);
    expect(removed).toEqual([first.id]);
    expect(existsSync(snapshotDir(first.id, home))).toBe(false);
    expect(existsSync(snapshotDir(pinned.id, home))).toBe(true);
    expect(existsSync(snapshotDir(newest.id, home))).toBe(true);
  });
});

describe("snapshot ids", () => {
  it("sort chronologically and carry a collision suffix", () => {
    const id = newSnapshotId(new Date("2026-09-18T23:34:00.000Z"), "a1b2c3");
    expect(id).toBe("20260918T233400Z-a1b2c3");
    expect(
      newSnapshotId(new Date("2026-09-17T00:00:00.000Z"), "000000") < id,
    ).toBe(true);
  });
});
