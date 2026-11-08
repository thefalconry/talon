/**
 * Bridge-health watchdog in the MCP supervisor.
 *
 * Regression: under load the gateway's /health can take >2s to answer while
 * Talon is perfectly alive. Every supervisor counted those timeouts as
 * "Talon is gone" and killed its MCP child after ~60s — hundreds of children
 * at once, which then failed their registrations and had to respawn. A
 * timeout must be treated as "busy"; only a closed port means "gone".
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  BRIDGE_FAILURES_BEFORE_EXIT,
  BRIDGE_UNRESPONSIVE_BEFORE_EXIT,
  BridgeWatchdog,
  classifyBridgePingError,
  pingBridge,
} from "../core/mcp-hub/launcher.js";

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function closedPortUrl(): Promise<string> {
  const url = await listen(() => {});
  await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  return url;
}

describe("BridgeWatchdog", () => {
  it("does not evict when a live-but-busy gateway only times out for ~60s", () => {
    const w = new BridgeWatchdog();
    for (let i = 0; i < BRIDGE_FAILURES_BEFORE_EXIT; i++) {
      expect(w.record("unresponsive")).toBe(false);
    }
  });

  it("evicts after the short budget once the port is really closed", () => {
    const w = new BridgeWatchdog();
    for (let i = 0; i < BRIDGE_FAILURES_BEFORE_EXIT - 1; i++) {
      expect(w.record("unreachable")).toBe(false);
    }
    expect(w.record("unreachable")).toBe(true);
  });

  it("counts timeouts toward the short budget when the port then closes", () => {
    // Shutdown path: the old daemon stalls, then releases the port.
    const w = new BridgeWatchdog();
    for (let i = 0; i < BRIDGE_FAILURES_BEFORE_EXIT - 1; i++) {
      expect(w.record("unresponsive")).toBe(false);
    }
    expect(w.record("unreachable")).toBe(true);
  });

  it("still evicts a gateway wedged for the long budget", () => {
    const w = new BridgeWatchdog();
    for (let i = 0; i < BRIDGE_UNRESPONSIVE_BEFORE_EXIT - 1; i++) {
      expect(w.record("unresponsive")).toBe(false);
    }
    expect(w.record("unresponsive")).toBe(true);
  });

  it("a healthy ping resets the count", () => {
    const w = new BridgeWatchdog();
    for (let i = 0; i < BRIDGE_FAILURES_BEFORE_EXIT - 1; i++) {
      w.record("unreachable");
    }
    expect(w.record("ok")).toBe(false);
    expect(w.consecutiveFailures).toBe(0);
    expect(w.record("unreachable")).toBe(false);
  });
});

describe("pingBridge", () => {
  it("reports ok for a 2xx /health", async () => {
    const url = await listen((req, res) => {
      res.writeHead(req.url === "/health" ? 200 : 404).end("{}");
    });
    expect(await pingBridge(url, 1000)).toBe("ok");
  });

  it("reports unreachable for a non-2xx reply", async () => {
    const url = await listen((_req, res) => res.writeHead(503).end());
    expect(await pingBridge(url, 1000)).toBe("unreachable");
  });

  it("reports unreachable when nothing listens on the port", async () => {
    expect(await pingBridge(await closedPortUrl(), 1000)).toBe("unreachable");
  });

  it("reports unresponsive when the gateway accepts but does not answer in time", async () => {
    const url = await listen(() => {
      /* never respond — a saturated event loop */
    });
    expect(await pingBridge(url, 150)).toBe("unresponsive");
  });

  it("classifies abort/timeout errors as unresponsive, others as unreachable", () => {
    expect(classifyBridgePingError(new DOMException("t", "TimeoutError"))).toBe(
      "unresponsive",
    );
    expect(classifyBridgePingError(new DOMException("a", "AbortError"))).toBe(
      "unresponsive",
    );
    expect(classifyBridgePingError(new TypeError("fetch failed"))).toBe(
      "unreachable",
    );
    expect(classifyBridgePingError(null)).toBe("unreachable");
  });
});
