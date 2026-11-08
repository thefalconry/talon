/**
 * The remote-target protocol, against an in-memory fake.
 *
 * This is the half of the contract Talon owns: the bodies it sends, the
 * shapes it accepts back, the order it sends them in (parts first,
 * manifest last — its presence is what marks a remote snapshot
 * complete), and what it records when a target is missing, not ready,
 * or broken. The Google Drive plugin implements the other half against
 * the same vocabulary; see docs/backups.md.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverTargets,
  selectTargets,
  type TargetDeps,
} from "../core/backup/targets.js";
import { pruneRemote, uploadSnapshot } from "../core/backup/upload.js";
import { snapshotDir } from "../core/backup/store.js";
import { ENCRYPTION_MAGIC } from "../core/backup/archive/crypt.js";
import type { ActionResult } from "../core/types.js";
import type { Manifest } from "../core/backup/types.js";

type Call = { plugin: string; body: Record<string, unknown> };

/** A target plugin that keeps its "remote" in a Map. */
function fakeTarget(
  options: { id?: string; ready?: boolean; failUpload?: boolean } = {},
) {
  const id = options.id ?? "drive";
  const stored = new Map<string, Manifest>();
  const parts = new Map<string, Set<string>>();
  const calls: Call[] = [];
  const dispatch = vi.fn(
    async (plugin: string, body: Record<string, unknown>) => {
      calls.push({ plugin, body });
      const snapshotId = String(body.snapshotId ?? "");
      switch (body.action) {
        case "backup.target.describe":
          return {
            ok: true,
            data: {
              id,
              name: "Google Drive",
              ready: options.ready ?? true,
              ...(options.ready === false ? { detail: "not signed in" } : {}),
            },
          } satisfies ActionResult;
        case "backup.target.upload": {
          if (options.failUpload) return { ok: false, error: "quota exceeded" };
          const part = body.part as {
            name: string;
            sha256: string;
            contentAddressed?: boolean;
          };
          const held = parts.get(snapshotId) ?? new Set<string>();
          const already =
            part.contentAddressed &&
            [...parts.values()].some((names) => names.has(part.name));
          held.add(part.name);
          parts.set(snapshotId, held);
          return {
            ok: true,
            data: {
              remoteId: `remote-${part.name}`,
              ...(already ? { deduplicated: true } : {}),
            },
          };
        }
        case "backup.target.upload_manifest":
          stored.set(snapshotId, body.manifest as Manifest);
          return { ok: true, data: { remoteId: `remote-${snapshotId}` } };
        case "backup.target.list":
          return {
            ok: true,
            data: {
              snapshots: [...stored.entries()].map(([sid, manifest]) => ({
                snapshotId: sid,
                manifest,
                parts: [...(parts.get(sid) ?? [])].map((name) => ({
                  name,
                  remoteId: `remote-${name}`,
                  bytes: 1,
                })),
              })),
            },
          };
        case "backup.target.delete":
          stored.delete(snapshotId);
          parts.delete(snapshotId);
          return { ok: true };
        case "backup.target.download":
          writeFileSync(String(body.destPath), "downloaded");
          return { ok: true };
        default:
          return null;
      }
    },
  );
  const deps: TargetDeps = { plugins: () => ["fake-plugin"], dispatch };
  return { deps, calls, stored, parts, dispatch };
}

function manifestFor(home: string, id: string, pinned = false): Manifest {
  mkdirSync(snapshotDir(id, home), { recursive: true });
  // Uploads refuse plaintext parts; the signature is what they check.
  writeFileSync(
    join(snapshotDir(id, home), "state.tar.zst"),
    Buffer.concat([ENCRYPTION_MAGIC, Buffer.from("part bytes")]),
  );
  return {
    schema: 1,
    id,
    kind: pinned ? "checkpoint" : "backup",
    pinned,
    createdAt: Number(id.slice(9, 15)) || 1,
    host: "test",
    talonVersion: "0.0.0",
    parts: [{ name: "state.tar.zst", bytes: 10, sha256: "a".repeat(64) }],
    includes: ["config.json"],
    excludes: [],
    sizeBytes: 10,
    remote: {},
  };
}

