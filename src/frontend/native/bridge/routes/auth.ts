import type { RouteHost } from "./host.js";
import type { BridgeRoutes } from "./table.js";
import { describePrincipal } from "../credentials/principal.js";
import { upgradeCredential } from "../credentials/upgrade.js";
import { clientAddress } from "../client-address.js";

export function authRoutes(
  host: RouteHost,
): Pick<BridgeRoutes, "GET /auth/whoami" | "POST /auth/upgrade"> {
  const { json, readJson } = host;
  return {
    // ── Credential self-service ────────────────────────────────────────

    // Which credential this is, what it may do, and whether the daemon
    // wants it upgraded (shared token) or rotated (operator request).
    "GET /auth/whoami": ({ res, principal }) => {
      if (!principal)
        return json(res, 401, { ok: false, error: "Unauthorized" });
      json(res, 200, describePrincipal(principal, host.credentials));
    },

    // Trade the shared token (or this credential) for a per-device one.
    // The reply is the only copy of the new token anywhere.
    "POST /auth/upgrade": async ({ req, res, principal }) => {
      if (!principal)
        return json(res, 401, { ok: false, error: "Unauthorized" });
      const body = await readJson(req);
      const reply = await upgradeCredential(
        host.credentials,
        principal,
        body,
        clientAddress(req),
      );
      res.setHeader("Cache-Control", "no-store");
      json(res, reply.status, reply.body);
    },
  };
}
