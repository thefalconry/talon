/**
 * Bridge server — the HTTP + Server-Sent Events transport for the Talon
 * Client Bridge Protocol (see protocol.ts).
 *
 * Pure transport: it parses requests, enforces the optional bearer token,
 * fans SSE events out to every connected client, and delegates all logic to
 * the injected `BridgeServerHandlers`. No engine imports live here, so the
 * same server serves the Electron desktop app, a remote Android client, or a
 * curl one-liner identically.
 *
 * Binds `host` (loopback by default) with the gateway's EADDRINUSE +1..+5
 * fallback so two daemons on one machine don't collide. With a TLS identity
 * injected (see tls.ts) the same server speaks HTTPS instead — clients pin
 * the certificate fingerprint surfaced on `/health`.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { log, logError, logDebug, logWarn } from "../../../util/log.js";
import {
  raiseAlert,
  resolveAlert,
} from "../../../core/frontend-runtime/alerts.js";
import { errorText } from "../../health/outage.js";
import {
  certificateSpkiPin,
  formatFingerprint,
  isLoopbackHost,
  type BridgeTlsIdentity,
} from "./tls.js";
import { checkBridgeTokenStrength } from "./auth.js";
import { AuthGuard, type AuthGuardPolicy } from "./auth-guard.js";
import { basename } from "node:path";
import { contentTypeFor, safeUploadName } from "../media/media.js";
import { type BridgeEvent } from "../protocol.js";
import { buildRoutes } from "./routes/index.js";
import type { BridgeServerHandlers, RouteHost } from "./routes/host.js";
import type { AdvertisedEndpoints } from "../../../core/mesh/links/endpoints.js";
import {
  BRIDGE_ROUTE_AUTH,
  QUERY_TOKEN_ROUTES,
  type AuthState,
  type BridgeRouteKey,
  type RouteContext,
  type RouteHandler,
} from "./routes/table.js";
import {
  describeTier,
  hasScope,
  presentedCredentialId,
  resolvePrincipal,
  routeAllows,
  type BridgeCredentials,
  type BridgePrincipal,
} from "./credentials/principal.js";

export type { BridgeServerHandlers, SendOptions } from "./routes/host.js";
export { BRIDGE_ROUTE_AUTH, type BridgeRouteKey } from "./routes/table.js";
export type { BridgeCredentials } from "./credentials/principal.js";

/** One live SSE connection: the device it claimed and who opened it. */
type StreamSession = {
  deviceId: string | undefined;
  principal: BridgePrincipal;
};

const SSE_PING_MS = 25_000;
/**
 * Unsent bytes a stream may hold before it counts as dead. A client that
 * stops reading without closing (phone asleep, network switch) otherwise
 * buffers every broadcast in memory until TCP gives up on it, minutes later.
 * Far past anything a live client falls behind by; evicted, it reconnects
 * and gets a fresh `hello`.
 */
const SSE_MAX_BACKLOG_BYTES = 16 * 1024 * 1024;
// Device command results ride this route, and a `computer` screenshot is up
// to 300 KB of JPEG, i.e. ~400 KB once base64'd into JSON. At 256 KB a busy
// screen's result was rejected and the daemon timed out waiting for it.
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Routes a page served by the bridge itself posts a plain HTML form to
 * (the secret drop). A browser stamps that POST with the bridge's own
 * origin, which is no cross-site request — so these, and only these,
 * accept it without `native.allowedOrigins`. Every other route still
 * refuses any Origin not configured, same-origin included: a page under
 * /media is the bridge's origin too.
 */
const SAME_ORIGIN_FORM_ROUTES: ReadonlySet<string> = new Set(["POST /secret"]);

/** `host[:port]` of an Origin header, or undefined when it doesn't parse. */
function originHost(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}
const PORT_FALLBACKS = 5;

/**
 * Server-level socket deadlines (slow-loris resistance). Node applies
 * `requestTimeout` only until the request has been fully RECEIVED, so the
 * long-lived SSE stream (a bodyless GET) and file downloads (response
 * bodies) are unaffected. It does bound request bodies, and every
 * body-reading route sits behind the bearer check (an unauthenticated
 * request is answered 401/429 with `Connection: close` before its body is
 * read) — the one pre-auth exception, `POST /secret`, reads a body only
 * for a live single-use grant and caps it at 200 KB — so the budget is sized for the largest authenticated upload
 * (512 MB) on a slow link, not for an attacker.
 */
