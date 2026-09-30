/**
 * SSRF guard for `fetch_url`.
 *
 * The URL comes from the model, and the model reads untrusted pages, so
 * "fetch this" can be steered at anything the daemon's host can reach:
 * the cloud metadata endpoint (169.254.169.254 hands out instance
 * credentials), the loopback gateway, a router admin page on the LAN.
 * So before every request — the first one and each redirect hop — the
 * host is resolved and EVERY address it resolves to must be public.
 * Redirects are followed by hand (never by the transport) in the fetch
 * ladder (core/fetch/ladder.ts), which calls `assertPublicUrl` on every
 * hop, so a public page cannot bounce the request into a private one.
 *
 * Residual risk, stated plainly: the runtime's fetch (the "plain" rung)
 * resolves the name again after we checked it, so a DNS-rebinding server
 * with a zero TTL can still race it. Pinning the checked address would
 * need a custom connector, which Bun does not honour. The curl rungs do
 * pin (`--resolve` to the checked addresses); requests through a SOCKS
 * exit are resolved by the exit, outside this host's network.
 *
 * The guard is opt-in: `fetch_url` applies it only when the operator sets
 * `fetchUrl.allowPrivateNetworks: false`. By default the agent can read
 * local services (a home lab, a local dev server).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Resolves a host name to every address it maps to. Injected in tests. */
export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

export class BlockedUrlError extends Error {}

// ── Address classification ──────────────────────────────────────────────────

/** Non-public IPv4 ranges: [network, prefix length]. */
const BLOCKED_V4: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT (also Tailscale)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

/** Non-public IPv6 ranges (IPv4-mapped/compatible are unwrapped first). */
const BLOCKED_V6: ReadonlyArray<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64 — reaches whatever IPv4 it embeds
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 — embeds an IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

function v4ToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

function v6ToBigInt(ip: string): bigint {
  let text = ip.toLowerCase().split("%")[0];
  // A trailing dotted quad (::ffff:1.2.3.4) becomes two hextets.
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    text =
      text.slice(0, -dotted[1].length) +
      `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const fill = tail === null ? 0 : 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(fill).fill("0"), ...tailParts];
  return parts.reduce(
    (acc, part) => (acc << 16n) | BigInt(parseInt(part || "0", 16)),
    0n,
  );
}

function inV4(ip: number, [net, bits]: [string, number]): boolean {
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (v4ToInt(net) & mask);
}

function inV6(ip: bigint, [net, bits]: [string, number]): boolean {
  const shift = BigInt(128 - bits);
  return ip >> shift === v6ToBigInt(net) >> shift;
}

/** True when `ip` is loopback, private, link-local, reserved or otherwise non-public. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip.split("%")[0]);
  if (family === 4) {
    const n = v4ToInt(ip);
    return BLOCKED_V4.some((range) => inV4(n, range));
  }
  if (family !== 6) return true; // not an address at all: refuse
  const n = v6ToBigInt(ip);
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses
  // reach the embedded IPv4 host — judge that instead.
  const high = n >> 32n;
  if (high === 0xffffn || (high === 0n && n > 1n)) {
    const v4 = Number(n & 0xffffffffn);
    return BLOCKED_V4.some((range) => inV4(v4, range));
  }
  return BLOCKED_V6.some((range) => inV6(n, range));
}

// ── URL checks ──────────────────────────────────────────────────────────────

/**
 * Throw unless `url` is http(s) and its host resolves only to public
 * addresses. A literal IP is judged directly; a name is resolved.
 * Returns the checked addresses so a caller that can pin the connection
 * to them (curl `--resolve`) closes the rebinding race.
 */
export async function assertPublicUrl(
  url: URL,
  resolve: Resolver = defaultResolver,
): Promise<string[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError("URL must use http or https protocol");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch (err) {
      throw new BlockedUrlError(
        `Cannot resolve ${host}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (addresses.length === 0) {
    throw new BlockedUrlError(`Cannot resolve ${host}`);
  }
  const blocked = addresses.find(isBlockedAddress);
  if (blocked) {
    throw new BlockedUrlError(
      `Refusing to fetch ${host}: it resolves to a private, loopback or link-local address (${blocked}). ` +
        `Remove fetchUrl.allowPrivateNetworks: false from config.json (or set it to true) to allow local addresses.`,
    );
  }
  return addresses;
}
