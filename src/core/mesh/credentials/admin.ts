/**
 * Operator surface for per-device credentials — what `talon mesh` drives
 * through the daemon's loopback gateway (core/engine/gateway-routes.ts).
 *
 * Pure policy over the store: resolve "which device?" from an id, a
 * credential id, or a registry name, then list / revoke / rotate / re-scope.
 * Every reply is plain data plus a human line; the CLI only renders.
 */

import type { DeviceCredentialStore } from "./store.js";
import { normalizeScopes, type DeviceCredential } from "./types.js";

type CredentialAdminOp = "revoke" | "rotate" | "scopes";

/** What the admin surface needs from the mesh around it. */
export type CredentialAdminContext = {
  store: DeviceCredentialStore;
  /** Registry lookup by id or name (MeshService.resolveDevice). */
  resolveDeviceId: (query: string) => string | undefined;
  /** Whether the shared token is still accepted from remote clients. */
  legacySharedToken: () => boolean;
};

export type CredentialOverview = {
  ok: true;
  credentials: DeviceCredential[];
  legacyDevices: { deviceId: string; lastSeen: number }[];
  legacySharedToken: boolean;
};

export type CredentialAdminResult =
  | { ok: true; text: string; credentials: DeviceCredential[] }
  | { ok: false; error: string };

export async function credentialOverview(
  ctx: CredentialAdminContext,
): Promise<CredentialOverview> {
  await ctx.store.load();
  return {
    ok: true,
    credentials: ctx.store.list(),
    legacyDevices: ctx.store.legacyDevices(),
    legacySharedToken: ctx.legacySharedToken(),
  };
}

/**
 * Resolve a CLI argument to the device id credentials are bound to. A
 * credential id wins (it is unambiguous), then an exact device id with
 * credentials (a device removed from the registry can still hold one), then
 * whatever the registry resolves the text to.
 */
function resolveTarget(
  ctx: CredentialAdminContext,
  query: string,
): { deviceId: string } | { credentialId: string } | undefined {
  const all = ctx.store.list();
  if (all.some((c) => c.id === query)) return { credentialId: query };
  if (all.some((c) => c.deviceId === query)) return { deviceId: query };
  const fromRegistry = ctx.resolveDeviceId(query);
  return fromRegistry ? { deviceId: fromRegistry } : undefined;
}

export async function credentialAdmin(
  ctx: CredentialAdminContext,
  body: Record<string, unknown>,
): Promise<CredentialAdminResult> {
  await ctx.store.load();
  const op = body.op;
  const query = typeof body.device === "string" ? body.device.trim() : "";
  if (op !== "revoke" && op !== "rotate" && op !== "scopes") {
    return { ok: false, error: "op must be revoke, rotate or scopes" };
  }
  if (!query) return { ok: false, error: "device is required" };
  const target = resolveTarget(ctx, query);
  if (!target) {
    return { ok: false, error: `No device or credential matches "${query}"` };
  }
  if ("credentialId" in target) {
    if (op !== "revoke") {
      return { ok: false, error: `${op} takes a device, not a credential id` };
    }
    const revoked = await ctx.store.revokeCredential(
      target.credentialId,
      "revoked by operator",
    );
    return done(revoked, `Revoked credential ${target.credentialId}.`, ctx);
  }
  return deviceOp(ctx, op, target.deviceId, body.scopes);
}

async function deviceOp(
  ctx: CredentialAdminContext,
  op: CredentialAdminOp,
  deviceId: string,
  scopes: unknown,
): Promise<CredentialAdminResult> {
  if (op === "revoke") {
    const revoked = await ctx.store.revokeDevice(
      deviceId,
      "revoked by operator",
    );
    return done(
      revoked,
      `Revoked ${revoked.length} credential(s) for ${deviceId}; its live sessions were dropped.`,
      ctx,
    );
  }
  if (op === "rotate") {
    const pending = await ctx.store.requestRotation(deviceId);
    return done(
      pending,
      `Rotation requested for ${deviceId}: it swaps credentials on its next heartbeat (companions: next connect). The old credential expires in 7 days either way — revoke it to cut it off now.`,
      ctx,
    );
  }
  const next = normalizeScopes(
    typeof scopes === "string" ? scopes.split(",").map((s) => s.trim()) : [],
  );
  if (next.length === 0) {
    return {
      ok: false,
      error: "scopes must list one or more of: device, client, operator",
    };
  }
  const changed = await ctx.store.setScopes(deviceId, next);
  return done(
    changed,
    `${deviceId} now holds: ${next.join(", ")}. Its live sessions were dropped so the new scopes apply on reconnect.`,
    ctx,
  );
}

function done(
  credentials: DeviceCredential[],
  text: string,
  ctx: CredentialAdminContext,
): CredentialAdminResult {
  if (credentials.length === 0) {
    return { ok: false, error: "That device holds no live credential." };
  }
  const legacyNote = ctx.legacySharedToken()
    ? " Note: native.legacySharedToken is on, so a device that still has the shared token can reconnect with it — rotate native.token and set legacySharedToken: false to close that door."
    : "";
  return { ok: true, text: text + legacyNote, credentials };
}
