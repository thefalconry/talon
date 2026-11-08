/**
 * Shared MCP-registration helpers for the remote-server backend family.
 *
 * Both OpenCode and Kilo expose the same MCP HTTP API surface
 * (`POST /mcp` to add, `DELETE /mcp/:name` to disconnect) and share the
 * same visibility model upstream: every registered MCP server's tools
 * are visible to every session by default. Talon keeps namespaced servers
 * registered concurrently, then scopes visibility per prompt with a tool
 * override map and execution with per-session permission rules.
 *
 * Functions exported here:
 *
 *   - {@link ensureChatMcpServer} — register the current chat's
 *     `talon-tools-<chatId>` MCP server. Returns the registered name so
 *     callers can scope tool overrides to this chat alone.
 *   - {@link ensurePluginMcpServers} — register chat-namespaced plugin MCP
 *     servers (`mempalace-tools`, `brave-search`, `github-tools`, …) under
 *     short `tp-<chat hash>-<plugin>` names (see
 *     {@link getPluginMcpServerName} for the length budget).
 *   - {@link buildToolOverrides} — produce a `tools` map that whitelists
 *     this chat's Talon tools and blacklists every other chat's. Used
 *     as the `tools` field on the prompt payload to constrain the model's
 *     visible tool catalog.
 *   - {@link disconnectChatMcpServer} — explicit teardown for hot-swap
 *     paths (plugin reload, shutdown).
 *
 * Performance: registrations are cached locally in
 * `state.registeredMcpServers`. Both OpenCode's and Kilo's `GET /mcp` is
 * known to return `{}` regardless of actual state, so we can't rely on
 * the server to tell us what's already registered. A chat's initial plugin
 * registrations run concurrently through the hub; later turns skip them.
 */

import { createHash } from "node:crypto";

import { log, logDebug, logWarn } from "../../util/log.js";
import {
  talonHubUrl,
  pluginHubUrl,
  hubPluginServerNames,
  listHubPluginToolNames,
  describeHubChildExit,
} from "../../core/mcp-hub/index.js";
import type { RemoteAgentClient } from "./client.js";
import { gatewayAuthHeaders } from "../../core/engine/gateway-auth.js";
import type { RemoteServerState } from "./state.js";
import { errMsg } from "./state.js";
import type { TalonConfig } from "../../core/config/index.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";
import { ALL_TOOLS, nativeTools } from "../../core/tools/index.js";
import {
  frontendForChatId,
  nonTerminalFrontends,
} from "../runtime/frontends.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** Stable name prefix for Talon's per-chat MCP servers. */
export const TALON_MCP_SERVER_NAME = "talon-tools";
/**
 * Stable prefix for chat-scoped plugin MCP registrations. Deliberately
 * terse: the upstream agent server composes tool ids as
 * `<server>_<tool>`, and Anthropic rejects tool names over 64 characters
 * (`\`name\` must be at most 64 characters`). The old
 * `talon-plugin-<chatId>-<plugin>` form alone reached ~45 characters and
 * hard-failed the first call of any long-named plugin tool.
 */
export const TALON_PLUGIN_MCP_SERVER_NAME = "tp";

/**
 * Upper bound on a generated plugin MCP server name. The 64-character
 * Anthropic tool-name limit must cover `<server>_<tool>`, so this leaves
 * 31 characters for the plugin's own tool name — comfortably above the
 * longest ones in the wild (`browser_take_screenshot`, 23).
 */
export const PLUGIN_MCP_SERVER_NAME_MAX_LENGTH = 32;

/** Hex characters of the chat-id hash embedded in a plugin server name. */
const PLUGIN_SERVER_CHAT_HASH_LENGTH = 8;
/** Hex characters of the plugin-name hash appended when the name is cut. */
const PLUGIN_SERVER_PLUGIN_HASH_LENGTH = 6;

/**
 * MCP add() calls slower than this get a `[slow]` annotation in the log
 * so operators can spot misbehaving plugins or a sluggish agent server.
 * Picked as a soft threshold — most local subprocess spawns finish in
 * <500ms; the outliers are the ones worth investigating.
 */
