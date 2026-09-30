/**
 * Device-id claims — the spoofing check.
 *
 * Mesh requests name a device: `?deviceId=` on /events and /devices/file,
 * `id` on /devices/register, `deviceId` on /location and
 * /devices/command-result. A per-device credential may only ever name its
 * own device; an unbound pairing/installer credential is bound by the first
 * id it names — re-pairing (revoking) a device that already holds one when
 * the store allows it, see DeviceCredentialStore.bind. The
 * shared token and an open bridge name whatever they like — that is the
 * legacy trust model — but a remote shared-token claim is recorded so the
 * operator can see which devices still need upgrading.
 */

import { logWarn } from "../../../../util/log.js";
import type { BridgeCredentials, BridgePrincipal } from "./principal.js";

export type ClaimResult =
  { ok: true; deviceId: string | undefined } | { ok: false; error: string };

export function claimDevice(
  principal: BridgePrincipal | null,
  claimed: string | undefined,
  credentials: BridgeCredentials | undefined,
): ClaimResult {
  if (principal === null || principal.kind === "open") {
    return { ok: true, deviceId: claimed };
  }
  if (principal.kind === "shared") {
    if (claimed && !principal.local && credentials) {
      credentials.authority.noteLegacy(claimed);
    }
    return { ok: true, deviceId: claimed };
  }
  const bound = principal.deviceId;
  if (bound !== null) {
    return claimed === undefined || claimed === bound
      ? { ok: true, deviceId: bound }
      : {
          ok: false,
          error: `This credential belongs to device ${bound}; it cannot act as ${claimed}.`,
        };
  }
  if (claimed === undefined) return { ok: true, deviceId: undefined };
  const bind = credentials?.authority.bind(principal.credentialId, claimed);
  if (!bind || !bind.ok) {
    const error = bind?.error ?? "Credential cannot be bound";
    // Callers answer 403 with this error (never 401: the token itself is
    // fine). Without this line a pairing that authenticated but could not
    // bind leaves no trace on the daemon side.
    logWarn(
      "native",
      `bridge.auth event=bind_refused credential=${principal.credentialId} device=${claimed}: ${error}`,
    );
    return { ok: false, error };
  }
  // The rest of this request (and the SSE session it may open) acts as the
  // device it just became.
  principal.deviceId = claimed;
  return { ok: true, deviceId: claimed };
}
