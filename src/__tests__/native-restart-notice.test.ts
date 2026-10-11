/**
 * The restart notice: when the bridge stops, every open event stream gets
 * a `bye` frame before it ends, so devices know whether a successor is
 * coming and when to be back (instead of waiting out their backoff).
 */

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

let server: BridgeServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

/** Open /events and resolve with every frame once the server ends it. */
async function streamUntilClosed(
  port: number,
  deviceId?: string,
): Promise<{ frames: Promise<BridgeEvent[]> }> {
  const query = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/events${query}`, {
    headers: { Authorization: "Bearer secret" },
  });
  expect(res.status).toBe(200);
  const body = res.body!;
  // Wrapped: an async function returning a bare promise would await it.
  const frames = (async () => {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of body) {
      text += decoder.decode(chunk as Uint8Array, { stream: true });
    }
    return text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as BridgeEvent);
  })();
  return { frames };
}

async function start(): Promise<number> {
  server = new BridgeServer(
    { host: "127.0.0.1", port: 0, token: "secret", startedAt: "boot" },
    handlers,
  );
  return server.start();
}

describe("bridge restart notice", () => {
  it("tells every stream a restart is coming, and when to be back, as its last frame", async () => {
    const port = await start();
    const device = await streamUntilClosed(port, "node-1");
    const desktop = await streamUntilClosed(port);

    await server!.stop({ restart: { reconnectAfterMs: 5_000 } });
    server = null;

    for (const frames of [await device.frames, await desktop.frames]) {
      expect(frames[0]?.kind).toBe("hello");
      expect(frames.at(-1)).toEqual({
        kind: "bye",
        reason: "restart",
        reconnectAfterMs: 5_000,
      });
    }
  });

  it("says shutdown, with no schedule, on a plain stop", async () => {
    const port = await start();
    const device = await streamUntilClosed(port, "node-1");

    await server!.stop();
    server = null;

    expect((await device.frames).at(-1)).toEqual({
      kind: "bye",
      reason: "shutdown",
    });
  });
});
