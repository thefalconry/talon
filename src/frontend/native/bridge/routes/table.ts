import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  BridgePrincipal,
  BridgeRouteAuth,
  BridgeScope,
} from "../credentials/principal.js";

export type { BridgeRouteAuth };

/**
 * ok: request carries the right token (or none is required).
 * anonymous: no credential presented — a pre-pairing probe, not an attack.
 * bad: a credential was presented and it is wrong.
 */
export type AuthState = "ok" | "anonymous" | "bad";

/** Any authenticated caller — the route itself decides what it may see. */
const ANY: readonly BridgeScope[] = ["device", "client", "operator"];

/**
 * The bridge's routes and the auth tier of each — declared once, here,
 * rather than implied by where an `if` sits relative to the auth check.
 * The security posture of the transport is this table: a route is
 * pre-auth only by appearing in it as "public", reachable by a per-device
 * credential only through the scope written next to it, and the route
 * tests walk every entry and prove each tier holds on the wire. Adding a
 * route without an entry is a type error (`buildRoutes` is exhaustive over
 * these keys); widening one is a diff a reviewer sees.
 */
export const BRIDGE_ROUTE_AUTH = {
  // Pre-auth by design. /health serves pairing data (identity, protocol,
  // fingerprint) to anyone and the operational view only to a token
  // holder. /pair, /node/install and /node/binary hand over a credential
  // to a device that holds none yet; the single-use grant in the query is
  // the entire authorization.
  "GET /health": "public",
  "GET /pair": "public",
  "GET /node/install": "public",
  "GET /node/binary": "public",

  // Credential self-service. Any credential may ask who it is, and trade
  // itself (or the shared legacy token) for a fresh per-device credential
  // bound to ONE device id — the in-band upgrade and rotation path.
  "GET /auth/whoami": ANY,
  "POST /auth/upgrade": ANY,

  // The event stream. A device-only credential receives only what is
  // addressed to its own device (commands, locates) — never chat traffic.
  "GET /events": ["device", "client"],

  // The chat UI.
  "GET /chats": "client",
  "POST /chats": "client",
  "POST /chats/rename": "client",
  "POST /chats/delete": "client",
  "POST /chats/reset": "client",
  "POST /chats/interrupt": "client",
  "POST /chats/pulse": "client",
  "POST /queue": "client",
  "GET /history": "client",
  "GET /search": "client",

  // Memory — read-only. The typed memory store is readable over the
  // bridge but never writable from it: asserting and dropping stay with
  // the daemon's own write path.
  "GET /memory": "client",
  "GET /memory/why": "client",

  "POST /send": "client",
  // The slash commands /send answers itself — names and one-liners for
  // autocomplete. Operator-only ones are listed (flagged `admin`) and
  // refused at /send time for a credential without the scope.
  "GET /commands": "client",
  "POST /upload": "client",
  "GET /media": "client",
  "GET /models": "client",
  "POST /model": "client",
  "GET /backends": "client",
  "POST /backend": "client",
  "GET /effort": "client",
  "POST /effort": "client",
  // Reads of the non-secret, allowlisted settings snapshot and the
  // extension lists are the UI's; changing any of it is the operator's.
  "GET /plugins": "client",
  "GET /skills": "client",
  "GET /config": "client",

  // Operator. Logs carry command lines, paths and device output, so they
  // are not a chat-UI read.
  "GET /logs": "operator",
  "POST /plugins/toggle": "operator",
  "POST /skills/toggle": "operator",
  "POST /config": "operator",
  "POST /control": "operator",

  // Mesh — a device acting as itself. Every body/query naming a device id
  // is checked against the credential's own device (credentials/claims.ts).
  // The one-time `transfer` token on /devices/file authorizes one
  // direction+path for one device; the credential still has to be that
  // device's.
  "POST /devices/register": "device",
  "POST /location": "device",
  "POST /devices/command-result": "device",
  "POST /devices/file": "device",
  "GET /devices/file": "device",
  // The fleet view (every device and its last location) is the UI's.
  "GET /devices": "client",
} as const satisfies Record<string, BridgeRouteAuth>;

export type BridgeRouteKey = keyof typeof BRIDGE_ROUTE_AUTH;

/**
 * The only routes that take the credential as a `?token=` query parameter.
 * Everywhere else it must come as `Authorization: Bearer`. A token in a URL
 * ends up in proxy logs, browser history and screenshots, so it is accepted
 * only where a client can't set a header: an EventSource stream, and media
 * handed to an image widget or an external viewer. Those are the only two
 * places shipped companions put it; talon-node never does.
 */
export const QUERY_TOKEN_ROUTES: ReadonlySet<BridgeRouteKey> = new Set([
  "GET /events",
  "GET /media",
]);

/** What a route handler receives; `auth` is already evaluated. */
export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  auth: AuthState;
  /** Who is calling — null only on a public route hit without a credential. */
  principal: BridgePrincipal | null;
};

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

/** Every route with its handler — exhaustive over BRIDGE_ROUTE_AUTH by construction. */
export type BridgeRoutes = Record<BridgeRouteKey, RouteHandler>;
