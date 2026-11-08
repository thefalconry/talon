/**
 * Restore — the guard on the staged request, and the swap itself.
 *
 * The staged-request tests are the important ones: `restore-pending.json`
 * is a file that makes the next boot replace the database and the memory,
 * so anything about it that is not exactly right must end in "delete and
 * ignore", never in "apply anyway".
 */

import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRestorePending,
  destinationFor,
  readRestorePending,
  restorePendingPath,
  restoreSnapshot,
  verifyParts,
  writeRestorePending,
  RESTORE_PENDING_MAX_AGE_MS,
} from "../core/backup/restore.js";
import { buildSnapshot } from "../core/backup/snapshot.js";
import {
  listLocalManifests,
  partPath,
  snapshotDir,
} from "../core/backup/store.js";
import { resolveBackupSettings } from "../core/backup/plan.js";
import type { BackupTarget } from "../core/backup/targets.js";

const SETTINGS = resolveBackupSettings({ includePalace: false });
const copyDatabase = (dest: string) =>
  writeFileSync(dest, "SQLite format 3\0snapshot");

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "talon-restore-"));
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "data", "traces"), { recursive: true });
  mkdirSync(join(root, "workspace", "memory"), { recursive: true });
  writeFileSync(join(root, "config.json"), '{"model":"original"}');
  writeFileSync(join(root, "prompts", "system.md"), "original prompt");
  writeFileSync(
    join(root, "workspace", "memory", "memory.md"),
    "original memory",
  );
  writeFileSync(join(root, "workspace", "identity.md"), "original identity");
  writeFileSync(join(root, "data", "traces", "chat.jsonl"), "trace kept");
  writeFileSync(join(root, "data", "talon.db"), "live database");
  return root;
}

describe("the staged restore request", () => {
  it("round-trips a fresh request", async () => {
    const root = home();
    await writeRestorePending(
      {
        id: "20260101T000000Z-aaaaaa",
        requestedAt: Date.now(),
        requestedBy: "123",
      },
      root,
    );
    const pending = await readRestorePending(root);
    expect(pending?.id).toBe("20260101T000000Z-aaaaaa");
    expect(pending?.requestedBy).toBe("123");
  });

  it("ignores and deletes a request that is too old", async () => {
    const root = home();
    const requestedAt = Date.now() - RESTORE_PENDING_MAX_AGE_MS - 1_000;
    await writeRestorePending(
      { id: "20260101T000000Z-aaaaaa", requestedAt },
      root,
    );
    expect(await readRestorePending(root)).toBeNull();
    expect(existsSync(restorePendingPath(root))).toBe(false);
  });

  it("ignores a request from the future, a bad id, and a corrupt file", async () => {
    const root = home();
    await writeRestorePending(
      { id: "20260101T000000Z-aaaaaa", requestedAt: Date.now() + 60_000 },
      root,
    );
    expect(await readRestorePending(root)).toBeNull();

    await writeRestorePending(
      { id: "../../etc/passwd", requestedAt: Date.now() } as never,
      root,
    );
    expect(await readRestorePending(root)).toBeNull();
    expect(existsSync(restorePendingPath(root))).toBe(false);

    writeFileSync(restorePendingPath(root), "{not json");
    expect(await readRestorePending(root)).toBeNull();
    expect(existsSync(restorePendingPath(root))).toBe(false);
  });

  it("is absent, not an error, when nothing was staged", async () => {
    const root = home();
    expect(await readRestorePending(root)).toBeNull();
    await clearRestorePending(root); // idempotent
  });
});

describe("destinationFor", () => {
  it("maps archive paths back onto this machine", () => {
    // Archive paths are always `/`-separated; destinations are native
    // paths, so the expectations go through `join` and hold on Windows too.
    const extras = [{ n: 0, source: join("/home", "someone", "notes") }];
    expect(destinationFor("config.json", "/talon", extras)).toBe(
      join("/talon", "config.json"),
    );
    expect(destinationFor("workspace/memory/memory.md", "/talon", extras)).toBe(
      join("/talon", "workspace", "memory", "memory.md"),
    );
    expect(destinationFor("db/talon.db", "/talon", extras)).toBe(
      join("/talon", "data", "talon.db"),
    );
    expect(destinationFor("extra/0/CLAUDE.md", "/talon", extras)).toBe(
      join("/home", "someone", "notes", "CLAUDE.md"),
    );
    // An extra this machine has no mapping for is skipped, not guessed.
    expect(destinationFor("extra/7/x", "/talon", extras)).toBeNull();
  });
});

describe("verifyParts", () => {
  it("refuses a snapshot whose bytes no longer match the manifest", async () => {
    const root = home();
    const manifest = await buildSnapshot({
      kind: "backup",
      settings: SETTINGS,
      home: root,
      copyDatabase,
    });
    await verifyParts(manifest, root); // intact

    writeFileSync(partPath(manifest.id, "state.tar.zst", root), "tampered");
    await expect(verifyParts(manifest, root)).rejects.toThrow(/corrupt/i);
  });
});

