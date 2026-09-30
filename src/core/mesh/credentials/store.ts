/**
 * DeviceCredentialStore — per-device bearer credentials for the mesh.
 *
 * Persists `{id, deviceId, tokenHash, scopes, …}` rows to a 0600 sidecar
 * next to the device registry (~/.talon/mesh-credentials.json). Plaintext
 * tokens are returned exactly once, from `mint`, and never stored.
 *
 * Lifecycle of a credential:
 *
 *   mint ──► (unbound: first device id it names binds it; expires unbound)
 *        ──► active ──► superseded (new one minted; revoked on the new one's
 *                       first use, so a lost reply never locks a device out)
 *                   ──► rotation requested (grace window, then expires)
 *                   ──► revoked (listeners drop that credential's live
 *                       sessions immediately)
 *
 * `authenticate` is synchronous — it runs on every bridge request — so the
 * store must be `load()`ed before the bridge starts serving (MeshService.load
 * does it). Until then it knows no credentials and every token fails closed.
 */

import { resolve } from "node:path";
import { dirs } from "../../../util/paths.js";
import { log, logWarn } from "../../../util/log.js";
import { TalonError } from "../../errors.js";
import { readArray, writePrivateJson } from "../persist.js";
import { faultText } from "../../engine/fault-text.js";
import { raiseAlert, resolveAlert } from "../../frontend-runtime/alerts.js";
import {
  credentialIdOf,
  digestsEqual,
  hashCredentialToken,
  mintCredentialToken,
} from "./token.js";
import {
  normalizeScopes,
  type CredentialOrigin,
  type DeviceCredential,
  type DeviceCredentialRecord,
  type MeshScope,
} from "./types.js";

const DEFAULT_FILE = resolve(dirs.root, "mesh-credentials.json");
const DAY_MS = 24 * 60 * 60 * 1000;
/** A pairing link or installer that is never used stops being a credential. */
export const UNBOUND_TTL_MS = 7 * DAY_MS;
/** How long a device has to pick up a requested rotation before it expires. */
const ROTATION_GRACE_MS = 7 * DAY_MS;
/** Revoked rows are kept this long for `talon mesh` / audit, then pruned. */
const REVOKED_RETENTION_MS = 30 * DAY_MS;
/** Hard cap on stored rows — the sidecar is rewritten on every change. */
const MAX_RECORDS = 512;
/** lastUsedAt is kept in memory per request, persisted at most this often. */
const TOUCH_PERSIST_MS = 60_000;
/** Same bound the registry applies to device ids. */
const MAX_DEVICE_ID_CHARS = 128;

export type RevocationListener = (credentialIds: readonly string[]) => void;

export type MintInput = {
  /** Bind now, or null to bind on first use (pairing / installer). */
  deviceId: string | null;
  scopes: readonly MeshScope[];
  origin: CredentialOrigin;
};

export type BindResult =
  { ok: true; credential: DeviceCredential } | { ok: false; error: string };

const PERSIST_ALERT = "mesh.credentials.persist";

/** Operator-minted, bind-on-first-use origins allowed to re-pair a device. */
const REPAIR_ORIGINS: ReadonlySet<CredentialOrigin> = new Set([
  "pair",
  "install",
]);

export class DeviceCredentialStore {
  private records = new Map<string, DeviceCredentialRecord>();
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<RevocationListener>();
  /** Device ids seen authenticating with the shared token (this run). */
  private readonly legacy = new Map<string, number>();
  private lastPersist = 0;

  constructor(
    private readonly file: string = DEFAULT_FILE,
    private readonly now: () => number = Date.now,
  ) {}

  /** Hydrate from disk. Idempotent: the first caller reads, the rest share it. */
  load(): Promise<void> {
    this.loading ??= readArray<DeviceCredentialRecord>(this.file).then(
      (rows) => {
        for (const row of rows) {
          if (isRecord(row)) {
            this.records.set(row.id, {
              ...row,
              scopes: normalizeScopes(row.scopes),
            });
          }
        }
        this.prune();
      },
    );
    return this.loading;
  }

  /**
   * Mint a credential and wait until it is on disk — the path for handing a
   * device a token it will replace its old one with (a crash between reply
   * and write would otherwise strand the device on a token nobody knows).
   * Minting for a device that already holds one marks the old one
   * superseded: it keeps working until the new token is first presented,
   * then it is revoked.
   */
  async mint(
    input: MintInput,
  ): Promise<{ token: string; credential: DeviceCredential }> {
    await this.load();
    const minted = this.create(input);
    await this.persist();
    return minted;
  }

  /**
   * Mint synchronously, persisting in the background — for pairing links
   * and installers, whose worst case on a crash is a link that no longer
   * works (the device never switched away from anything).
   */
  mintNow(input: MintInput): { token: string; credential: DeviceCredential } {
    const minted = this.create(input);
    this.persistSoon();
    return minted;
  }

