/**
 * Backup hardening (#1047, #1044): signed manifests, the downgrade guard
 * for unsigned ones, login sessions kept off remote targets, the key file
 * kept out of every part, owner-only modes after a restore, and the
 * palace part actually being applied.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecrypted } from "../core/backup/archive/crypt.js";
import {
  canonicalJson,
  signManifest,
  verifyManifest,
} from "../core/backup/archive/manifest-auth.js";
import { createDecompressor } from "../core/backup/archive/zstd.js";
import {
  PASSPHRASE_ENV,
  generatePassphraseFile,
  resolvePassphrase,
} from "../core/backup/passphrase.js";
import { resolveBackupSettings } from "../core/backup/plan.js";
import { restoreSnapshot, verifyParts } from "../core/backup/restore.js";
import {
  authenticateManifest,
  privateFileMode,
} from "../core/backup/restore/guard.js";
import { buildSnapshot } from "../core/backup/snapshot.js";
import { partPath, writeManifest } from "../core/backup/store.js";
import { discoverTargets, type TargetDeps } from "../core/backup/targets.js";
import { uploadSnapshot } from "../core/backup/upload.js";
import type { BackupSettings, Manifest } from "../core/backup/types.js";

const POSIX = process.platform !== "win32";
const copyDatabase = (dest: string) =>
  writeFileSync(dest, "SQLite format 3\0snapshot");

afterEach(() => {
  delete process.env[PASSPHRASE_ENV];
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "talon-harden-"));
  mkdirSync(join(root, "workspace", "memory"), { recursive: true });
  writeFileSync(join(root, "config.json"), '{"botToken":"SECRET-TOKEN"}');
  writeFileSync(join(root, "workspace", "memory", "memory.md"), "original");
  mkdirSync(join(root, "whatsapp-auth"), { recursive: true });
  writeFileSync(join(root, "whatsapp-auth", "creds.json"), "WA-SESSION");
  writeFileSync(join(root, ".user-session"), "USERBOT-SESSION");
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "talon.db"), "live database");
  return root;
}

async function keyed(
  root: string,
  extra: Partial<BackupSettings> = {},
  name = "backup.key",
): Promise<BackupSettings> {
  const passphraseFile = await generatePassphraseFile(
    join(root, "keys-out", name),
  );
  return resolveBackupSettings({
    includePalace: false,
    encryption: { passphraseFile },
    ...extra,
  });
}

function snapshot(root: string, settings: BackupSettings) {
  return buildSnapshot({ kind: "backup", settings, home: root, copyDatabase });
}

/** Every byte of a part's decrypted (and decompressed) tar stream. */
async function partText(
  root: string,
  manifest: Manifest,
  name: string,
  settings: BackupSettings,
): Promise<string> {
  const passphrase = (await resolvePassphrase(settings))!;
  const stream = (
    await openDecrypted(partPath(manifest.id, name, root), passphrase)
  ).pipe(createDecompressor());
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("latin1");
}

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }),
    ).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});

