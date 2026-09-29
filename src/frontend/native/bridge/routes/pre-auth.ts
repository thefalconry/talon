import type { RouteHost } from "./host.js";
import type { BridgeRoutes } from "./table.js";
import { BRIDGE_PROTOCOL_VERSION } from "../../protocol.js";

export function preAuthRoutes(
  host: RouteHost,
): Pick<
  BridgeRoutes,
  "GET /health" | "GET /pair" | "GET /node/install" | "GET /node/binary"
> {
  const { json, handlers: h } = host;
  return {
    // ── Pre-auth ───────────────────────────────────────────────────────

    // Unauthenticated so clients can discover/ping the bridge before they
    // hold a token. Pre-auth it serves only what pairing needs (identity,
    // protocol, fingerprint) — operational details like bot name,
    // backend, and chat count are not for internet scanners to enumerate.
    "GET /health": ({ res, auth }) => {
      const base = {
        app: "talon-bridge",
        ok: true,
        protocol: BRIDGE_PROTOCOL_VERSION,
        port: host.port(),
        scheme: host.scheme(),
        // The certificate's own hash — public by definition (any TLS
        // client sees the certificate), surfaced so pairing UIs can
        // display it.
        fingerprint: host.fingerprint(),
        authRequired: Boolean(host.opts.token),
      };
      if (auth !== "ok") return json(res, 200, base);
      const s = h.status();
      return json(res, 200, {
        ...base,
        host: host.opts.host,
        startedAt: host.opts.startedAt,
        botName: s.botName,
        backend: s.backend,
        model: s.model,
        activeChats: s.activeChats,
        capabilities: ["mesh", "mesh-commands", "mesh-file-stream"],
      });
    },

    // Companion pairing: the phone holds no bridge credential yet, and
    // the single-use grant is what it comes to collect. Serving the page
    // IS the handover, so the grant is spent whichever leg is hit.
    "GET /pair": ({ req, res, url }) => {
      const token = url.searchParams.get("grant") ?? "";
      const wantsJson =
        url.searchParams.get("format") === "json" ||
        (req.headers.accept ?? "").includes("application/json");
      const served = token
        ? h.openCompanionPair(token, wantsJson ? "json" : "html")
        : null;
      if (!served) {
        return json(res, 404, {
          ok: false,
          error: "Unknown, expired, or already-used pairing link",
        });
      }
      res.writeHead(200, {
        "Content-Type": served.contentType,
        // A pairing payload is a credential; nothing may keep a copy.
        "Cache-Control": "no-store",
        ...host.corsHeaders(),
      });
      res.end(served.body);
    },

    // Node provisioning: the target host holds no bridge credential yet —
    // the single-use grant token (minted by make_node_install_link,
    // expiring, one serve per leg) is the entire authorization, the same
    // trust model as streamed-transfer tokens.
    "GET /node/install": async ({ res, url }) => {
      const token = url.searchParams.get("provision") ?? "";
      const install = token
        ? await h.openNodeInstall(
            token,
            url.searchParams.get("os"),
            url.searchParams.get("arch"),
          )
        : null;
      if (!install) return host.unknownProvision(res);
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${install.filename}"`,
        ...host.corsHeaders(),
      });
      res.end(install.script);
    },
    "GET /node/binary": ({ res, url }) => {
      const token = url.searchParams.get("provision") ?? "";
      const binary = token ? h.openNodeBinary(token) : null;
      if (!binary) return host.unknownProvision(res);
      host.streamFile(res, binary);
    },
  };
}
