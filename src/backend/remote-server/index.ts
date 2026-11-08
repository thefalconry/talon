/**
 * Shared remote-server backend framework — barrel re-export.
 *
 * Helpers used by the OpenCode and Kilo drivers (both wrap a
 * long-running upstream agent server that exposes a common HTTP API
 * for MCP registration, session lifecycle, tool listing, and provider
 * resolution).
 *
 * Architecture in four layers:
 *
 *   - {@link RemoteServerState} (state.ts) — per-backend mutable container.
 *     Each concrete backend owns one instance, holding the cached client,
 *     config, frontend label, gateway-port resolver, and the MCP /
 *     provider caches.
 *
 *   - Lifecycle / MCP / sessions / providers — pure helpers that take a
 *     `RemoteAgentClient` + `RemoteServerState` and act on them.
 *
 *   - Bindings (server-bindings.ts, chat-turn.ts, turn.ts, factory.ts) —
 *     the helpers closed over one backend's state, the SSE-driven turn,
 *     the chat-turn orchestration, and the registry factory composition.
 *
 *   - Profiles (`profiles/bind.ts` + `profiles/{kilo,opencode}.ts`) —
 *     `bindRemoteProfile` closes all of the above over one driver's
 *     state, and each driver is one file of constants: SDK
 *     constructors, port, delivery contract, model-selection parser,
 *     model-picker budget.
 *
 * What's NOT here (intentionally):
 *
 *   - Tool definitions, frontend prompt format — those are backend-
 *     agnostic and live in `core/` and `backend/runtime/`.
 *
 * This barrel exposes the helper layer for tests and the conformance
 * suite; the bindings modules import from the concrete files directly.
 */

export type { RemoteAgentClient } from "./client.js";

export { type RemoteServerState, createRemoteServerState } from "./state.js";

export { stopRemoteServer } from "./lifecycle.js";

export {
  TALON_MCP_SERVER_NAME,
  TALON_PLUGIN_MCP_SERVER_NAME,
  PLUGIN_MCP_SERVER_NAME_MAX_LENGTH,
  getChatMcpServerName,
  getPluginMcpServerName,
  getPluginMcpServerPrefix,
  isTalonToolID,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  getRegisteredMcpServerNames,
} from "./mcp.js";