describe("manifest signatures", () => {
  it("signs every snapshot taken with a passphrase", async () => {
    const root = home();
    const settings = await keyed(root);
    const manifest = await snapshot(root, settings);
    expect(manifest.auth?.alg).toBe("hmac-sha256");
    const passphrase = (await resolvePassphrase(settings))!;
    expect(await verifyManifest(manifest, passphrase)).toBe(true);
    // Pin state and upload status change after writing; they are not signed.
    manifest.pinned = true;
    manifest.remote.drive = { status: "uploaded", remoteId: "x" };
    expect(await verifyManifest(manifest, passphrase)).toBe(true);
    expect(await verifyManifest(manifest, "a different passphrase")).toBe(
      false,
    );
  });

  it("refuses a restore when the manifest was edited", async () => {
    const root = home();
    const settings = await keyed(root);
    const manifest = await snapshot(root, settings);
    manifest.extras = [{ n: 0, source: "/etc" }];
    await writeManifest(manifest, root);
    writeFileSync(join(root, "workspace", "memory", "memory.md"), "drifted");
    await expect(
      restoreSnapshot({ id: manifest.id, settings, home: root }),
    ).rejects.toThrow(/manifest authentication failed/);
    expect(
      readFileSync(join(root, "workspace", "memory", "memory.md"), "utf8"),
    ).toBe("drifted");
  });

  it("refuses a signed manifest when no passphrase is configured", async () => {
    const root = home();
    const manifest = await snapshot(root, await keyed(root));
    await expect(authenticateManifest(manifest, {})).rejects.toThrow(
      /signed with a backup passphrase/,
    );
  });

  it("refuses a manifest whose signature was stripped", async () => {
    const root = home();
    const settings = await keyed(root);
    const manifest = await snapshot(root, settings);
    delete manifest.auth;
    await writeManifest(manifest, root);
    await expect(
      restoreSnapshot({ id: manifest.id, settings, home: root }),
    ).rejects.toThrow(/no manifest signature/);
  });

  it("refuses a plaintext part under a signed manifest", async () => {
    const root = home();
    const settings = await keyed(root);
    const signed = await snapshot(root, settings);
    const plain = await snapshot(
      root,
      resolveBackupSettings({ includePalace: false }),
    );
    // A key holder re-signing a manifest that points at a plaintext part:
    // the part check still insists on encryption.
    const swapped: Manifest = {
      ...plain,
      auth: undefined,
    };
    swapped.auth = await signManifest(
      swapped,
      (await resolvePassphrase(settings))!,
    );
    await expect(verifyParts(swapped, root, settings)).rejects.toThrow(
      /not encrypted although its manifest is signed/,
    );
    expect(signed.parts.every((part) => part.encrypted)).toBe(true);
  });

  it("restores an unsigned legacy snapshot when no key is configured, but not from a remote", async () => {
    const root = home();
    const legacy = await snapshot(
      root,
      resolveBackupSettings({ includePalace: false }),
    );
    await expect(authenticateManifest(legacy, {})).resolves.toBe(false);
    await expect(
      authenticateManifest(legacy, {}, { fromRemote: true }),
    ).rejects.toThrow(/remote target/);
    await expect(
      authenticateManifest(
        legacy,
        {},
        { fromRemote: true, allowUnauthenticated: true },
      ),
    ).resolves.toBe(false);
  });
});

describe("login sessions", () => {
  it("go into their own local-only part by default", async () => {
    const root = home();
    const settings = await keyed(root);
    const manifest = await snapshot(root, settings);
    const logins = manifest.parts.find((p) => p.name.startsWith("logins"));
    expect(logins).toMatchObject({
      name: "logins.tar.zst.enc",
      encrypted: true,
      localOnly: true,
    });
    const state = await partText(
      root,
      manifest,
      manifest.parts[0].name,
      settings,
    );
    expect(state).toContain("SECRET-TOKEN");
    expect(state).not.toContain("WA-SESSION");
    expect(state).not.toContain("USERBOT-SESSION");
    const sessions = await partText(root, manifest, logins!.name, settings);
    expect(sessions).toContain("WA-SESSION");
    expect(sessions).toContain("USERBOT-SESSION");
  });

  it("are left out entirely with loginSessions: off, and shipped with remote", async () => {
    const root = home();
    const off = await snapshot(
      root,
      await keyed(root, { loginSessions: "off" }),
    );
    expect(off.parts.map((p) => p.name)).toEqual(["state.tar.zst.enc"]);
    expect(off.includes).not.toContain("whatsapp-auth");
    const remote = await snapshot(
      root,
      await keyed(root, { loginSessions: "remote" }, "k2"),
    );
    const logins = remote.parts.find((p) => p.name.startsWith("logins"));
    expect(logins?.localOnly).toBeUndefined();
  });

  it("are never offered to a remote target unless opted in", async () => {
    const root = home();
    const manifest = await snapshot(root, await keyed(root));
    const uploaded: string[] = [];
    const deps: TargetDeps = {
      plugins: () => ["drive-plugin"],
      dispatch: async (_plugin, body) => {
        if (body.action === "backup.target.describe") {
          return { ok: true, data: { id: "drive", ready: true } };
        }
        if (body.action === "backup.target.upload") {
          uploaded.push(String((body.part as { name: string }).name));
        }
        return { ok: true, data: { remoteId: "r" } };
      },
    };
    const result = await uploadSnapshot(
      manifest,
      await discoverTargets(deps),
      root,
    );
    expect(result.remote.drive.status).toBe("uploaded");
    expect(uploaded).toEqual(["state.tar.zst.enc"]);
  });

  it("a restore from a remote copy goes on without the local-only part", async () => {
    const root = home();
    const settings = await keyed(root);
    const manifest = await snapshot(root, settings);
    const logins = manifest.parts.find((p) => p.localOnly)!;
    rmSync(partPath(manifest.id, logins.name, root));
    writeFileSync(join(root, "workspace", "memory", "memory.md"), "drifted");
    writeFileSync(join(root, ".user-session"), "CURRENT-SESSION");
    await restoreSnapshot({
      id: manifest.id,
      settings,
      home: root,
      skipCheckpoint: true,
    });
    expect(
      readFileSync(join(root, "workspace", "memory", "memory.md"), "utf8"),
    ).toBe("original");
    // Nothing to restore it from — the live session is left alone.
    expect(readFileSync(join(root, ".user-session"), "utf8")).toBe(
      "CURRENT-SESSION",
    );
  });
});

