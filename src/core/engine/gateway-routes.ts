/**
 * The action gateway's HTTP routes — declared once, in order, rather than
 * implied by where an `if` sits in `Gateway.start`. Every request first
 * passes the transport guard (loopback Host, no browser Origin, JSON POST
 * bodies) and every route except `/health` requires the gateway token —
 * see gateway-auth.ts. The table is the list a reviewer reads.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { bus } from "../bus/index.js";
import { taskTable } from "../tasks/index.js";
import { agentRegistry } from "../agents/index.js";
import { handleHubRequest, HUB_PATH_PREFIX } from "../mcp-hub/index.js";
import { getMeshService } from "../mesh/index.js";
import {
  credentialAdmin,
  credentialOverview,
  type CredentialAdminContext,
} from "../mesh/credentials/index.js";
import { log, logError } from "../../util/log.js";
import { checkGatewayTransport, hasValidGatewayToken } from "./gateway-auth.js";

/** What the routes need from the Gateway that owns them. */
export type GatewayRouteHost = {
  /** The port the gateway is bound to — the only Host port it answers on. */
  port: () => number;
  /** The token every non-public route requires. */
  token: () => string;
  /**
   * The /health body. `full` (an authenticated caller) adds the live
   * counters; without it only the identity fields discovery matches on.
   */
  healthSnapshot: (full: boolean) => Record<string, unknown>;
  /** Schedule a graceful stop; false when this process cannot be stopped this way. */
  requestShutdown: () => boolean;
  /** Hot-reload plugins from config; resolves to the loaded plugin names. */
  reloadPlugins: () => Promise<string[]>;
  /** Origin the MCP hub advertises for its own endpoints. */
  hubOrigin: () => string;
  /** The /action body handler. */
  handleAction: (body: Record<string, unknown>) => Promise<unknown>;
};

type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  host: GatewayRouteHost;
  /** True when the request carried a valid gateway token. */
  authenticated: boolean;
};

type GatewayRoute = {
  method: "GET" | "POST" | "ANY";
  path: string;
  /** `prefix` matches `path` as a leading segment; default is an exact match. */
  match?: "prefix";
  /** Served without the gateway token (still behind the transport guard). */
  public?: boolean;
  handle: (ctx: RouteContext) => void | Promise<void>;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // Serialise before writing headers: a body that cannot be stringified
  // must surface as a 500, not as a half-sent 200 that never ends.
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

const ROUTES: readonly GatewayRoute[] = [
  {
    // Unauthenticated so discovery, container healthchecks and the MCP
    // launcher's watchdog can probe it — which is why an anonymous caller
    // only gets the identity fields, never the live counters.
    method: "GET",
    path: "/health",
    public: true,
    handle: ({ res, host, authenticated }) =>
      sendJson(res, 200, host.healthSnapshot(authenticated)),
  },
  {
    // Graceful stop for `talon stop`/`talon restart`. Respond before
    // triggering so the client isn't cut off mid-request; the shutdown
    // path takes seconds, so the reply flushes safely.
    method: "POST",
    path: "/shutdown",
    handle: ({ res, host }) => {
      if (!host.requestShutdown()) {
        sendJson(res, 501, {
          ok: false,
          error: "Shutdown not supported by this process",
        });
        return;
      }
      sendJson(res, 200, { ok: true });
    },
  },
  {
    // Bus tail — recent events, optionally after a cursor. Read by `talon events`.
    method: "GET",
    path: "/events/recent",
    match: "prefix",
    handle: ({ res, url }) => {
      const since = Number(url.searchParams.get("since") ?? "0");
      sendJson(res, 200, {
        ok: true,
        events: bus.recent(Number.isInteger(since) && since > 0 ? since : 0),
      });
    },
  },
  {
    // The task table — every live/recent unit of agent work. Read by `talon ps`.
    method: "GET",
    path: "/tasks",
    handle: ({ res }) =>
      sendJson(res, 200, { ok: true, tasks: taskTable.list() }),
  },
  {
    // The sub-agent registry — live agents plus the settled ring. Same
    // content-free contract as /tasks: ids, labels, states, never briefs.
    method: "GET",
    path: "/agents",
    handle: ({ res }) =>
      sendJson(res, 200, {
        ok: true,
        agents: agentRegistry.list().map(({ brief: _brief, ...rest }) => rest),
      }),
  },
  {
    // Abort one killable task by id — the transport for `talon kill`.
    method: "POST",
    path: "/tasks/kill",
    handle: async ({ req, res }) => {
      let id: unknown;
      try {
        id = ((await readJsonBody(req)) as { id?: unknown }).id;
      } catch {
        sendJson(res, 400, { ok: false, error: "Invalid JSON" });
        return;
      }
      if (typeof id !== "number" || !Number.isInteger(id)) {
        sendJson(res, 400, { ok: false, error: "id must be an integer" });
        return;
      }
      sendJson(res, 200, taskTable.kill(id));
    },
  },
  {
    // Hot-reload plugins from config — the transport for `talon plugin
    // install/enable/disable`, which has no chat context and so cannot use
    // the reload_plugins action.
    method: "POST",
    path: "/plugins/reload",
    handle: async ({ res, host }) => {
      try {
        const loaded = await host.reloadPlugins();
        log("gateway", `/plugins/reload: ${loaded.length} plugins loaded`);
        sendJson(res, 200, { ok: true, loaded });
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          error: `Plugin reload failed: ${err instanceof Error ? err.message : err}`,
        });
      }
    },
  },
  {
    // Per-device mesh credentials — the transport for `talon mesh`.
    method: "GET",
    path: "/mesh/credentials",
    handle: async ({ req, res }) => {
      const ctx = await meshCredentialContext(req, res);
      if (ctx) sendJson(res, 200, await credentialOverview(ctx));
    },
  },
  {
    // `talon mesh revoke|rotate|scopes <device>`. Revocation drops the
    // device's live bridge sessions before this answers.
    method: "POST",
    path: "/mesh/credentials",
    handle: async ({ req, res }) => {
      const ctx = await meshCredentialContext(req, res);
      if (!ctx) return;
      // A JSON content type forces a CORS preflight this gateway never
      // grants, so a web page cannot drive credential changes via the
      // user's browser (a text/plain "simple" POST would skip it).
      if (!(req.headers["content-type"] ?? "").includes("application/json")) {
        sendJson(res, 415, { ok: false, error: "Expected application/json" });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(req)) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { ok: false, error: "Invalid JSON" });
        return;
      }
      sendJson(res, 200, await credentialAdmin(ctx, body));
    },
  },
  {
    // The mesh command audit — the transport for `talon mesh audit`.
    // Prefix match: the query (?limit=&device=) follows the path.
    method: "GET",
    path: "/mesh/audit",
    match: "prefix",
    handle: async ({ res, url }) => {
      const limit = Number(url.searchParams.get("limit") ?? "");
      const device = url.searchParams.get("device") ?? "";
      const entries = await getMeshService().readAudit({
        ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
        ...(device ? { device } : {}),
      });
      sendJson(res, 200, { ok: true, entries });
    },
  },
  {
    // MCP hub — daemon-hosted MCP-over-HTTP endpoints for every backend
    // (see core/mcp-hub).
    method: "ANY",
    path: HUB_PATH_PREFIX,
    match: "prefix",
    handle: ({ req, res, host }) =>
      handleHubRequest(req, res, host.hubOrigin()),
  },
  {
    method: "POST",
    path: "/action",
    handle: async ({ req, res, host }) => {
      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(req)) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { ok: false, error: "Invalid JSON" });
        return;
      }
      sendJson(res, 200, await host.handleAction(body));
    },
  },
];

