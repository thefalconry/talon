/**
 * MCP hub — the idle-session reaper.
 *
 * A client that holds its connection for the chat's lifetime (the
 * openai-agents bundle pool) keeps an SSE stream open between turns and
 * never re-initializes on a 404. A quiet chat is therefore still a live
 * session: reaping it would fail every later tool call with "Unknown or
 * expired MCP session". Only a session with nothing open is a straggler.
 *
 * The reaper runs on a 5-minute interval against a 30-minute idle
 * window, so `setInterval` and `Date` are faked from before the hub's
 * first request; sockets and the SDK's own timers stay real.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
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

vi.mock("../core/plugin/index.js", () => ({
  handlePluginAction: vi.fn(async () => null),
  getPluginMcpServers: vi.fn(() => ({})),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Gateway } from "../core/engine/gateway.js";
import { initHub, shutdownHub, talonHubUrl } from "../core/mcp-hub/index.js";
import { gatewayFetch, TEST_GATEWAY_TOKEN } from "./helpers/gateway-fetch.js";

const MINUTE = 60_000;

let gateway: Gateway;
let bridgeUrl: string;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  initHub({});
  gateway = new Gateway("daemon");
  const port = await gateway.start(0);
  bridgeUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await shutdownHub();
  await gateway.stop();
  vi.useRealTimers();
});

/** Let the event loop run so stream opens/closes reach the server. */
function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectClient(chatId: string): Promise<Client> {
  const client = new Client(
    { name: "reaper-test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(talonHubUrl(bridgeUrl, "telegram", chatId)),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${TEST_GATEWAY_TOKEN}` },
        },
      },
    ),
  );
  return client;
}

/** A session opened by hand: initialize only, no standalone stream. */
async function openBareSession(chatId: string): Promise<string> {
  const res = await gatewayFetch(talonHubUrl(bridgeUrl, "telegram", chatId), {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "bare", version: "1" },
      },
    }),
  });
  await res.body?.cancel();
  const id = res.headers.get("mcp-session-id");
  expect(id).toBeTruthy();
  return id!;
}

function listToolsRaw(chatId: string, sessionId: string): Promise<Response> {
  return gatewayFetch(talonHubUrl(bridgeUrl, "telegram", chatId), {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
}

describe("hub session reaper", () => {
  it("keeps a quiet session whose client holds its event stream open", async () => {
    const client = await connectClient("reaper-held");
    try {
      // The SDK opens its standalone GET stream right after initialize.
      await settle();
      vi.advanceTimersByTime(45 * MINUTE);
      await settle();

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("send");
    } finally {
      await client.close();
    }
  });

  it("still reaps a session with nothing open once it is idle", async () => {
    const chatId = "reaper-bare";
    const sessionId = await openBareSession(chatId);

    vi.advanceTimersByTime(45 * MINUTE);
    await settle();

    const res = await listToolsRaw(chatId, sessionId);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it("reaps a session idle for the full window after its stream closed", async () => {
    const chatId = "reaper-closed";
    const client = await connectClient(chatId);
    const sessionId = (client.transport as StreamableHTTPClientTransport)
      .sessionId!;
    // Drop the client's side without a DELETE — a crashed backend.
    await (client.transport as StreamableHTTPClientTransport)
      .close()
      .catch(() => {});
    await settle();

    vi.advanceTimersByTime(45 * MINUTE);
    await settle();

    const res = await listToolsRaw(chatId, sessionId);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });
});
