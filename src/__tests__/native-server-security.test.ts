import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  BridgeServer,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";
import type { BridgeEvent } from "../frontend/native/protocol.js";
import { connect, type Socket } from "node:net";

const handlers: BridgeServerHandlers = {
  status: () => ({
    app: "talon-bridge",
    protocol: 1,
    botName: "Talon",
    backend: "test",
    model: "m1",
    activeChats: 2,
    startedAt: "now",
  }),
  listChats: () => [],
  createChat: () => {
    throw new Error("unused");
  },
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
  registerDevice: async () => ({}) as never,
  storeLocation: async () => ({}) as never,
  listDevices: () => ({ devices: [], locations: [] }),
  completeCommand: () => false,
  acceptFileUpload: async () => ({ ok: false, error: "unused" }),
  openFileDownload: async () => null,
  openNodeInstall: () => null,
  openCompanionPair: () => null,
  openNodeBinary: () => null,
};

describe("bridge server security posture", () => {
  let server: BridgeServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  // Backoff off so the lockout tests can fire 20 wrong tokens quickly; the
  // backoff itself is covered in native-bridge-auth-guard.test.ts.
  async function startServer(token?: string): Promise<number> {
    server = new BridgeServer(
      {
        host: "127.0.0.1",
        port: 0,
        token,
        startedAt: "boot",
        authPolicy: { backoffBaseMs: 0 },
      },
      handlers,
    );
    return server.start();
  }

  const get = (port: number, path: string, token?: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  it("serves only pairing data on unauthenticated /health", async () => {
    const port = await startServer("secret");
    const res = await get(port, "/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.app).toBe("talon-bridge");
    expect(body.authRequired).toBe(true);
    expect(typeof body.protocol).toBe("number");
    for (const leaked of [
      "botName",
      "backend",
      "model",
      "activeChats",
      "startedAt",
      "host",
      "capabilities",
    ]) {
      expect(body).not.toHaveProperty(leaked);
    }
  });

  it("serves the full /health to an authenticated client", async () => {
    const port = await startServer("secret");
    const body = (await (
      await get(port, "/health", "secret")
    ).json()) as Record<string, unknown>;
    expect(body.botName).toBe("Talon");
    expect(body.backend).toBe("test");
    expect(body.activeChats).toBe(2);
    expect(body.startedAt).toBe("boot");
  });

  it("keeps the full /health when no token is configured (local use)", async () => {
    const port = await startServer();
    const body = (await (await get(port, "/health")).json()) as Record<
      string,
      unknown
    >;
    expect(body.botName).toBe("Talon");
    expect(body.authRequired).toBe(false);
  });

  it("locks out an address after repeated wrong tokens", async () => {
    const port = await startServer("secret");
    for (let i = 0; i < 20; i++) {
      expect((await get(port, "/chats", "wrong")).status).toBe(401);
    }
    // Locked out now — even the correct token is refused for the window.
    const locked = await get(port, "/chats", "secret");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
  });

  it("does not count tokenless probes toward the lockout", async () => {
    const port = await startServer("secret");
    for (let i = 0; i < 25; i++) {
      expect((await get(port, "/chats")).status).toBe(401);
    }
    expect((await get(port, "/chats", "secret")).status).toBe(200);
  });

  it("resets the failure count on a successful auth", async () => {
    const port = await startServer("secret");
    for (let i = 0; i < 19; i++) await get(port, "/chats", "wrong");
    expect((await get(port, "/chats", "secret")).status).toBe(200);
    // Counter cleared — 19 more misses still don't trip the lockout.
    for (let i = 0; i < 19; i++) await get(port, "/chats", "wrong");
    expect((await get(port, "/chats", "secret")).status).toBe(200);
  });

  it("marks every response nosniff", async () => {
    const port = await startServer("secret");
    for (const res of [
      await get(port, "/health"),
      await get(port, "/chats", "secret"),
      await get(port, "/chats", "wrong"),
    ]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("gates the pre-auth node provisioning routes on the grant token alone", async () => {
    // Deliberately pre-auth (a fresh host holds no bearer yet) — so a bad or
    // missing provision token must 404, and a valid one must serve without
    // any Authorization header.
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token: "secret", startedAt: "boot" },
      {
        ...handlers,
        openNodeInstall: (token) =>
          token === "good-grant"
            ? { script: "#!/bin/sh\necho install", filename: "install.sh" }
            : null,
      },
    );
    const port = await server.start();

    expect((await get(port, "/node/install")).status).toBe(404);
    expect((await get(port, "/node/install?provision=wrong")).status).toBe(404);
    const ok = await get(port, "/node/install?provision=good-grant");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("echo install");
    expect((await get(port, "/node/binary?provision=wrong")).status).toBe(404);
  });
});

/**
 * Device commands carry one-time transfer tokens, exec command lines and —
 * on the chunked fallback — whole base64 file bodies. They used to go to
 * every SSE client with each client filtering by its own id, which is
 * courtesy rather than enforcement. These drive the real transport: a live
 * server, real SSE connections, real frames on the wire.
 */
describe("bridge server device addressing", () => {
  let server: BridgeServer | null = null;
  const streams: SseStream[] = [];

  afterEach(async () => {
    for (const s of streams.splice(0)) s.close();
    await server?.stop();
    server = null;
  });

  type SseStream = { text: () => string; close: () => void };

  /** Open a real /events stream, accumulating frames as they arrive. */
  async function openEvents(
    port: number,
    deviceId?: string,
  ): Promise<SseStream> {
    const query = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/events${query}`, {
      headers: { Authorization: "Bearer secret" },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = "";
    void (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    })().catch(() => {
      /* stream closed — the test is done with it */
    });
    const stream: SseStream = {
      text: () => text,
      close: () => void reader.cancel().catch(() => {}),
    };
    streams.push(stream);
    return stream;
  }

  /** Let the frames written by sendToDevice reach the sockets. */
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 100));

  const get = (port: number, path: string, token?: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  const command = (deviceId: string, token: string): BridgeEvent => ({
    kind: "device_command",
    id: "cmd-1",
    deviceId,
    name: "download_file",
    params: { token, path: "/sdcard/secret.bin" },
  });

  it("delivers a device command only to the client that claimed the device", async () => {
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token: "secret", startedAt: "boot" },
      handlers,
    );
    const port = await server.start();
    const phone = await openEvents(port, "phone");
    const laptop = await openEvents(port, "laptop");

    server.sendToDevice("phone", command("phone", "one-time-token"));
    await settle();

    expect(phone.text()).toContain("one-time-token");
    expect(laptop.text()).not.toContain("one-time-token");
    expect(laptop.text()).not.toContain("device_command");
    // Non-addressed events still reach everyone.
    server.broadcast({ kind: "typing", chatId: "c1", on: true });
    await settle();
    expect(laptop.text()).toContain("typing");
  });

  it("keeps unclaimed clients working without showing them addressed traffic", async () => {
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token: "secret", startedAt: "boot" },
      handlers,
    );
    const port = await server.start();
    // A companion build from before the claim existed, plus a modern one.
    const legacy = await openEvents(port);
    const phone = await openEvents(port, "phone");

    // Nobody claims "tablet", so the legacy client is the only audience left
    // — that fallback is what keeps pre-claim builds reachable.
    server.sendToDevice("tablet", command("tablet", "tablet-token"));
    await settle();
    expect(legacy.text()).toContain("tablet-token");

    // But a claimed device's traffic never reaches it.
    server.sendToDevice("phone", command("phone", "phone-token"));
    await settle();
    expect(phone.text()).toContain("phone-token");
    expect(legacy.text()).not.toContain("phone-token");
  });

  it("passes the caller's claimed device id to the transfer routes", async () => {
    const seen: Array<string | undefined> = [];
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token: "secret", startedAt: "boot" },
      {
        ...handlers,
        openFileDownload: async (_token, fromDeviceId) => {
          seen.push(fromDeviceId);
          return null;
        },
      },
    );
    const port = await server.start();

    await get(port, "/devices/file?transfer=t1&deviceId=phone", "secret");
    await get(port, "/devices/file?transfer=t1", "secret");
    expect(seen).toEqual(["phone", undefined]);
  });
  it("serves a pairing grant pre-auth, once, and never caches it", async () => {
    const served: Array<[string, string]> = [];
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token: "secret", startedAt: "boot" },
      {
        ...handlers,
        openCompanionPair: (token, format) => {
          served.push([token, format]);
          // One grant, one serve — the store's own single-use latch.
          return served.length > 1
            ? null
            : {
                contentType: "text/html; charset=utf-8",
                body: '<a href="talon://pair?u=x">Open</a>',
              };
        },
      },
    );
    const port = await server.start();

    // No Authorization header: the whole point is a phone that holds no
    // bridge credential yet, so the grant must be the entire authorization.
    const first = await get(port, "/pair?grant=g1");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.text()).toContain("talon://pair");

    const replay = await get(port, "/pair?grant=g1");
    expect(replay.status).toBe(404);
    // The route asks both times — refusing a spent grant is the store's
    // job, not the transport's.
    expect(served).toEqual([
      ["g1", "html"],
      ["g1", "html"],
    ]);
  });

  it("asks for JSON when the companion does", async () => {
    const formats: string[] = [];
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token: "secret", startedAt: "boot" },
      {
        ...handlers,
        openCompanionPair: (_token, format) => {
          formats.push(format);
          return {
            contentType: "application/json; charset=utf-8",
            body: '{"url":"http://h:1"}',
          };
        },
      },
    );
    const port = await server.start();

    await get(port, "/pair?grant=g1&format=json");
    await fetch(`http://127.0.0.1:${port}/pair?grant=g2`, {
      headers: { Accept: "application/json" },
    });
    expect(formats).toEqual(["json", "json"]);
  });

  it("refuses a /pair request with no grant at all", async () => {
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token: "secret", startedAt: "boot" },
      handlers,
    );
    const port = await server.start();
    const res = await get(port, "/pair");
    expect(res.status).toBe(404);
  });
});