  /**
   * Resolve a presented token to its credential, or null when it is not a
   * live credential (unknown, wrong secret, revoked, expired). The first use
   * of a replacement credential revokes the one it superseded.
   */
  authenticate(token: string): DeviceCredential | null {
    const id = credentialIdOf(token);
    const record = id ? this.records.get(id) : undefined;
    if (!record || !digestsEqual(record.tokenHash, hashCredentialToken(token)))
      return null;
    if (!this.isActive(record)) return null;
    const firstUse = record.lastUsedAt === undefined;
    this.touch(record);
    if (firstUse) this.retireSuperseded(record.id);
    return publicView(record);
  }

  /**
   * Bind an unbound credential to the device id it just named.
   *
   * When that id already holds live credentials, an operator-minted pairing
   * or installer credential takes the device over (a re-pair): the old
   * credentials are revoked and their live sessions dropped. This is the
   * "the Mac's app was reset but kept its device id" case, which otherwise
   * needs a `talon mesh revoke` before the new link can work.
   *
   * Trust: every unbound credential is operator-minted (`pair`/`install`,
   * see MeshService → BridgeLinks) and binds exactly once — after this call
   * it is bound, so a replayed link cannot bind again. Takeover is further
   * limited to devices whose live credentials carry no scope the new one
   * lacks: a device-only installer link can re-provision a node, but can
   * never evict (and then impersonate) a companion holding client/operator.
   * A credential of any other origin keeps the old rule — refused.
   */
  bind(credentialId: string, deviceId: string): BindResult {
    const record = this.records.get(credentialId);
    if (!record || !this.isActive(record)) {
      return { ok: false, error: "Credential is no longer valid" };
    }
    if (record.deviceId !== null) {
      return record.deviceId === deviceId
        ? { ok: true, credential: publicView(record) }
        : { ok: false, error: `Credential is bound to ${record.deviceId}` };
    }
    const id = deviceId.trim();
    if (!id || id.length > MAX_DEVICE_ID_CHARS) {
      return { ok: false, error: "Invalid device id" };
    }
    const existing = this.activeRecordsFor(id);
    if (existing.length > 0) {
      const refusal = this.takeoverRefusal(record, id, existing);
      if (refusal) return { ok: false, error: refusal };
    }
    record.deviceId = id;
    delete record.expiresAt;
    log("mesh", `Credential ${record.id} bound to device ${id}`);
    if (existing.length > 0) {
      logWarn(
        "mesh",
        `Credential ${record.id} (${record.origin}) re-paired device ${id}; revoking ${existing.map((r) => r.id).join(", ")}`,
      );
      // Mark revoked synchronously (authenticate must reject them from this
      // instant); revokeRecords drops their sessions and persists.
      void this.revokeRecords(existing, `re-paired by ${record.id}`).catch(
        (err: unknown) =>
          logWarn("mesh", `Could not persist re-pair revocation: ${err}`),
      );
    } else {
      this.persistSoon();
    }
    return { ok: true, credential: publicView(record) };
  }

  /** Why `record` may not take over `deviceId` from `existing`, if it may not. */
  private takeoverRefusal(
    record: DeviceCredentialRecord,
    deviceId: string,
    existing: readonly DeviceCredentialRecord[],
  ): string | null {
    const revokeHint = `revoke it first (talon mesh revoke ${deviceId})`;
    if (!REPAIR_ORIGINS.has(record.origin)) {
      return `Device ${deviceId} already has a credential — ${revokeHint}`;
    }
    const held = new Set(record.scopes);
    const wider = existing.flatMap((r) => r.scopes).filter((s) => !held.has(s));
    if (wider.length > 0) {
      return (
        `Device ${deviceId} already has a credential with scopes this link does not carry ` +
        `(${[...new Set(wider)].join(", ")}) — ${revokeHint}`
      );
    }
    return null;
  }

  /** True when the operator asked for this credential to be replaced. */
  rotationDue(credentialId: string): boolean {
    const record = this.records.get(credentialId);
    return Boolean(record?.rotateRequestedAt && !record.supersededBy);
  }

