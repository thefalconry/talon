/**
 * SSRF guard for fetch_url (#1049): private/loopback/link-local/metadata
 * addresses are refused — as literals, after DNS resolution, and after
 * every redirect hop — unless the operator opted out. The per-hop redirect
 * checks live with the ladder that follows the redirects (fetch-ladder.test.ts).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assertPublicUrl,
  isBlockedAddress,
  type Resolver,
} from "../core/engine/gateway-actions/fetch-url/guard.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const resolveTo =
  (map: Record<string, string[]>): Resolver =>
  async (host) =>
    map[host] ?? ["93.184.215.14"];

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fd00::1",
    "fe80::1%eth0",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    "93.184.215.14",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("refuses literal private hosts, including bracketed IPv6", async () => {
    for (const url of [
      "http://127.0.0.1:19876/health",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://2130706433/", // 127.0.0.1 in decimal — URL normalises it
    ]) {
      await expect(assertPublicUrl(new URL(url))).rejects.toThrow(
        /Refusing to fetch/,
      );
    }
  });

  it("refuses a name that resolves to a private address", async () => {
    await expect(
      assertPublicUrl(
        new URL("https://intranet.example"),
        resolveTo({ "intranet.example": ["93.184.215.14", "10.0.0.5"] }),
      ),
    ).rejects.toThrow(/10\.0\.0\.5/);
  });

  it("allows a name that resolves only to public addresses", async () => {
    await expect(
      assertPublicUrl(new URL("https://example.com"), resolveTo({})),
    ).resolves.toEqual(["93.184.215.14"]);
  });

  it("refuses when resolution fails", async () => {
    await expect(
      assertPublicUrl(new URL("https://nx.example"), async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(/Cannot resolve/);
  });
});
