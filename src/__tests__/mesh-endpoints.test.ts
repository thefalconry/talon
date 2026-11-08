import { describe, expect, it } from "vitest";
import {
  advertisedEndpoints,
  MAX_MESH_ENDPOINTS,
  parseDialAddress,
} from "../core/mesh/links/endpoints.js";

describe("parseDialAddress", () => {
  it("takes IPv4 and bracketed IPv6 literals with a port", () => {
    expect(parseDialAddress("203.0.113.7:443")).toEqual({
      host: "203.0.113.7",
      port: 443,
    });
    expect(parseDialAddress("[2001:db8::1]:8443")).toEqual({
      host: "2001:db8::1",
      port: 8443,
    });
  });

  it("refuses hostnames, missing or bad ports, unbracketed v6", () => {
    for (const bad of [
      "mesh.example.org:443",
      "203.0.113.7",
      "203.0.113.7:0",
      "203.0.113.7:70000",
      "2001:db8::1:443",
      "[203.0.113.7]:443",
      "999.1.1.1:443",
      "",
    ]) {
      expect(parseDialAddress(bad), bad).toBeNull();
    }
  });
});

describe("advertisedEndpoints", () => {
  it("advertises nothing until native.endpoints is configured", () => {
    expect(advertisedEndpoints("https://mesh.example.org", undefined)).toBe(
      undefined,
    );
  });

  it("puts publicUrl first, drops duplicates and trailing slashes", () => {
    const out = advertisedEndpoints("https://mesh.example.org/", [
      { url: "https://mesh.example.org", dial: "203.0.113.7:443" },
      { url: "https://mesh.example.org" },
      { url: "https://mesh.example.org/", dial: "203.0.113.7:443" },
      { url: "https://backup.example.net", label: " second name " },
    ]);
    expect(out?.list).toEqual([
      { url: "https://mesh.example.org" },
      { url: "https://mesh.example.org", dial: "203.0.113.7:443" },
      { url: "https://backup.example.net", label: "second name" },
    ]);
    expect(out?.v).toMatch(/^[0-9a-f]{64}$/);
  });

  it("versions the list by content", () => {
    const a = advertisedEndpoints("https://a.example", [
      { url: "https://a.example", dial: "203.0.113.7:443" },
    ]);
    const same = advertisedEndpoints("https://a.example/", [
      { url: "https://a.example/", dial: "203.0.113.7:443" },
    ]);
    const other = advertisedEndpoints("https://a.example", [
      { url: "https://a.example", dial: "203.0.113.8:443" },
    ]);
    expect(same?.v).toBe(a?.v);
    expect(other?.v).not.toBe(a?.v);
  });

  it("an explicitly empty list still advertises (so devices forget)", () => {
    expect(advertisedEndpoints(undefined, [])).toEqual({
      v: expect.any(String),
      list: [],
    });
  });

  it("caps the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      url: `https://n${i}.example`,
    }));
    expect(advertisedEndpoints("https://p.example", many)?.list).toHaveLength(
      MAX_MESH_ENDPOINTS,
    );
  });
});