export type BridgeTimeouts = {
  /** Whole header block must arrive within this. Node default: 60s. */
  headersMs: number;
  /** Whole request (headers + body) must arrive within this. Node: 300s. */
  requestMs: number;
  /** Idle keep-alive sockets are closed after this. */
  keepAliveMs: number;
  /** How often Node sweeps for expired header/request deadlines. */
  checkIntervalMs: number;
};

export const DEFAULT_BRIDGE_TIMEOUTS: BridgeTimeouts = {
  headersMs: 20_000,
  requestMs: 30 * 60_000,
  keepAliveMs: 5_000,
  checkIntervalMs: 30_000,
};

/**
 * `pipe` never closes its source when the destination goes away, so a
 * client that hangs up mid-download (app backgrounded, image scrolled
 * away) would leave the paused read stream holding its fd forever.
 */
function releaseOnClose(res: ServerResponse, stream: ReadStream): void {
  res.once("close", () => stream.destroy());
}

export class BridgeServer {
  private server: Server | null = null;
  /**
   * Live SSE connections → the mesh device id each one claimed on connect
   * (undefined for clients that didn't claim one: desktop UIs, and companion
   * builds from before the claim existed) and the principal that opened it.
   * The claim is what makes `sendToDevice` addressable rather than a shout;
   * the principal is what lets a revocation find and drop the session.
   */
  private clients = new Map<ServerResponse, StreamSession>();
  private unsubscribeRevocations: (() => void) | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private port = 0;
  private tlsIdentity: BridgeTlsIdentity | null = null;
  /** Backoff, lockout and the global failure budget for wrong tokens. */
  private readonly authGuard: AuthGuard;
  /** `METHOD /path` → handler; a Map so lookups only ever hit own entries. */
  private readonly routes: ReadonlyMap<BridgeRouteKey, RouteHandler>;

  constructor(
    private readonly opts: {
      host: string;
      port: number;
      token?: string;
      /** Origins permitted to call the bridge from a browser. Empty by
       *  default: native clients send no Origin and need no entry here. */
      allowedOrigins?: readonly string[];
      startedAt: string;
      /**
       * When present, the bridge serves HTTPS with this identity. A provider
       * (not the identity itself) so the transport stays free of key-file
       * I/O — it resolves once, inside `start()`.
       */
      tls?: () => Promise<BridgeTlsIdentity>;
      /**
       * Per-device credentials (core/mesh/credentials) and the migration
       * policy. Absent: the shared `token` is the only credential, as
       * before.
       */
      credentials?: BridgeCredentials;
      /** `native.allowWeakToken`: start on a public bind despite a weak token. */
      allowWeakToken?: boolean;
      /** Operator alert for security events (the global auth cooldown). */
      onSecurityAlert?: (message: string) => void;
      /**
       * `native.sseMaxLifetimeMs`: end each event stream after this long
       * (±10% jitter) so clients re-authenticate. Unset = never.
       */
      sseMaxLifetimeMs?: number;
      /**
       * `native.endpoints`, resolved: the other ways devices can reach this
       * bridge, sent in every device's register reply. Absent = no field.
       */
      endpoints?: AdvertisedEndpoints;
      /** Overrides for tests; production uses the defaults. */
      authPolicy?: Partial<AuthGuardPolicy>;
      timeouts?: Partial<BridgeTimeouts>;
    },
    private readonly handlers: BridgeServerHandlers,
  ) {
    this.authGuard = new AuthGuard(opts.authPolicy, {
      onAlert: opts.onSecurityAlert,
    });
    this.routes = new Map(
      Object.entries(buildRoutes(this.routeHost())) as [
        BridgeRouteKey,
        RouteHandler,
      ][],
    );
  }

  getPort(): number {
    return this.port;
  }

  /** "https" once started with a TLS identity, else "http". */
  getScheme(): "http" | "https" {
    return this.tlsIdentity ? "https" : "http";
  }

  /** The served certificate's SHA-256 fingerprint (hex), or null over HTTP. */
  getFingerprint(): string | null {
    return this.tlsIdentity?.fingerprint ?? null;
  }

