import type { RouteHost } from "./host.js";
import type { BridgeRoutes } from "./table.js";
import type { ServerResponse } from "node:http";
import { deviceIdParam } from "./params.js";
import { claimDevice } from "../credentials/claims.js";
import { hasScope } from "../credentials/principal.js";
import { credentialHint } from "../credentials/upgrade.js";
import type { RouteContext } from "./table.js";

/**
 * Resolve the device a mesh request acts as — the spoofing check. Returns
 * the effective id (a per-device credential's own device when the request
 * named none), or null after answering 403 for a claim the credential may
 * not make.
 */
function actingDevice(
  host: RouteHost,
  ctx: RouteContext,
  claimed: unknown,
): { deviceId: string | undefined } | null {
  const named =
    typeof claimed === "string" && claimed.trim() ? claimed.trim() : undefined;
  const claim = claimDevice(ctx.principal, named, host.credentials);
  if (claim.ok) return { deviceId: claim.deviceId };
  host.json(ctx.res, 403, { ok: false, error: claim.error });
  return null;
}

/** Stamp the acting device onto a body field the handler reads it from. */
function withDevice(
  body: Record<string, unknown>,
  field: "id" | "deviceId",
  deviceId: string | undefined,
): Record<string, unknown> {
  return deviceId === undefined ? body : { ...body, [field]: deviceId };
}

// Streamed device file transfers (see core/mesh/transfers/transfers.ts). The
// one-time `transfer` token authorizes exactly one direction+path; the
// caller names itself so the token's device binding can be checked.
function transferToken(
  host: RouteHost,
  url: URL,
  res: ServerResponse,
): string | null {
  const token = url.searchParams.get("transfer") ?? "";
  if (!token) {
    host.json(res, 400, { ok: false, error: "transfer required" });
    return null;
  }
  return token;
}

export function meshRoutes(
  host: RouteHost,
): Pick<
  BridgeRoutes,
  | "POST /devices/register"
  | "POST /location"
  | "GET /devices"
  | "POST /devices/command-result"
  | "POST /devices/file"
  | "GET /devices/file"
> {
  const { json, readJson, handlers: h } = host;
  return {
    // ── Mesh ───────────────────────────────────────────────────────────

    // Registration is also the heartbeat, so its reply is where a device
    // learns it should trade the shared token for its own credential, or
    // rotate the one it has (`credential.action`), and the other ways it
    // can reach this bridge when its usual URL stops working (`endpoints`).
    "POST /devices/register": async (ctx) => {
      const body = await readJson(ctx.req);
      const acting = actingDevice(host, ctx, body.id);
      if (!acting) return;
      const device = await h.registerDevice(
        withDevice(body, "id", acting.deviceId),
      );
      const hint = credentialHint(host.credentials, ctx.principal);
      const endpoints =
        ctx.principal && hasScope(ctx.principal, "device")
          ? host.endpoints()
          : undefined;
      json(ctx.res, 200, {
        ok: true,
        deviceId: device.id,
        ...(hint ? { credential: hint } : {}),
        ...(endpoints ? { endpoints } : {}),
      });
    },
    "POST /location": async (ctx) => {
      const body = await readJson(ctx.req);
      const acting = actingDevice(host, ctx, body.deviceId);
      if (!acting) return;
      await h.storeLocation(withDevice(body, "deviceId", acting.deviceId));
      json(ctx.res, 200, { ok: true });
    },
    "GET /devices": async ({ res }) => json(res, 200, await h.listDevices()),
    "POST /devices/command-result": async (ctx) => {
      const body = await readJson(ctx.req);
      // A credential answers as its own device only — so it can never
      // complete (or forge the result of) another device's command.
      const acting = actingDevice(host, ctx, body.deviceId);
      if (!acting) return;
      // ok:false for a late/unknown correlation id — not an HTTP error,
      // the device's POST was well-formed; nothing was waiting anymore.
      json(ctx.res, 200, {
        ok: h.completeCommand(withDevice(body, "deviceId", acting.deviceId)),
      });
    },
    "POST /devices/file": async (ctx) => {
      const { req, res, url } = ctx;
      const acting = actingDevice(host, ctx, deviceIdParam(url));
      if (!acting) return;
      const token = transferToken(host, url, res);
      if (token === null) return;
      const result = await h.acceptFileUpload(token, req, acting.deviceId);
      json(res, result.ok ? 200 : 409, result);
    },
    "GET /devices/file": async (ctx) => {
      const { res, url } = ctx;
      const acting = actingDevice(host, ctx, deviceIdParam(url));
      if (!acting) return;
      const token = transferToken(host, url, res);
      if (token === null) return;
      const file = await h.openFileDownload(token, acting.deviceId);
      if (!file)
        return json(res, 404, {
          ok: false,
          error: "Unknown or already-used transfer token",
        });
      host.streamFile(res, file);
    },
  };
}
