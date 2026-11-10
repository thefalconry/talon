/**
 * Hub proxy server — an in-process MCP server that forwards tools/list
 * and tools/call to a hub-managed child (see children.ts).
 *
 * One proxy per hub session; many sessions share one child. The child
 * is re-acquired through `getChild` on every call, so a child that
 * was idle-reaped or crashed respawns transparently mid-session —
 * clients never see the lifecycle, only (at worst) a slow first call.
 * tools/list goes through `listTools`, which the hub answers from its
 * per-server cache when it can, so listing alone need not spawn.
 *
 * Tools-only by design: every MCP server Talon consumes (plugins,
 * brave) exposes tools, and the backends only wire tools. Resource /
 * prompt requests are not declared in capabilities, so well-behaved
 * clients won't send them.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ChildHandle } from "./children.js";

export type ProxySource = {
  listTools: () => Promise<Tool[]>;
  getChild: () => Promise<ChildHandle>;
};

export function buildProxyServer(name: string, source: ProxySource): Server {
  const server = new Server(
    { name, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: await source.listTools() };
  });

  // `extra.signal` fires when the upstream client cancels or its session
  // closes; passing it on stops the child's work instead of orphaning it.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const child = await source.getChild();
    return child.callTool(
      request.params.name,
      request.params.arguments ?? {},
      extra.signal,
    );
  });

  return server;
}