  /** The served key's SPKI pin (base64 SHA-256), or null over HTTP. */
  getSpkiPin(): string | null {
    return this.tlsIdentity
      ? certificateSpkiPin(this.tlsIdentity.certPem)
      : null;
  }

  /**
   * Push an event to every connected SSE client that may see it. Chat
   * traffic is for `client`-scoped sessions only; a device-only credential
   * hears the mesh-wide `locate` and nothing else.
   */
  broadcast(event: BridgeEvent): void {
    if (this.clients.size === 0) return;
    const targets: ServerResponse[] = [];
    for (const [res, session] of this.clients) {
      if (event.kind === "locate" || hasScope(session.principal, "client")) {
        targets.push(res);
      }
    }
    this.write(targets, event);
  }

  /**
   * End every live stream opened with one of `credentialIds` — revocation
   * (and a scope change) must bite now, not at the client's next request.
   */
  dropCredentialSessions(credentialIds: readonly string[]): number {
    let dropped = 0;
    for (const [res, { principal }] of this.clients) {
      if (
        principal.kind === "device" &&
        credentialIds.includes(principal.credentialId)
      ) {
        this.clients.delete(res);
        try {
          res.end();
        } catch {
          /* already gone */
        }
        dropped++;
      }
    }
    if (dropped > 0) {
      log(
        "native",
        `Dropped ${dropped} live session(s) of revoked/changed credential(s) ${credentialIds.join(", ")}`,
      );
    }
    return dropped;
  }

  /**
   * Push an event to the client(s) that claimed `deviceId` — the delivery
   * path for anything addressed to ONE device.
   *
   * Device commands are not public: their params carry one-time transfer
   * tokens, exec command lines, remote paths, and — on the chunked fallback —
   * whole base64 file bodies. Broadcasting them would hand every connected
   * client another device's secrets and rely on each client discarding what
   * isn't addressed to it, which is courtesy, not enforcement.
   *
   * A claim is an ADDRESS, not a credential: any client holding the bridge
   * token could claim any id, and the bridge token is (still) the only trust
   * boundary here. What this buys is that a device does not passively
   * receive traffic meant for its peers.
   *
   * Clients that claimed nothing are the fallback audience, and only when the
   * target claimed nothing either: a companion build that predates the claim
   * can't be addressed, and dropping its commands would take the mesh offline
   * for it. So an updated device's traffic never reaches them — the fallback
   * shrinks to nothing as the fleet updates. Only shared-token sessions are
   * in that fallback: a per-device credential is its own device or nobody.
   *
   * With per-device credentials the claim IS enforced: a credential can
   * only claim the device it is bound to (credentials/claims.ts).
   */
  sendToDevice(deviceId: string, event: BridgeEvent): void {
    if (this.clients.size === 0) return;
    const claimed: ServerResponse[] = [];
    const unclaimed: ServerResponse[] = [];
    for (const [res, { deviceId: id, principal }] of this.clients) {
      if (id === deviceId) claimed.push(res);
      else if (id === undefined && principal.kind !== "device") {
        unclaimed.push(res);
      }
    }
    if (claimed.length === 0) {
      logDebug(
        "native",
        `No SSE client claims device ${deviceId} — delivering to ${unclaimed.length} unclaimed client(s)`,
      );
    }
    this.write(claimed.length > 0 ? claimed : unclaimed, event);
  }

