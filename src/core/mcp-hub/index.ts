/**
 * MCP hub — daemon-hosted MCP over streamable HTTP, one endpoint for
 * every backend. The daemon hosts
 *
 *   /mcp/talon/<frontend>/<chatId>   Talon's own tools, IN-PROCESS
 *                                    (zero subprocesses; chat binding
 *                                    comes from the URL, not env)
 *   /mcp/plugin/<serverName>/<chatId> external plugin / brave servers,
 *                                    proxied to hub-managed children
 *                                    that are shared across sessions
 *                                    and reaped when idle
 *
 * and every backend connects with its SDK's HTTP/remote MCP transport
 * (claude-sdk `type:"http"`, openai-agents `MCPServerStreamableHttp`,
 * codex `mcp_servers.<name>.url`, kilo/opencode `type:"remote"`).
 *
 * Invariants:
 *   - per-chat tool isolation (binding is per-session from the URL)
 *   - chat-scoped plugin children keep TALON_CHAT_ID in their env
 *   - tool-surface trimming (disabledTools / disabledToolTags)
 *   - plugin reload retires children; the next request respawns from
 *     the current registry (see reloadHubChildren)
 *   - children are orphan-guarded (one reaper per daemon, falling back
 *     to the per-child supervisor wrap — see child-guard.ts)
 *   - a session's tools/list does not spawn its chat's child when any
 *     chat already listed that server (see listChildTools)
 *
 * Endpoints live on the gateway HTTP server (127.0.0.1-bound, behind the
 * same token and Host/Origin guard as /action — see engine/gateway-auth.ts;
 * every backend's hub entry carries the token as a bearer header).
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getPluginMcpServers } from "../plugin/index.js";
import { enableChildGuard, stopChildGuard } from "./child-guard.js";
import { log, logError } from "../../util/log.js";
import { buildTalonToolServer, VALID_TOOL_FRONTENDS } from "./talon-server.js";
import { buildProxyServer } from "./proxy-server.js";
import {
  acquireChild,
  closeAllChildren,
  formatChildExit,
  getLastChildExit,
  listChildTools,
  retireAllChildren,
  startChildReaper,
  stopChildReaper,
  type ChildSpec,
} from "./children.js";
import type { ToolFrontend } from "../tools/types.js";
import {
  initGuestDmScope,
  isGuestPluginAllowed,
  isGuestTurn,
  type GuestDmScopeConfig,
} from "./guest-scope.js";

export const HUB_PATH_PREFIX = "/mcp/";

// ── Config ──────────────────────────────────────────────────────────────────

export type HubConfig = {
  disabledTools?: readonly string[];
  disabledToolTags?: readonly string[];
  braveApiKey?: string;
  /** Surface the native tool set (bash/read/write/… + teleport). */
  nativeTools?: boolean;
  /** Conversation-only tool surface for non-operator senders. */
  guestDmScope?: GuestDmScopeConfig;
  /** Operator's Telegram id — their messages keep the full surface. */
  adminUserId?: number;
  /** Further operator sender keys (see guest-scope.ts). */
  operatorIds?: readonly string[];
  /**
   * Orphan-guard hub children with the reaper (child-guard.ts). Set by the
   * daemon bootstrap, whose entrypoint dispatches `_mcp-reaper`; left off
   * by embedders/tests that drive the hub from an entry that doesn't.
   */
  guardChildren?: boolean;
};

let hubConfig: HubConfig = {};

/** Set at bootstrap; safe to call again on config reload. */
export function initHub(config: HubConfig): void {
  hubConfig = config;
  initGuestDmScope(config.guestDmScope, config.adminUserId, config.operatorIds);
  if (config.guardChildren) enableChildGuard();
  startChildReaper();
}

// ── URL builders (used by every backend) ────────────────────────────────────

/** URL of the in-process Talon tool server for one (frontend, chat). */
export function talonHubUrl(
  bridgeUrl: string,
  frontend: string,
  chatId: string,
): string {
  return `${bridgeUrl}${HUB_PATH_PREFIX}talon/${encodeURIComponent(frontend)}/${encodeURIComponent(chatId)}`;
}

/** URL of a hub-proxied plugin/brave server for one chat. */
export function pluginHubUrl(
  bridgeUrl: string,
  serverName: string,
  chatId: string,
): string {
  return `${bridgeUrl}${HUB_PATH_PREFIX}plugin/${encodeURIComponent(serverName)}/${encodeURIComponent(chatId)}`;
}

