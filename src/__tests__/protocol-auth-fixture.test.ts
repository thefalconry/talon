/**
 * The per-device credential wire contract (protocol/fixtures/auth_v1.json),
 * asserted from the daemon side: the fixture's requests are replayed
 * against a live bridge and every reply must have exactly the fixture's
 * shape — the same samples talon-node (protocol_conformance_test.go) and
 * the companion (protocol_conformance_test.dart) parse with their real code.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BridgeServer,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";
import {
  DeviceCredentialStore,
  isDeviceCredentialToken,
} from "../core/mesh/credentials/index.js";

type Json = Record<string, unknown>;
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../protocol/fixtures",
);
const fx = JSON.parse(
  readFileSync(join(FIXTURES, "auth_v1.json"), "utf-8"),
) as {
  credentialPattern: string;
  sampleCredentials: string[];
  sampleSharedTokens: string[];
  upgradeRequests: Record<"node" | "companion", Json>;
  upgradeReplies: Record<"node" | "companion", Json>;
  registerReplies: Record<"none" | "upgrade" | "rotate", Json>;
  whoami: Record<"shared" | "device" | "rotate" | "open", Json>;
};

const SHARED = "fixture-shared-token";

const handlers = new Proxy({} as BridgeServerHandlers, {
  get: (_t, prop) => {
    if (prop === "registerDevice") {
      return async (body: Json) => ({ id: String(body.id) });
    }
    if (prop === "status") return () => ({});
    if (prop === "listChats" || prop === "liveTurnEvents") return () => [];
    return () => undefined;
  },
});

let server: BridgeServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function bridge(withToken = true): Promise<{
  port: number;
  store: DeviceCredentialStore;
}> {
  const dir = await mkdtemp(join(tmpdir(), "talon-auth-fixture-"));
  const store = new DeviceCredentialStore(join(dir, "creds.json"));
  await store.load();
  server = new BridgeServer(
    {
      host: "127.0.0.1",
      port: 0,
      ...(withToken ? { token: SHARED } : {}),
      startedAt: "boot",
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
  return { port: await server.start(), store };
}

async function call(
  port: number,
  method: string,
  path: string,
  token: string | undefined,
  body?: Json,
): Promise<Json> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as Json;
}

const withDevice = (sample: Json, deviceId: string): Json =>
  JSON.parse(JSON.stringify(sample).replaceAll("{{DEVICE_ID}}", deviceId));

/** Same keys, same value types — and equal values outside `except`. */
function expectShape(actual: Json, sample: Json, except: string[]): void {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(sample).sort());
  for (const [key, value] of Object.entries(sample)) {
    expect(typeof actual[key], key).toBe(typeof value);
    if (!except.includes(key)) expect(actual[key], key).toEqual(value);
  }
}

describe("auth fixture (protocol/fixtures/auth_v1.json)", () => {
  it("the token pattern is the daemon's", () => {
    const pattern = new RegExp(fx.credentialPattern);
    for (const t of fx.sampleCredentials) {
      expect(pattern.test(t)).toBe(true);
      expect(isDeviceCredentialToken(t)).toBe(true);
    }
    for (const t of fx.sampleSharedTokens) {
      expect(isDeviceCredentialToken(t)).toBe(false);
    }
  });

  for (const client of ["node", "companion"] as const) {
    it(`a ${client} upgrade reply has exactly the fixture shape`, async () => {
      const { port } = await bridge();
      const deviceId = String(fx.upgradeReplies[client].deviceId);
      const reply = await call(
        port,
        "POST",
        "/auth/upgrade",
        SHARED,
        withDevice(fx.upgradeRequests[client], deviceId),
      );
      expectShape(reply, fx.upgradeReplies[client], ["token", "credentialId"]);
      expect(String(reply.token)).toMatch(new RegExp(fx.credentialPattern));
      expect(String(reply.token).split(".")[1]).toBe(reply.credentialId);
    });
  }

  it("register replies carry the fixture's credential hints", async () => {
    const { port, store } = await bridge();
    const upgrade = await call(port, "POST", "/devices/register", SHARED, {
      id: "dev_node01",
    });
    expect(upgrade).toEqual(fx.registerReplies.upgrade);
    const { token } = await store.mint({
      deviceId: "dev_node01",
      scopes: ["device"],
      origin: "upgrade",
    });
    const none = await call(port, "POST", "/devices/register", token, {
      id: "dev_node01",
    });
    expect(none).toEqual(fx.registerReplies.none);
    await store.requestRotation("dev_node01");
    const rotate = await call(port, "POST", "/devices/register", token, {
      id: "dev_node01",
    });
    expect(rotate).toEqual(fx.registerReplies.rotate);
  });

  it("whoami answers in the fixture's shapes", async () => {
    const { port, store } = await bridge();
    expect(await call(port, "GET", "/auth/whoami", SHARED)).toEqual(
      fx.whoami.shared,
    );
    const { token } = await store.mint({
      deviceId: "dev_node01",
      scopes: ["device"],
      origin: "upgrade",
    });
    expectShape(
      await call(port, "GET", "/auth/whoami", token),
      fx.whoami.device,
      ["credentialId"],
    );
    await store.requestRotation("dev_node01");
    expectShape(
      await call(port, "GET", "/auth/whoami", token),
      fx.whoami.rotate,
      ["credentialId"],
    );
    await server?.stop();
    const open = await bridge(false);
    expect(await call(open.port, "GET", "/auth/whoami", undefined)).toEqual(
      fx.whoami.open,
    );
  });
});
