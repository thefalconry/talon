/**
 * Boot-time upgrade checkpoint — the first boot of a new version takes a
 * pinned `pre-upgrade <old>→<new>` snapshot before anything else touches
 * the data, and a failed one alerts but never stops the boot.
 *
 * Every case runs against a scratch Talon home and a scratch database
 * file; nothing here resolves the real ~/.talon.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointOnVersionChange,
  readLastBootVersion,
  recordBootVersion,
  bootVersionMarkerPath,
  UPGRADE_CHECKPOINT_ALERT,
} from "../core/backup/boot/version-checkpoint.js";
import { buildSnapshot } from "../core/backup/snapshot.js";
import { extractTar } from "../core/backup/archive/tar.js";
import { createDecompressor } from "../core/backup/archive/zstd.js";
import { readManifest, snapshotDir } from "../core/backup/store.js";
import { DEFAULT_WORKSPACE_INCLUDE } from "../core/backup/plan.js";
import type { BackupSettings, Manifest } from "../core/backup/types.js";

const SETTINGS: BackupSettings = {
  enabled: true,
  intervalHours: 6,
  keepLocal: 12,
  keepRemote: 30,
  keepDaily: 7,
  keepWeekly: 4,
  keepCheckpoints: 10,
  includePalace: false,
  loginSessions: "local",
  includeSessions: false,
  workspaceInclude: DEFAULT_WORKSPACE_INCLUDE,
  extraPaths: [],
  checkpointBeforeUpdate: true,
};

const scratch: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "talon-upgrade-ckpt-"));
  scratch.push(home);
  mkdirSync(join(home, "data"), { recursive: true });
  mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  writeFileSync(join(home, "config.json"), "{}");
  writeFileSync(join(home, "workspace", "memory", "memory.md"), "remembered");
  return home;
}

/** A real SQLite file holding one history row, as an old version left it. */
function oldDatabase(home: string): string {
  const path = join(home, "data", "talon.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE history_messages (chat_id TEXT, text TEXT)");
  db.prepare("INSERT INTO history_messages VALUES (?, ?)").run("c1", "hi");
  db.close();
  return path;
}

function writeMarker(home: string, version: string): void {
  writeFileSync(
    bootVersionMarkerPath(home),
    JSON.stringify({ version, bootedAt: "2026-09-01T00:00:00.000Z" }),
  );
}

