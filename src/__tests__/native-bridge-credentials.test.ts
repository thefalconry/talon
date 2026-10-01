/**
 * Per-device credentials on the wire (#1042 phase 2).
 *
 * A live bridge with the shared token AND a credential store: every route's
 * declared scope holds for device-, client- and operator-scoped credentials;
 * a credential can never act as another device; device-only streams hear no
 * chat traffic and no other device's commands; revocation drops live
 * sessions; and the shared-token → per-device upgrade and rotation
 * handshakes work end to end, including with legacy mode off.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_ROUTE_AUTH,
  BridgeServer,
  type BridgeRouteKey,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";
import { routeAllows } from "../frontend/native/bridge/credentials/principal.js";
import type { AuthGuardPolicy } from "../frontend/native/bridge/auth-guard.js";
import {
  DEFAULT_COMPANION_SCOPES,
  DeviceCredentialStore,
  type MeshScope,
} from "../core/mesh/credentials/index.js";

const SHARED = "shared-bridge-secret";

const registered: Record<string, unknown>[] = [];
const results: Record<string, unknown>[] = [];

const handlers: BridgeServerHandlers = {
  status: () => ({
    app: "talon-bridge",
    protocol: 1,
    botName: "Talon",
    backend: "test",
    model: "m1",
    activeChats: 0,
    startedAt: "now",
  }),
  listChats: () => [{ id: "c1", title: "secret chat" }] as never,
  createChat: () => ({}) as never,
  renameChat: () => null,
  deleteChat: () => false,
  history: () => [],
  search: () => [],
  listMemory: () => ({ ok: true, rows: [] }),
  memoryWhy: () => null,
  send: () => {},
  upload: async () => ({
    path: "",
    name: "",
    size: 0,
    mimeType: "application/octet-stream",
    url: "",
    image: false,
  }),
  listModels: () => ({ active: "", models: [] }),
  setModel: () => {},
  listBackends: () => ({ active: "", backends: [] }),
  setBackend: async () => ({ ok: true }),
  setEffort: () => {},
  effortLevels: async () => ({ active: "", levels: [] }),
  listPlugins: () => [],
  setPluginEnabled: async () => ({ ok: true }),
  listSkills: () => [],
  setSkillEnabled: () => ({ ok: true }),
  resetChat: () => false,
  interruptTurn: async () => false,
  setPulse: () => {},
  queueMessage: () => {},
  getConfig: () => ({}) as never,
  setConfig: () => ({}) as never,
  control: async () => ({ ok: true, message: "" }),
  logs: () => [],
  liveTurnEvents: () => [],
  listCommands: () => [],
  mediaPath: () => null,
  registerDevice: async (body) => {
    registered.push(body);
    return { id: String(body.id ?? "anon") } as never;
  },
  storeLocation: async () => ({}) as never,
  listDevices: () => ({ devices: [], locations: [] }),
  completeCommand: (body) => {
    results.push(body);
    return true;
  },
  acceptFileUpload: async () => ({ ok: false, error: "unused" }),
  openFileDownload: async () => null,
  openNodeInstall: () => null,
  openCompanionPair: () => null,
  openNodeBinary: () => null,
  openSecretDrop: () => null,
  isLiveSecretDrop: () => false,
  submitSecretDrop: async () => ({ status: 404, html: "" }),
};

type Setup = {
  server: BridgeServer;
  port: number;
  store: DeviceCredentialStore;
};

let current: BridgeServer | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
  registered.length = 0;
  results.length = 0;
});

async function setup(
  opts: {
    legacySharedToken?: boolean;
    companionScopes?: MeshScope[];
    authPolicy?: Partial<AuthGuardPolicy>;
  } = {},
): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), "talon-bridge-creds-"));
  const store = new DeviceCredentialStore(join(dir, "creds.json"));
  await store.load();
  const server = new BridgeServer(
    {
      host: "127.0.0.1",
      port: 0,
      token: SHARED,
      startedAt: "boot",
      ...(opts.authPolicy ? { authPolicy: opts.authPolicy } : {}),
      credentials: {
        authority: store,
        policy: {
          legacySharedToken: opts.legacySharedToken ?? true,
          companionScopes: opts.companionScopes ?? ["device", "client"],
        },
      },
    },
    handlers,
  );
  current = server;
  const port = await server.start();
  return { server, port, store };
}

async function call(
  port: number,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    signal: controller.signal,
  });
  const status = res.status;
  let parsed: Record<string, unknown> = {};
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    parsed = (await res.json()) as Record<string, unknown>;
  } else {
    controller.abort();
    await res.body?.cancel().catch(() => {});
  }
  return { status, body: parsed };
}

/** Open an SSE stream and collect its frames until `stop()` or it ends. */
async function openStream(
  port: number,
  token: string,
  deviceId?: string,
): Promise<{
  status: number;
  frames: () => Record<string, unknown>[];
  ended: Promise<void>;
  stop: () => void;
}> {
  const controller = new AbortController();
  const q = new URLSearchParams({ token });
  if (deviceId) q.set("deviceId", deviceId);
  const res = await fetch(`http://127.0.0.1:${port}/events?${q}`, {
    signal: controller.signal,
  });
  const collected: Record<string, unknown>[] = [];
  let buffer = "";
  const ended = (async () => {
    if (!res.body || res.status !== 200) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith("data: ")) {
            collected.push(
              JSON.parse(frame.slice(6)) as Record<string, unknown>,
            );
          }
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    status: res.status,
    frames: () => collected,
    ended,
    stop: () => controller.abort(),
  };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("per-route scopes", () => {
  it("every route's declared scope holds for single-scope credentials", async () => {
    const { port, store } = await setup();
    for (const scope of ["device", "client", "operator"] as const) {
      const { token } = await store.mint({
        deviceId: `dev-${scope}`,
        scopes: [scope],
        origin: "upgrade",
      });
      for (const key of Object.keys(BRIDGE_ROUTE_AUTH) as BridgeRouteKey[]) {
        const tier = BRIDGE_ROUTE_AUTH[key];
        if (tier === "public") continue;
        const [method, path] = key.split(" ") as [string, string];
        const { status } = await call(port, method, path, token);
        const allowed = routeAllows(tier, {
          kind: "device",
          credentialId: "x",
          deviceId: `dev-${scope}`,
          scopes: [scope],
        });
        if (allowed) {
          expect(status, `${key} refused a ${scope} credential`).not.toBe(403);
          expect(status).not.toBe(401);
        } else {
          expect(status, `${key} served a ${scope}-only credential`).toBe(403);
        }
      }
    }
  });

  it("a device-only credential cannot read config, change it, or read logs", async () => {
    const { port, store } = await setup();
    const { token } = await store.mint({
      deviceId: "node-a",
      scopes: ["device"],
      origin: "install",
    });
    expect((await call(port, "GET", "/config", token)).status).toBe(403);
    expect((await call(port, "POST", "/config", token, { x: 1 })).status).toBe(
      403,
    );
    expect((await call(port, "GET", "/logs", token)).status).toBe(403);
    expect((await call(port, "POST", "/send", token, {})).status).toBe(403);
    expect((await call(port, "POST", "/control", token, {})).status).toBe(403);
  });

  it("the shared token keeps every scope", async () => {
    const { port } = await setup();
    expect((await call(port, "GET", "/logs", SHARED)).status).toBe(200);
    expect((await call(port, "GET", "/config", SHARED)).status).toBe(200);
  });

  it("a revoked or garbage credential is 401, not 403", async () => {
    const { port, store } = await setup();
    const { token } = await store.mint({
      deviceId: "a",
      scopes: ["device"],
      origin: "upgrade",
    });
    await store.revokeDevice("a", "test");
    expect((await call(port, "GET", "/auth/whoami", token)).status).toBe(401);
    expect(
      (
        await call(
          port,
          "GET",
          "/auth/whoami",
          `tdc1.${"0".repeat(16)}.${"A".repeat(43)}`,
        )
      ).status,
    ).toBe(401);
  });
});

describe("auth guard", () => {
  it("a wrong per-device credential counts toward the auth guard like a wrong shared token", async () => {
    const { port, store } = await setup({
      authPolicy: { backoffBaseMs: 0, globalMaxFailures: 3 },
    });
    const { token } = await store.mint({
      deviceId: "a",
      scopes: ["device"],
      origin: "upgrade",
    });
    await store.revokeDevice("a", "test");
    const garbage = `tdc1.${"0".repeat(16)}.${"A".repeat(43)}`;
    expect((await call(port, "GET", "/auth/whoami", token)).status).toBe(401);
    expect((await call(port, "GET", "/auth/whoami", garbage)).status).toBe(401);
    expect((await call(port, "GET", "/auth/whoami", "wrong")).status).toBe(401);
    // Past the global threshold: a fourth bad credential of either kind is
    // refused outright, while a valid one still gets in.
    expect((await call(port, "GET", "/auth/whoami", garbage)).status).toBe(429);
    const { token: good } = await store.mint({
      deviceId: "b",
      scopes: ["device"],
      origin: "upgrade",
    });
    expect((await call(port, "GET", "/auth/whoami", good)).status).toBe(200);
  });
});

describe("device-id spoofing", () => {
  it("a credential for A cannot register, report, answer or stream as B", async () => {
    const { port, store } = await setup();
    const { token } = await store.mint({
      deviceId: "A",
      scopes: ["device"],
      origin: "upgrade",
    });
    const reg = await call(port, "POST", "/devices/register", token, {
      id: "B",
    });
    expect(reg.status).toBe(403);
    expect(registered).toEqual([]);
    expect(
      (
        await call(port, "POST", "/location", token, {
          deviceId: "B",
          lat: 1,
          lon: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(port, "POST", "/devices/command-result", token, {
          commandId: "c1",
          deviceId: "B",
          ok: true,
        })
      ).status,
    ).toBe(403);
    expect(results).toEqual([]);
    expect(
      (await call(port, "GET", "/devices/file?deviceId=B&transfer=t", token))
        .status,
    ).toBe(403);
    const stream = await openStream(port, token, "B");
    expect(stream.status).toBe(403);
  });

  it("acting as itself works, and an omitted id is filled with its own", async () => {
    const { port, store } = await setup();
    const { token } = await store.mint({
      deviceId: "A",
      scopes: ["device"],
      origin: "upgrade",
    });
    expect(
      (await call(port, "POST", "/devices/register", token, { id: "A" }))
        .status,
    ).toBe(200);
    await call(port, "POST", "/devices/command-result", token, {
      commandId: "c1",
      ok: true,
    });
    expect(results[0]).toMatchObject({ deviceId: "A" });
  });

  it("an unbound pairing credential binds to the first id it names, then only that", async () => {
    const { port, store } = await setup();
    await store.mint({
      deviceId: "taken",
      scopes: ["device", "client", "operator"],
      origin: "upgrade",
    });
    const pair = store.mintNow({
      deviceId: null,
      scopes: ["device", "client"],
      origin: "pair",
    });
    // Cannot take over a device holding scopes the link lacks — and the
    // refusal is a 403 carrying the reason, never a 401 (the token is fine).
    const refused = await call(port, "POST", "/devices/register", pair.token, {
      id: "taken",
    });
    expect(refused.status).toBe(403);
    expect(String(refused.body.error)).toContain("already has a credential");
    expect(
      (
        await call(port, "POST", "/devices/register", pair.token, {
          id: "phone",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(port, "POST", "/devices/register", pair.token, {
          id: "other",
        })
      ).status,
    ).toBe(403);
    const who = await call(port, "GET", "/auth/whoami", pair.token);
    expect(who.body).toMatchObject({ kind: "device", deviceId: "phone" });
  });

  it("a pairing link re-pairs a known device: the old credential and its stream die", async () => {
    const { port, store } = await setup();
    const old = await store.mint({
      deviceId: "mac",
      scopes: ["device", "client"],
      origin: "upgrade",
    });
    const oldStream = await openStream(port, old.token, "mac");
    expect(oldStream.status).toBe(200);
    await tick();

    const pair = store.mintNow({
      deviceId: null,
      scopes: ["device", "client"],
      origin: "pair",
    });
    const stream = await openStream(port, pair.token, "mac");
    expect(stream.status).toBe(200);
    await Promise.race([
      oldStream.ended,
      tick(2_000).then(() => {
        throw new Error("re-paired device's old stream still open");
      }),
    ]);
    expect((await call(port, "GET", "/auth/whoami", old.token)).status).toBe(
      401,
    );
    const who = await call(port, "GET", "/auth/whoami", pair.token);
    expect(who.body).toMatchObject({ kind: "device", deviceId: "mac" });
    stream.stop();
  });
});

describe("streams", () => {
  it("device-only sessions get their own commands and locates, never chat traffic or a peer's commands", async () => {
    const { server, port, store } = await setup();
    const a = await store.mint({
      deviceId: "A",
      scopes: ["device"],
      origin: "install",
    });
    const b = await store.mint({
      deviceId: "B",
      scopes: ["device"],
      origin: "install",
    });
    const sa = await openStream(port, a.token);
    const sb = await openStream(port, b.token);
    const ui = await openStream(port, SHARED);
    await tick();
    server.broadcast({ kind: "typing", chatId: "c1", on: true } as never);
    server.broadcast({ kind: "locate" } as never);
    server.sendToDevice("A", {
      kind: "device_command",
      id: "cmd-1",
      deviceId: "A",
      name: "status",
      params: {},
    } as never);
    await tick(100);
    const kinds = (s: typeof sa) => s.frames().map((f) => f.kind);
    expect(kinds(sa)).toEqual(["hello", "locate", "device_command"]);
    expect(sa.frames()[0]).toMatchObject({ chats: [] });
    expect(kinds(sb)).toEqual(["hello", "locate"]);
    expect(kinds(ui)).toContain("typing");
    // The shared-token UI claimed nothing and A is claimed: not delivered.
    expect(kinds(ui)).not.toContain("device_command");
    for (const s of [sa, sb, ui]) s.stop();
  });

  it("revoking a device drops its live stream at once; other devices stay up", async () => {
    const { port, store } = await setup();
    const a = await store.mint({
      deviceId: "A",
      scopes: ["device"],
      origin: "install",
    });
    const b = await store.mint({
      deviceId: "B",
      scopes: ["device"],
      origin: "install",
    });
    const sa = await openStream(port, a.token);
    const sb = await openStream(port, b.token);
    await tick();
    await store.revokeDevice("A", "compromised");
    await Promise.race([
      sa.ended,
      tick(2_000).then(() => {
        throw new Error("revoked stream still open");
      }),
    ]);
    expect((await call(port, "GET", "/auth/whoami", a.token)).status).toBe(401);
    expect((await call(port, "GET", "/auth/whoami", b.token)).status).toBe(200);
    let bEnded = false;
    void sb.ended.then(() => (bEnded = true));
    await tick(100);
    expect(bEnded).toBe(false);
    sb.stop();
  });
});

describe("migration off the shared token", () => {
  it("a heartbeat on the shared token is told to upgrade; the upgrade mints a bound device credential", async () => {
    const { port } = await setup();
    const reg = await call(port, "POST", "/devices/register", SHARED, {
      id: "node-1",
    });
    expect(reg.body).toMatchObject({
      ok: true,
      credential: { action: "upgrade" },
    });

    const up = await call(port, "POST", "/auth/upgrade", SHARED, {
      deviceId: "node-1",
      client: "node",
      scopes: ["device"],
    });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({
      ok: true,
      deviceId: "node-1",
      scopes: ["device"],
    });
    const token = String(up.body.token);
    expect(token).toMatch(/^tdc1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);

    const who = await call(port, "GET", "/auth/whoami", token);
    expect(who.body).toMatchObject({
      kind: "device",
      deviceId: "node-1",
      scopes: ["device"],
      credentialId: up.body.credentialId,
    });
    expect(who.body.action).toBeUndefined();
    const again = await call(port, "POST", "/devices/register", token, {
      id: "node-1",
    });
    expect(again.body.credential).toBeUndefined();
  });

  it("caps in-band grants: node → device, companion → a narrowed policy", async () => {
    const { port } = await setup();
    const node = await call(port, "POST", "/auth/upgrade", SHARED, {
      deviceId: "n",
      client: "node",
      scopes: ["device", "client", "operator"],
    });
    expect(node.body.scopes).toEqual(["device"]);
    const phone = await call(port, "POST", "/auth/upgrade", SHARED, {
      deviceId: "p",
      client: "companion",
      scopes: ["device", "client", "operator"],
    });
    expect(phone.body.scopes).toEqual(["device", "client"]);
    const greedy = await call(port, "POST", "/auth/upgrade", SHARED, {
      deviceId: "g",
      client: "companion",
      scopes: ["operator"],
    });
    expect(greedy.status).toBe(403);
    const bad = await call(port, "POST", "/auth/upgrade", SHARED, {
      deviceId: "",
    });
    expect(bad.status).toBe(400);
  });

  it("with the default policy a companion upgrade carries operator, even when it asks for device + client", async () => {
    const { port } = await setup({
      companionScopes: [...DEFAULT_COMPANION_SCOPES],
    });
    const phone = await call(port, "POST", "/auth/upgrade", SHARED, {
      deviceId: "p",
      client: "companion",
      scopes: ["device", "client"],
    });
    expect(phone.body.scopes).toEqual(["device", "client", "operator"]);
    const node = await call(port, "POST", "/auth/upgrade", SHARED, {
      deviceId: "n",
      client: "node",
      scopes: ["device"],
    });
    expect(node.body.scopes).toEqual(["device"]);
    const deviceOnly = await call(port, "POST", "/auth/upgrade", SHARED, {
      deviceId: "d",
      client: "companion",
      scopes: ["device"],
    });
    expect(deviceOnly.body.scopes).toEqual(["device"]);
  });

  it("rotation: flagged on the heartbeat, re-issued in-band, old credential dies on the new one's first use", async () => {
    const { port, store } = await setup();
    const first = await store.mint({
      deviceId: "A",
      scopes: ["device"],
      origin: "install",
    });
    await store.requestRotation("A");
    const reg = await call(port, "POST", "/devices/register", first.token, {
      id: "A",
    });
    expect(reg.body).toMatchObject({ credential: { action: "rotate" } });
    expect(
      (await call(port, "GET", "/auth/whoami", first.token)).body.action,
    ).toBe("rotate");

    const spoof = await call(port, "POST", "/auth/upgrade", first.token, {
      deviceId: "B",
    });
    expect(spoof.status).toBe(403);

    const up = await call(port, "POST", "/auth/upgrade", first.token, {
      deviceId: "A",
    });
    expect(up.status).toBe(200);
    const next = String(up.body.token);
    // Old one still works until the new one is used (lost-reply safety).
    expect((await call(port, "GET", "/auth/whoami", first.token)).status).toBe(
      200,
    );
    expect((await call(port, "GET", "/auth/whoami", next)).status).toBe(200);
    await tick();
    expect((await call(port, "GET", "/auth/whoami", first.token)).status).toBe(
      401,
    );
  });

  it("with legacy mode off, the shared token works only for same-machine, unproxied clients", async () => {
    const { port } = await setup({ legacySharedToken: false });
    expect((await call(port, "GET", "/auth/whoami", SHARED)).status).toBe(200);
    const proxied = await call(port, "GET", "/auth/whoami", SHARED, undefined, {
      "X-Forwarded-For": "203.0.113.9",
    });
    expect(proxied.status).toBe(401);
  });

  it("with legacy mode on, a proxied shared-token client still works and is offered the upgrade", async () => {
    const { port } = await setup();
    const who = await call(port, "GET", "/auth/whoami", SHARED, undefined, {
      "X-Forwarded-For": "203.0.113.9",
    });
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ kind: "shared", action: "upgrade" });
  });

  it("without a credential store the upgrade endpoint says so", async () => {
    const server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token: SHARED, startedAt: "boot" },
      handlers,
    );
    current = server;
    const port = await server.start();
    const up = await call(port, "POST", "/auth/upgrade", SHARED, {
      deviceId: "x",
    });
    expect(up.status).toBe(404);
    const reg = await call(port, "POST", "/devices/register", SHARED, {
      id: "x",
    });
    expect(reg.body.credential).toBeUndefined();
  });
});
