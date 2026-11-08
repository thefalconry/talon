/**
 * A QR-linked WhatsApp session must not be mistaken for an unpaired one.
 *
 * Baileys only sets `creds.registered` on the pairing-CODE path. Scan the QR
 * instead and the session is fully authenticated — it has `me`, `account` and
 * app-state keys, it sends and receives — while `registered` stays false for
 * the lifetime of the link.
 *
 * Reading that flag alone therefore parked a healthy session on its first
 * ordinary disconnect, and then `parkUntilPaired` waited on the same flag, so
 * nothing short of a process restart could get it back.
 *
 * These assert on the real shape of a QR session's creds, taken from a live
 * install, rather than on a hand-made object that happens to satisfy the fix.
 */
import { describe, it, expect } from "vitest";
import { isPaired } from "../frontend/whatsapp/connection/pairing.js";

// Shape observed on a working QR-linked install: authenticated in every way
// that matters, `registered` still false.
const qrLinked = {
  registered: false,
  me: { id: "447700900101:3@s.whatsapp.net", name: "~" },
  account: { details: "…" },
  platform: "android",
};

// What an expired pairing window actually looks like: keys generated for the
// attempt, but no identity was ever issued.
const neverPaired = {
  registered: false,
  me: undefined,
};

const codeLinked = {
  registered: true,
  me: { id: "447700900101:1@s.whatsapp.net" },
};

describe("isPaired", () => {
  it("treats a QR-linked session as paired despite registered=false", () => {
    expect(isPaired(qrLinked)).toBe(true);
  });

  it("treats a pairing-code session as paired", () => {
    expect(isPaired(codeLinked)).toBe(true);
  });

  it("treats an expired pairing window as unpaired", () => {
    expect(isPaired(neverPaired)).toBe(false);
  });

  it("handles a null me without throwing", () => {
    expect(isPaired({ registered: false, me: null })).toBe(false);
  });

  it("handles empty creds", () => {
    expect(isPaired({})).toBe(false);
  });

  it("does not rely on registered alone — the regression this exists for", () => {
    // If someone reverts to `creds.registered`, this is the case that breaks:
    // a live session that reports itself unpaired.
    expect(qrLinked.registered).toBe(false);
    expect(isPaired(qrLinked)).toBe(true);
  });
});