/**
 * Names of every hub-served plugin server — what backends enumerate to
 * build their per-chat URL maps. Registry-backed, so it reflects plugin
 * reloads immediately. (brave-search is served by the hub too, but each
 * backend adds it explicitly alongside its frontend tools.)
 */
export function hubPluginServerNames(only?: string[]): string[] {
  // Specs are built with placeholder identity — only the names matter.
  return Object.keys(getPluginMcpServers("", "hub-enum", only));
}

/**
 * Enumerate one plugin server's tools through the same hub-managed child that
 * serves MCP requests. Remote agent servers do not include dynamically-added
 * MCP tools in their `/experimental/tool/ids` response, so OpenCode/Kilo need
 * this authoritative list to build per-chat visibility overrides.
 */
export async function listHubPluginToolNames(
  serverName: string,
  chatId: string,
  bridgeUrl: string,
): Promise<string[]> {
  const tools = await listChildTools(childKey(serverName, chatId), () =>
    pluginSpec(serverName, chatId, bridgeUrl),
  );
  return tools.map((tool) => tool.name);
}

/** Stderr lines quoted in a registration-failure warning (full tail is in the exit log line). */
const EXIT_SUMMARY_STDERR_LINES = 5;

/**
 * Why the hub child behind (serverName, chatId) last went away —
 * `code=1 signal=null 2s ago; stderr: …` — or null if it never exited.
 * Lets a backend's "registration failed: Connection closed" warning
 * carry the cause.
 */
export function describeHubChildExit(
  serverName: string,
  chatId: string,
): string | null {
  const exit = getLastChildExit(childKey(serverName, chatId));
  return exit ? formatChildExit(exit, EXIT_SUMMARY_STDERR_LINES) : null;
}

/**
 * brave-search is chat-agnostic (one shared child); plugins read
 * TALON_CHAT_ID at boot, so their children stay chat-scoped and the
 * idle reaper bounds the fleet.
 */
function childKey(serverName: string, chatId: string): string {
  return serverName === "brave-search"
    ? "brave-search"
    : `${serverName}\u0000${chatId}`;
}

// ── Server construction per session ─────────────────────────────────────────

type HubTarget =
  | { kind: "talon"; frontend: ToolFrontend; chatId: string }
  | { kind: "plugin"; serverName: string; chatId: string };

function parseHubPath(rawUrl: string): HubTarget | null {
  const path = rawUrl.split("?")[0];
  if (!path.startsWith(HUB_PATH_PREFIX)) return null;
  const parts = path
    .slice(HUB_PATH_PREFIX.length)
    .split("/")
    .map((part) => decodeURIComponent(part));
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  const [kind, name, chatId] = parts;
  if (kind === "talon") {
    if (!VALID_TOOL_FRONTENDS.has(name)) return null;
    return { kind: "talon", frontend: name as ToolFrontend, chatId };
  }
  if (kind === "plugin") return { kind: "plugin", serverName: name, chatId };
  return null;
}

function braveSpec(bridgeUrl: string): ChildSpec {
  return {
    command: resolve(
      import.meta.dirname ?? ".",
      "../../../node_modules/.bin/brave-search-mcp-server",
    ),
    args: [],
    env: { BRAVE_API_KEY: hubConfig.braveApiKey ?? "" },
    bridgeUrl,
  };
}

/**
 * Resolve the child spec for a plugin server name. Looked up lazily at
 * spawn time so a reload always spawns from the current registry.
 * Throws when the name is unknown (plugin removed / never existed).
 */
function pluginSpec(
  serverName: string,
  chatId: string,
  bridgeUrl: string,
): ChildSpec {
  if (serverName === "brave-search") return braveSpec(bridgeUrl);
  const specs = getPluginMcpServers(bridgeUrl, chatId);
  const spec = specs[serverName];
  if (!spec) throw new Error(`Unknown hub plugin server: ${serverName}`);
  return {
    command: spec.command,
    args: [...spec.args],
    env: spec.env,
    bridgeUrl,
  };
}

/** Test-only: expose the spec resolution for the pass-through contract. */
export const _pluginSpecForTesting = pluginSpec;

function buildServerFor(target: HubTarget, bridgeUrl: string) {
  if (target.kind === "talon") {
    return buildTalonToolServer({
      frontend: target.frontend,
      chatId: target.chatId,
      bridgeUrl,
      disabledTools: hubConfig.disabledTools,
      disabledToolTags: hubConfig.disabledToolTags,
      includeNativeTools: hubConfig.nativeTools,
      guest: isGuestTurn(target.chatId),
    });
  }
  // Re-checked per request: a session opened during an operator turn must
  // not serve a later guest turn in the same chat.
  const key = childKey(target.serverName, target.chatId);
  const spec = () => pluginSpec(target.serverName, target.chatId, bridgeUrl);
  const denied = () =>
    guestPluginDenied(target)
      ? Promise.reject(new Error("Not available in this chat"))
      : null;
  return buildProxyServer(target.serverName, {
    listTools: () => denied() ?? listChildTools(key, spec),
    getChild: () => denied() ?? acquireChild(key, spec),
  });
}

