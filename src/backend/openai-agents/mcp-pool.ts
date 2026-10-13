/**
 * Per-chat MCP bundle pool for the OpenAI Agents backend.
 *
 * Every server is a lightweight `MCPServerStreamableHttp` client
 * pointing at the daemon's MCP hub (`core/mcp-hub`): Talon's own tools
 * run in-process there, and plugin/brave servers are hub-managed
 * children shared across chats and reaped when idle. A bundle is just
 * HTTP client objects; the process count is owned and bounded by the hub.
 *
 * The bundle is cached per chat so `cacheToolsList` survives across
 * turns and each turn skips the connect handshake.
 *
 * Concurrency: `getOrCreateBundle` serialises the build-or-return
 * decision on a per-chat in-flight Promise so two concurrent turns from
 * the same chat (cross-frontend, e.g. Telegram + Discord) reuse one
 * bundle rather than double-connect. Different chats build
 * independently in parallel.
 */

import { connectMcpServers, MCPServerStreamableHttp } from "@openai/agents";
import type { MCPServer } from "@openai/agents";
import { gatewayAuthHeaders } from "../../core/engine/gateway-auth.js";
import {
  talonHubUrl,
  pluginHubUrl,
  hubPluginServerNames,
} from "../../core/mcp-hub/index.js";
import type { ToolExclusionConfig } from "../../core/tools/mcp-env.js";
import { frontendsForChat } from "../runtime/frontends.js";
import { log, logWarn } from "../../util/log.js";

/**
 * One per-chat bundle. Its hub sessions stay open until `close()` is
 * called via `releaseBundle()` / `releaseAllBundles()`.
 */
export interface OpenAIAgentsMcpBundle {
  /** Connected MCP servers ready to pass to `new Agent({ mcpServers })`. */
  servers: MCPServer[];
  /** Close every server's hub session. Safe to call multiple times. */
  close: () => Promise<void>;
  /** Servers that failed to connect — exposed for diagnostics. */
  failed: ReadonlyArray<{ name: string; error: string }>;
}

/**
 * Inputs for {@link getOrCreateBundle}. Everything but `chatId` is
 * effectively constant across turns for a given Talon process — they're
 * passed per-call so the module doesn't have to import state.
 */
export interface BundleInputs {
  chatId: string;
  bridgeUrl: string;
  frontends: readonly string[];
  braveApiKey?: string;
  /**
   * Tool-surface trimming slice of the Talon config. Accepted for call
   *-site stability; trimming is applied hub-side (initHub) where the
   * Talon tool servers are composed.
   */
  toolExclusions?: ToolExclusionConfig | null;
}

/** Live bundles keyed by chatId. */
const bundles = new Map<string, OpenAIAgentsMcpBundle>();
/** In-flight build promises so concurrent gets share one build. */
const inflight = new Map<string, Promise<OpenAIAgentsMcpBundle>>();

/**
 * Return the cached bundle for `chatId`, or build + connect a new one.
 *
 * Build path uses the SDK's `connectMcpServers` helper for clean
 * lifecycle management: per-server connect timeouts (10s default),
 * `failed`/`errors` collections instead of fail-the-whole-bundle,
 * `dropFailed: true` so one bad plugin doesn't take down the rest.
 *
 * Every server is constructed with `cacheToolsList: true` so the SDK
 * fetches the tool definitions exactly once per server-lifetime instead
 * of re-listing on every turn.
 */
export async function getOrCreateBundle(
  args: BundleInputs,
): Promise<OpenAIAgentsMcpBundle> {
  const cached = bundles.get(args.chatId);
  if (cached) return cached;

  const pending = inflight.get(args.chatId);
  if (pending) return pending;

  const promise = (async (): Promise<OpenAIAgentsMcpBundle> => {
    try {
      const bundle = await buildBundle(args);
      bundles.set(args.chatId, bundle);
      return bundle;
    } finally {
      inflight.delete(args.chatId);
    }
  })();

  inflight.set(args.chatId, promise);
  return promise;
}

/**
 * Close the bundle for `chatId` and drop it from the pool. No-op when
 * the chat has no live bundle.
 *
 * If `getOrCreateBundle` is in flight when called, releases the bundle
 * once the in-flight build resolves so it is not left open.
 */
