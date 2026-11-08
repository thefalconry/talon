import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteHost } from "./host.js";
import type { BridgeRoutes } from "./table.js";
import { BRIDGE_PROTOCOL_VERSION } from "../../protocol.js";

export function preAuthRoutes(
  host: RouteHost,
): Pick<
  BridgeRoutes,
  | "GET /health"
  | "GET /pair"
  | "GET /node/install"
  | "GET /node/binary"
  | "GET /secret"
  | "POST /secret"
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
    // Secret drop. GET shows the paste form and leaves the grant live, so
    // a chat app fetching the link for a preview can't burn it. POST
    // checks the grant BEFORE reading a byte of body — an anonymous caller
    // without one gets nothing read and a closed socket — then reads at
    // most SECRET_BODY_MAX bytes. The value goes to the core service and
    // nowhere else: not a log line, not an error message.
    "GET /secret": ({ res, url }) => {
      const form = h.openSecretDrop(url.searchParams.get("grant") ?? "");
      if (!form) return sendSecretPage(res, 404, notFoundPage());
      sendSecretPage(res, 200, form);
    },
    "POST /secret": async ({ req, res, url }) => {
      const token = url.searchParams.get("grant") ?? "";
      if (!h.isLiveSecretDrop(token)) {
        res.setHeader("Connection", "close");
        return sendSecretPage(res, 404, notFoundPage());
      }
      let body: string;
      try {
        body = await readCappedBody(req, SECRET_BODY_MAX);
      } catch {
        res.setHeader("Connection", "close");
        return sendSecretPage(res, 413, notFoundPage("Too large."));
      }
      const result = await h.submitSecretDrop(
        token,
        body,
        req.headers["content-type"],
      );
      sendSecretPage(res, result.status, result.html);
    },
    "GET /node/binary": ({ res, url }) => {
      const token = url.searchParams.get("provision") ?? "";
      const binary = token ? h.openNodeBinary(token) : null;
      if (!binary) return host.unknownProvision(res);
      host.streamFile(res, binary);
    },
  };
}

/** A form-encoded 64 KB value plus its encoding overhead, and no more. */
const SECRET_BODY_MAX = 200 * 1024;

/** Read a request body as UTF-8, refusing anything over `max` bytes. */
async function readCappedBody(
  req: IncomingMessage,
  max: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > max) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Secret-drop pages: no caching anywhere, no framing, no referrer, and a
 * CSP that allows inline style and a same-origin form post — nothing else.
 */
function sendSecretPage(
  res: ServerResponse,
  status: number,
  html: string,
): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(html);
}

function notFoundPage(message?: string): string {
  const text = message ?? "This link is unknown, expired, or already used.";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not available</title><p style="font:15px system-ui,sans-serif;padding:24px">${text} Ask for a fresh one with /secret &lt;name&gt;.</p>\n`;
}
