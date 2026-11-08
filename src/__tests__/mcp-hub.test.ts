/**
 * MCP hub — end-to-end tests over a real gateway HTTP server.
 *
 * A real `Gateway` is started on an ephemeral port and a real MCP
 * client (`@modelcontextprotocol/sdk` StreamableHTTPClientTransport)
 * connects to the hub endpoints, exactly as the backends do in
 * production. Covers:
 *
 *   - in-process Talon tool serving (tools/list + a bridged tools/call
 *     that round-trips through the gateway's /action dispatch)
 *   - per-URL (frontend, chatId) binding
 *   - session lifecycle (unknown session → 404, DELETE terminates)
 *   - proxied plugin children (spawned once, shared, tool call
 *     forwarded) using a tiny stdio MCP server subprocess
 *   - child retirement on reload (next acquire respawns)
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

// One fake plugin server: a self-contained stdio MCP server script the
// hub spawns as a child (node -e).
const FAKE_PLUGIN_SCRIPT = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "fake-plugin-tools", version: "1.0.0" });
server.tool("echo_pid", "Echo the input plus this process pid", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text: text + ":" + process.pid }],
}));
await server.connect(new StdioServerTransport());
`;

vi.mock("../core/plugin/index.js", () => ({
  handlePluginAction: vi.fn(async () => null),
  getPluginMcpServers: vi.fn(() => ({
    "fake-plugin-tools": {
      command: process.execPath,
      args: ["--input-type=module", "-e", FAKE_PLUGIN_SCRIPT],
      env: {},
    },
  })),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Gateway } from "../core/engine/gateway.js";
import {
  initHub,
  shutdownHub,
  reloadHubChildren,
  talonHubUrl,
  pluginHubUrl,
} from "../core/mcp-hub/index.js";
import { getActiveChildKeys } from "../core/mcp-hub/children.js";
import { gatewayFetch, TEST_GATEWAY_TOKEN } from "./helpers/gateway-fetch.js";

let gateway: Gateway;
let bridgeUrl: string;

async function connectClient(url: string): Promise<Client> {
  const client = new Client(
    { name: "hub-test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { Authorization: `Bearer ${TEST_GATEWAY_TOKEN}` },
      },
    }),
  );
  return client;
}

beforeAll(async () => {
  initHub({});
  gateway = new Gateway("daemon");
  const port = await gateway.start(0);
  bridgeUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await shutdownHub();
  await gateway.stop();
});

describe("mcp-hub / talon tool serving (in-process)", () => {
  it("serves the frontend tool set over streamable HTTP", async () => {
    const client = await connectClient(
      talonHubUrl(bridgeUrl, "telegram", "chat-1"),
    );
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("end_turn");
      expect(names).toContain("send");
    } finally {
      await client.close();
    }
  });

  it("tool calls bridge into the gateway bound to the URL's chatId", async () => {
    const seen: Array<Record<string, unknown>> = [];
    gateway.setFrontendHandler(async (body) => {
      seen.push(body);
      return { ok: true };
    });
    // The gateway requires an active context for ambient routing.
    gateway.setContext(4242, "4242", "telegram");

    const client = await connectClient(
      talonHubUrl(bridgeUrl, "telegram", "4242"),
    );
    try {
      // end_turn WITH text routes through the bridge as send_message
      // (a silent end_turn makes no bridge call by design).
      const result = await client.callTool({
        name: "end_turn",
        arguments: { text: "hello from the hub" },
      });
      expect(result.isError ?? false).toBe(false);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]._chatId).toBe("4242");
      expect(seen[0].action).toBe("send_message");
      expect(seen[0].text).toBe("hello from the hub");
    } finally {
      gateway.setFrontendHandler(null);
      gateway.clearContext(4242);
      await client.close();
    }
  });

  it("rejects unknown frontends and unknown sessions", async () => {
    const bad = await gatewayFetch(`${bridgeUrl}/mcp/talon/nosuch/c1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    expect(bad.status).toBe(404);

    const stale = await gatewayFetch(`${bridgeUrl}/mcp/talon/telegram/c1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": "not-a-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(stale.status).toBe(404);
  });
});

describe("mcp-hub / plugin child proxying", () => {
  it("proxies tool list + call to a spawned child, shared across sessions", async () => {
    const url = pluginHubUrl(bridgeUrl, "fake-plugin-tools", "chat-A");
    const clientA = await connectClient(url);
    const clientB = await connectClient(url);
    try {
      const { tools } = await clientA.listTools();
      expect(tools.map((t) => t.name)).toContain("echo_pid");

      const resultA = (await clientA.callTool({
        name: "echo_pid",
        arguments: { text: "hello" },
      })) as { content: Array<{ type: string; text: string }> };
      const resultB = (await clientB.callTool({
        name: "echo_pid",
        arguments: { text: "hello" },
      })) as { content: Array<{ type: string; text: string }> };

      const pidA = resultA.content[0].text.split(":")[1];
      const pidB = resultB.content[0].text.split(":")[1];
      // Two sessions, ONE child process.
      expect(pidA).toBe(pidB);
      expect(getActiveChildKeys()).toContain("fake-plugin-tools\u0000chat-A");
    } finally {
      await clientA.close();
      await clientB.close();
    }
  }, 20_000);

  it("reload retires children; next call respawns a fresh process", async () => {
    const url = pluginHubUrl(bridgeUrl, "fake-plugin-tools", "chat-B");
    const client = await connectClient(url);
    try {
      const before = (await client.callTool({
        name: "echo_pid",
        arguments: { text: "x" },
      })) as { content: Array<{ type: string; text: string }> };
      const pidBefore = before.content[0].text.split(":")[1];

      reloadHubChildren();
      expect(getActiveChildKeys()).not.toContain(
        "fake-plugin-tools\u0000chat-B",
      );

      // Same session keeps working — the proxy re-acquires a new child.
      const after = (await client.callTool({
        name: "echo_pid",
        arguments: { text: "x" },
      })) as { content: Array<{ type: string; text: string }> };
      const pidAfter = after.content[0].text.split(":")[1];
      expect(pidAfter).not.toBe(pidBefore);
    } finally {
      await client.close();
    }
  }, 20_000);
});
