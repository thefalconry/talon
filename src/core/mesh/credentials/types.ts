/**
 * Per-device mesh credentials — the shapes.
 *
 * A credential is a bearer secret the daemon mints for ONE device (or, for a
 * pairing link that has not been redeemed yet, for whichever device first
 * names itself with it) and a set of scopes. The daemon keeps only a hash of
 * the secret plus the metadata below; the plaintext exists once, in the reply
 * or link that hands it to the device.
 *
 * Scopes (see docs/mesh-credentials.md):
 *
 *   device    register/heartbeat/report as ITSELF, receive and answer its
 *             own commands, move the files the daemon asked it to move.
 *   client    the chat UI: chats, history, search, sending, non-secret
 *             settings reads, the device list.
 *   operator  config and extension writes, daemon control, logs.
 *
 * The shared `native.token` (legacy) and an open loopback bridge carry every
 * scope — that is what they meant before per-device credentials existed.
 */

const MESH_SCOPES = ["device", "client", "operator"] as const;
export type MeshScope = (typeof MESH_SCOPES)[number];

/**
 * What a paired or upgraded companion gets unless the operator narrows it
 * (`native.companionScopes`): everything, as with the shared token.
 */
export const DEFAULT_COMPANION_SCOPES: readonly MeshScope[] = [
  "device",
  "client",
  "operator",
];

/**
 * The companion default before `operator` joined it. Credentials still
 * holding exactly this (and never set by hand) are moved to the current
 * default on startup — see `DeviceCredentialStore.adoptDefaultScopes`.
 */
export const FORMER_COMPANION_SCOPES: readonly MeshScope[] = [
  "device",
  "client",
];

/** A headless talon-node is a device and nothing else. */
export const NODE_SCOPES: readonly MeshScope[] = ["device"];

/** How a credential came to exist — for the audit trail and `talon mesh`. */
export type CredentialOrigin =
  /** Minted into a companion pairing link. */
  | "pair"
  /** Minted into a talon-node installer. */
  | "install"
  /** Swapped in-band for the shared legacy token. */
  | "upgrade"
  /** Re-issued to a device that already held a per-device credential. */
  | "rotate";

/** The persisted row. `tokenHash` never leaves the store. */
export type DeviceCredentialRecord = {
  /** Public id — the middle segment of the token; safe to log and show. */
  id: string;
  /**
   * The device this credential acts as. Null until a pairing/installer
   * credential is first used: the first device id it names binds it for
   * good (and an id another live credential already holds is refused).
   */
  deviceId: string | null;
  /** Hex SHA-256 of the whole token. */
  tokenHash: string;
  scopes: MeshScope[];
  /**
   * When an operator last set this device's scopes by hand (`talon mesh
   * scopes`). Such a credential keeps its scopes when a default changes.
   */
  scopesSetAt?: number;
  origin: CredentialOrigin;
  createdAt: number;
  lastUsedAt?: number;
  /** Hard stop: an unbound credential's bind deadline, or a rotation's grace. */
  expiresAt?: number;
  /** Operator asked (`talon mesh rotate`) for this credential to be replaced. */
  rotateRequestedAt?: number;
  /**
   * The credential that replaces this one. It stays valid until the
   * replacement is first used — so a device that never received its new
   * token (a dropped reply) is not locked out — and is revoked then.
   */
  supersededBy?: string;
  revokedAt?: number;
  revokeReason?: string;
};

/** The view everything outside the store sees. */
export type DeviceCredential = Omit<DeviceCredentialRecord, "tokenHash">;

/** Parse an untrusted scope list: known names only, canonical order, no dupes. */
export function normalizeScopes(value: unknown): MeshScope[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.filter((v) => typeof v === "string"));
  return MESH_SCOPES.filter((scope) => wanted.has(scope));
}