describe("discoverTargets", () => {
  it("adopts a plugin that describes itself and skips everything else", async () => {
    const { deps } = fakeTarget();
    const [target] = await discoverTargets(deps);
    expect(target.id).toBe("drive");
    expect(target.name).toBe("Google Drive");
    expect(target.ready).toBe(true);

    const silent: TargetDeps = {
      plugins: () => ["p"],
      dispatch: async () => null,
    };
    expect(await discoverTargets(silent)).toEqual([]);

    const broken: TargetDeps = {
      plugins: () => ["p"],
      dispatch: async () => ({ ok: false, error: "no credentials" }),
    };
    expect(await discoverTargets(broken)).toEqual([]);

    const nameless: TargetDeps = {
      plugins: () => ["p"],
      dispatch: async () => ({ ok: true, data: { name: "anonymous" } }),
    };
    expect(await discoverTargets(nameless)).toEqual([]);

    const throwing: TargetDeps = {
      plugins: () => ["p"],
      dispatch: async () => {
        throw new Error("plugin exploded");
      },
    };
    expect(await discoverTargets(throwing)).toEqual([]);
  });

  it("honours the configured target list, dropping unknown ids", async () => {
    const { deps } = fakeTarget();
    const available = await discoverTargets(deps);
    expect(selectTargets(available, undefined)).toHaveLength(1);
    expect(selectTargets(available, [])).toHaveLength(0);
    expect(selectTargets(available, ["drive"])).toHaveLength(1);
    expect(selectTargets(available, ["s3"])).toHaveLength(0);
  });
});

describe("uploadSnapshot", () => {
  it("sends every part, then the manifest, and records the result", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-upload-"));
    const fake = fakeTarget();
    const targets = await discoverTargets(fake.deps);
    const manifest = manifestFor(home, "20260101T000001Z-aaaaaa");

    const result = await uploadSnapshot(manifest, targets, home);
    const actions = fake.calls.map((call) => call.body.action);
    expect(actions).toEqual([
      "backup.target.describe",
      "backup.target.upload",
      "backup.target.upload_manifest",
    ]);
    // The upload body carries an absolute path the plugin can stream.
    const upload = fake.calls[1].body.part as { path: string };
    expect(upload.path).toBe(
      join(snapshotDir(manifest.id, home), "state.tar.zst"),
    );
    expect(result.remote.drive.status).toBe("uploaded");
    expect(result.remote.drive.remoteId).toBe(`remote-${manifest.id}`);
    expect(fake.stored.has(manifest.id)).toBe(true);
  });

  it("records a failure per target without failing the backup", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-upload-fail-"));
    const fake = fakeTarget({ failUpload: true });
    const targets = await discoverTargets(fake.deps);
    const manifest = manifestFor(home, "20260101T000002Z-bbbbbb");

    const result = await uploadSnapshot(manifest, targets, home);
    expect(result.remote.drive.status).toBe("failed");
    expect(result.remote.drive.error).toMatch(/quota exceeded/);
    // Nothing was marked complete on the remote.
    expect(fake.stored.size).toBe(0);
  });

  it("leaves a target that is not ready pending, and never uploads to it", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-upload-pending-"));
    const fake = fakeTarget({ ready: false });
    const targets = await discoverTargets(fake.deps);
    const manifest = manifestFor(home, "20260101T000003Z-cccccc");

    const result = await uploadSnapshot(manifest, targets, home);
    expect(result.remote.drive).toEqual({
      status: "pending",
      error: "not signed in",
    });
    expect(fake.calls.map((c) => c.body.action)).toEqual([
      "backup.target.describe",
    ]);
  });
});

const NEWEST = (keepLast: number) => ({
  keepLast,
  keepDaily: 0,
  keepWeekly: 0,
  keepCheckpoints: 10,
});

