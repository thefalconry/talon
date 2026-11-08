/**
 * Gateway auth — the credential and request guard in front of the local
 * action gateway (and the MCP hub mounted on it).
 *
 * The gateway binds 127.0.0.1, but loopback is not a trust boundary on its
 * own: other accounts on the same host can connect to it, and a browser can
 * be steered at it (cross-site requests, DNS rebinding). So every request
 * passes three checks before routing:
 *
 *   - Host must name loopback on the gateway's own port. A rebinding
 *     hostname resolves to 127.0.0.1 but still carries its own Host.
 *   - No `Origin` header. Talon's clients (Node/Bun fetch, the Claude/Codex
 *     CLIs, MCP SDK clients) never send one; browsers always do on the
 *     requests that matter, and scripts cannot suppress it.
 *   - POSTs must declare `Content-Type: application/json`, which a plain
 *     HTML form cannot produce without a CORS preflight.
 *
 * and every route except `/health` requires the gateway token as
 * `Authorization: Bearer <token>`, compared in constant time.
 *
 * The token is minted once (32 random bytes) into ~/.talon/keys/gateway-token
 * with owner-only permissions and stays stable across restarts, so agent
 * servers and CLIs configured by a previous boot keep working. The daemon
 * also exports it as TALON_GATEWAY_TOKEN, so every process it spawns (MCP
 * children, the Claude/Codex CLIs, plugins) inherits it without the value
 * ever appearing on a command line. Delete the file and restart to rotate.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { dirs } from "../../util/paths.js";

/** Env var carrying the token to child processes (plugins, agent CLIs). */
export const GATEWAY_TOKEN_ENV = "TALON_GATEWAY_TOKEN";

const TOKEN_FILE = "gateway-token";
/** 32 random bytes → 43 base64url chars. */
const TOKEN_BYTES = 32;

let cachedToken: string | null = null;

/** Path of the persisted token file. */
export function gatewayTokenPath(dir: string = dirs.keys): string {
  return resolve(dir, TOKEN_FILE);
}

function readTokenFile(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf-8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function mintTokenFile(path: string): string {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // `mode` above is ignored when the file exists
  return token;
}

/**
 * The gateway token, for the process that SERVES the gateway (and for
 * in-process callers). Resolution: an inherited TALON_GATEWAY_TOKEN, then
 * the key file, else a freshly minted key file. The result is exported to
 * `process.env` so children spawned afterwards inherit it.
 */
export function gatewayToken(): string {
  if (!cachedToken) {
    const inherited = process.env[GATEWAY_TOKEN_ENV]?.trim();
    const path = inherited ? "" : gatewayTokenPath();
    cachedToken = inherited || readTokenFile(path) || mintTokenFile(path);
  }
  // Re-asserted on every call: children spawned from here on must see the
  // token even if something cleared the variable in between.
  process.env[GATEWAY_TOKEN_ENV] = cachedToken;
  return cachedToken;
}

/**
 * The gateway token for a CLIENT of a running daemon (CLI commands): the
 * inherited env var or the key file, never minting one. Undefined when the
 * daemon has not provisioned a token yet.
 */
export function readGatewayToken(): string | undefined {
  return (
    process.env[GATEWAY_TOKEN_ENV]?.trim() || readTokenFile(gatewayTokenPath())
  );
}

/** Header map authenticating a request to the gateway. */
export function gatewayAuthHeaders(
  token: string | undefined = gatewayToken(),
): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Test seam: forget the cached token so the next call re-resolves it. */
export function resetGatewayTokenCache(): void {
  cachedToken = null;
}

// ── Request guard ───────────────────────────────────────────────────────────

/** A refused request: HTTP status plus a short, non-sensitive reason. */
export type GatewayRefusal = { status: number; error: string };

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time check of the request's bearer token against `expected`. */
export function hasValidGatewayToken(
  req: IncomingMessage,
  expected: string,
): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return false;
  // Hash both sides so the comparison is length-independent.
  return timingSafeEqual(digest(match[1]!), digest(expected));
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (typeof host !== "string") return false;
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.some((name) => normalized === `${name}:${port}`);
}

function isJsonContentType(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const mediaType = value.split(";")[0]!.trim().toLowerCase();
  return mediaType === "application/json";
}

/**
 * Transport-level checks every request must pass, `/health` included:
 * loopback Host on the bound port, no browser Origin, JSON POST bodies.
 */
export function checkGatewayTransport(
  req: IncomingMessage,
  port: number,
): GatewayRefusal | null {
  if (req.headers.origin !== undefined) {
    return { status: 403, error: "Browser requests are not accepted" };
  }
  if (!isLoopbackHost(req.headers.host, port)) {
    return { status: 403, error: "Host not allowed" };
  }
  if (
    req.method === "POST" &&
    !isJsonContentType(req.headers["content-type"])
  ) {
    return { status: 415, error: "Content-Type must be application/json" };
  }
  return null;
}