describe("restoreSnapshot", () => {
  it("brings the covered paths back and checkpoints what it replaced", async () => {
    const root = home();
    const snapshot = await buildSnapshot({
      kind: "checkpoint",
      label: "known good",
      settings: SETTINGS,
      home: root,
      copyDatabase,
    });

    // Drift: an edit, a deletion, and a file added since the snapshot.
    writeFileSync(join(root, "config.json"), '{"model":"broken"}');
    rmSync(join(root, "workspace", "memory", "memory.md"));
    writeFileSync(
      join(root, "prompts", "stray.md"),
      "added after the snapshot",
    );
    writeFileSync(join(root, "data", "talon.db"), "corrupted database");
    writeFileSync(join(root, "data", "talon.db-wal"), "stale wal");

    const report = await restoreSnapshot({
      id: snapshot.id,
      settings: SETTINGS,
      home: root,
    });

    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(
      '{"model":"original"}',
    );
    expect(
      readFileSync(join(root, "workspace", "memory", "memory.md"), "utf8"),
    ).toBe("original memory");
    // A file the snapshot did not have is gone: the covered roots become
    // exactly the snapshot.
    expect(existsSync(join(root, "prompts", "stray.md"))).toBe(false);
    // The database came from the archive, and its stale sidecar is gone.
    expect(readFileSync(join(root, "data", "talon.db"), "utf8")).toContain(
      "snapshot",
    );
    expect(existsSync(join(root, "data", "talon.db-wal"))).toBe(false);
    // Traces travel in the sessions part and come back with it.
    expect(
      readFileSync(join(root, "data", "traces", "chat.jsonl"), "utf8"),
    ).toBe("trace kept");

    expect(report.databaseReplaced).toBe(true);
    expect(report.checkpointId).toBeDefined();
    const manifests = await listLocalManifests(root);
    const checkpoint = manifests.find((m) => m.id === report.checkpointId);
    expect(checkpoint?.pinned).toBe(true);
    expect(checkpoint?.label).toBe(`pre-restore ${snapshot.id}`);
    // Staging is cleaned up.
    expect(
      existsSync(join(snapshotDir(snapshot.id, root), "restore-staging")),
    ).toBe(false);
  });

  it("restores the palace from its own part", async () => {
    const root = home();
    mkdirSync(join(root, "workspace", "palace", "wing"), { recursive: true });
    writeFileSync(join(root, "workspace", "palace", "wing", "a.json"), "room");
    const snapshot = await buildSnapshot({
      kind: "backup",
      settings: resolveBackupSettings({ includePalace: true }),
      home: root,
      copyDatabase,
    });
    rmSync(join(root, "workspace", "palace"), { recursive: true });
    const report = await restoreSnapshot({
      id: snapshot.id,
      settings: SETTINGS,
      home: root,
      skipCheckpoint: true,
    });
    // The palace is excluded from the state part; its own root must not
    // be filtered by that rule on the way back in.
    expect(
      readFileSync(join(root, "workspace", "palace", "wing", "a.json"), "utf8"),
    ).toBe("room");
    expect(report.written["workspace/palace"]).toBe(1);
  });

  it("refuses an id it has never seen", async () => {
    const root = home();
    await expect(
      restoreSnapshot({
        id: "20260101T000000Z-ffffff",
        settings: SETTINGS,
        home: root,
      }),
    ).rejects.toThrow(/No snapshot/);
  });

  it("closes the database handle before it swaps the file", async () => {
    const root = home();
    const snapshot = await buildSnapshot({
      kind: "backup",
      settings: SETTINGS,
      home: root,
      copyDatabase,
    });
    const order: string[] = [];
    await restoreSnapshot({
      id: snapshot.id,
      settings: SETTINGS,
      home: root,
      skipCheckpoint: true,
      beforeApply: () => {
        order.push("closed");
        // The swap has not happened yet — the live file is still there.
        expect(readFileSync(join(root, "data", "talon.db"), "utf8")).toBe(
          "live database",
        );
      },
    });
    order.push("applied");
    expect(order).toEqual(["closed", "applied"]);
    expect(readFileSync(join(root, "data", "talon.db"), "utf8")).toContain(
      "snapshot",
    );
  });
});

describe("restoring parts fetched from a target", () => {
  /** A target whose only working call is `download`. */
  function downloadingTarget(download: BackupTarget["download"]): BackupTarget {
    const unused = () => Promise.reject(new Error("not used"));
    return {
      id: "drive",
      name: "Drive",
      ready: true,
      upload: unused,
      uploadManifest: unused,
      list: unused,
      remove: unused,
      download,
    };
  }

  it("refetches a part whose earlier download was cut short", async () => {
    const root = home();
    const manifest = await buildSnapshot({
      kind: "backup",
      settings: SETTINGS,
      home: root,
      copyDatabase,
    });
    const state = partPath(manifest.id, "state.tar.zst", root);
    const bytes = readFileSync(state);
    rmSync(state);
    const restore = (target: BackupTarget) =>
      restoreSnapshot({
        id: manifest.id,
        settings: SETTINGS,
        home: root,
        target,
        skipCheckpoint: true,
        allowUnauthenticated: true,
      });

    await expect(
      restore(
        downloadingTarget(async (_id, _part, dest) => {
          writeFileSync(dest, bytes.subarray(0, bytes.length >> 1));
          throw new Error("connection reset");
        }),
      ),
    ).rejects.toThrow(/connection reset/);

    writeFileSync(join(root, "workspace", "memory", "memory.md"), "drifted");
    await restore(
      downloadingTarget(async (_id, _part, dest) => {
        writeFileSync(dest, bytes);
      }),
    );
    expect(
      readFileSync(join(root, "workspace", "memory", "memory.md"), "utf8"),
    ).toBe("original memory");
  });
});