describe("pruneRemote", () => {
  it("keeps the newest N and every pinned snapshot", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-prune-remote-"));
    const fake = fakeTarget();
    const targets = await discoverTargets(fake.deps);
    for (const [id, pinned] of [
      ["20260101T000010Z-aaaaaa", false],
      ["20260101T000020Z-bbbbbb", true],
      ["20260101T000030Z-cccccc", false],
      ["20260101T000040Z-dddddd", false],
    ] as const) {
      await uploadSnapshot(manifestFor(home, id, pinned), targets, home);
    }
    expect(fake.stored.size).toBe(4);

    await pruneRemote(targets, NEWEST(2));
    expect([...fake.stored.keys()].sort()).toEqual([
      "20260101T000020Z-bbbbbb", // pinned
      "20260101T000030Z-cccccc",
      "20260101T000040Z-dddddd",
    ]);
  });

  it("never prunes an entry whose manifest is unreadable or has no createdAt", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-prune-remote-"));
    const fake = fakeTarget();
    const targets = await discoverTargets(fake.deps);
    for (const id of ["20260101T000030Z-cccccc", "20260101T000040Z-dddddd"]) {
      await uploadSnapshot(manifestFor(home, id), targets, home);
    }
    // A manifest that came back partial: no createdAt, nothing to rank by.
    // `createdAt ?? 0` used to make this look oldest and delete it first.
    fake.stored.set("20260101T000010Z-aaaaaa", {
      id: "20260101T000010Z-aaaaaa",
    } as unknown as Manifest);
    fake.stored.set("20260101T000020Z-bbbbbb", {
      ...manifestFor(home, "20260101T000020Z-bbbbbb"),
      createdAt: Number.NaN,
    });

    await pruneRemote(targets, NEWEST(1));
    expect([...fake.stored.keys()].sort()).toEqual([
      "20260101T000010Z-aaaaaa", // unreadable — kept
      "20260101T000020Z-bbbbbb", // no usable createdAt — kept
      "20260101T000040Z-dddddd", // newest
    ]);
  });

  it("keeps checkpoints on their own budget and the newest verified snapshot", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-prune-remote-"));
    const fake = fakeTarget();
    const targets = await discoverTargets(fake.deps);
    const at = (id: string, patch: Partial<Manifest>) =>
      uploadSnapshot({ ...manifestFor(home, id), ...patch }, targets, home);
    await at("20260101T000010Z-aaaaaa", { verifiedAt: 5 });
    await at("20260101T000020Z-bbbbbb", {});
    await at("20260101T000030Z-cccccc", { kind: "checkpoint" });
    await at("20260101T000040Z-dddddd", {});

    await pruneRemote(targets, NEWEST(1));
    expect([...fake.stored.keys()].sort()).toEqual([
      "20260101T000010Z-aaaaaa", // last verified
      "20260101T000030Z-cccccc", // checkpoint, own budget
      "20260101T000040Z-dddddd", // newest scheduled
    ]);
  });

  it("skips a target it cannot list rather than deleting on partial data", async () => {
    const dispatch = vi.fn(
      async (_plugin: string, body: Record<string, unknown>) =>
        body.action === "backup.target.describe"
          ? { ok: true, data: { id: "drive", name: "Drive", ready: true } }
          : { ok: false, error: "network down" },
    );
    const targets = await discoverTargets({ plugins: () => ["p"], dispatch });
    await pruneRemote(targets, NEWEST(1));
    const deletes = dispatch.mock.calls.filter(
      ([, body]) => body.action === "backup.target.delete",
    );
    expect(deletes).toHaveLength(0);
  });
});

describe("a target that never answers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is dropped from discovery after the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const found = discoverTargets({
      plugins: () => ["hung"],
      dispatch: () => new Promise<never>(() => {}),
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await found).toEqual([]);
  });

  it("fails the upload after the deadline instead of holding the run", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-upload-hung-"));
    const manifest = manifestFor(home, "20260101T000004Z-dddddd");
    let uploading!: () => void;
    const reached = new Promise<void>((resolve) => (uploading = resolve));
    const dispatch = vi.fn(
      async (_plugin: string, body: Record<string, unknown>) => {
        if (body.action === "backup.target.describe") {
          return {
            ok: true,
            data: { id: "drive", name: "Drive", ready: true },
          };
        }
        uploading();
        return new Promise<never>(() => {});
      },
    );
    const targets = await discoverTargets({ plugins: () => ["p"], dispatch });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = uploadSnapshot(manifest, targets, home);
    await reached;
    // Base allowance plus the part's 10 bytes at the floor rate.
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
    const done = await result;
    expect(done.remote.drive.status).toBe("failed");
    expect(done.remote.drive.error).toMatch(
      /drive: upload failed — no answer within 30 min/,
    );
  });
});

describe("download", () => {
  it("asks the target to stream one part to an absolute path", async () => {
    const home = mkdtempSync(join(tmpdir(), "talon-download-"));
    const fake = fakeTarget();
    const [target] = await discoverTargets(fake.deps);
    const dest = join(home, "state.tar.zst");
    await target.download("20260101T000001Z-aaaaaa", "state.tar.zst", dest);
    const call = fake.calls.at(-1)!;
    expect(call.body.action).toBe("backup.target.download");
    expect(call.body.destPath).toBe(dest);
    expect((call.body.part as { name: string }).name).toBe("state.tar.zst");
  });

  it("turns a target error into one classified failure", async () => {
    const dispatch = vi.fn(
      async (_plugin: string, body: Record<string, unknown>) =>
        body.action === "backup.target.describe"
          ? { ok: true, data: { id: "drive", name: "Drive", ready: true } }
          : { ok: false, error: "file not found" },
    );
    const [target] = await discoverTargets({ plugins: () => ["p"], dispatch });
    await expect(
      target.download("20260101T000001Z-aaaaaa", "x", "/tmp/x"),
    ).rejects.toThrow(/drive: download failed — file not found/);
  });
});
