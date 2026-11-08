/**
 * The HTTP bridge only carries a numeric chat id. For a non-Telegram chat
 * the gateway must hand shared actions the canonical string id it holds for
 * the active turn (the Thread key), so cron jobs, triggers and history land
 * under the id the rest of the engine uses — not the derived number.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sharedMock = vi.hoisted(() => vi.fn(async () => null));

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
  handleSharedAction: sharedMock,
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

let gateway: Gateway;
let port: number;

async function post(body: Record<string, unknown>): Promise<void> {
  await gatewayFetch(`http://127.0.0.1:${port}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The chatKey the gateway passed on the most recent shared-action dispatch. */
function lastChatKey(): unknown {
  const call = sharedMock.mock.calls.at(-1) as unknown[] | undefined;
  return call?.[3];
}

beforeAll(async () => {
  gateway = new Gateway();
  // A frontend that handles nothing, so every action falls through to the
  // shared registry.
  gateway.registerFrontendHandler("native", async () => null);
  port = await gateway.start(0);
});

afterAll(async () => {
  await gateway.stop();
});

describe("gateway → shared actions: canonical chat key", () => {
  it("passes the turn's string chat id for a non-Telegram chat", async () => {
    gateway.setContext(456, "d_abc", "native");
    await post({ action: "read_history", _chatId: "456" });
    expect(sharedMock).toHaveBeenCalled();
    expect(lastChatKey()).toBe("d_abc");
    gateway.clearContext(456);
  });

  it("falls back to the numeric id when no context holds a string id", async () => {
    // Explicit routing (heartbeat-style): chat_id present, no active context.
    await post({ action: "read_history", _chatId: "789", chat_id: 789 });
    expect(lastChatKey()).toBe("789");
  });
});
