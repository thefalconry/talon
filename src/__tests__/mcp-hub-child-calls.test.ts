/**
 * MCP hub — in-flight tool calls on hub children.
 *
 * A plugin tool call can legitimately run for minutes (a crawl, a mine,
 * a slow page). These tests pin that the hub itself never kills such a
 * call from under the model (no idle reap of a busy child, no 60s SDK
 * default), and that when the model's side gives up, the child hears
 * about it.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildProxyServer } from "../core/mcp-hub/proxy-server.js";
import {
  acquireChild,
  closeAllChildren,
  getActiveChildKeys,
  startChildReaper,
  stopChildReaper,
} from "../core/mcp-hub/children.js";

/**
 * Minimal stdio MCP server. Tools:
 *   - `hang`: never answers
 *   - `slow`: answers after `ms` milliseconds
 *   - `cancelled`: the request ids this server was told to cancel
 * Exits when stdin closes so hub-side closes are instant.
 */
const FAKE_SERVER = {
  command: process.execPath,
  args: [
    "--no-warnings",
    "-e",
    `
    process.stdin.setEncoding("utf-8");
    process.stdin.on("end", () => process.exit(0));
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
    const text = (id, t) => send({ id, result: { content: [{ type: "text", text: t }] } });
    const cancelled = [];
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          send({ id: msg.id, result: {
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "0" },
          } });
        } else if (msg.method === "tools/list") {
          send({ id: msg.id, result: { tools: [] } });
        } else if (msg.method === "tools/call") {
          const { name, arguments: args } = msg.params;
          if (name === "slow") setTimeout(() => text(msg.id, "done"), args.ms);
          if (name === "cancelled") text(msg.id, JSON.stringify(cancelled));
        } else if (msg.method === "notifications/cancelled") {
          cancelled.push(msg.params.requestId);
        }
      }
    });
  `,
  ],
  env: {},
};

afterEach(async () => {
  vi.useRealTimers();
  stopChildReaper();
  delete process.env.TALON_MCP_HUB_IDLE_MS;
  await closeAllChildren();
});

describe("hub child idle reaper", () => {
  it("never reaps a child with a call in flight", async () => {
    process.env.TALON_MCP_HUB_IDLE_MS = "1";
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    startChildReaper();

    const key = "reap-busy chat";
    const child = await acquireChild(key, () => FAKE_SERVER);
    const call = child.callTool("slow", { ms: 500 });
    // Idle by the clock (TTL 1ms), but busy.
    await new Promise((r) => setTimeout(r, 20));
    vi.advanceTimersByTime(60_000);

    expect(getActiveChildKeys()).toContain(key);
    await expect(call).resolves.toMatchObject({
      content: [{ type: "text", text: "done" }],
    });

    // Idle for real now: the next sweep reaps it.
    await new Promise((r) => setTimeout(r, 20));
    vi.advanceTimersByTime(60_000);
    expect(getActiveChildKeys()).not.toContain(key);
  }, 20_000);
});

describe("hub child call timeout", () => {
  it("does not cut a long call at the SDK's 60s default, but still bounds it", async () => {
    const child = await acquireChild("long-call chat", () => FAKE_SERVER);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let outcome: unknown = "pending";
    const call = child.callTool("hang", {}).then(
      () => (outcome = "resolved"),
      (err: unknown) => (outcome = err),
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(outcome).toBe("pending");

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await call;
    expect(String(outcome)).toMatch(/timed out/i);
  }, 20_000);
});

describe("hub proxy cancellation", () => {
  it("forwards an upstream cancel to the child's in-flight call", async () => {
    const key = "cancel-forward chat";
    // Spawned up front, so the abort lands after the call reached the child.
    const child = await acquireChild(key, () => FAKE_SERVER);
    const server = buildProxyServer("fake", {
      listTools: async () => await child.listTools(),
      getChild: () => acquireChild(key, () => FAKE_SERVER),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "upstream", version: "0" });
    await client.connect(clientSide);

    const abort = new AbortController();
    const call = client.callTool({ name: "hang", arguments: {} }, undefined, {
      signal: abort.signal,
    });
    await new Promise((r) => setTimeout(r, 200));
    abort.abort("turn aborted");
    await expect(call).rejects.toThrow();

    let seen: unknown[] = [];
    for (let i = 0; i < 50 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const res = await child.callTool("cancelled", {});
      seen = JSON.parse((res.content[0] as { text: string }).text);
    }
    expect(seen).toHaveLength(1);
    await client.close();
  }, 20_000);
});

describe("hub child spawn failures", () => {
  it("a spec factory that throws does not poison the key once backoff passes", async () => {
    // pluginSpec throws synchronously for a server missing from the
    // registry — e.g. mid-reload, while the registry is being rebuilt.
    const key = "spec-throws chat";
    await expect(
      acquireChild(key, () => {
        throw new Error("Unknown hub plugin server: fake-tools");
      }),
    ).rejects.toThrow(/Unknown hub plugin server/);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    await expect(acquireChild(key, () => FAKE_SERVER)).resolves.toBeDefined();
  }, 20_000);
});
