import { describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { claimDevice } from "../frontend/native/bridge/credentials/claims.js";
import type {
  BridgeCredentials,
  BridgePrincipal,
} from "../frontend/native/bridge/credentials/principal.js";
import { logWarn } from "../util/log.js";

describe("claimDevice — unbound pairing credential", () => {
  it("logs a refused bind (device already holds a live credential)", () => {
    const error =
      "Device mac already has a credential — revoke it first (talon mesh revoke mac)";
    const credentials = {
      authority: { bind: vi.fn(() => ({ ok: false, error })) },
    } as unknown as BridgeCredentials;
    const principal = {
      kind: "device",
      credentialId: "5cccbfb5d2d65eb0",
      deviceId: null,
      scopes: ["device", "client", "operator"],
    } as unknown as BridgePrincipal;

    expect(claimDevice(principal, "mac", credentials)).toEqual({
      ok: false,
      error,
    });
    expect(vi.mocked(logWarn)).toHaveBeenCalledWith(
      "native",
      expect.stringContaining(
        "bridge.auth event=bind_refused credential=5cccbfb5d2d65eb0 device=mac",
      ),
    );
  });
});
