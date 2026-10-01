/**
 * The bridge's auth posture, proven per route on the wire.
 *
 * BRIDGE_ROUTE_AUTH declares every route and its tier. This walks the
 * whole table against a live server with a token configured and checks
 * two things for each entry: without a credential, exactly the "public"
 * routes get past the auth gate; with the token, every route does. So a
 * route can only become pre-auth by being declared "public" in the table,
 * and that declaration is what a reviewer sees — the test does not need
 * updating when a route is added, only when the posture changes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  BRIDGE_ROUTE_AUTH,
  BridgeServer,
  type BridgeRouteKey,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";

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
  listChats: () => [],
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
  registerDevice: async () => ({ id: "d1" }) as never,
  storeLocation: async () => ({}) as never,
  listDevices: () => ({ devices: [], locations: [] }),
  completeCommand: () => false,
  acceptFileUpload: async () => ({ ok: false, error: "unused" }),
  openFileDownload: async () => null,
  openNodeInstall: () => null,
  openCompanionPair: () => null,
  openNodeBinary: () => null,
  openSecretDrop: () => null,
  isLiveSecretDrop: () => false,
  submitSecretDrop: async () => ({ status: 404, html: "" }),
};

const TOKEN = "route-table-secret";

/**
 * One request per route. `/events` is an SSE stream that never ends on
 * its own, so the status is read and the connection dropped.
 */
async function hit(
  port: number,
  key: BridgeRouteKey,
  token?: string,
): Promise<number> {
  const [method, path] = key.split(" ") as [string, string];
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: method === "POST" ? "{}" : undefined,
    signal: controller.signal,
  });
  const status = res.status;
  controller.abort();
  await res.body?.cancel().catch(() => {});
  return status;
}

describe("bridge route table", () => {
  let server: BridgeServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("declares exactly the six pre-auth routes as public", () => {
    const publicRoutes = Object.entries(BRIDGE_ROUTE_AUTH)
      .filter(([, tier]) => tier === "public")
      .map(([key]) => key)
      .sort();
    expect(publicRoutes).toEqual([
      "GET /health",
      "GET /node/binary",
      "GET /node/install",
      "GET /pair",
      "GET /secret",
      "POST /secret",
    ]);
  });

  it("holds every route's declared tier on the wire", async () => {
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token: TOKEN, startedAt: "boot" },
      handlers,
    );
    const port = await server.start();

    for (const key of Object.keys(BRIDGE_ROUTE_AUTH) as BridgeRouteKey[]) {
      const tier = BRIDGE_ROUTE_AUTH[key];
      const anonymous = await hit(port, key);
      if (tier === "public") {
        expect(
          anonymous,
          `${key} is public but refused an anonymous caller`,
        ).not.toBe(401);
      } else {
        expect(
          anonymous,
          `${key} is bearer-gated but served without a token`,
        ).toBe(401);
      }
      const authed = await hit(port, key, TOKEN);
      expect(authed, `${key} refused the bridge token`).not.toBe(401);
    }
  });

  it("answers an unknown route 401 before 404, so anonymous callers learn nothing", async () => {
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token: TOKEN, startedAt: "boot" },
      handlers,
    );
    const port = await server.start();
    const anonymous = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(anonymous.status).toBe(401);
    const authed = await fetch(`http://127.0.0.1:${port}/nope`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(authed.status).toBe(404);
    // A public path under the wrong method is not public.
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/health`, {
      method: "POST",
    });
    expect(wrongMethod.status).toBe(401);
  });
});
