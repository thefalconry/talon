/**
 * WhatsApp pairing policy + the admin-notify seam.
 *
 * Pairing is on demand only (see whatsapp-pairing-broker.test.ts for the
 * broker/lock invariants); what lives here is the close-code taxonomy the
 * connection loop reads and the notify seam that carries alerts about a
 * dead frontend over a live one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { classifyClose } from "../frontend/whatsapp/connection/pairing.js";
import {
  clearPendingAdminNotifications,
  notifyAdmin,
  setAdminNotifier,
} from "../core/frontend-runtime/admin-notify.js";

afterEach(() => {
  setAdminNotifier(null);
  clearPendingAdminNotifications();
});

describe("admin notify seam", () => {
  it("delivers through the wired notifier", async () => {
    const delivered: string[] = [];
    setAdminNotifier(async (text) => {
      delivered.push(text);
    });
    expect(await notifyAdmin("code ABCD-1234")).toBe(true);
    expect(delivered).toEqual(["code ABCD-1234"]);
  });

  it("degrades to false when nothing is wired", async () => {
    expect(await notifyAdmin("nobody home")).toBe(false);
  });

  it("swallows delivery failures rather than throwing into the caller", async () => {
    setAdminNotifier(async () => {
      throw new Error("telegram down too");
    });
    await expect(notifyAdmin("x")).resolves.toBe(false);
  });
});

describe("close-code taxonomy", () => {
  it("reads 515 as pairing success, not an error", () => {
    // Entering a pairing code CLOSES the connection with restartRequired;
    // the old handler logged it as an anonymous failure and applied
    // reconnect backoff to the very reconnect that completes the login.
    expect(classifyClose(515, false)).toEqual({ kind: "pairing-accepted" });
    expect(classifyClose(515, true)).toEqual({ kind: "pairing-accepted" });
  });

  it("reads 440 as a session takeover to back off from", () => {
    expect(classifyClose(440, true)).toEqual({ kind: "replaced" });
  });

  it("distinguishes a killed session from an expired pairing attempt", () => {
    expect(classifyClose(401, true)).toEqual({
      kind: "logged-out",
      midPairing: false,
    });
    expect(classifyClose(401, false)).toEqual({
      kind: "logged-out",
      midPairing: true,
    });
    expect(classifyClose(403, true)).toEqual({
      kind: "logged-out",
      midPairing: false,
    });
  });

  it("treats everything else as transient", () => {
    for (const code of [408, 428, 500, 503, undefined]) {
      expect(classifyClose(code, true)).toEqual({ kind: "reconnect" });
    }
  });
});
