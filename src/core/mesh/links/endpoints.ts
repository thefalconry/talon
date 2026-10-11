/**
 * Bridge endpoint lists (mesh high availability, phase 1).
 *
 * A device dials one URL today. The daemon can also advertise an ordered
 * list of OTHER ways to reach the same bridge — the same URL dialled at a
 * fixed IP (skipping DNS), a second DNS name — in the `POST
 * /devices/register` reply, which every device already reads on its 60 s
 * heartbeat. A device that understands the list fails over between the
 * entries; one that doesn't ignores the unknown field.
 *
 * Every entry must reach the SAME bridge certificate: devices keep the pin
 * they already hold and never learn a new one from this list.
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";

/** One way to reach the bridge. */
export type MeshEndpoint = {
  /** Base URL: decides the Host header, TLS SNI and the proxy site. */
  url: string;
  /**
   * Socket address to connect to instead of resolving the URL's host —
   * an IP literal and port (`203.0.113.7:443`, `[2001:db8::1]:443`).
   * The URL's host still goes in SNI and Host, so a proxy routes it.
   */
  dial?: string;
  /** Free-form note shown in status output. */
  label?: string;
};

/** The register-reply field: the list plus a version to spot changes. */
export type AdvertisedEndpoints = {
  /** sha256 (hex) of the canonical list; opaque to devices. */
  v: string;
  list: MeshEndpoint[];
};

/** Most entries the daemon advertises (and a device accepts). */
export const MAX_MESH_ENDPOINTS = 8;

/**
 * `host:port` where host is an IP literal (`[v6]` bracketed) and port is
 * 1-65535 — null when it is anything else. Hostnames are refused on
 * purpose: a dial override exists to skip name resolution.
 */
export function parseDialAddress(
  raw: string,
): { host: string; port: number } | null {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([0-9.]+)):(\d{1,5})$/.exec(raw.trim());
  if (!m) return null;
  const host = m[1] ?? m[2] ?? "";
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  const family = isIP(host);
  if (family === 0) return null;
  // An IPv6 address must be bracketed, an IPv4 one must not be.
  if ((family === 6) !== (m[1] !== undefined)) return null;
  return { host, port };
}

/** Same text as a URL with any trailing slash dropped. */
function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The list the register reply advertises, or undefined when the operator
 * configured none (`native.endpoints` unset — the reply then carries no
 * field at all, exactly as before). `publicUrl` always comes first;
 * duplicates (same URL and dial) are dropped, keeping the first.
 * An explicitly empty `native.endpoints` advertises just `publicUrl` (or
 * nothing), which tells devices to forget a list they learned earlier.
 */
export function advertisedEndpoints(
  publicUrl: string | undefined,
  configured: readonly MeshEndpoint[] | undefined,
): AdvertisedEndpoints | undefined {
  if (configured === undefined) return undefined;
  const list: MeshEndpoint[] = [];
  const seen = new Set<string>();
  const add = (entry: MeshEndpoint): void => {
    const url = trimUrl(entry.url);
    const dial = entry.dial?.trim() || undefined;
    const key = `${url}\n${dial ?? ""}`;
    if (!url || seen.has(key) || list.length >= MAX_MESH_ENDPOINTS) return;
    seen.add(key);
    const label = entry.label?.trim() || undefined;
    list.push({
      url,
      ...(dial ? { dial } : {}),
      ...(label ? { label } : {}),
    });
  };
  if (publicUrl) add({ url: publicUrl });
  for (const entry of configured) add(entry);
  return { v: endpointsVersion(list), list };
}

/** Stable digest of a list: field order fixed, so equal lists match. */
function endpointsVersion(list: readonly MeshEndpoint[]): string {
  const canonical = JSON.stringify(
    list.map((e) => [e.url, e.dial ?? "", e.label ?? ""]),
  );
  return createHash("sha256").update(canonical).digest("hex");
}