export async function releaseBundle(chatId: string): Promise<void> {
  // If a build is in flight, wait for it then close the result.
  const pending = inflight.get(chatId);
  if (pending) {
    try {
      const bundle = await pending;
      await bundle.close();
    } catch {
      // Build threw — nothing to close. Already cleaned via build's
      // own error path.
    }
    bundles.delete(chatId);
    return;
  }

  const bundle = bundles.get(chatId);
  if (!bundle) return;
  bundles.delete(chatId);
  await bundle.close().catch((err) => {
    logWarn(
      "agent",
      `[${chatId}] MCP bundle close failed: ${errMsg(err)} (continuing)`,
    );
  });
}

/**
 * Close every live bundle. Used by the backend factory's `cleanup`
 * hook so unbinding the openai-agents backend leaves no hub sessions
 * behind.
 */
export async function releaseAllBundles(): Promise<void> {
  const ids = [...bundles.keys()];
  await Promise.allSettled(ids.map((id) => releaseBundle(id)));
}

/**
 * Diagnostic: how many live bundles + their chat ids. Exposed for
 * tests and `/status`-style introspection.
 */
export function getActiveBundleIds(): readonly string[] {
  return [...bundles.keys()];
}

/**
 * Build + connect a bundle that is NOT cached in the pool. The caller
 * owns it and must `close()` it. Used by isolated one-shot runs: their
 * context label (`heartbeat`, `agent:<id>`) can be shared by concurrent
 * runs (every isolated cron job runs as `heartbeat`), so a pooled bundle
 * released by one run would be pulled out from under another.
 */
export function openUnpooledBundle(
  args: BundleInputs,
): Promise<OpenAIAgentsMcpBundle> {
  return buildBundle(args);
}

// ── Internal: build + connect ───────────────────────────────────────────────

async function buildBundle(args: BundleInputs): Promise<OpenAIAgentsMcpBundle> {
  const { chatId, bridgeUrl, frontends, braveApiKey } = args;

  const built: MCPServerStreamableHttp[] = [];

  // Frontend MCP tool servers. Each exposes the Talon-native delivery
  // surface (send, react, end_turn, …) for that frontend, scoped to
  // `chatId` via the hub URL — the server itself runs in-process
  // inside the daemon. Scoped to the chat's owning frontend;
  // cross-surface contexts keep the full set.
  for (const frontend of frontendsForChat(chatId, frontends)) {
    built.push(
      new MCPServerStreamableHttp({
        name: `${frontend}-tools`,
        url: talonHubUrl(bridgeUrl, frontend, chatId),
        cacheToolsList: true,
        requestInit: { headers: gatewayAuthHeaders() },
      }),
    );
  }

  // Brave Search MCP server (if configured) — one hub child shared by
  // every chat.
  if (braveApiKey) {
    built.push(
      new MCPServerStreamableHttp({
        name: "brave-search",
        url: pluginHubUrl(bridgeUrl, "brave-search", chatId),
        cacheToolsList: true,
        requestInit: { headers: gatewayAuthHeaders() },
      }),
    );
  }

  // Plugin MCP servers — hub-managed children (chat-scoped, idle-reaped).
  for (const name of hubPluginServerNames()) {
    built.push(
      new MCPServerStreamableHttp({
        name,
        url: pluginHubUrl(bridgeUrl, name, chatId),
        cacheToolsList: true,
        requestInit: { headers: gatewayAuthHeaders() },
      }),
    );
  }

  // Use the SDK's lifecycle helper. Parallel connect, per-server
  // timeout (10s default), failed servers tracked in `.failed` rather
  // than failing the whole bundle. `dropFailed: true` (default) means
  // `.active` only includes the ones that successfully connected.
  const mcpServers = await connectMcpServers(built, {
    connectInParallel: true,
  });

  const failedInfo: { name: string; error: string }[] = [];
  for (const [server, error] of mcpServers.errors) {
    failedInfo.push({ name: server.name, error: errMsg(error) });
    logWarn(
      "agent",
      `[${chatId}] MCP server ${server.name} failed to connect: ${errMsg(error)}`,
    );
  }

  log(
    "agent",
    `[${chatId}] MCP bundle ready: ${mcpServers.active.length} server(s) connected` +
      (failedInfo.length > 0 ? `, ${failedInfo.length} failed` : ""),
  );

  const bundle: OpenAIAgentsMcpBundle = {
    servers: mcpServers.active,
    failed: failedInfo,
    close: async () => {
      await mcpServers.close().catch((err) => {
        logWarn("agent", `MCP bundle close failed: ${errMsg(err)}`);
      });
    },
  };
  return bundle;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