const SLOW_MCP_REGISTRATION_MS = 1000;

/** Servers whose registration failure was already warned about (see below). */
const warnedMcpRegistrationFailures = new Set<string>();

/**
 * OpenCode's `/experimental/tool/ids` endpoint omits dynamically registered
 * MCP tools despite its API description. Synthesize Talon's known MCP ids so
 * prompt-level overrides can still isolate concurrently registered chats.
 */
const TALON_TOOL_NAMES = [...ALL_TOOLS, ...nativeTools].map(
  (tool) => tool.name,
);

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Derive a chat MCP server name from a chat id. Telegram chat ids are
 * already alphanumeric/dash; Discord snowflakes are pure digits; the
 * sanitisation step is defense-in-depth for any future frontend.
 */
export function getChatMcpServerName(chatId: string): string {
  const safeChatId = safeMcpNamePart(chatId, "chat");
  return `${TALON_MCP_SERVER_NAME}-${safeChatId}`;
}

/** Sanitize a component embedded in an upstream MCP registration name. */
function safeMcpNamePart(value: string, fallback: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_") || fallback;
}

/** Leading `length` hex characters of the SHA-256 of `value`. */
function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * Name prefix shared by every plugin MCP server registered for one chat
 * (`tp-<8-hex chat hash>-`). The permission ruleset allows this chat's
 * prefix and denies `tp-*` for everything else, so the prefix must be a
 * pure function of the chat id — never of the plugin.
 */
export function getPluginMcpServerPrefix(chatId: string): string {
  return `${TALON_PLUGIN_MCP_SERVER_NAME}-${shortHash(chatId, PLUGIN_SERVER_CHAT_HASH_LENGTH)}-`;
}

/**
 * Per-chat registration name for a plugin-provided MCP server.
 *
 * Deterministic for a given (plugin, chat) pair and never longer than
 * {@link PLUGIN_MCP_SERVER_NAME_MAX_LENGTH}. The plugin name is kept
 * verbatim while it fits; an overlong one is cut and suffixed with a short
 * hash of the full name so two long plugins sharing a head stay distinct.
 * Nothing parses the name back — `state.pluginMcpServersByChat` is the
 * reverse map from chat + plugin to registered name.
 */
export function getPluginMcpServerName(
  pluginName: string,
  chatId: string,
): string {
  const prefix = getPluginMcpServerPrefix(chatId);
  const budget = PLUGIN_MCP_SERVER_NAME_MAX_LENGTH - prefix.length;
  const safePlugin = safeMcpNamePart(pluginName, "plugin");
  if (safePlugin.length <= budget) return `${prefix}${safePlugin}`;
  const head = safePlugin.slice(
    0,
    budget - PLUGIN_SERVER_PLUGIN_HASH_LENGTH - 1,
  );
  return `${prefix}${head}-${shortHash(pluginName, PLUGIN_SERVER_PLUGIN_HASH_LENGTH)}`;
}

/** Whether a tool id belongs to one of Talon's MCP servers. */
export function isTalonToolID(toolID: string): boolean {
  return (
    toolID.startsWith(`${TALON_MCP_SERVER_NAME}_`) ||
    toolID.startsWith(`${TALON_MCP_SERVER_NAME}-`)
  );
}

/**
 * The frontend whose tool surface a chat should get: its owning
 * frontend (by chat-id shape) when that frontend is configured, else
 * the process-primary frontend — which also covers the heartbeat
 * sentinel and other cross-surface contexts.
 */
