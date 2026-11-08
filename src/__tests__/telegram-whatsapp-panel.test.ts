/**
 * The Telegram /whatsapp panel offers only actions that can succeed.
 *
 * It used to show "Re-pair" while linked, but pairing refuses on a linked
 * account, so the button only ever answered "already linked". Unlinking
 * from the panel would drop a working link, so the button is gone while
 * linked and comes back once the phone unlinks the device.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { whatsAppPanel } from "../frontend/telegram/commands/whatsapp-pairing.js";
import { registerPairingProvider } from "../core/frontend-runtime/pairing-broker.js";

const begin = vi.fn();

function provide(linked: boolean): void {
  registerPairingProvider({ label: "WhatsApp", isLinked: () => linked, begin });
}

const buttons = () => whatsAppPanel().keyboard.flat();

beforeEach(() => {
  registerPairingProvider(null);
  begin.mockReset();
});

describe("/whatsapp panel", () => {
  it("offers pairing when not linked", () => {
    provide(false);
    expect(buttons().map((b) => b.callback_data)).toEqual([
      "whatsapp:pair",
      "whatsapp:refresh",
    ]);
  });

  it("offers no pair button while linked", () => {
    provide(true);
    expect(buttons().map((b) => b.callback_data)).toEqual(["whatsapp:refresh"]);
    expect(whatsAppPanel().text).toContain("Linked");
  });

  it("has no buttons when WhatsApp is not enabled", () => {
    expect(buttons()).toEqual([]);
  });
});
