/**
 * Device commands across a reconnect, on the real transport: a live bridge
 * server, real SSE streams, the real mesh service and the wiring the native
 * frontend uses (mesh-transport.ts).
 *
 * The daemon restarts about 1.6 times a day and every device reconnects
 * after it. A command issued in that gap used to be written to nobody (or
 * to an unclaimed legacy client) and then wait out its whole timeout.
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
  BridgeServer,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";
import { registerMeshTransport } from "../frontend/native/mesh-transport.js";
import { MeshRegistry, MeshService } from "../core/mesh/index.js";
import type { BridgeEvent } from "../frontend/native/protocol.js";

/** Only what opening an event stream reads. */
const handlers = {
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
  liveTurnEvents: () => [],
} as unknown as BridgeServerHandlers;

type SseStream = { text: () => string; close: () => Promise<void> };

let server: BridgeServer | null = null;
const streams: SseStream[] = [];

afterEach(async () => {
  for (const s of streams.splice(0)) await s.close();
  await server?.stop();
  server = null;
});

async function startServer(): Promise<{ server: BridgeServer; port: number }> {
  server = new BridgeServer(
    { host: "127.0.0.1", port: 0, token: "secret", startedAt: "boot" },
    handlers,
  );
  return { server, port: await server.start() };
}

async function openEvents(port: number, deviceId?: string): Promise<SseStream> {
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
    /* stream closed */
  });
  const stream: SseStream = {
    text: () => text,
    close: () => reader.cancel().catch(() => {}),
  };
  streams.push(stream);
  return stream;
}

const settle = (ms = 100): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await settle(10);
  }
}

async function meshWithPhone(commandHoldMs: number): Promise<{
  mesh: MeshService;
  phone: Parameters<MeshService["sendCommand"]>[0];
}> {
  const dir = await mkdtemp(join(tmpdir(), "talon-command-hold-"));
  const mesh = new MeshService(
    new MeshRegistry({
      devices: join(dir, "devices.json"),
      locations: join(dir, "locations.json"),
      history: join(dir, "history.json"),
    }),
    { commandHoldMs },
  );
  await mesh.register({
    id: "phone",
    name: "Pixel 9",
    platform: "android",
    appVersion: "1.0.0",
  });
  const phone = (await mesh.list()).devices.find((d) => d.id === "phone")!;
  return { mesh, phone };
}

/** The `device_command` frames on a stream. */
function commandsOn(stream: SseStream): Array<{ id: string; name: string }> {
  return stream
    .text()
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as BridgeEvent)
    .filter((event) => event.kind === "device_command")
    .map((event) => event as unknown as { id: string; name: string });
}

describe("device commands across a reconnect", () => {
  it("delivers a command sent before the device's stream opens (fresh daemon)", async () => {
    const { server, port } = await startServer();
    const { mesh, phone } = await meshWithPhone(5_000);
    const detach = registerMeshTransport(
      { mesh, broadcast: (event) => server.broadcast(event) },
      server,
    );

    // The device is "online" by presence but has no stream yet: exactly
    // the state just after a daemon restart.
    const pending = mesh.sendCommand(phone, "ring", {}, 10_000);
    await settle();
    const stream = await openEvents(port, "phone");
    await until(() => commandsOn(stream).length === 1);

    const [frame] = commandsOn(stream);
    expect(frame!.name).toBe("ring");
    mesh.completeCommand({ commandId: frame!.id, deviceId: "phone", ok: true });
    expect((await pending).ok).toBe(true);
    detach();
  });

  it("holds a reconnecting device's command instead of handing it to an unclaimed client", async () => {
    const { server, port } = await startServer();
    const { mesh, phone } = await meshWithPhone(5_000);
    registerMeshTransport(
      { mesh, broadcast: (event) => server.broadcast(event) },
      server,
    );
    const legacy = await openEvents(port);
    const first = await openEvents(port, "phone");
    await first.close();
    await settle();

    const pending = mesh.sendCommand(
      phone,
      "exec",
      { cmd: "id", secret: "s3cret" },
      10_000,
    );
    await settle();
    expect(legacy.text()).not.toContain("s3cret");

    const again = await openEvents(port, "phone");
    await until(() => commandsOn(again).length === 1);
    expect(legacy.text()).not.toContain("s3cret");
    const [frame] = commandsOn(again);
    mesh.completeCommand({ commandId: frame!.id, deviceId: "phone", ok: true });
    expect((await pending).ok).toBe(true);
  });

  it("fails fast when the device does not come back within the hold", async () => {
    await startServer();
    const { mesh, phone } = await meshWithPhone(150);
    registerMeshTransport(
      { mesh, broadcast: (event) => server!.broadcast(event) },
      server!,
    );

    const started = Date.now();
    const result = await mesh.sendCommand(phone, "ring", {}, 10_000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('"ring" was not delivered');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("reports where sendToDevice put the frame", async () => {
    const { server, port } = await startServer();
    const event: BridgeEvent = {
      kind: "device_command",
      id: "c1",
      deviceId: "tablet",
      name: "ring",
      params: {},
    };
    expect(server.sendToDevice("tablet", event)).toBe("none");
    // A pre-claim client is still the audience for a device that never
    // claimed a stream…
    await openEvents(port);
    expect(server.sendToDevice("tablet", event)).toBe("fallback");
    // …but not once that device has claimed one: then it is reconnecting.
    const tablet = await openEvents(port, "tablet");
    expect(server.sendToDevice("tablet", event)).toBe("claimed");
    await tablet.close();
    await settle();
    expect(server.sendToDevice("tablet", event)).toBe("none");
  });
});