/**
 * The mesh's credential admin context, or null after answering why not.
 * Browser-originated requests are refused outright: only local processes
 * (the CLI) manage credentials.
 */
async function meshCredentialContext(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<CredentialAdminContext | null> {
  if (req.headers.origin) {
    sendJson(res, 403, { ok: false, error: "Browser requests are refused" });
    return null;
  }
  const mesh = getMeshService();
  await mesh.load();
  const ctx = mesh.credentialAdminContext();
  if (!ctx) {
    sendJson(res, 501, {
      ok: false,
      error: "This daemon has no per-device credential store",
    });
  }
  return ctx;
}

function matches(route: GatewayRoute, req: IncomingMessage): boolean {
  if (route.method !== "ANY" && req.method !== route.method) return false;
  const url = req.url ?? "";
  return route.match === "prefix"
    ? url.startsWith(route.path)
    : url === route.path;
}

/** Serve one request: first matching route wins; nothing matches → 404. */
export async function dispatchGatewayRoute(
  req: IncomingMessage,
  res: ServerResponse,
  host: GatewayRouteHost,
): Promise<void> {
  const refusal = checkGatewayTransport(req, host.port());
  if (refusal) {
    sendJson(res, refusal.status, { ok: false, error: refusal.error });
    return;
  }
  const authenticated = hasValidGatewayToken(req, host.token());
  const route = ROUTES.find((candidate) => matches(candidate, req));
  if (!authenticated && !route?.public) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }
  if (!route) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  try {
    await route.handle({
      req,
      res,
      url: new URL(req.url ?? "/", "http://gateway"),
      host,
      authenticated,
    });
  } catch (err) {
    if (res.headersSent) return;
    // Log full error (incl. stack via logError's structured `stack` field)
    // on the server; return a generic message to the client so we don't
    // leak implementation details. CodeQL: js/stack-trace-exposure.
    logError("gateway", `Unhandled error on ${req.method} ${req.url}`, err);
    sendJson(res, 500, { ok: false, error: "Internal server error" });
  }
}

const PORT_RETRIES = 5;

/**
 * Bind to 127.0.0.1, walking up from `port` on EADDRINUSE (at most
 * `PORT_RETRIES` times). Resolves with the port actually bound — `port`
 * 0 asks the OS for a free one — and leaves a persistent error handler
 * on the server, so a later server-level error is logged instead of
 * crashing the process via an unhandled 'error' event.
 */
export function listenWithRetry(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let attempt = 0;
    const tryPort = (candidate: number): void => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < PORT_RETRIES) {
          attempt++;
          server.removeAllListeners("error");
          // The failed listen() left its one-shot 'listening' callback
          // registered; drop it or every stale callback fires when a later
          // port finally binds.
          server.removeAllListeners("listening");
          tryPort(candidate + 1);
        } else {
          reject(err);
        }
      });
      server.listen(candidate, "127.0.0.1", () => {
        const addr = server.address();
        const bound =
          typeof addr === "object" && addr !== null
            ? (addr as { port: number }).port
            : candidate;
        server.removeAllListeners("error");
        server.on("error", (err) =>
          logError("gateway", "HTTP server error", err),
        );
        resolve(bound);
      });
    };
    tryPort(port);
  });
}
