/**
 * Encryption wired through the subsystem: where the passphrase comes
 * from, snapshots written encrypted, restores that decrypt (or refuse
 * and touch nothing), legacy plaintext snapshots that still restore, and
 * the rule that a plaintext snapshot never reaches a remote target.
 * Everything runs in temp directories; no passphrase is ever printed.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEncryptedFile } from "../core/backup/archive/crypt.js";
import { sha256File } from "../core/backup/archive/digest.js";
import {
  PASSPHRASE_ENV,
  generatePassphraseFile,
  resolvePassphrase,
} from "../core/backup/passphrase.js";
import { resolveBackupSettings } from "../core/backup/plan.js";
import { restoreSnapshot, verifyParts } from "../core/backup/restore.js";
import { buildSnapshot } from "../core/backup/snapshot.js";
import { partPath, writeManifest } from "../core/backup/store.js";
import { discoverTargets, type TargetDeps } from "../core/backup/targets.js";
import { PLAINTEXT_REFUSAL, uploadSnapshot } from "../core/backup/upload.js";
import type { BackupSettings } from "../core/backup/types.js";

const PLAIN = resolveBackupSettings({ includePalace: false });
const copyDatabase = (dest: string) =>
  writeFileSync(dest, "SQLite format 3\0snapshot");

afterEach(() => {
  delete process.env[PASSPHRASE_ENV];
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "talon-enc-"));
  mkdirSync(join(root, "workspace", "memory"), { recursive: true });
  writeFileSync(join(root, "config.json"), '{"botToken":"SECRET-TOKEN"}');
  writeFileSync(join(root, "workspace", "memory", "memory.md"), "original");
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "talon.db"), "live database");
  return root;
}

async function keyed(
  root: string,
  name = "backup.key",
): Promise<BackupSettings> {
  const passphraseFile = await generatePassphraseFile(
    join(root, "keys-out", name),
  );
  return resolveBackupSettings({
    includePalace: false,
    encryption: { passphraseFile },
  });
}

function snapshot(root: string, settings: BackupSettings) {
  return buildSnapshot({ kind: "backup", settings, home: root, copyDatabase });
}

describe("resolvePassphrase", () => {
  it("is null when nothing is configured", async () => {
    expect(await resolvePassphrase({}, {})).toBeNull();
  });

  it("prefers the environment, then the file", async () => {
    const root = home();
    const settings = await keyed(root);
    const fromFile = await resolvePassphrase(settings, {});
    expect(fromFile?.length).toBeGreaterThanOrEqual(40);
    const fromEnv = await resolvePassphrase(settings, {
      [PASSPHRASE_ENV]: "an environment passphrase",
    });
    expect(fromEnv).toBe("an environment passphrase");
  });

  it("fails loudly when encryption is configured but unusable", async () => {
    await expect(resolvePassphrase({ encryption: {} }, {})).rejects.toThrow(
      /no passphrase/,
    );
    await expect(
      resolvePassphrase(
        { encryption: { passphraseFile: "/nonexistent/key" } },
        {},
      ),
    ).rejects.toThrow(/Cannot read/);
    await expect(
      resolvePassphrase({}, { [PASSPHRASE_ENV]: "short" }),
    ).rejects.toThrow(/shorter than/);
  });
});

describe("generatePassphraseFile", () => {
  it("writes a mode-600 key and refuses to overwrite it", async () => {
    const root = home();
    const path = await generatePassphraseFile(join(root, "k", "backup.key"));
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const before = readFileSync(path, "utf8");
    await expect(generatePassphraseFile(path)).rejects.toThrow(
      /already exists/,
    );
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("encrypted snapshots", () => {
  it("writes encrypted parts and restores them", async () => {
    const root = home();
    const settings = await keyed(root);
    const manifest = await snapshot(root, settings);
    const [part] = manifest.parts;
    expect(part.name).toBe("state.tar.zst.enc");
    expect(part.encrypted).toBe(true);
    const path = partPath(manifest.id, part.name, root);
    expect(await isEncryptedFile(path)).toBe(true);
    expect(readFileSync(path).includes(Buffer.from("SECRET-TOKEN"))).toBe(
      false,
    );

    writeFileSync(join(root, "workspace", "memory", "memory.md"), "drifted");
    await restoreSnapshot({ id: manifest.id, settings, home: root });
    expect(
      readFileSync(join(root, "workspace", "memory", "memory.md"), "utf8"),
    ).toBe("original");
  });

  it("fails a snapshot rather than writing plaintext when the key is missing", async () => {
    const root = home();
    await expect(
      snapshot(root, resolveBackupSettings({ encryption: {} })),
    ).rejects.toThrow(/no passphrase/);
  });

  it("refuses a wrong passphrase and extracts nothing", async () => {
    const root = home();
    const manifest = await snapshot(root, await keyed(root));
    writeFileSync(join(root, "workspace", "memory", "memory.md"), "drifted");
    const wrong = await keyed(root, "other.key");
    await expect(
      restoreSnapshot({ id: manifest.id, settings: wrong, home: root }),
    ).rejects.toThrow(/wrong passphrase/);
    expect(
      readFileSync(join(root, "workspace", "memory", "memory.md"), "utf8"),
    ).toBe("drifted");
    // Not even a staging tree or a pre-restore checkpoint was produced.
    expect(
      existsSync(join(root, "backups", manifest.id, "restore-staging")),
    ).toBe(false);
  });

  it("refuses a restore with no passphrase at all", async () => {
    const root = home();
    const manifest = await snapshot(root, await keyed(root));
    await expect(verifyParts(manifest, root, {})).rejects.toThrow(
      /is encrypted/,
    );
  });

  it("refuses a tampered byte even when the manifest digest was updated too", async () => {
    const root = home();
    const settings = await keyed(root);
    const manifest = await snapshot(root, settings);
    const path = partPath(manifest.id, manifest.parts[0].name, root);
    const bytes = readFileSync(path);
    bytes[bytes.length - 30] ^= 0x01;
    writeFileSync(path, bytes);
    manifest.parts[0].sha256 = await sha256File(path);
    await writeManifest(manifest, root);
    // The digest is covered by the manifest's MAC, so the rewrite itself
    // is caught first…
    await expect(
      restoreSnapshot({ id: manifest.id, settings, home: root }),
    ).rejects.toThrow(/manifest authentication failed/);
    // …and the part check refuses the byte on its own as well.
    await expect(verifyParts(manifest, root, settings)).rejects.toThrow(
      /cannot be decrypted/,
    );
  });

  it("still restores a plaintext snapshot taken before encryption was on", async () => {
    const root = home();
    const legacy = await snapshot(root, PLAIN);
    expect(legacy.parts[0].name).toBe("state.tar.zst");
    writeFileSync(join(root, "workspace", "memory", "memory.md"), "drifted");
    // With a passphrase configured, an unsigned manifest needs the
    // operator's explicit say-so (it is what a stripped MAC looks like).
    const settings = await keyed(root);
    await expect(
      restoreSnapshot({
        id: legacy.id,
        settings,
        home: root,
        skipCheckpoint: true,
      }),
    ).rejects.toThrow(/allow-unauthenticated/);
    await restoreSnapshot({
      id: legacy.id,
      settings,
      home: root,
      skipCheckpoint: true,
      allowUnauthenticated: true,
    });
    expect(
      readFileSync(join(root, "workspace", "memory", "memory.md"), "utf8"),
    ).toBe("original");
  });

  it("re-encrypts the palace instead of reusing it under an old key", async () => {
    const root = home();
    mkdirSync(join(root, "workspace", "palace"), { recursive: true });
    writeFileSync(join(root, "workspace", "palace", "room.md"), "palace");
    const first = await keyed(root);
    const withPalace = (s: BackupSettings) => ({ ...s, includePalace: true });
    const a = await snapshot(root, withPalace(first));
    const b = await snapshot(root, withPalace(first));
    const palace = (m: typeof a) =>
      m.parts.find((p) => p.name.startsWith("palace-"))!;
    expect(palace(b).sha256).toBe(palace(a).sha256); // reused, same key

    const c = await snapshot(
      root,
      withPalace(await keyed(root, "rotated.key")),
    );
    expect(palace(c).name).toBe(palace(a).name);
    expect(palace(c).sha256).not.toBe(palace(a).sha256); // re-encrypted
  }, 60_000);
});

describe("remote targets", () => {
  function fakeTarget() {
    const actions: string[] = [];
    const deps: TargetDeps = {
      plugins: () => ["drive-plugin"],
      dispatch: async (_plugin, body) => {
        actions.push(String(body.action));
        if (body.action === "backup.target.describe") {
          return { ok: true, data: { id: "drive", ready: true } };
        }
        return { ok: true, data: { remoteId: "r" } };
      },
    };
    return { deps, actions };
  }

  it("refuses to upload a plaintext snapshot", async () => {
    const root = home();
    const manifest = await snapshot(root, PLAIN);
    const fake = fakeTarget();
    const result = await uploadSnapshot(
      manifest,
      await discoverTargets(fake.deps),
      root,
    );
    expect(result.remote.drive.status).toBe("failed");
    expect(result.remote.drive.error).toContain(PLAINTEXT_REFUSAL);
    expect(fake.actions).toEqual(["backup.target.describe"]);
  });

  it("uploads an encrypted snapshot", async () => {
    const root = home();
    const manifest = await snapshot(root, await keyed(root));
    const fake = fakeTarget();
    const result = await uploadSnapshot(
      manifest,
      await discoverTargets(fake.deps),
      root,
    );
    expect(result.remote.drive.status).toBe("uploaded");
    expect(fake.actions).toContain("backup.target.upload");
  });
});
