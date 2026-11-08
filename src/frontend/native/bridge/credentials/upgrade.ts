/**
 * The in-band credential upgrade — `POST /auth/upgrade`.
 *
 * Two callers, one endpoint:
 *
 *   shared token → a per-device credential bound to the device id in the
 *     body (the migration path off `native.token`). Scopes are what the
 *     client asks for, capped by policy: a node gets `device`; a companion
 *     at most `native.companionScopes` (default: all three, as the shared
 *     token it is trading carried). A companion that asks for `client`
 *     also gets `operator` whenever that list allows it.
 *
 *   per-device credential → a replacement with the same device and scopes
 *     (rotation, when the operator asked for it or the client wants one).
 *
 * The replaced credential stays valid until the new one is first used, so a
 * reply lost in transit never strands a device; it is revoked on that first
 * use. The reply carries the only copy of the new token and is `no-store`.
 */

import { log } from "../../../../util/log.js";
import { claimDevice } from "./claims.js";
import type {
  BridgeCredentials,
  BridgePrincipal,
  BridgeScope,
} from "./principal.js";

export type UpgradeReply = { status: number; body: Record<string, unknown> };

const DEVICE_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const SCOPES: readonly BridgeScope[] = ["device", "client", "operator"];

function fail(status: number, error: string): UpgradeReply {
  return { status, body: { ok: false, error } };
}

function requestedScopes(value: unknown): BridgeScope[] {
  if (!Array.isArray(value)) return [];
  return SCOPES.filter((s) => value.includes(s));
}

/** What a shared-token client may be granted, given what it asked for. */
function grantFor(
  credentials: BridgeCredentials,
  client: unknown,
  asked: BridgeScope[],
): BridgeScope[] {
  const ceiling: readonly BridgeScope[] =
    client === "node" ? ["device"] : credentials.policy.companionScopes;
  if (asked.length === 0) return [...ceiling];
  const granted = asked.filter((s) => ceiling.includes(s));
  // Shipped companions ask for device + client: the list predates operator
  // being part of the default. The companion is the full UI (settings,
  // extensions), so it gets operator whenever the policy allows it.
  if (
    client !== "node" &&
    granted.includes("client") &&
    ceiling.includes("operator") &&
    !granted.includes("operator")
  ) {
    granted.push("operator");
  }
  return granted;
}

export async function upgradeCredential(
  credentials: BridgeCredentials | undefined,
  principal: BridgePrincipal,
  body: Record<string, unknown>,
  remote: string,
): Promise<UpgradeReply> {
  if (!credentials) {
    return fail(404, "Per-device credentials are not enabled on this bridge");
  }
  if (principal.kind === "open") {
    return fail(
      409,
      "This bridge requires no token; there is nothing to upgrade",
    );
  }
  const deviceId =
    typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  if (!DEVICE_ID_RE.test(deviceId)) {
    return fail(400, "deviceId is required (1-128 of A-Z a-z 0-9 . _ : @ -)");
  }
  const rotating = principal.kind === "device";
  if (rotating) {
    // A credential can only re-issue itself: same device, same scopes.
    const claim = claimDevice(principal, deviceId, credentials);
    if (!claim.ok) return fail(403, claim.error);
  }

  const scopes = rotating
    ? [...principal.scopes]
    : grantFor(credentials, body.client, requestedScopes(body.scopes));
  if (scopes.length === 0) {
    return fail(403, "None of the requested scopes can be granted in-band");
  }
  const minted = await credentials.authority.mint({
    deviceId,
    scopes,
    origin: rotating ? "rotate" : "upgrade",
  });
  log(
    "native",
    `Issued credential ${minted.credential.id} to device ${deviceId} (${scopes.join(", ")}) — ` +
      (rotating
        ? `rotated from ${principal.credentialId}`
        : `in-band upgrade from the shared token`) +
      ` via ${remote}`,
  );
  return {
    status: 200,
    body: {
      ok: true,
      token: minted.token,
      credentialId: minted.credential.id,
      deviceId,
      scopes,
    },
  };
}

/**
 * The `credential` hint on a /devices/register reply — how a heartbeating
 * device learns it should upgrade or rotate without an extra request.
 */
export function credentialHint(
  credentials: BridgeCredentials | undefined,
  principal: BridgePrincipal | null,
): { action: "upgrade" | "rotate" } | undefined {
  if (!credentials || principal === null) return undefined;
  if (principal.kind === "shared") return { action: "upgrade" };
  if (
    principal.kind === "device" &&
    credentials.authority.rotationDue(principal.credentialId)
  ) {
    return { action: "rotate" };
  }
  return undefined;
}