  /** Every stored credential (live and recently revoked), newest first. */
  list(): DeviceCredential[] {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicView);
  }

  /** Live credentials acting as `deviceId`. */
  activeFor(deviceId: string): DeviceCredential[] {
    return this.activeRecordsFor(deviceId).map(publicView);
  }

  /** Revoke every live credential of a device; returns what was revoked. */
  async revokeDevice(
    deviceId: string,
    reason: string,
  ): Promise<DeviceCredential[]> {
    await this.load();
    return this.revokeRecords(this.activeRecordsFor(deviceId), reason);
  }

  /** Revoke one credential by id. */
  async revokeCredential(
    credentialId: string,
    reason: string,
  ): Promise<DeviceCredential[]> {
    await this.load();
    const record = this.records.get(credentialId);
    return record && this.isActive(record)
      ? this.revokeRecords([record], reason)
      : [];
  }

  /**
   * Ask a device to replace its credential. It picks the request up on its
   * next heartbeat and swaps in-band; the old credential expires after a
   * grace window whether or not it did.
   */
  async requestRotation(deviceId: string): Promise<DeviceCredential[]> {
    await this.load();
    const at = this.now();
    const records = this.activeRecordsFor(deviceId);
    for (const record of records) {
      record.rotateRequestedAt = at;
      record.expiresAt = Math.min(
        record.expiresAt ?? Infinity,
        at + ROTATION_GRACE_MS,
      );
    }
    if (records.length > 0) await this.persist();
    return records.map(publicView);
  }

  /**
   * Replace a device's scopes. Live sessions are dropped (through the
   * revocation listeners) so nothing keeps streaming under the old grant;
   * the device reconnects with the same token and the new scopes.
   */
  async setScopes(
    deviceId: string,
    scopes: readonly MeshScope[],
  ): Promise<DeviceCredential[]> {
    await this.load();
    const next = normalizeScopes(scopes);
    if (next.length === 0) {
      throw new TalonError("At least one scope is required", {
        reason: "bad_request",
      });
    }
    const records = this.activeRecordsFor(deviceId);
    const at = this.now();
    for (const record of records) {
      record.scopes = next;
      record.scopesSetAt = at;
    }
    if (records.length > 0) {
      await this.persist();
      this.emit(records.map((r) => r.id));
    }
    return records.map(publicView);
  }

  /**
   * Move every live credential still holding exactly `from` to `to`, unless
   * its scopes were set by hand — for when a default widens, so devices
   * issued the old default get the new one. Returns how many changed.
   */
  async adoptDefaultScopes(
    from: readonly MeshScope[],
    to: readonly MeshScope[],
  ): Promise<number> {
    await this.load();
    const was = normalizeScopes(from).join(",");
    const next = normalizeScopes(to);
    let changed = 0;
    for (const record of this.records.values()) {
      if (!this.isActive(record) || record.scopesSetAt !== undefined) continue;
      if (record.scopes.join(",") !== was) continue;
      record.scopes = [...next];
      changed++;
    }
    if (changed > 0) await this.persist();
    return changed;
  }

  /** Subscribe to revocations (the bridge drops matching sessions). */
  onRevoked(listener: RevocationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Record that `deviceId` is still authenticating with the shared token.
   * Warns the first time per device per run; returns true that time.
   */
  noteLegacy(deviceId: string): boolean {
    const first = !this.legacy.has(deviceId);
    this.legacy.set(deviceId, this.now());
    if (first) {
      logWarn(
        "mesh",
        `Device ${deviceId} is authenticating with the shared native.token (legacy). ` +
          `Current companions and talon-node swap it for a per-device credential automatically; ` +
          `run \`talon mesh\` to see which devices are still on the shared token.`,
      );
    }
    return first;
  }

  /** Devices seen on the shared token this run that hold no live credential. */
  legacyDevices(): { deviceId: string; lastSeen: number }[] {
    return [...this.legacy]
      .filter(([deviceId]) => this.activeRecordsFor(deviceId).length === 0)
      .map(([deviceId, lastSeen]) => ({ deviceId, lastSeen }));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private create(input: MintInput): {
    token: string;
    credential: DeviceCredential;
  } {
    const scopes = normalizeScopes(input.scopes);
    if (scopes.length === 0) {
      throw new TalonError("A credential needs a scope", {
        reason: "bad_request",
      });
    }
    this.prune();
    if (this.records.size >= MAX_RECORDS) {
      throw new TalonError(
        `Credential store is full (${MAX_RECORDS}) — revoke unused devices first`,
        { reason: "forbidden", status: 409 },
      );
    }
    const minted = mintCredentialToken();
    const at = this.now();
    const scopesSetAt = this.handSetScopes(input.deviceId, scopes);
    const record: DeviceCredentialRecord = {
      id: minted.id,
      deviceId: input.deviceId,
      tokenHash: minted.tokenHash,
      scopes,
      ...(scopesSetAt !== undefined ? { scopesSetAt } : {}),
      origin: input.origin,
      createdAt: at,
      ...(input.deviceId === null ? { expiresAt: at + UNBOUND_TTL_MS } : {}),
    };
    if (input.deviceId !== null) this.supersede(input.deviceId, record.id, at);
    this.records.set(record.id, record);
    return { token: minted.token, credential: publicView(record) };
  }

  /** A re-issue keeps the mark of scopes an operator set by hand. */
  private handSetScopes(
    deviceId: string | null,
    scopes: readonly MeshScope[],
  ): number | undefined {
    if (deviceId === null) return undefined;
    const key = scopes.join(",");
    return this.activeRecordsFor(deviceId).find(
      (r) => r.scopesSetAt !== undefined && r.scopes.join(",") === key,
    )?.scopesSetAt;
  }

  private isActive(record: DeviceCredentialRecord): boolean {
    if (record.revokedAt !== undefined) return false;
    return record.expiresAt === undefined || this.now() < record.expiresAt;
  }

  private activeRecordsFor(deviceId: string): DeviceCredentialRecord[] {
    return [...this.records.values()].filter(
      (r) => r.deviceId === deviceId && this.isActive(r),
    );
  }

  /**
   * A new credential for `deviceId` supersedes its live ones. One the device
   * has used stays valid until the replacement's first use (lost-reply
   * safety); one it never used was never adopted — a retried upgrade — and
   * is revoked outright, so retries cannot pile up live credentials. No
   * session can exist for a never-used credential, so nothing to drop.
   */
  private supersede(deviceId: string, replacementId: string, at: number): void {
    for (const old of this.activeRecordsFor(deviceId)) {
      if (old.lastUsedAt === undefined) {
        old.revokedAt = at;
        old.revokeReason = `never used; replaced by ${replacementId}`;
      } else {
        old.supersededBy = replacementId;
      }
    }
  }

  private touch(record: DeviceCredentialRecord): void {
    record.lastUsedAt = this.now();
    if (record.lastUsedAt - this.lastPersist >= TOUCH_PERSIST_MS) {
      this.persistSoon();
    }
  }

  private retireSuperseded(replacementId: string): void {
    const old = [...this.records.values()].filter(
      (r) => r.supersededBy === replacementId && this.isActive(r),
    );
    if (old.length === 0) return;
    void this.revokeRecords(old, `replaced by ${replacementId}`).catch(
      (err: unknown) =>
        logWarn("mesh", `Could not retire superseded credential: ${err}`),
    );
  }

  private async revokeRecords(
    records: DeviceCredentialRecord[],
    reason: string,
  ): Promise<DeviceCredential[]> {
    if (records.length === 0) return [];
    const at = this.now();
    for (const record of records) {
      record.revokedAt = at;
      record.revokeReason = reason.slice(0, 200);
      log(
        "mesh",
        `Revoked credential ${record.id} (device ${record.deviceId ?? "unbound"}): ${record.revokeReason}`,
      );
    }
    // Drop sessions before the disk write: revocation must bite now, not
    // after an fsync.
    this.emit(records.map((r) => r.id));
    await this.persist();
    return records.map(publicView);
  }

  private emit(ids: readonly string[]): void {
    for (const listener of this.listeners) {
      try {
        listener(ids);
      } catch (err) {
        logWarn("mesh", `Credential revocation listener threw: ${err}`);
      }
    }
  }

  /** Drop long-revoked and long-expired rows. */
  private prune(): void {
    const cutoff = this.now() - REVOKED_RETENTION_MS;
    for (const [id, record] of this.records) {
      const endedAt = record.revokedAt ?? record.expiresAt;
      if (endedAt !== undefined && endedAt < cutoff) this.records.delete(id);
    }
  }

  private persistSoon(): void {
    void this.persist().catch((err: unknown) =>
      logWarn("mesh", `Could not persist mesh credentials: ${err}`),
    );
  }

  private async persist(): Promise<void> {
    this.lastPersist = this.now();
    try {
      await writePrivateJson(this.file, [...this.records.values()]);
    } catch (err) {
      // A credential that never reached disk is gone after a restart —
      // the device holding it is locked out. Disk faults need a human.
      raiseAlert(
        PERSIST_ALERT,
        `Could not save mesh device credentials: ${faultText(err)}. Newly paired or rotated devices will lose access after a restart until this is fixed.`,
      );
      throw err;
    }
    resolveAlert(PERSIST_ALERT, "Mesh device credentials are saving again.");
  }
}

function publicView(record: DeviceCredentialRecord): DeviceCredential {
  const { tokenHash: _hash, ...rest } = record;
  return { ...rest, scopes: [...rest.scopes] };
}

/** Reject hand-edited or corrupt rows rather than trusting them. */
function isRecord(value: unknown): value is DeviceCredentialRecord {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    /^[0-9a-f]{16}$/.test(row.id) &&
    typeof row.tokenHash === "string" &&
    /^[0-9a-f]{64}$/.test(row.tokenHash) &&
    (row.deviceId === null || typeof row.deviceId === "string") &&
    typeof row.createdAt === "number" &&
    normalizeScopes(row.scopes).length > 0
  );
}