describe("the passphrase file", () => {
  it("is never captured, even when it sits in a backed-up folder", async () => {
    const root = home();
    const passphraseFile = await generatePassphraseFile(
      join(root, "workspace", "secrets", "backup.key"),
    );
    writeFileSync(join(root, "workspace", "secrets", "api.txt"), "API-KEY");
    const settings = resolveBackupSettings({
      includePalace: false,
      encryption: { passphraseFile },
    });
    const passphrase = readFileSync(passphraseFile, "utf8").trim();
    const manifest = await snapshot(root, settings);
    const state = await partText(
      root,
      manifest,
      manifest.parts[0].name,
      settings,
    );
    expect(state).toContain("API-KEY");
    expect(state).not.toContain("workspace/secrets/backup.key");
    expect(state).not.toContain(passphrase);
  });
});

describe("restored file modes", () => {
  it.skipIf(!POSIX)(
    "are owner-only whatever they were archived with",
    async () => {
      const root = home();
      chmodSync(join(root, "config.json"), 0o644);
      mkdirSync(join(root, "workspace", "scripts"), { recursive: true });
      writeFileSync(
        join(root, "workspace", "scripts", "run.sh"),
        "#!/bin/sh\n",
      );
      chmodSync(join(root, "workspace", "scripts", "run.sh"), 0o755);
      chmodSync(join(root, "workspace", "memory"), 0o755);
      const settings = await keyed(root);
      const manifest = await snapshot(root, settings);
      for (const name of [
        "manifest.json",
        ...manifest.parts.map((p) => p.name),
      ]) {
        expect(
          statSync(join(root, "backups", manifest.id, name)).mode & 0o777,
        ).toBe(0o600);
      }
      expect(statSync(join(root, "backups", manifest.id)).mode & 0o777).toBe(
        0o700,
      );
      await restoreSnapshot({
        id: manifest.id,
        settings,
        home: root,
        skipCheckpoint: true,
      });
      const mode = (path: string) => statSync(join(root, path)).mode & 0o777;
      expect(mode("config.json")).toBe(0o600);
      expect(mode("workspace/scripts/run.sh")).toBe(0o700);
      expect(mode("workspace/memory")).toBe(0o700);
      expect(mode("whatsapp-auth/creds.json")).toBe(0o600);
      expect(mode("data/talon.db")).toBe(0o600);
    },
  );

  it("keeps the owner's execute bit and nothing else", () => {
    expect(privateFileMode(0o644)).toBe(0o600);
    expect(privateFileMode(0o755)).toBe(0o700);
    expect(privateFileMode(0o400)).toBe(0o600);
  });
});

describe("the palace part (#1044)", () => {
  it("is applied by a restore, not just extracted", async () => {
    const root = home();
    mkdirSync(join(root, "workspace", "palace", "wing"), { recursive: true });
    writeFileSync(join(root, "workspace", "palace", "wing", "room.md"), "v1");
    const settings = await keyed(root, { includePalace: true });
    const manifest = await snapshot(root, settings);
    rmSync(join(root, "workspace", "palace"), { recursive: true });
    await restoreSnapshot({
      id: manifest.id,
      settings,
      home: root,
      skipCheckpoint: true,
    });
    expect(
      readFileSync(
        join(root, "workspace", "palace", "wing", "room.md"),
        "utf8",
      ),
    ).toBe("v1");
  });

  it("is applied even when an older manifest did not list it", async () => {
    const root = home();
    mkdirSync(join(root, "workspace", "palace"), { recursive: true });
    writeFileSync(join(root, "workspace", "palace", "room.md"), "old");
    const legacy = await snapshot(
      root,
      resolveBackupSettings({ includePalace: true }),
    );
    legacy.includes = legacy.includes.filter((r) => r !== "workspace/palace");
    await writeManifest(legacy, root);
    rmSync(join(root, "workspace", "palace"), { recursive: true });
    await restoreSnapshot({
      id: legacy.id,
      settings: resolveBackupSettings({ includePalace: true }),
      home: root,
      skipCheckpoint: true,
    });
    expect(existsSync(join(root, "workspace", "palace", "room.md"))).toBe(true);
  });
});
