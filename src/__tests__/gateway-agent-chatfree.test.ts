import { describe, it, expect, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// Control the three routing helpers gateway.ts consults for chat-free dispatch.
const h = vi.hoisted(() => ({
  agent: vi.fn(async (_body: unknown, _id: string) => null as unknown),
  chatFree: vi.fn(
    async (_body: unknown) => ({ ok: true, marker: "chat-free" }) as unknown,
  ),
  isChatFree: new Set<string>(["list_devices"]),
}));

vi.mock("../core/engine/gateway-actions/index.js", () => ({
  handleSharedAction: vi.fn(async () => null),
  handleAgentContextAction: (b: unknown, id: string) => h.agent(b, id),
  handleChatFreeAction: (b: unknown) => h.chatFree(b),
  isChatFreeAction: (a: string) => h.isChatFree.has(a),
}));

import { Gateway } from "../core/engine/gateway.js";

describe("agent context reaching chat-free actions", () => {
  it("routes a chat-free action from an agent context to the chat-free handler", async () => {
    const g = new Gateway();
    // handleAgentContextAction returns null (not an agent action); the action
    // is chat-free, so it must fall through rather than fail chat routing.
    const r = await (
      g as unknown as {
        handleAction: (b: Record<string, unknown>) => Promise<unknown>;
      }
    ).handleAction({ action: "list_devices", _chatId: "agent:abc" });
    expect(r).toEqual({ ok: true, marker: "chat-free" });
    expect(h.chatFree).toHaveBeenCalled();
  });

  it("still refuses a genuinely chat-scoped action from an agent context", async () => {
    const g = new Gateway();
    const r = await (
      g as unknown as {
        handleAction: (b: Record<string, unknown>) => Promise<unknown>;
      }
    ).handleAction({ action: "send_message", _chatId: "agent:abc" });
    expect(r).toEqual({ ok: false, error: "No active chat context" });
  });
});
