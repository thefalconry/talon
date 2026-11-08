/**
 * The per-device credential token format.
 *
 *   tdc1.<id: 16 hex>.<secret: 32 random bytes, base64url>
 *
 * The id lets the daemon find the row without a table scan and is safe to
 * log; the secret is 256 bits, so a plain SHA-256 is the right hash (a slow
 * KDF buys nothing against a secret that was never guessable). The prefix
 * makes the credential kind self-describing: clients use it to tell a
 * per-device credential from the shared legacy token without asking.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "tdc1";
const TOKEN_RE = /^tdc1\.([0-9a-f]{16})\.[A-Za-z0-9_-]{43}$/;

export type MintedToken = { id: string; token: string; tokenHash: string };

export function mintCredentialToken(): MintedToken {
  const id = randomBytes(8).toString("hex");
  const token = `${PREFIX}.${id}.${randomBytes(32).toString("base64url")}`;
  return { id, token, tokenHash: hashCredentialToken(token) };
}

/** The credential id a well-formed token names, or null for anything else. */
export function credentialIdOf(token: string): string | null {
  return TOKEN_RE.exec(token)?.[1] ?? null;
}

/** True when `token` has the per-device credential shape (not the shared token). */
export function isDeviceCredentialToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function hashCredentialToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two hex digests of equal length. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
