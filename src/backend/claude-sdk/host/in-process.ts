/**
 * The in-process agent host — `AgentHostClient` implemented as direct
 * calls into `backend/claude-sdk/`.
 *
 * `docs/agent-host-sidecar.md` Phase 1. This is the implementation that
 * keeps today's behaviour exactly: every method is a call-through to the
 * function the claude-sdk `BackendFactory` used to call itself. There is
 * no process, no framing and no logic of its own — the only code that
 * moved here is `refreshTools`' two-phase MCP teardown, which had to,
 * because it drives a `Query` handle and handles do not cross a process
 * boundary.
 *
 * Phase 2 adds a sibling that speaks the same interface over a child
 * process's stdio. Nothing above this file changes when it does.
 */

import type {
  AgentHostClient,
  HostReadyInfo,
  HostSessionInfo,
  HostToolRefresh,
} from "../../../core/agent-runtime/agent-host.js";
import { AGENT_HOST_PROTOCOL_VERSION } from "../../../core/agent-runtime/agent-host.js";
import type { TalonConfig } from "../../../core/config/index.js";
import { getSession } from "../../../storage/sessions.js";
import { talonVersion } from "../../../util/version.js";

import {
  initAgent as claudeInitAgent,
  warmSession as claudeWarmSession,
  getActiveQuery,
  buildMcpServers,
  buildPluginMcpServers,
  runOneShotAgent as claudeRunOneShotAgent,
} from "../index.js";
import {
  runChatTurnAs as claudeRunChatTurnAs,
  interruptChatTurn as claudeInterruptChatTurn,
} from "../handler.js";
import {
  DEFAULT_CLAUDE_ACCOUNT,
  type ClaudeRunAccount,
} from "../accounts/account.js";
import { waitForMcpServersReady } from "../mcp-ready.js";
import { listModels as claudeListModels } from "../model-provider.js";
import { getPlanUsage } from "../usage/plan-usage.js";

/**
 * Install an MCP server set on the chat's live query. `null` when the
 * chat has no query in flight — the same "nothing to refresh" answer
 * `ToolRuntime.refreshTools` has always given.
 */
async function setMcpServers(
  chatId: string,
  servers: Record<string, unknown>,
): Promise<HostToolRefresh | null> {
  const qi = getActiveQuery(chatId);
  if (!qi) return null;
  return qi.setMcpServers(servers as Parameters<typeof qi.setMcpServers>[0]);
}

/**
 * Re-derive the chat's MCP config from the live plugin registry. Body
 * lifted verbatim from the claude-sdk factory's `tools.refreshTools`,
 * comments included — the ordering is load-bearing.
 */
async function refreshTools(chatId: string): Promise<HostToolRefresh | null> {
  const qi = getActiveQuery(chatId);
  if (!qi) return null;
  // Two-phase teardown: remove all MCP servers first so each
  // subprocess receives an OS-agnostic shutdown via stdio, then
  // install the fresh set.
  await qi.setMcpServers({});
  const freshServers = {
    ...buildMcpServers(chatId),
    ...buildPluginMcpServers(chatId),
  };
  const result = await qi.setMcpServers(freshServers);
  // setMcpServers resolves on REGISTER, not CONNECT — MCP startup is
  // non-blocking. A stdio server that dials a slow remote (e.g. the
  // playwright plugin connecting to the Camoufox websocket) is still
  // 'pending' at this point and its tools are absent from the live
  // registry, so the turn would proceed with mcp__playwright-tools__*
  // stuck "connecting" until the next refresh. Wait (bounded) for the
  // newly-added servers to finish connecting before returning.
  await waitForMcpServersReady(qi, result.added);
  return result;
}

/**
 * The context figures `warm_session` populates, read back out of the
 * daemon's session store. In-process the host and the store share a
 * process, so this is a lookup; in Phase 2 it is the reply that carries
 * those numbers home.
 */
async function sessionInfo(chatId: string): Promise<HostSessionInfo> {
  const session = getSession(chatId);
  return {
    chatId,
    sessionId: session.sessionId,
    turns: session.turns,
    contextTokens: session.usage.contextTokens,
    contextWindow: session.usage.contextWindow,
  };
}

/**
 * The Claude SDK backend keeps no conversation memory of its own — each
 * turn is a fresh subprocess — so the only per-chat state the host holds
 * is the in-flight query handle. Dropping it is interrupting it.
 *
 * Not bound into the `Backend` object: claude-sdk has no `resetChat`
 * slot today and Phase 1 does not add one. `/reset` still clears the
 * stored session id through `storage/sessions.ts`, as it always has.
 */
async function resetSession(chatId: string): Promise<boolean> {
  return claudeInterruptChatTurn(chatId);
}

/**
 * Build the in-process host. `config` and `getBridgePort` are held only
 * for `hello()`, which performs the same `initAgent(config,
 * getBridgePort)` the factory used to call inline. `account` is the Claude
 * login every spawn from this host runs as (default: the `claude` backend's).
 */
export function createInProcessAgentHost(
  config: TalonConfig,
  getBridgePort?: () => number,
  account: ClaudeRunAccount = DEFAULT_CLAUDE_ACCOUNT,
): AgentHostClient {
  return {
    async hello(): Promise<HostReadyInfo> {
      await claudeInitAgent(config, getBridgePort, account);
      // `sdk` is omitted: in-process there is no separately-pinned SDK
      // build to name — the daemon's own lockfile is the answer, and
      // Phase 4 gives the host a `package.json` of its own to report.
      return { protocol: AGENT_HOST_PROTOCOL_VERSION, host: talonVersion() };
    },
    runTurn: claudeRunChatTurnAs(account),
    interrupt: (chatId) => claudeInterruptChatTurn(chatId),
    runOneShot: (params) => claudeRunOneShotAgent(params, account),
    warmSession: (chatId) => claudeWarmSession(chatId, account),
    setMcpServers,
    refreshTools,
    listModels: (filter) => claudeListModels(filter),
    planUsage: () => getPlanUsage(account.configDir),
    sessionInfo,
    resetSession,
    // Nothing to drain while the host is this process: the daemon's own
    // shutdown path already aborts in-flight turns.
    shutdown: async () => undefined,
  };
}
