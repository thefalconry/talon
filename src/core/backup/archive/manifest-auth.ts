/**
 * Manifest authentication — proof that a manifest was written by someone
 * holding the backup passphrase.
 *
 * Every encrypted part authenticates itself, but the manifest decides
 * which parts a restore extracts, where the `extra/<n>` trees land and
 * which digests count as "correct". It travels with the parts to every
 * remote target, so whoever controls the remote controls the manifest:
 * without a MAC they could drop the state part, re-point an extra path,
 * or swap an encrypted part for a plaintext one of their own and fix the
 * digest to match.
 *
 * The MAC is HMAC-SHA256 under a scrypt-derived key (fresh salt per
 * manifest, parameters stored beside it) over a canonical JSON encoding
 * of every field except the ones that legitimately change after the
 * snapshot is written — `pinned` and the per-target `remote` map — and
 * the `auth` block itself.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Manifest, ManifestAuth } from "../types.js";
import {
  DEFAULT_SCRYPT,
  deriveScryptKey,
  scryptParamsInRange,
  type ScryptParams,
} from "./crypt.js";

const SALT_BYTES = 16;
/** Domain separation: this key signs manifests and nothing else. */
const CONTEXT = "talon-backup-manifest-v1\0";

/** JSON with object keys sorted at every depth and undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The bytes the MAC covers: everything that must not change after writing. */
function signedBytes(manifest: Manifest): Buffer {
  const {
    remote: _remote,
    pinned: _pinned,
    auth: _auth,
    ...covered
  } = manifest;
  return Buffer.from(CONTEXT + canonicalJson(covered), "utf8");
}

function mac(key: Buffer, manifest: Manifest): Buffer {
  return createHmac("sha256", key).update(signedBytes(manifest)).digest();
}

/** A fresh `auth` block for this manifest under this passphrase. */
export async function signManifest(
  manifest: Manifest,
  passphrase: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<ManifestAuth> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveScryptKey(passphrase, salt, params);
  return {
    v: 1,
    alg: "hmac-sha256",
    kdf: "scrypt",
    ...params,
    salt: salt.toString("base64"),
    mac: mac(key, manifest).toString("base64"),
  };
}

/**
 * True only when the manifest carries a well-formed `auth` block whose MAC
 * verifies under this passphrase. Any malformed field is a failure, never
 * an exception — the caller decides what an unauthenticated manifest means.
 */
export async function verifyManifest(
  manifest: Manifest,
  passphrase: string,
): Promise<boolean> {
  const auth = manifest.auth;
  if (!auth || auth.v !== 1 || auth.alg !== "hmac-sha256") return false;
  if (auth.kdf !== "scrypt" || !scryptParamsInRange(auth)) return false;
  const salt = Buffer.from(String(auth.salt), "base64");
  const expected = Buffer.from(String(auth.mac), "base64");
  if (salt.length !== SALT_BYTES || expected.length !== 32) return false;
  const key = await deriveScryptKey(passphrase, salt, auth);
  return timingSafeEqual(mac(key, manifest), expected);
}
