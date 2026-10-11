/**
 * The address a bridge request really came from, for the auth guard and
 * auth log lines.
 *
 * Behind a reverse proxy on the same host (Caddy in front of the bridge)
 * every request's socket peer is loopback, so keying the auth guard on the
 * socket address puts every device and every attacker in one bucket: twenty
 * wrong tokens from anyone lock everyone out. The proxy says who its client
 * was in `X-Forwarded-For`.
 *
 * Trust rule: `X-Forwarded-For` is honoured only when the socket peer is
 * loopback, i.e. a process on this machine, which is where the proxy runs.
 * From any other peer the header is client-supplied and ignored. The list
 * is read right to left, skipping loopback hops (proxies chained on this
 * host); the first non-loopback entry is the client. Entries to its left
 * were written by whoever connected to the proxy and are never trusted.
 * An entry that is not an IP address ends the walk and the socket peer is
 * used, so a malformed header can't mint arbitrary guard keys.
 *
 * Caddy's reverse_proxy replaces a client-sent `X-Forwarded-For` with the
 * real peer unless that peer is one of its own `trusted_proxies`, and the
 * rightmost-hop rule is safe even for proxies that append instead.
 *
 * A local process can choose its own key by sending the header. It already
 * holds the shared token (it reads the 0600 discovery file), the global
 * failure budget and per-credential backoff don't key on address at all,
 * and a valid per-device credential is never address-locked, so this buys
 * an attacker on the box nothing.
 */

import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/** 127.0.0.0/8, ::1, and their IPv4-mapped IPv6 forms. */
export function isLoopbackAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice("::ffff:".length) : a;
  return isIP(v4) === 4 && v4.startsWith("127.");
}

/**
 * One `X-Forwarded-For` entry as a bare IP, or null if it isn't one.
 * Accepts `[v6]`, `[v6]:port` and `v4:port`, which some proxies emit.
 */
function parseHop(raw: string): string | null {
  let hop = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(hop);
  if (bracketed) hop = bracketed[1] ?? "";
  else if (/^[\d.]+:\d+$/.test(hop)) hop = hop.slice(0, hop.lastIndexOf(":"));
  return isIP(hop) === 0 ? null : hop;
}

/**
 * The client address for a request: the socket peer, or, when that peer is
 * loopback, the rightmost non-loopback `X-Forwarded-For` hop.
 */
export function resolveClientAddress(
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
): string {
  const socket = peer ?? "unknown";
  if (forwardedFor === undefined || !isLoopbackAddress(socket)) return socket;
  // Repeated headers are one list, in order (RFC 9110 §5.3).
  const hops = (
    Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor
  ).split(",");
  for (let i = hops.length - 1; i >= 0; i--) {
    const raw = hops[i] ?? "";
    if (raw.trim() === "") continue;
    const hop = parseHop(raw);
    if (hop === null) return socket;
    if (!isLoopbackAddress(hop)) return hop;
  }
  return socket;
}

/** `resolveClientAddress` for a live request. */
export function clientAddress(req: IncomingMessage): string {
  return resolveClientAddress(
    req.socket.remoteAddress,
    req.headers["x-forwarded-for"],
  );
}
