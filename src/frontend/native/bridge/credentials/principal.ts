/**
 * Who is calling the bridge, and what they may do.
 *
 * A request authenticates as one of:
 *
 *   open    no token is configured (loopback-only bind) — every scope,
 *           exactly as before per-device credentials existed.
 *   shared  the shared `native.token` — every scope. From a non-local
 *           client it is the LEGACY path: accepted only while
 *           `native.legacySharedToken` is on, and every device that uses
 *           it is offered an in-band upgrade to its own credential.
 *   device  a per-device credential (core/mesh/credentials): the scopes it
 *           was granted, bound to one device id.
 *
 * Transport-pure like the server: the credential store is reached through
 * the structural `BridgeCredentialAuthority` slice, injected at startup.
 */

import type { IncomingMessage } from "node:http";
import {
  credentialIdOf,
  isDeviceCredentialToken,
} from "../../../../core/mesh/credentials/index.js";
import { logWarn } from "../../../../util/log.js";
import { clientAddress } from "../client-address.js";

/**
 * What a credential may do (see core/mesh/credentials/types.ts):
 *   device    act as ITSELF on the mesh — register, report, answer its own
 *             commands, move the files the daemon asked for.
 *   client    the chat UI — chats, history, sending, non-secret reads.
 *   operator  config / extension writes, daemon control, logs.
 * The shared `native.token` and an open loopback bridge hold all three.
 */
export type BridgeScope = "device" | "client" | "operator";

/**
 * A route's tier in routes/table.ts. "public": served without a
 * credential — every such entry is gated some other way (a single-use
 * grant minted by the daemon, or for /health by answering only what
 * pairing needs until a token is presented). A scope: the request's
 * credential must hold it. A scope list: it must hold at least one.
 */
export type BridgeRouteAuth = "public" | BridgeScope | readonly BridgeScope[];

export type BridgePrincipal =
  | { kind: "open" }
  | { kind: "shared"; local: boolean }
  | {
      kind: "device";
      credentialId: string;
      /** Null until an unbound pairing/installer credential names a device. */
      deviceId: string | null;
      scopes: readonly BridgeScope[];
    };

type AuthenticatedCredential = {
  id: string;
  deviceId: string | null;
  scopes: readonly BridgeScope[];
};

/** The slice of core's DeviceCredentialStore the bridge depends on. */
type BridgeCredentialAuthority = {
  authenticate(token: string): AuthenticatedCredential | null;
  bind(
    credentialId: string,
    deviceId: string,
  ): { ok: true } | { ok: false; error: string };
  rotationDue(credentialId: string): boolean;
  noteLegacy(deviceId: string): boolean;
  onRevoked(listener: (credentialIds: readonly string[]) => void): () => void;
  mint(input: {
    deviceId: string | null;
    scopes: readonly BridgeScope[];
    origin: "upgrade" | "rotate";
  }): Promise<{ token: string; credential: AuthenticatedCredential }>;
};

type BridgeCredentialPolicy = {
  /** Accept the shared `native.token` from non-local clients. */
  legacySharedToken: boolean;
  /** The most a companion may be granted in-band (`native.companionScopes`). */
  companionScopes: readonly BridgeScope[];
};

/** Per-device credential support, as injected into the bridge server. */
export type BridgeCredentials = {
  authority: BridgeCredentialAuthority;
  policy: BridgeCredentialPolicy;
};

const ALL_SCOPES: readonly BridgeScope[] = ["device", "client", "operator"];

function principalScopes(p: BridgePrincipal): readonly BridgeScope[] {
  return p.kind === "device" ? p.scopes : ALL_SCOPES;
}

export function hasScope(p: BridgePrincipal, scope: BridgeScope): boolean {
  return principalScopes(p).includes(scope);
}

/** Whether `p` clears a route's declared tier. */
export function routeAllows(
  tier: BridgeRouteAuth,
  p: BridgePrincipal,
): boolean {
  if (tier === "public") return true;
  const needed: readonly BridgeScope[] =
    typeof tier === "string" ? [tier] : tier;
  return needed.some((scope) => hasScope(p, scope));
}

/** Human form of a tier for a 403 body: `"operator"` / `"device" or "client"`. */
export function describeTier(tier: BridgeRouteAuth): string {
  const scopes = typeof tier === "string" ? [tier] : tier;
  return scopes.map((s) => `"${s}"`).join(" or ");
}

/**
 * Same-machine and not relayed. The shared token is how the local desktop
 * app and CLI authenticate (they read it from the 0600 discovery file), so
 * it keeps working for them with legacy mode off. A reverse proxy on the
 * same host also connects from loopback, so any forwarding header makes the
 * request remote — a proxied internet client must never pass as local.
 */
function isLocalRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  const loopback =
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.");
  if (!loopback) return false;
  const h = req.headers;
  return !(
    h["x-forwarded-for"] ||
    h["forwarded"] ||
    h["x-real-ip"] ||
    h["x-forwarded-host"]
  );
}

/**
 * The per-device credential id a presented bearer names (`tdc1.<id>.…`), so
 * a refusal can count against that id as well as the address. Null for the
 * shared token or anything malformed. Ids are identifiers, safe to log.
 */
export function presentedCredentialId(candidate: string): string | null {
  return credentialIdOf(candidate);
}

/** Addresses already warned about a refused legacy token (bounded). */
const refusedLegacy = new Set<string>();

/**
 * Resolve a presented bearer to a principal, or null when it must be
 * refused. `sharedMatches` is the server's constant-time check against
 * `native.token`.
 */
export function resolvePrincipal(
  candidate: string,
  req: IncomingMessage,
  sharedMatches: (candidate: string) => boolean,
  credentials: BridgeCredentials | undefined,
): BridgePrincipal | null {
  if (credentials && isDeviceCredentialToken(candidate)) {
    const cred = credentials.authority.authenticate(candidate);
    return cred
      ? {
          kind: "device",
          credentialId: cred.id,
          deviceId: cred.deviceId,
          scopes: cred.scopes,
        }
      : null;
  }
  if (!sharedMatches(candidate)) return null;
  const local = isLocalRequest(req);
  if (!local && credentials && !credentials.policy.legacySharedToken) {
    const remote = clientAddress(req);
    if (!refusedLegacy.has(remote) && refusedLegacy.size < 256) {
      refusedLegacy.add(remote);
      logWarn(
        "native",
        `Refused the shared bridge token from ${remote}: native.legacySharedToken is off, so remote clients need a per-device credential (pair the device again).`,
      );
    }
    return null;
  }
  return { kind: "shared", local };
}

/** What `GET /auth/whoami` answers. */
export function describePrincipal(
  p: BridgePrincipal,
  credentials: BridgeCredentials | undefined,
): Record<string, unknown> {
  const base = { ok: true, kind: p.kind, scopes: [...principalScopes(p)] };
  if (p.kind !== "device") {
    // A shared-token client can trade up to its own credential; clients
    // that read the token from the local discovery file simply do not.
    const upgrade = p.kind === "shared" && credentials !== undefined;
    return upgrade ? { ...base, action: "upgrade" } : base;
  }
  const rotate = credentials?.authority.rotationDue(p.credentialId) ?? false;
  return {
    ...base,
    credentialId: p.credentialId,
    deviceId: p.deviceId,
    ...(rotate ? { action: "rotate" } : {}),
  };
}
