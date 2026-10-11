/**
 * The bridge's auth guard keys on the real client behind a same-host
 * reverse proxy.
 *
 * Behind Caddy every request's socket peer is 127.0.0.1. Keyed on that,
 * twenty wrong tokens from anyone on the internet locked every proxied
 * device out for the lockout window, valid per-device credentials included.
 * Now: `X-Forwarded-For` is honoured (rightmost non-loopback hop) only when
 * the peer is loopback, and a valid per-device credential is never refused
 * by an address lockout.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { logWarn } from "../util/log.js";
import {
  BridgeServer,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";
import {
  isLoopbackAddress,
  resolveClientAddress,
} from "../frontend/native/bridge/client-address.js";
import { DeviceCredentialStore } from "../core/mesh/credentials/index.js";

// ── Address resolution ──────────────────────────────────────────────────────

describe("resolveClientAddress", () => {
  it("uses the socket peer when there is no forwarding header", () => {
    expect(resolveClientAddress("127.0.0.1", undefined)).toBe("127.0.0.1");
    expect(resolveClientAddress("203.0.113.5", undefined)).toBe("203.0.113.5");
    expect(resolveClientAddress(undefined, undefined)).toBe("unknown");
  });

  it("ignores X-Forwarded-For from a peer that is not loopback", () => {
    expect(resolveClientAddress("203.0.113.5", "198.51.100.7")).toBe(
      "203.0.113.5",
    );
    expect(resolveClientAddress("192.168.0.10", "127.0.0.1")).toBe(
      "192.168.0.10",
    );
  });

  it("takes the rightmost non-loopback hop from a loopback peer", () => {
    expect(resolveClientAddress("127.0.0.1", "198.51.100.7")).toBe(
      "198.51.100.7",
    );
    expect(resolveClientAddress("::1", "2001:db8::7")).toBe("2001:db8::7");
    expect(resolveClientAddress("::ffff:127.0.0.1", "198.51.100.7")).toBe(
      "198.51.100.7",
    );
    // A client-written entry on the left never wins over the proxy's.
    expect(resolveClientAddress("127.0.0.1", "10.9.9.9, 198.51.100.7")).toBe(
      "198.51.100.7",
    );
    // Chained proxies on this host are skipped.
    expect(
      resolveClientAddress("127.0.0.1", "198.51.100.7, 127.0.0.1, ::1"),
    ).toBe("198.51.100.7");
    // Repeated headers are one list.
    expect(
      resolveClientAddress("127.0.0.1", ["10.9.9.9", "198.51.100.7"]),
    ).toBe("198.51.100.7");
  });

  it("strips ports and brackets some proxies add", () => {
    expect(resolveClientAddress("127.0.0.1", "198.51.100.7:5123")).toBe(
      "198.51.100.7",
    );
    expect(resolveClientAddress("127.0.0.1", "[2001:db8::7]:443")).toBe(
      "2001:db8::7",
    );
  });

  it("falls back to the peer on a malformed or loopback-only header", () => {
    expect(resolveClientAddress("127.0.0.1", "not-an-ip")).toBe("127.0.0.1");
    expect(resolveClientAddress("127.0.0.1", "198.51.100.7, junk")).toBe(
      "127.0.0.1",
    );
    expect(resolveClientAddress("127.0.0.1", "127.0.0.1")).toBe("127.0.0.1");
    expect(resolveClientAddress("127.0.0.1", " , ")).toBe("127.0.0.1");
  });

  it("knows loopback", () => {
    for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(a), a).toBe(true);
    }
    for (const a of ["10.0.0.1", "::", "::ffff:10.0.0.1", "128.0.0.1", "x"]) {
      expect(isLoopbackAddress(a), a).toBe(false);
    }
  });
});

// ── Over the wire ───────────────────────────────────────────────────────────

const handlers = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === "status")
        return () => ({
          app: "talon-bridge",
          protocol: 1,
          botName: "Talon",
          backend: "test",
          model: "m1",
          activeChats: 0,
          startedAt: "now",
        });
      if (key === "listChats" || key === "liveTurnEvents") return () => [];
      return () => undefined;
    },
  },
) as BridgeServerHandlers;

const SHARED = randomBytes(32).toString("base64url");
const WRONG = "wrong-token";
const LOCKOUT = { lockoutMaxFailures: 3, backoffBaseMs: 0 };

let server: BridgeServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  vi.mocked(logWarn).mockClear();
});

async function start(host = "127.0.0.1") {
  const dir = await mkdtemp(join(tmpdir(), "talon-bridge-xff-"));
  const store = new DeviceCredentialStore(join(dir, "creds.json"));
  await store.load();
  server = new BridgeServer(
    {
      host,
      port: 0,
      token: SHARED,
      startedAt: "boot",
      authPolicy: LOCKOUT,
      credentials: {
        authority: store,
        policy: {
          legacySharedToken: true,
          companionScopes: ["device", "client"],
        },
      },
    },
    handlers,
  );
  const port = await server.start();
  return { port, store };
}

/** GET /auth/whoami → status code. */
function whoami(
  port: number,
  bearer: string,
  opts: { forwardedFor?: string; connectTo?: string } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: opts.connectTo ?? "127.0.0.1",
        port,
        path: "/auth/whoami",
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(opts.forwardedFor !== undefined
            ? { "X-Forwarded-For": opts.forwardedFor }
            : {}),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** This host's first non-internal IPv4, for a non-loopback socket peer. */
function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

describe("bridge auth guard behind a same-host proxy", () => {
  it("separates two clients the proxy forwarded for", async () => {
    const { port } = await start();
    for (let i = 0; i < LOCKOUT.lockoutMaxFailures; i++) {
      expect(await whoami(port, WRONG, { forwardedFor: "203.0.113.9" })).toBe(
        401,
      );
    }
    // The guesser is locked out, even with the right shared token...
    expect(await whoami(port, SHARED, { forwardedFor: "203.0.113.9" })).toBe(
      429,
    );
    // ...and another client arriving through the same proxy is not.
    expect(await whoami(port, SHARED, { forwardedFor: "198.51.100.7" })).toBe(
      200,
    );
    const warned = vi
      .mocked(logWarn)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(warned).toMatch(/event=lockout addr=203\.0\.113\.9 /);
  });

  it("lets a valid device credential in while its address is locked out", async () => {
    const { port, store } = await start();
    const { token } = await store.mint({
      deviceId: "node-a",
      scopes: ["device"],
      origin: "install",
    });
    // No forwarding header: every request shares the socket address, as
    // they would behind a proxy that doesn't say who its client was.
    for (let i = 0; i < LOCKOUT.lockoutMaxFailures; i++) {
      expect(await whoami(port, WRONG)).toBe(401);
    }
    expect(await whoami(port, SHARED)).toBe(429);
    expect(await whoami(port, token)).toBe(200);
    // The device getting in doesn't unlock the address for anyone else.
    expect(await whoami(port, SHARED)).toBe(429);
  });

  const lan = lanAddress();
  it.skipIf(lan === undefined)(
    "ignores X-Forwarded-For from a peer that is not loopback",
    async () => {
      const { port } = await start("0.0.0.0");
      // A fresh spoofed address on every guess: if the header were trusted
      // from this peer, no key would ever reach the limit.
      for (let i = 0; i < LOCKOUT.lockoutMaxFailures; i++) {
        expect(
          await whoami(port, WRONG, {
            connectTo: lan,
            forwardedFor: `198.51.100.${i + 1}`,
          }),
        ).toBe(401);
      }
      expect(
        await whoami(port, SHARED, {
          connectTo: lan,
          forwardedFor: "198.51.100.200",
        }),
      ).toBe(429);
    },
  );
});