/**
 * A client that stops reading without closing its socket (phone asleep,
 * network switch) must not buffer the whole event stream in daemon memory
 * until TCP gives up on it.
 */
describe("bridge server event-stream backlog", () => {
  let server: BridgeServer | null = null;
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    await server?.stop();
    server = null;
  });

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** A raw /events connection; `read: false` never consumes a byte. */
  async function rawEvents(
    port: number,
    read: boolean,
  ): Promise<{ socket: Socket; text: () => string }> {
    const socket = connect(port, "127.0.0.1");
    sockets.push(socket);
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    let text = "";
    if (read) socket.on("data", (d: Buffer) => (text += d.toString()));
    else socket.pause();
    await wait(100);
    return { socket, text: () => text };
  }

  it("drops a stalled client once its backlog passes the cap, keeping live ones", async () => {
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, startedAt: "boot" },
      handlers,
    );
    const port = await server.start();
    const stalled = await rawEvents(port, false);
    const live = await rawEvents(port, true);

    // ~25 MB of turn traffic, paced so a reading client keeps up.
    const bulk = "x".repeat(64 * 1024);
    for (let batch = 0; batch < 40; batch++) {
      for (let i = 0; i < 10; i++) {
        server.broadcast({ kind: "delta", chatId: "c1", text: bulk });
      }
      await wait(5);
    }
    server.broadcast({ kind: "typing", chatId: "c1", on: true });

    // The stalled socket was cut: reading what the kernel holds reaches EOF.
    const closed = new Promise<boolean>((resolve) => {
      stalled.socket.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 3_000).unref();
    });
    stalled.socket.resume();
    expect(await closed).toBe(true);

    await wait(100);
    expect(live.socket.destroyed).toBe(false);
    expect(live.text()).toContain('"kind":"typing"');
  });
});