function guestPluginDenied(target: { serverName: string; chatId: string }) {
  return isGuestTurn(target.chatId) && !isGuestPluginAllowed(target.serverName);
}

// ── Session registry ────────────────────────────────────────────────────────

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  /** Requests still open on this session, SSE streams included. */
  open: number;
};

const sessions = new Map<string, SessionEntry>();

/**
 * Sessions whose client vanished without a DELETE (crashed subprocess,
 * kill -9) are closed after this idle window. Every well-behaved client
 * terminates explicitly, so this only catches stragglers. A session with
 * a request still open is never idle: a client that holds its event
 * stream between turns (openai-agents keeps one per chat for good) is
 * alive however quiet the chat, and it does not re-initialize on a 404.
 * The idle clock restarts when its last open request ends.
 */
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_REAP_INTERVAL_MS = 5 * 60_000;
let sessionReaper: ReturnType<typeof setInterval> | null = null;

function startSessionReaper(): void {
  if (sessionReaper) return;
  sessionReaper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, entry] of sessions) {
      if (entry.open > 0 || entry.lastSeen >= cutoff) continue;
      sessions.delete(id);
      entry.transport.close().catch(() => {});
      log("gateway", `hub session reaped (idle): ${id.slice(0, 8)}…`);
    }
  }, SESSION_REAP_INTERVAL_MS);
  sessionReaper.unref?.();
}

// ── HTTP entry point (invoked by the gateway) ───────────────────────────────

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/** `Host` values a loopback client of the gateway at `bridgeUrl` sends. */
function loopbackHosts(bridgeUrl: string): string[] {
  const { port } = new URL(bridgeUrl);
  return ["127.0.0.1", "localhost", "[::1]"].map((name) => `${name}:${port}`);
}

/**
 * Handle one request under /mcp/. `bridgeUrl` is the gateway's own base
 * URL (the gateway knows its bound port; the hub does not).
 */
export async function handleHubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bridgeUrl: string,
): Promise<void> {
  startSessionReaper();
  try {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const entry = sessions.get(sessionId);
      if (!entry) {
        jsonRpcError(res, 404, "Unknown or expired MCP session");
        return;
      }
      entry.lastSeen = Date.now();
      entry.open++;
      res.once("close", () => {
        entry.open--;
        entry.lastSeen = Date.now();
      });
      await entry.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== "POST") {
      jsonRpcError(res, 405, "Method not allowed without a session");
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      jsonRpcError(res, 400, "Invalid JSON body");
      return;
    }
    if (!isInitializeRequest(body)) {
      jsonRpcError(res, 400, "Expected an initialize request");
      return;
    }

    const target = parseHubPath(req.url ?? "");
    if (!target) {
      jsonRpcError(res, 404, "Unknown hub endpoint");
      return;
    }

    if (target.kind === "plugin" && guestPluginDenied(target)) {
      jsonRpcError(res, 403, "Not available in this chat");
      return;
    }

    const server = buildServerFor(target, bridgeUrl);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Defence in depth behind the gateway's own Host/Origin guard.
      enableDnsRebindingProtection: true,
      allowedHosts: loopbackHosts(bridgeUrl),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastSeen: Date.now(), open: 0 });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    logError("gateway", `hub request failed: ${req.method} ${req.url}`, err);
    if (!res.headersSent) {
      jsonRpcError(res, 500, "Internal hub error");
    }
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Plugin reload: RETIRE every child — the next request (from any chat)
 * spawns fresh processes running the reloaded plugin code, while calls
 * already in flight finish on the old process instead of erroring
 * mid-turn. Live sessions keep working — their proxies re-acquire on
 * the next call.
 */
export function reloadHubChildren(): void {
  retireAllChildren();
}

/** Daemon shutdown: close sessions, children, and timers. */
export async function shutdownHub(): Promise<void> {
  stopChildReaper();
  if (sessionReaper) {
    clearInterval(sessionReaper);
    sessionReaper = null;
  }
  const entries = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(entries.map((entry) => entry.transport.close()));
  await closeAllChildren();
  stopChildGuard();
}

/** Diagnostic: live hub session count. */
export function getHubSessionCount(): number {
  return sessions.size;
}
