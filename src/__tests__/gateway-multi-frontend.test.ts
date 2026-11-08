import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import type { FrontendActionHandler } from "../core/types.js";
import { gatewayFetch } from "./helpers/gateway-fetch.js";

let gateway: Gateway;
let port: number;

const telegramHandler: FrontendActionHandler = async () => ({
  ok: true,
  message_id: 101,
  text: "telegram",
});

const nativeHandler: FrontendActionHandler = async () => ({
  ok: true,
  message_id: 202,
  text: "native",
});

beforeAll(async () => {
  gateway = new Gateway();
  gateway.registerFrontendHandler("telegram", telegramHandler);
  gateway.registerFrontendHandler("native", nativeHandler);
  port = await gateway.start(0);
});

afterAll(async () => {
  await gateway.stop();
});

describe("gateway multi-frontend registry", () => {
  it("routes each chat to its owning frontend handler", async () => {
    gateway.setContext(111, "111", "telegram");
    gateway.setContext(222, "d_222", "native");

    const telegramResp = await gatewayFetch(`http://127.0.0.1:${port}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "send_message",
        _chatId: "111",
        text: "hello telegram",
      }),
    });
    const nativeResp = await gatewayFetch(`http://127.0.0.1:${port}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "send_message",
        _chatId: "222",
        text: "hello native",
      }),
    });

    const telegramBody = (await telegramResp.json()) as Record<string, unknown>;
    const nativeBody = (await nativeResp.json()) as Record<string, unknown>;

    expect(telegramBody.message_id).toBe(101);
    expect(nativeBody.message_id).toBe(202);

    gateway.clearContext(111);
    gateway.clearContext(222);
  });
});
