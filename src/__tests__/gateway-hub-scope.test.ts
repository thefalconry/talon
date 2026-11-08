/**
 * The gateway's caller check and the hub's per-sender scope are two
 * independent layers, and each must hold with the other in place:
 *
 *   - a hub client that presents the gateway token during a guest turn is
 *     still held to the guest surface — authenticating the transport does
 *     not widen what the turn may do;
 *   - a hub request without the token is refused with 401 before any
 *     scope is consulted, whatever the chat's current turn scope is.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/plugin/index.js", () => ({
  handlePluginAction: vi.fn(async () => null),
  getPluginMcpServers: vi.fn(() => ({})),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Gateway } from "../core/engine/gateway.js";
import { initHub, shutdownHub, talonHubUrl } from "../core/mcp-hub/index.js";
import { enterTurnScope } from "../core/mcp-hub/guest-scope.js";
import { TEST_GATEWAY_TOKEN } from "./helpers/gateway-fetch.js";

const ADMIN = 424242420;
const GROUP = -1001000000001;

let gateway: Gateway;
let bridgeUrl: string;
const actions: Record<string, unknown>[] = [];

beforeAll(async () => {
  initHub({ adminUserId: ADMIN });
  gateway = new Gateway("daemon");
  gateway.setFrontendHandler(async (body) => {
    actions.push(body);
    return { ok: true, text: "done" };
  });
  const port = await gateway.start(0);
  bridgeUrl = `http://127.0.0.1:${port}`;
  gateway.setContext(GROUP, String(GROUP), "telegram");
});

afterAll(async () => {
  await shutdownHub();
  await gateway.stop();
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "scope-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(talonHubUrl(bridgeUrl, "telegram", String(GROUP))),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${TEST_GATEWAY_TOKEN}` },
        },
      },
    ),
  );
  return client;
}

function textOf(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0].text;
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "no-token", version: "0" },
  },
});

function postWithoutToken(): Promise<Response> {
  return fetch(talonHubUrl(bridgeUrl, "telegram", String(GROUP)), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: INITIALIZE,
  });
}

describe("gateway token + per-sender scope", () => {
  it("a token-bearing client in a guest turn still gets only guest tools", async () => {
    // Session opened while the operator's turn runs: full surface listed.
    const operator = enterTurnScope(String(GROUP), "operator");
    const client = await connect();
    operator();

    const release = enterTurnScope(String(GROUP), "guest");
    try {
      actions.length = 0;
      const forward = await client.callTool({
        name: "forward_message",
        arguments: { message_id: "5", from_chat_id: String(ADMIN) },
      });
      expect(forward.isError).toBe(true);
      expect(textOf(forward)).toMatch(/Not available in this chat/);

      const elsewhere = await client.callTool({
        name: "send",
        arguments: { type: "text", text: "hi", chat_id: String(ADMIN) },
      });
      expect(textOf(elsewhere)).toMatch(/chat_id must be this chat/);
      // Neither refused call reached the frontend.
      expect(actions).toEqual([]);

      // A conversation tool in its own chat goes through, authenticated.
      const own = await client.callTool({
        name: "send",
        arguments: { type: "text", text: "hi" },
      });
      expect(textOf(own)).toBe("done");
      expect(actions).toHaveLength(1);
      expect(actions[0]._chatId).toBe(String(GROUP));
    } finally {
      release();
      await client.close();
    }
  });

  it("a hub request without the token is 401 whatever the turn scope", async () => {
    for (const scope of ["guest", "operator"] as const) {
      const release = enterTurnScope(String(GROUP), scope);
      try {
        const res = await postWithoutToken();
        expect(res.status).toBe(401);
        expect(res.headers.get("mcp-session-id")).toBeNull();
      } finally {
        release();
      }
    }
    // And with no turn in flight at all.
    expect((await postWithoutToken()).status).toBe(401);
  });
});