function fakeManifest(id: string): Manifest {
  return { id } as unknown as Manifest;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("checkpointOnVersionChange", () => {
  it("takes a pinned pre-upgrade checkpoint when the version changed", async () => {
    const home = tempHome();
    const databaseFile = oldDatabase(home);
    writeMarker(home, "5.25.0");
    const build = vi.fn(async () => fakeManifest("ckpt-1"));
    const result = await checkpointOnVersionChange({
      settings: SETTINGS,
      version: "5.26.0",
      home,
      databaseFile,
      build,
    });
    expect(result).toEqual({
      status: "taken",
      id: "ckpt-1",
      from: "5.25.0",
      to: "5.26.0",
    });
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "checkpoint",
        label: "pre-upgrade 5.25.0→5.26.0",
        pinned: true,
        home,
        // Transcripts would hold the boot for minutes; only state + db go in.
        settings: expect.objectContaining({ includeSessions: false }),
      }),
    );
    expect(await readLastBootVersion(home)).toBe("5.26.0");
  });

  it("skips the boot checkpoint once /update has recorded the version", async () => {
    const home = tempHome();
    const databaseFile = oldDatabase(home);
    writeMarker(home, "5.25.0");
    await recordBootVersion("5.26.0", home);
    const build = vi.fn();
    const result = await checkpointOnVersionChange({
      settings: SETTINGS,
      version: "5.26.0",
      home,
      databaseFile,
      build,
    });
    expect(result).toEqual({ status: "unchanged", version: "5.26.0" });
    expect(build).not.toHaveBeenCalled();
  });

  it("does nothing when the same version boots again", async () => {
    const home = tempHome();
    writeMarker(home, "5.26.0");
    const build = vi.fn();
    const result = await checkpointOnVersionChange({
      settings: SETTINGS,
      version: "5.26.0",
      home,
      databaseFile: oldDatabase(home),
      build,
    });
    expect(result.status).toBe("unchanged");
    expect(build).not.toHaveBeenCalled();
  });

  it("records the version on a fresh install without a checkpoint", async () => {
    const home = tempHome();
    const build = vi.fn();
    const result = await checkpointOnVersionChange({
      settings: SETTINGS,
      version: "5.26.0",
      home,
      databaseFile: join(home, "data", "talon.db"),
      build,
    });
    expect(result.status).toBe("fresh-install");
    expect(build).not.toHaveBeenCalled();
    expect(await readLastBootVersion(home)).toBe("5.26.0");
  });

  it("checkpoints an existing install that predates the marker", async () => {
    const home = tempHome();
    const build = vi.fn(async () => fakeManifest("ckpt-2"));
    const result = await checkpointOnVersionChange({
      settings: SETTINGS,
      version: "5.26.0",
      home,
      databaseFile: oldDatabase(home),
      build,
    });
    expect(result).toMatchObject({ status: "taken", from: "unknown" });
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({ label: "pre-upgrade unknown→5.26.0" }),
    );
  });

  it("respects backup.checkpointBeforeUpdate=false", async () => {
    const home = tempHome();
    writeMarker(home, "5.25.0");
    const build = vi.fn();
    const result = await checkpointOnVersionChange({
      settings: { ...SETTINGS, checkpointBeforeUpdate: false },
      version: "5.26.0",
      home,
      databaseFile: oldDatabase(home),
      build,
    });
    expect(result.status).toBe("disabled");
    expect(build).not.toHaveBeenCalled();
    expect(await readLastBootVersion(home)).toBe("5.26.0");
  });

  it("alerts on failure, never throws, and retries on the next boot", async () => {
    const home = tempHome();
    writeMarker(home, "5.25.0");
    const alert = vi.fn();
    const build = vi.fn(async () => {
      throw new Error("Cannot read backup.encryption.passphraseFile");
    });
    const result = await checkpointOnVersionChange({
      settings: SETTINGS,
      version: "5.26.0",
      home,
      databaseFile: oldDatabase(home),
      build,
      alert,
    });
    expect(result).toMatchObject({
      status: "failed",
      from: "5.25.0",
      to: "5.26.0",
    });
    expect(alert).toHaveBeenCalledWith(
      UPGRADE_CHECKPOINT_ALERT,
      expect.stringContaining("passphraseFile"),
      { severity: "critical" },
    );
    // The marker did not advance: the next boot tries again.
    expect(await readLastBootVersion(home)).toBe("5.25.0");
  });

  it("builds a real pinned snapshot holding the old database", async () => {
    const home = tempHome();
    const databaseFile = oldDatabase(home);
    writeMarker(home, "5.25.0");
    const result = await checkpointOnVersionChange({
      settings: SETTINGS,
      version: "5.26.0",
      home,
      databaseFile,
      build: buildSnapshot,
    });
    expect(result.status).toBe("taken");
    if (result.status !== "taken") return;
    const manifest = await readManifest(result.id, home);
    expect(manifest?.pinned).toBe(true);
    expect(manifest?.kind).toBe("checkpoint");
    expect(manifest?.label).toBe("pre-upgrade 5.25.0→5.26.0");
    // The captured database is the old version's, row for row.
    const out = mkdtempSync(join(tmpdir(), "talon-upgrade-x-"));
    scratch.push(out);
    await extractTar(
      createReadStream(
        join(snapshotDir(result.id, home), "state.tar.zst"),
      ).pipe(createDecompressor()),
      out,
    );
    const copy = new DatabaseSync(join(out, "db", "talon.db"));
    expect(copy.prepare("SELECT text FROM history_messages").all()).toEqual([
      { text: "hi" },
    ]);
    copy.close();
    expect(
      JSON.parse(readFileSync(bootVersionMarkerPath(home), "utf8")).version,
    ).toBe("5.26.0");
  });
});

describe("boot order", () => {
  it("takes the upgrade checkpoint before bootstrap and the chat reconcile", () => {
    const app = readFileSync(join(import.meta.dirname, "..", "app.ts"), "utf8");
    const checkpoint = app.indexOf('bootPhase("upgrade checkpoint"');
    const bootstrap = app.indexOf('bootPhase("bootstrap"');
    const backend = app.indexOf('bootPhase("backend + dispatcher"');
    const restore = app.indexOf('bootPhase("staged restore"');
    expect(checkpoint).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(checkpoint);
    expect(checkpoint).toBeLessThan(bootstrap);
    expect(bootstrap).toBeLessThan(backend);
    // A failed checkpoint makes this boot skip its destructive steps.
    expect(app).toMatch(/skipDestructiveSteps: !upgrade\.safe/);
  });
});
