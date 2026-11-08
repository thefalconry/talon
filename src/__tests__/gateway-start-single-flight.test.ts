import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/plugin/index.js", () => ({
  handlePluginAction: vi.fn(async () => null),
}));

vi.mock("../core/engine/gateway-actions/index.js", () => ({
  handleSharedAction: vi.fn(async () => null),
  isChatFreeAction: vi.fn(() => false),
  handleChatFreeAction: vi.fn(async () => null),
}));

vi.mock("../util/watchdog.js", () => ({
  getHealthStatus: vi.fn(() => ({
    healthy: true,
    totalMessagesProcessed: 0,
    recentErrorCount: 0,
    msSinceLastMessage: 0,
  })),
}));

vi.mock("../storage/sessions.js", () => ({
  getActiveSessionCount: vi.fn(() => 0),
}));

vi.mock("../core/engine/dispatcher.js", () => ({
  getActiveCount: vi.fn(() => 0),
}));

import { Gateway } from "../core/engine/gateway.js";
import { gatewayFetch } from "./helpers/gateway-fetch.js";

let gateway: Gateway | null = null;

afterEach(async () => {
  await gateway?.stop();
  gateway = null;
});

/** The port /health claims to be listening on. */
async function healthPort(port: number): Promise<number> {
  const res = await gatewayFetch(`http://127.0.0.1:${port}/health`);
  const body = (await res.json()) as { port: number };
  return body.port;
}

describe("Gateway.start() single-flight", () => {
  it("binds once for concurrent callers and reports that one port", async () => {
    // The real shape of the bug: app.ts starts every non-stdin frontend with
    // Promise.all, and each frontend calls gateway.start() itself. Before the
    // fix each caller built its own http.Server and bound its own port.
    gateway = new Gateway();
    const started: number[] = [];
    gateway.onStarted((p) => started.push(p));

    const ports = await Promise.all([
      gateway.start(0),
      gateway.start(0),
      gateway.start(0),
    ]);

    expect(new Set(ports).size).toBe(1);
    const port = ports[0]!;
    expect(port).toBeGreaterThan(0);
    expect(gateway.getPort()).toBe(port);

    // /health must agree — it used to report the last finisher's port.
    expect(await healthPort(port)).toBe(port);

    // onStarted fires exactly once, with the bound port.
    expect(started).toEqual([port]);
  });

  it("serves the first caller's requested port to later callers", async () => {
    gateway = new Gateway();
    const [first, second] = await Promise.all([
      gateway.start(0),
      gateway.start(19876),
    ]);
    expect(second).toBe(first);
    expect(await healthPort(first)).toBe(first);
  });

  it("restarts cleanly after stop()", async () => {
    gateway = new Gateway();
    const first = await gateway.start(0);
    expect(first).toBeGreaterThan(0);
    await gateway.stop();
    expect(gateway.getPort()).toBe(0);

    const second = await gateway.start(0);
    expect(second).toBeGreaterThan(0);
    expect(await healthPort(second)).toBe(second);
  });

  it("returns the live port on a start() after the bind settled", async () => {
    gateway = new Gateway();
    const port = await gateway.start(0);
    expect(await gateway.start(0)).toBe(port);
  });
});
