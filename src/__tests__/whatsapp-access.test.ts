/**
 * WhatsApp access gates — the pure decisions behind the group allow-list
 * and the "is this message for us?" check, with no socket involved.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import type { WAMessage } from "baileys";
import type { TalonConfig } from "../core/config/index.js";
import type { Gateway } from "../core/engine/gateway.js";
import {
  isAddressedToSelf,
  isGroupAllowed,
} from "../frontend/whatsapp/access.js";
import { createWhatsAppRuntime } from "../frontend/whatsapp/runtime.js";

const SELF = ["447700900101", "123456789012345"];

function groupMessage(contextInfo?: {
  mentionedJid?: string[];
  participant?: string;
}): WAMessage {
  return {
    key: { id: "WA1", remoteJid: "g@g.us", fromMe: false },
    message: { extendedTextMessage: { text: "hi", contextInfo } },
  } as unknown as WAMessage;
}

function runtimeFor(whatsapp: Record<string, unknown>) {
  return createWhatsAppRuntime(
    { whatsapp } as unknown as TalonConfig,
    {} as Gateway,
  );
}

describe("isAddressedToSelf", () => {
  it("matches an @-mention by either of our ids, ignoring the JID suffix", () => {
    const byPhone = groupMessage({
      mentionedJid: ["447700900101@s.whatsapp.net"],
    });
    const byLid = groupMessage({ mentionedJid: ["123456789012345@lid"] });
    expect(isAddressedToSelf(SELF, byPhone)).toBe(true);
    expect(isAddressedToSelf(SELF, byLid)).toBe(true);
  });

  it("matches a quote of one of our messages", () => {
    const msg = groupMessage({ participant: "447700900101@s.whatsapp.net" });
    expect(isAddressedToSelf(SELF, msg)).toBe(true);
  });

  it("is false for other people, and always false before we know our ids", () => {
    const other = groupMessage({ mentionedJid: ["999@s.whatsapp.net"] });
    expect(isAddressedToSelf(SELF, other)).toBe(false);
    expect(isAddressedToSelf(SELF, groupMessage())).toBe(false);
    const self = groupMessage({
      mentionedJid: ["447700900101@s.whatsapp.net"],
    });
    expect(isAddressedToSelf([], self)).toBe(false);
  });
});

describe("isGroupAllowed", () => {
  it("always honours allowedGroups, then lets the policy decide", async () => {
    const listed = runtimeFor({ allowedGroups: ["g@g.us"] });
    expect(await isGroupAllowed(listed, "g@g.us")).toBe(true);
    expect(await isGroupAllowed(listed, "other@g.us")).toBe(false);

    const open = runtimeFor({ groupPolicy: "all" });
    expect(await isGroupAllowed(open, "other@g.us")).toBe(true);
  });
});
