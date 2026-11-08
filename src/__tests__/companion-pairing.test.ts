import { describe, expect, it } from "vitest";

import {
  CompanionPairStore,
  pairDeepLink,
  pairLink,
  pairPage,
} from "../core/mesh/links/companion-pairing.js";
import {
  renderMeshPairLink,
  renderMeshReport,
} from "../frontend/telegram/render/reports.js";
import { BridgeLinks } from "../core/mesh/links/bridge-links.js";

const grantInput = {
  bridgeUrl: "https://192.168.1.20:19880",
  bearerToken: "s3cr3t-token",
  fingerprint: "AA:BB:CC",
  label: "Talon",
};

describe("CompanionPairStore", () => {
  it("serves a grant exactly once", () => {
    const store = new CompanionPairStore();
    const grant = store.create(grantInput);

    expect(store.claim(grant.token)).toEqual({
      url: "https://192.168.1.20:19880",
      token: "s3cr3t-token",
      fingerprint: "AA:BB:CC",
      label: "Talon",
    });
    // The page IS the handover — a replayed link must not hand the same
    // credentials to whoever else has the URL.
    expect(store.claim(grant.token)).toBeNull();
  });

  it("refuses an unknown or expired grant", () => {
    const store = new CompanionPairStore(-1); // everything is already stale
    const grant = store.create(grantInput);

    expect(store.claim("not-a-token")).toBeNull();
    expect(store.claim(grant.token)).toBeNull();
  });

  it("strips markup characters from a caller-supplied label", () => {
    const store = new CompanionPairStore();
    const grant = store.create({
      ...grantInput,
      label: "<img src=x onerror=alert(1)>",
    });

    const claimed = store.claim(grant.token);
    expect(claimed?.label).not.toContain("<");
    expect(claimed?.label).not.toContain(">");
  });

  it("omits the fingerprint over plain HTTP", () => {
    const store = new CompanionPairStore();
    const grant = store.create({
      bridgeUrl: "http://192.168.1.20:19880",
      bearerToken: "t",
    });

    expect(store.claim(grant.token)).toEqual({
      url: "http://192.168.1.20:19880",
      token: "t",
    });
  });

  it("mints distinct, unguessable tokens", () => {
    const store = new CompanionPairStore();
    const a = store.create(grantInput).token;
    const b = store.create(grantInput).token;

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe("pairing links", () => {
  it("points the browser link at the bridge that minted it", () => {
    const store = new CompanionPairStore();
    const grant = store.create(grantInput);

    expect(pairLink(grant)).toBe(
      `https://192.168.1.20:19880/pair?grant=${grant.token}`,
    );
  });

  it("carries the credentials themselves in the deep link", () => {
    // The grant is spent by the time the page renders, so the deep link
    // cannot depend on another round trip to resolve it.
    const deep = new URL(
      pairDeepLink({
        url: "https://192.168.1.20:19880",
        token: "s3cr3t-token",
        fingerprint: "AA:BB:CC",
        label: "Talon",
      }),
    );

    expect(deep.protocol).toBe("talon:");
    expect(deep.searchParams.get("u")).toBe("https://192.168.1.20:19880");
    expect(deep.searchParams.get("t")).toBe("s3cr3t-token");
    expect(deep.searchParams.get("f")).toBe("AA:BB:CC");
    expect(deep.searchParams.get("n")).toBe("Talon");
  });

  it("prints the values on the page for a phone without the app", () => {
    const page = pairPage({
      url: "https://192.168.1.20:19880",
      token: "s3cr3t-token",
      fingerprint: "AA:BB:CC",
    });

    expect(page).toContain("talon://pair?");
    expect(page).toContain("https://192.168.1.20:19880");
    expect(page).toContain("s3cr3t-token");
    expect(page).toContain("AA:BB:CC");
    // Self-contained: a LAN bridge behind a certificate warning has no
    // route to a CDN, and a half-loaded page is worse than none.
    expect(page).not.toMatch(/<(script|link)\b/);
  });

  it("escapes a label that reached the page anyway", () => {
    const page = pairPage({ url: "http://h:1", token: "t", label: "<b>x</b>" });

    expect(page).not.toContain("<b>x</b>");
    expect(page).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("renderMeshPairLink", () => {
  it("prints the link plus the manual fallback values", () => {
    const out = renderMeshPairLink({
      ok: true,
      link: "https://192.168.1.20:19880/pair?grant=abc",
      url: "https://192.168.1.20:19880",
      token: "s3cr3t-token",
      fingerprint: "AA:BB:CC",
    });

    expect(out).toContain("https://192.168.1.20:19880/pair?grant=abc");
    expect(out).toContain("s3cr3t-token");
    expect(out).toContain("AA:BB:CC");
  });

  it("explains why nothing could be minted", () => {
    const out = renderMeshPairLink({
      ok: false,
      text: "The native bridge isn't running.",
    });

    expect(out).toContain("bridge isn&#39;t running");
  });
});

describe("the /mesh bridge footer", () => {
  const bridge = {
    ok: true as const,
    url: "https://192.168.1.20:19880",
    authRequired: true,
    token: "s3cr3t-token",
    fingerprint: "AA:BB:CC",
  };

  it("shows the admin the whole connection profile", () => {
    // An operator asking their own daemon how to reach itself should get an
    // answer, not a scavenger hunt through config files.
    const out = renderMeshReport([], Date.now(), bridge);

    expect(out).toContain("192.168.1.20:19880");
    expect(out).toContain("s3cr3t-token");
    expect(out).toContain("AA:BB:CC");
  });

  it("gives a non-admin the address without the key to it", () => {
    const { token: _t, fingerprint: _f, ...redacted } = bridge;
    const out = renderMeshReport([], Date.now(), redacted);

    expect(out).toContain("192.168.1.20:19880");
    expect(out).toContain("token required");
    expect(out).not.toContain("s3cr3t-token");
  });

  it("says why there is nothing to dial", () => {
    const out = renderMeshReport([], Date.now(), {
      ok: false,
      text: "The native bridge isn't running.",
    });

    expect(out).toContain("bridge isn&#39;t running");
  });

  it("stays silent when no reachability was passed", () => {
    expect(renderMeshReport([], Date.now())).not.toContain("Bridge");
  });
});

describe("pairing from a container", () => {
  it("points pairing links at native.publicUrl when one is configured", () => {
    const links = new BridgeLinks(async () => {
      throw new Error("unused");
    });
    // A container binds 0.0.0.0 and only knows its internal address; the
    // configured public URL is what the phone must dial.
    links.setBridgeInfo({
      scheme: "https",
      host: "0.0.0.0",
      port: 19880,
      token: "bearer-secret",
      publicUrl: "https://truenas.lan:19880/",
    });

    const minted = links.makeCompanionPairLink("Phone");
    expect(minted.ok && minted.url).toBe("https://truenas.lan:19880");
    expect(minted.ok && minted.link).toMatch(
      /^https:\/\/truenas\.lan:19880\/pair\?grant=/,
    );
    const reach = links.bridgeReachability();
    expect(reach.ok && reach.url).toBe("https://truenas.lan:19880");
  });
});
