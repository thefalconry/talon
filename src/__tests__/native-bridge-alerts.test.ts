/**
 * Client-bridge boot alerts: a bridge that cannot listen, or cannot load
 * its TLS certificate, leaves every companion app unable to connect — the
 * operator hears it at once (`bridge.listen` / `bridge.tls`, critical), and
 * the next successful start resolves it.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../core/frontend-runtime/alerts.js", () => ({
  raiseAlert: vi.fn(),
  resolveAlert: vi.fn(),
}));

import {
  BridgeServer,
  type BridgeServerHandlers,
} from "../frontend/native/bridge/server.js";
import { raiseAlert, resolveAlert } from "../core/frontend-runtime/alerts.js";
import { logError } from "../util/log.js";

const handlers = {} as BridgeServerHandlers;

beforeEach(() => {
  vi.mocked(raiseAlert).mockClear();
  vi.mocked(resolveAlert).mockClear();
  vi.mocked(logError).mockClear();
});

describe("bridge boot alerts", () => {
  it("raises bridge.listen when the bridge cannot bind, resolves on a later start", async () => {
    // TEST-NET-3: never a local address, so bind fails with EADDRNOTAVAIL.
    const bad = new BridgeServer(
      { host: "203.0.113.1", port: 0, startedAt: "now" },
      handlers,
    );
    await expect(bad.start()).rejects.toThrow();
    expect(raiseAlert).toHaveBeenCalledWith(
      "bridge.listen",
      expect.stringMatching(
        /^The client bridge could not listen on 203\.0\.113\.1:0: .*EADDRNOTAVAIL.*Companion apps cannot connect\.$/,
      ),
      { severity: "critical" },
    );
    expect(logError).toHaveBeenCalledWith(
      "native",
      expect.stringMatching(
        /^bridge\.listen\.fail host=203\.0\.113\.1 port=0 attempt=0 err=/,
      ),
    );
    await bad.stop();

    const good = new BridgeServer(
      { host: "127.0.0.1", port: 0, startedAt: "now" },
      handlers,
    );
    await good.start();
    try {
      expect(resolveAlert).toHaveBeenCalledWith(
        "bridge.listen",
        "The client bridge is listening again.",
      );
    } finally {
      await good.stop();
    }
  });

  it("raises bridge.tls when the certificate cannot be loaded", async () => {
    const server = new BridgeServer(
      {
        host: "127.0.0.1",
        port: 0,
        startedAt: "now",
        tls: async () => {
          throw new Error("EACCES: permission denied, mkdir '/keys'");
        },
      },
      handlers,
    );
    await expect(server.start()).rejects.toThrow("EACCES");
    expect(raiseAlert).toHaveBeenCalledWith(
      "bridge.tls",
      "The client bridge could not load its TLS certificate: EACCES: permission denied, mkdir '/keys'. " +
        "Companion apps cannot connect.",
      { severity: "critical" },
    );
    expect(raiseAlert).not.toHaveBeenCalledWith(
      "bridge.listen",
      expect.anything(),
      expect.anything(),
    );
  });
});
