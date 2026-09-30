/**
 * MCP server specs — the stdio command for every plugin that exposes an MCP
 * server (via `mcpServer` command/args or `mcpServerPath`), plus the
 * standalone MCP entries from config. The hub spawns its children from these
 * raw specs and applies orphan protection itself (mcp-hub/child-guard.ts).
 */

import { resolve } from "node:path";
import { logWarn } from "../../util/log.js";
import { isBunRuntime } from "../../util/runtime.js";
import { registry, reloadState } from "./registry.js";
import type { McpServerConfig } from "./types.js";
import { GATEWAY_TOKEN_ENV, gatewayToken } from "../engine/gateway-auth.js";

function buildBridgeEnv(
  bridgeUrl: string,
  chatId: string,
  envVars?: Record<string, string>,
): Record<string, string> {
  return {
    ...envVars,
    TALON_BRIDGE_URL: bridgeUrl,
    // Plugins that call back into the gateway (POST /action) must send
    // this as `Authorization: Bearer <token>`.
    [GATEWAY_TOKEN_ENV]: gatewayToken(),
    TALON_CHAT_ID: chatId,
    TALON_RELOAD_AT: reloadState.lastReloadAt,
  };
}

/**
 * Build MCP server entries for plugins that provide an MCP server.
 * Plugins can expose an MCP server in two ways:
 *   - `mcpServerPath` — path to a Node/TypeScript MCP server script (run via tsx)
 *   - `mcpServer` — custom command/args for non-Node servers (Python, Go, etc.)
 * Plugins with neither are skipped. When both are set, `mcpServer` takes priority.
 *
 * @param only — optional list of plugin names to include. If omitted, all
 *   plugins with MCP servers are returned. Pass `[]` to get none.
 */
export function getPluginMcpServers(
  bridgeUrl: string,
  chatId: string,
  only?: string[],
): Record<string, McpServerConfig> {
  if (only !== undefined && only.length === 0) return {};

  const servers: Record<string, McpServerConfig> = {};

  // Resolve tsx from Talon's own node_modules (not cwd which may be ~/.talon/workspace/)
  const tsxPath = resolve(
    import.meta.dirname,
    "../../../node_modules/tsx/dist/esm/index.mjs",
  );

  for (const { plugin, envVars } of registry.all) {
    if (only !== undefined && !only.includes(plugin.name)) continue;

    // Let the plugin re-materialize on-disk state the child will read. Runs
    // on every build so a deleted file heals within a turn; never fatal.
    try {
      if (plugin.mcpServer || plugin.mcpServerPath) plugin.prepareMcpSpawn?.();
    } catch (err) {
      logWarn(
        "plugin",
        `${plugin.name}: prepareMcpSpawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const baseEnv = buildBridgeEnv(bridgeUrl, chatId, envVars);

    if (plugin.mcpServer) {
      // Custom command/args (Python, Go, etc.) — no tsx wrapper
      servers[`${plugin.name}-tools`] = {
        command: plugin.mcpServer.command,
        args: [...plugin.mcpServer.args],
        env: baseEnv,
      };
    } else if (plugin.mcpServerPath) {
      // TS server entry: bun runs it directly; node needs the tsx loader.
      servers[`${plugin.name}-tools`] = {
        command: isBunRuntime()
          ? process.execPath
          : process.platform === "win32"
            ? "npx"
            : "node",
        args: isBunRuntime()
          ? [plugin.mcpServerPath]
          : process.platform === "win32"
            ? ["tsx", plugin.mcpServerPath]
            : ["--import", tsxPath, plugin.mcpServerPath],
        env: baseEnv,
      };
    }
  }

  for (const entry of registry.mcpEntries) {
    if (only !== undefined && !only.includes(entry.name)) continue;
    servers[`${entry.name}-tools`] = {
      command: entry.command,
      args: [...(entry.args ?? [])],
      env: buildBridgeEnv(bridgeUrl, chatId, entry.env),
    };
  }

  return servers;
}