  private write(targets: Iterable<ServerResponse>, event: BridgeEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of targets) this.send(res, payload);
  }

  /** Write one frame to a stream, evicting it if its backlog never drains. */
  private send(res: ServerResponse, frame: string): void {
    if (res.writableLength > SSE_MAX_BACKLOG_BYTES) {
      this.clients.delete(res);
      logWarn(
        "native",
        `Dropped an SSE client that stopped reading (${res.writableLength} bytes unsent)`,
      );
      res.destroy();
      return;
    }
    try {
      res.write(frame);
    } catch {
      // Write on a half-closed socket — the 'close' handler will evict it.
    }
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    checkBridgeTokenStrength({
      token: this.opts.token,
      loopback: isLoopbackHost(this.opts.host),
      allowWeakToken: this.opts.allowWeakToken,
    });
    this.tlsIdentity = this.opts.tls ? await this.loadTls(this.opts.tls) : null;
    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      this.handle(req, res).catch((err) => {
        logError("native", "Bridge request handler threw", err);
        if (!res.headersSent) {
          res.writeHead(500, this.jsonHeaders());
          res.end(JSON.stringify({ ok: false, error: "Internal error" }));
        }
      });
    };
    // https.Server extends http.Server's request/lifecycle surface — one
    // `Server`-typed field serves both transports.
    const t = { ...DEFAULT_BRIDGE_TIMEOUTS, ...this.opts.timeouts };
    const serverOpts = {
      headersTimeout: t.headersMs,
      requestTimeout: t.requestMs,
      keepAliveTimeout: t.keepAliveMs,
      connectionsCheckingInterval: t.checkIntervalMs,
    };
    const server: Server = this.tlsIdentity
      ? createTlsServer(
          {
            ...serverOpts,
            key: this.tlsIdentity.keyPem,
            cert: this.tlsIdentity.certPem,
          },
          onRequest,
        )
      : createServer(serverOpts, onRequest);

    this.pingTimer = setInterval(() => {
      for (const res of this.clients.keys()) this.send(res, ": ping\n\n");
    }, SSE_PING_MS);
    this.pingTimer.unref?.();
    this.unsubscribeRevocations = this.opts.credentials?.authority.onRevoked(
      (ids) => this.dropCredentialSessions(ids),
    );

    return this.bind(server);
  }

  /**
   * The TLS identity, or a thrown boot failure the operator hears about:
   * without it no companion app can connect.
   */
  private async loadTls(
    load: () => Promise<BridgeTlsIdentity>,
  ): Promise<BridgeTlsIdentity> {
    try {
      const identity = await load();
      resolveAlert(
        "bridge.tls",
        "The client bridge TLS certificate loads again.",
      );
      return identity;
    } catch (err) {
      logError("native", `bridge.tls.fail err=${errorText(err)}`, err);
      raiseAlert(
        "bridge.tls",
        `The client bridge could not load its TLS certificate: ${errorText(err)}. Companion apps cannot connect.`,
        { severity: "critical" },
      );
      throw err;
    }
  }

  /**
   * Listen on the configured port, stepping up to PORT_FALLBACKS ports past
   * it when one is taken. A bind that fails for good raises `bridge.listen`
   * — the frontend has no surface at all without it.
   */
  private bind(server: Server): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let attempt = 0;
      const tryPort = (p: number): void => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && attempt < PORT_FALLBACKS) {
            attempt++;
            logWarn(
              "native",
              `bridge.listen port=${p} in use — trying port=${p + 1} attempt=${attempt}/${PORT_FALLBACKS}`,
            );
            server.removeAllListeners("error");
            server.removeAllListeners("listening");
            tryPort(p + 1);
          } else {
            logError(
              "native",
              `bridge.listen.fail host=${this.opts.host} port=${p} attempt=${attempt} err=${errorText(err)}`,
            );
            raiseAlert(
              "bridge.listen",
              `The client bridge could not listen on ${this.opts.host}:${p}: ${errorText(err)}. Companion apps cannot connect.`,
              { severity: "critical" },
            );
            reject(err);
          }
        });
        server.listen(p, this.opts.host, () => {
          this.server = server;
          const addr = server.address();
          this.port =
            typeof addr === "object" && addr !== null
              ? (addr as { port: number }).port
              : p;
          server.removeAllListeners("error");
          server.on("error", (err) =>
            logError("native", "Bridge server error", err),
          );
          log(
            "native",
            `Bridge listening on ${this.getScheme()}://${this.opts.host}:${this.port}` +
              (this.opts.token ? " (token required)" : ""),
          );
          if (this.tlsIdentity) {
            // The pairing datum: clients confirm this fingerprint on first
            // connect, so it belongs in the log where the operator looks.
            log(
              "native",
              `Bridge certificate fingerprint ${formatFingerprint(this.tlsIdentity.fingerprint)}`,
            );
          }
          resolveAlert(
            "bridge.listen",
            "The client bridge is listening again.",
          );
          resolve(this.port);
        });
      };
      tryPort(this.opts.port);
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.pingTimer);
    this.unsubscribeRevocations?.();
    this.unsubscribeRevocations = undefined;
    for (const res of this.clients.keys()) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        this.port = 0;
        resolve();
      });
    });
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://bridge");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // Origin / Host guard runs before everything, including OPTIONS: a
    // preflight that answers 204 to any origin is itself the permission
    // slip the browser is asking for.
    const origin =
      typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const refusal = this.originGuard(
      req,
      SAME_ORIGIN_FORM_ROUTES.has(`${method} ${path}`),
    );
    if (refusal !== undefined) {
      res.writeHead(403, {
        ...this.corsHeaders(),
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ ok: false, error: refusal }));
      return;
    }
    // Set once here rather than in corsHeaders(): setHeader values survive
    // every later writeHead(code, {...}) that does not name the same key,
    // so each of the response sites keeps the grant without threading the
    // origin through all of them.
    if (origin !== undefined && this.isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    if (method === "OPTIONS") {
      res.writeHead(204, this.corsHeaders());
      res.end();
      return;
    }

    const remote = req.socket.remoteAddress ?? "unknown";
    const key = `${method} ${path}` as BridgeRouteKey;
    const {
      state: auth,
      principal,
      credentialId,
    } = this.authState(req, url, QUERY_TOKEN_ROUTES.has(key));
    if (!(await this.admit(res, remote, auth, credentialId))) return;

    const route = this.routes.get(key);
    const ctx: RouteContext = { req, res, url, auth, principal };
    const tier = route ? BRIDGE_ROUTE_AUTH[key] : undefined;

    if (route && tier === "public") {
      await route(ctx);
      return;
    }
    // Unknown routes are 401 before they are 404: an unauthenticated caller
    // learns nothing about the route map.
    if (auth !== "ok" || principal === null) {
      return this.refuse(res, 401, "Unauthorized");
    }
    if (!route || tier === undefined) {
      return this.json(res, 404, { ok: false, error: "Not found" });
    }
    // Authenticated, but is this credential allowed HERE? The scope each
    // route needs is declared in routes/table.ts.
    if (!routeAllows(tier, principal)) {
      return this.json(res, 403, {
        ok: false,
        error: `This credential lacks the ${describeTier(tier)} scope ${key} requires`,
      });
    }

    try {
      await route(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.json(res, 400, { ok: false, error: msg });
    }
  }

  /** The surface the route modules get — bound closures, never the class. */
  private routeHost(): RouteHost {
    return {
      handlers: this.handlers,
      opts: this.opts,
      port: () => this.port,
      scheme: () => this.getScheme(),
      fingerprint: () => this.getFingerprint(),
      json: (res, code, body) => this.json(res, code, body),
      readJson: (req) => this.readJson(req),
      corsHeaders: () => this.corsHeaders(),
      streamFile: (res, file) => this.streamFile(res, file),
      serveMedia: (res, id) => this.serveMedia(res, id),
      openStream: (res, deviceId, principal) =>
        this.openStream(res, deviceId, principal),
      credentials: this.opts.credentials,
      endpoints: () => this.opts.endpoints,
      unknownProvision: (res) => this.unknownProvision(res),
    };
  }

  private unknownProvision(res: ServerResponse): void {
    this.json(res, 404, {
      ok: false,
      error: "Unknown, expired, or already-used provisioning token",
    });
  }

  /** Stream a file whose size is already known as an octet-stream body. */
  private streamFile(
    res: ServerResponse,
    file: { path: string; size: number },
  ): void {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.size),
      ...this.corsHeaders(),
    });
    const stream = createReadStream(file.path);
    stream.on("error", () => res.destroy());
    releaseOnClose(res, stream);
    stream.pipe(res);
  }

  /** Stream an attached image by id. Auth is already enforced by `handle`. */
  private async serveMedia(res: ServerResponse, id: string): Promise<void> {
    const filePath = id ? this.handlers.mediaPath(id) : null;
    if (!filePath) {
      return this.json(res, 404, { ok: false, error: "No such media" });
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return this.json(res, 404, { ok: false, error: "No such media" });
      }
      const rawName =
        this.handlers.mediaName?.(id) ??
        basename(filePath).replace(/^\d+-[0-9a-z]+-/, "");
      const filename = safeUploadName(rawName);
      res.writeHead(200, {
        ...this.corsHeaders(),
        "Content-Type": contentTypeFor(filePath),
        "Content-Length": String(info.size),
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, max-age=3600",
      });
      const stream = createReadStream(filePath);
      stream.on("error", () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      releaseOnClose(res, stream);
      stream.pipe(res);
    } catch {
      return this.json(res, 404, { ok: false, error: "No such media" });
    }
  }

  private openStream(
    res: ServerResponse,
    deviceId: string | undefined,
    principal: BridgePrincipal,
  ): void {
    // A device-only credential gets its own mesh traffic, not the chats.
    const seesChats = hasScope(principal, "client");
    res.writeHead(200, {
      ...this.corsHeaders(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 3000\n\n`);
    // Opening snapshot so a freshly-connected client renders immediately.
    res.write(
      `data: ${JSON.stringify({
        kind: "hello",
        status: this.handlers.status(),
        chats: seesChats ? this.handlers.listChats() : [],
      })}\n\n`,
    );
    // Replay any in-progress turn so a client that connected mid-turn (or
    // reconnected after a blip) sees the tool timeline immediately, not just
    // the tools that fire after it joined.
    try {
      for (const event of seesChats ? this.handlers.liveTurnEvents() : []) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      logError("native", "Failed to replay live turn to new client", err);
    }
    this.clients.set(res, { deviceId, principal });
    logDebug(
      "native",
      `SSE client connected${deviceId ? ` as device ${deviceId}` : ""} (${this.clients.size} total)`,
    );
    const lifetime = this.sseLifetimeTimer(res);
    res.on("close", () => {
      clearTimeout(lifetime);
      this.clients.delete(res);
      logDebug("native", `SSE client left (${this.clients.size} total)`);
    });
  }

  /**
   * Optional max lifetime for an event stream: ending it makes the client
   * reconnect and present its token again. Off unless configured —
   * clients do reconnect, but with their own backoff, and a device command
   * sent in that gap is lost.
   */
  private sseLifetimeTimer(
    res: ServerResponse,
  ): ReturnType<typeof setTimeout> | undefined {
    const max = this.opts.sseMaxLifetimeMs;
    if (!max || max <= 0) return undefined;
    // Jitter so a fleet that connected together doesn't reconnect together.
    const ms = Math.round(max * (0.9 + Math.random() * 0.2));
    const timer = setTimeout(() => {
      logDebug("native", "bridge.sse event=max_lifetime reason=expired");
      // Out of the fan-out before end(): a stream still flushing a backlog
      // stays open until it drains, and a broadcast in that window is a
      // write after end — an unhandled 'error' that takes the daemon down.
      this.clients.delete(res);
      res.end();
    }, ms);
    timer.unref?.();
    return timer;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Evaluate the presented credential. `queryToken` says whether this route
   * also takes it as `?token=` (QUERY_TOKEN_ROUTES); elsewhere a query
   * token is ignored, so the request reads as tokenless. A refused
   * per-device credential reports the id it named, for the auth guard.
   */
  private authState(
    req: IncomingMessage,
    url: URL,
    queryToken: boolean,
  ): {
    state: AuthState;
    principal: BridgePrincipal | null;
    credentialId: string | null;
  } {
    if (!this.opts.token) {
      return { state: "ok", principal: { kind: "open" }, credentialId: null };
    }
    const header = req.headers["authorization"];
    const fromHeader =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : null;
    const candidate =
      fromHeader ?? (queryToken ? url.searchParams.get("token") : null);
    if (candidate === null) {
      return { state: "anonymous", principal: null, credentialId: null };
    }
    // The shared token or a per-device credential (credentials/principal.ts).
    const principal = resolvePrincipal(
      candidate,
      req,
      (c) => this.tokenMatches(c),
      this.opts.credentials,
    );
    return principal
      ? { state: "ok", principal, credentialId: null }
      : {
          state: "bad",
          principal: null,
          credentialId: presentedCredentialId(candidate),
        };
  }

  /**
   * Apply the auth guard's verdict. Returns false once it has answered the
   * request itself (429), true when routing should continue — after any
   * backoff wait has elapsed.
   */
  private async admit(
    res: ServerResponse,
    remote: string,
    auth: AuthState,
    credentialId: string | null,
  ): Promise<boolean> {
    const verdict = this.authGuard.check(remote, auth, credentialId);
    if (verdict.kind === "reject") {
      this.refuse(
        res,
        429,
        verdict.reason === "lockout"
          ? "Too many failed auth attempts"
          : "Too many failed auth attempts; try again later",
        verdict.retryAfterSec,
      );
      return false;
    }
    if (verdict.kind === "delay" && !(await this.authGuard.hold(verdict.ms))) {
      // Too many responses already held: refuse now rather than queue more.
      this.refuse(res, 429, "Too many failed auth attempts", 1);
      return false;
    }
    // The client may have hung up while we waited.
    return !res.destroyed;
  }

  /**
   * An auth refusal. `Connection: close` so an unauthenticated caller
   * can't keep the socket, or dribble an unread request body into it.
   */
  private refuse(
    res: ServerResponse,
    code: 401 | 429,
    error: string,
    retryAfterSec?: number,
  ): void {
    res.writeHead(code, {
      ...this.jsonHeaders(),
      Connection: "close",
      ...(retryAfterSec !== undefined
        ? { "Retry-After": String(retryAfterSec) }
        : {}),
    });
    res.end(JSON.stringify({ ok: false, error }));
  }

  /**
   * Constant-time token comparison. Hashing both sides first equalizes
   * lengths (timingSafeEqual demands it) without leaking the real length.
   */
  private tokenMatches(candidate: string | null): boolean {
    if (candidate === null || !this.opts.token) return false;
    return timingSafeEqual(
      createHash("sha256").update(candidate).digest(),
      createHash("sha256").update(this.opts.token).digest(),
    );
  }

  /**
   * CORS headers.
   *
   * Deliberately NOT `Access-Control-Allow-Origin: *`. The bridge's clients
   * are native apps (Electron main process, Flutter, curl, talon-node),
   * which send no `Origin` at all — a wildcard buys them nothing and hands
   * every web page on the internet a readable cross-origin channel to the
   * agent API. Only an explicitly configured origin is echoed back.
   */
  private corsHeaders(): Record<string, string> {
    return {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      // Every response states its type; never let a browser guess one.
      "X-Content-Type-Options": "nosniff",
    };
  }

  /** True when `origin` is on the operator's `native.allowedOrigins` list. */
  private isAllowedOrigin(origin: string): boolean {
    return this.opts.allowedOrigins?.includes(origin) ?? false;
  }

  /**
   * Reject browser-driven cross-origin requests and DNS-rebinding.
   *
   * Two independent checks, because they stop different attacks:
   *
   *   - `Origin`: browsers attach it to every cross-origin request and
   *     scripts cannot forge it. Native clients omit it entirely. So "an
   *     Origin we did not allow" means "a web page is driving us" — which,
   *     on the default unauthenticated loopback bind, would let any site
   *     the user visits POST /send and run tools on this machine.
   *   - `Host`: a name that resolves to 127.0.0.1 makes the request
   *     SAME-origin, so no Origin header is sent and the check above never
   *     fires. Pinning Host to loopback/the configured bind closes that.
   *
   * Returns an error string when the request must be refused.
   */
  private originGuard(
    req: IncomingMessage,
    sameOriginAllowed = false,
  ): string | undefined {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "" && origin !== "null") {
      const sameOrigin =
        sameOriginAllowed && originHost(origin) === req.headers.host;
      if (!sameOrigin && !this.isAllowedOrigin(origin)) {
        return `Origin ${origin} is not allowed. Add it to native.allowedOrigins to permit browser clients.`;
      }
    }

    const host = req.headers.host;
    if (typeof host === "string" && host !== "") {
      // Strip the port; bracketed IPv6 keeps its brackets off.
      const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      const allowed =
        name === "127.0.0.1" ||
        name === "localhost" ||
        name === "::1" ||
        name === this.opts.host ||
        // A wildcard bind is reachable under every local name; the bearer
        // token is the control there, not the Host header.
        this.opts.host === "0.0.0.0" ||
        this.opts.host === "::";
      if (!allowed) {
        return `Host ${host} is not recognised for this bridge (DNS-rebinding guard).`;
      }
    }
    return undefined;
  }

  private jsonHeaders(): Record<string, string> {
    return { ...this.corsHeaders(), "Content-Type": "application/json" };
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, this.jsonHeaders());
    res.end(JSON.stringify(body));
  }

  /** Read a raw request body (binary-safe) up to `max` bytes. */
  private async readJson(
    req: IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("Body must be a JSON object");
    return parsed as Record<string, unknown>;
  }
}