function resolveChatToolFrontend(
  state: { frontendName: FrontendName; config: TalonConfig | null },
  chatId: string,
): FrontendName {
  const owner = frontendForChatId(chatId);
  if (
    owner &&
    owner !== state.frontendName &&
    nonTerminalFrontends(state.config?.frontend).includes(owner)
  ) {
    return owner as FrontendName;
  }
  return state.frontendName;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Ensure the per-chat Talon MCP server is registered with the upstream
 * agent server.
 *
 * Each chat gets its own namespaced MCP server (`talon-tools-<chatId>`).
 * Servers stay registered across concurrent turns; callers pass the result
 * of `buildToolOverrides` with each prompt so chat A cannot see chat B's
 * tools. Session permission rules independently deny cross-chat execution.
 *
 * Best-effort: a registration failure logs a warning but doesn't throw —
 * the conversation can still proceed without Talon-tool access.
 */
export async function ensureChatMcpServer<TClient extends RemoteAgentClient>(
  client: TClient,
  state: RemoteServerState<TClient>,
  chatId: string,
): Promise<string> {
  const serverName = getChatMcpServerName(chatId);

  // Local cache short-circuit. The upstream's GET /mcp returns {} regardless
  // of state, so we trust our own record of what we registered earlier in
  // this process. The upstream's POST /mcp is idempotent — a second `add`
  // for an existing name returns the current state without re-spawning the
  // subprocess — so the worst case of a stale cache is one wasted POST,
  // not a crash.
  if (state.registeredMcpServers.has(serverName)) {
    return serverName;
  }

  const startedAt = Date.now();
  try {
    await client.mcp.add({
      name: serverName,
      config: {
        type: "remote",
        headers: gatewayAuthHeaders(),
        // Talon's MCP hub serves the chat's tool set in-process over
        // streamable HTTP — no subprocess on the agent-server side, and
        // the (frontend, chatId) binding travels in the URL instead of
        // env. Tool-surface trimming is applied hub-side (initHub).
        // Bind the chat's OWNING frontend, not the process-primary one:
        // in multi-frontend deployments a native chat served by this
        // backend must get native-tools (send_message/end_turn), not
        // the primary frontend's tool surface.
        url: talonHubUrl(
          `http://127.0.0.1:${state.gatewayPortFn()}`,
          resolveChatToolFrontend(state, chatId),
          chatId,
        ),
      },
    });
    state.registeredMcpServers.add(serverName);
    state.registeredMcpTools.set(serverName, TALON_TOOL_NAMES);
    const ms = Date.now() - startedAt;
    log(
      "agent",
      `Registered ${serverName} MCP server with ${state.label} (${ms}ms)` +
        (ms > SLOW_MCP_REGISTRATION_MS ? " [slow]" : ""),
    );
  } catch (err) {
    logWarn(
      "agent",
      `MCP registration failed for ${serverName} (tools may not be available): ${errMsg(err)}`,
    );
  }

  return serverName;
}

/**
 * Register all plugin-provided MCP servers with the upstream agent server.
 *
 * Plugins are chat-scoped because most receive `TALON_CHAT_ID` at process
 * start. Each registration therefore gets a chat-qualified name and URL.
 * Registering a global `mempalace-tools` name during prewarm used to bind all
 * later chats to the sentinel `prewarm` context (and concurrent adds raced to
 * replace that URL). Namespacing removes both the routing bug and the race.
 *
 * Returns the list of server names that ended up registered (either
 * freshly added or already connected).
 */
export async function ensurePluginMcpServers<TClient extends RemoteAgentClient>(
  client: TClient,
  state: RemoteServerState<TClient>,
  chatId: string,
): Promise<string[]> {
  const bridgeUrl = `http://127.0.0.1:${state.gatewayPortFn()}`;
  const names = hubPluginServerNames();
  const byPlugin =
    state.pluginMcpServersByChat.get(chatId) ?? new Map<string, string>();
  state.pluginMcpServersByChat.set(chatId, byPlugin);

  // Drop registrations for plugins removed since this chat last ran.
  const desired = new Set(names);
  await Promise.all(
    [...byPlugin].map(async ([pluginName, serverName]) => {
      if (desired.has(pluginName)) return;
      await disconnectChatMcpServer(client, state, serverName);
      byPlugin.delete(pluginName);
    }),
  );

  const results = await Promise.all(
    names.map(async (name): Promise<string | null> => {
      const serverName = getPluginMcpServerName(name, chatId);
      if (state.registeredMcpServers.has(serverName)) {
        byPlugin.set(name, serverName);
        return serverName;
      }
      try {
        // Enumerate before adding. The upstream tool-id endpoint omits MCP
        // tools, so this list is required to disable sibling chats' plugin
        // tools in the prompt override map.
        const toolNames = await listHubPluginToolNames(name, chatId, bridgeUrl);
        const startedAt = Date.now();
        await client.mcp.add({
          name: serverName,
          config: {
            type: "remote",
            headers: gatewayAuthHeaders(),
            // Hub-managed child, shared across sessions and idle-reaped —
            // the agent server holds an HTTP connection, not a subprocess.
            url: pluginHubUrl(bridgeUrl, name, chatId),
          },
        });
        state.registeredMcpServers.add(serverName);
        state.registeredMcpTools.set(serverName, toolNames);
        byPlugin.set(name, serverName);
        warnedMcpRegistrationFailures.delete(serverName);
        const ms = Date.now() - startedAt;
        log(
          "agent",
          `Registered plugin MCP server: ${serverName} (${name} for chat ${chatId}, ${ms}ms)` +
            (ms > SLOW_MCP_REGISTRATION_MS ? " [slow]" : ""),
        );
        return serverName;
      } catch (err) {
        // Warn once per server, then debug: registration re-runs at the
        // head of every turn, so a dead backing service (an offline
        // browser endpoint, say) would otherwise emit one warning per
        // turn for the whole outage. Success clears the latch so the
        // next outage warns again.
        const level = warnedMcpRegistrationFailures.has(serverName)
          ? logDebug
          : logWarn;
        warnedMcpRegistrationFailures.add(serverName);
        // "Connection closed" alone says nothing; the hub knows how the
        // child behind this server last died.
        const exit = describeHubChildExit(name, chatId);
        level(
          "agent",
          `Plugin MCP registration failed for ${serverName}: ${errMsg(err)}` +
            (exit ? ` (hub child ${exit})` : ""),
        );
        return null;
      }
    }),
  );

  return results.filter((name): name is string => Boolean(name));
}

/**
 * Build a `tools` override map that enables ONLY this chat's Talon tools.
 *
 * Upstream tool environment is global — every registered MCP server's
 * tools are visible to every session. Talon overrides per-prompt to keep
 * each session pinned to its own namespaced tools, denying cross-chat
 * access at the visibility layer (not just the execution layer that
 * permission rules cover).
 *
 * When the current chat's tools have not appeared in `tool.ids()` yet, still
 * returns a map that disables any sibling chat tools already visible. MCP
 * registration completes asynchronously upstream; returning `undefined` in
 * that window exposed a concurrent heartbeat/dream toolset to the chat.
 * Returns `undefined` only when the catalog contains no Talon tools at all.
 */
export async function buildToolOverrides<TClient extends RemoteAgentClient>(
  client: TClient,
  state: RemoteServerState<TClient>,
  chatServerName: string,
  pluginServerNames: readonly string[] = [],
): Promise<Record<string, boolean> | undefined> {
  const overrides: Record<string, boolean> = {};
  const enabledServers = new Set([chatServerName, ...pluginServerNames]);
  let matchedManagedTool = false;

  // Build from Talon's own registration ledger first. This is the reliable
  // source for dynamic MCP tools; the upstream ids endpoint omits them and can
  // itself fail during a server wobble. A failed discovery call must never
  // discard the isolation map we can synthesize locally.
  for (const serverName of state.registeredMcpServers) {
    const toolNames =
      state.registeredMcpTools.get(serverName) ??
      (serverName.startsWith(`${TALON_MCP_SERVER_NAME}-`)
        ? TALON_TOOL_NAMES
        : []);
    const enabled = enabledServers.has(serverName);
    for (const toolName of toolNames) {
      overrides[`${serverName}_${toolName}`] = enabled;
    }
    if (toolNames.length > 0) matchedManagedTool = true;
  }

  try {
    const toolIdsResp = await client.tool.ids();
    const toolIds = Array.isArray(toolIdsResp.data) ? toolIdsResp.data : [];

    for (const toolId of toolIds) {
      if (typeof toolId !== "string") continue;
      const owner = [...state.registeredMcpServers].find((serverName) =>
        toolId.startsWith(`${serverName}_`),
      );
      if (owner) {
        overrides[toolId] = enabledServers.has(owner);
      } else if (isTalonToolID(toolId)) {
        overrides[toolId] = toolId.startsWith(`${chatServerName}_`);
      } else {
        continue;
      }
      matchedManagedTool = true;
    }
  } catch (err) {
    logWarn(
      "agent",
      `Failed to build ${state.label} tool overrides for ${chatServerName}: ${errMsg(err)}`,
    );
  }
  return matchedManagedTool ? overrides : undefined;
}

/**
 * Disconnect a per-chat MCP server. One-shot paths use this to release
 * their ephemeral context registration once the run ends.
 *
 * Errors are swallowed (the server may already be gone if MCP itself
 * crashed). The local cache entry is removed unconditionally so a
 * future `ensureChatMcpServer` re-registers — otherwise the cache
 * short-circuit would skip a server the upstream no longer has.
 *
 * Chat handlers deliberately keep registrations cached across turns;
 * per-prompt tool overrides provide cross-chat visibility isolation.
 */
export async function disconnectChatMcpServer<
  TClient extends RemoteAgentClient,
>(
  client: TClient,
  state: RemoteServerState<TClient>,
  serverName: string,
): Promise<void> {
  try {
    await client.mcp.disconnect({ name: serverName });
  } catch (err) {
    logWarn("agent", `Failed to disconnect ${serverName}: ${errMsg(err)}`);
  } finally {
    state.registeredMcpServers.delete(serverName);
    state.registeredMcpTools.delete(serverName);
    for (const byPlugin of state.pluginMcpServersByChat.values()) {
      for (const [pluginName, registeredName] of byPlugin) {
        if (registeredName === serverName) byPlugin.delete(pluginName);
      }
    }
  }
}

/**
 * Reconnect one chat's plugin registrations after a hot reload so the remote
 * server refreshes cached tool schemas. Hub children are already retired by
 * the plugin registry; this refresh handles added/removed/renamed tools.
 */
export async function refreshPluginMcpServers<
  TClient extends RemoteAgentClient,
>(
  client: TClient,
  state: RemoteServerState<TClient>,
  chatId: string,
): Promise<{
  added: string[];
  removed: string[];
  errors: Record<string, string>;
}> {
  const previous = new Set(
    state.pluginMcpServersByChat.get(chatId)?.keys() ?? [],
  );
  const existingNames = [
    ...(state.pluginMcpServersByChat.get(chatId)?.values() ?? []),
  ];
  await Promise.all(
    existingNames.map((name) => disconnectChatMcpServer(client, state, name)),
  );
  state.pluginMcpServersByChat.delete(chatId);

  const registered = await ensurePluginMcpServers(client, state, chatId);
  const current = new Set(
    state.pluginMcpServersByChat.get(chatId)?.keys() ?? [],
  );
  const desiredCount = hubPluginServerNames().length;
  return {
    added: [...current].filter((name) => !previous.has(name)),
    removed: [...previous].filter((name) => !current.has(name)),
    errors:
      registered.length === desiredCount && current.size === desiredCount
        ? {}
        : { registration: "one or more plugin MCP servers failed to register" },
  };
}

/**
 * Snapshot of the locally-cached MCP server registrations. Test-only:
 * `registeredMcpServers` is module-private state that integration tests
 * need to inspect to assert concurrent registrations are retained (the
 * upstream's GET /mcp returns {} regardless of state, so we can't query
 * the server itself).
 */
export function getRegisteredMcpServerNames<TClient extends RemoteAgentClient>(
  state: RemoteServerState<TClient>,
): string[] {
  return [...state.registeredMcpServers];
}
