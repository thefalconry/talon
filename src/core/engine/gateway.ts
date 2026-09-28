/**
 * Gateway — generic HTTP bridge between MCP tool subprocess and the active frontend.
 *
 * The MCP subprocess (tools.ts) calls POST /action with action bodies.
 * The gateway tries shared actions first (cron, fetch_url, history),
 * then delegates to the active frontend's action handler.
 *
 * No platform-specific imports — frontends register their handler at startup.
 */

import { createServer } from "node:http";
import pRetry, { AbortError } from "p-retry";
import { classify } from "../errors.js";
import { getActiveCount } from "./dispatcher.js";
import { Loom, getActiveLoom, type ContextRegistry } from "../weaver/index.js";
import { getHealthStatus } from "../../util/watchdog.js";
import { activeAlerts } from "../frontend-runtime/alerts.js";
import { getActiveSessionCount } from "../../storage/sessions.js";
import { log, logError, logDebug } from "../../util/log.js";
import { runInChatTurnScope } from "../../util/logging/turn-scope.js";
import {
  handleSharedAction,
  handleChatFreeAction,
  handleAgentContextAction,
  isChatFreeAction,
} from "./gateway-actions/index.js";
import { AGENT_CONTEXT_PREFIX } from "../agents/context.js";
import { registerCrossSendTarget } from "./gateway-actions/cross-send.js";
import { getHubSessionCount } from "../mcp-hub/index.js";
import {
  dispatchGatewayRoute,
  listenWithRetry,
  type GatewayRouteHost,
} from "./gateway-routes.js";
import { gatewayToken } from "./gateway-auth.js";
import { handlePluginAction } from "../plugin/index.js";
import type { FrontendActionHandler } from "../types.js";
import type { Backend } from "../agent-runtime/capabilities.js";
import { resolveOwnerFrontendId } from "../frontend-runtime/routing.js";

/** Serialized size of an action result; -1 when it can't be serialized. */
function actionResultBytes(result: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(result) ?? "");
  } catch {
    return -1;
  }
}

/** `tool.action name=… chat=… ms=… ok=… bytes=… [err=…]` for one bridge action. */
function logActionOutcome(
  body: Record<string, unknown>,
  chat: string,
  ms: number,
  result: unknown,
): void {
  const action = typeof body.action === "string" ? body.action : "?";
  const r = result as { ok?: unknown; error?: unknown } | null | undefined;
  const failed = !!r && typeof r === "object" && r.ok === false;
  const line =
    `tool.action name=${action} chat=${chat || "-"} ms=${ms} ` +
    `ok=${!failed} bytes=${actionResultBytes(result)}`;
  if (!failed) {
    logDebug("gateway", line);
    return;
  }
  const err = String(r.error ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 200);
  log("gateway", `${line} err=${err}`);
}

// ── Retry helper (stateless — standalone export) ─────────────────────────────

/**
 * Retry a function up to 3 times with classified error inspection.
 * Non-retryable errors (auth, bad_request, context_length) are thrown immediately.
 * Uses p-retry for proper exponential backoff with jitter.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(
    async (attempt) => {
      try {
        return await fn();
      } catch (err) {
        const classified = classify(err);
        if (!classified.retryable) {
          // Wrap in AbortError to prevent further retries
          throw new AbortError(classified);
        }
        const pRetryDelay = 1000 * Math.pow(2, attempt - 1);
        const delayMs = classified.retryAfterMs ?? pRetryDelay;
        log(
          "gateway",
          `Retry ${attempt}/3 (${classified.reason}) after ${delayMs}ms`,
        );
        if (classified.retryAfterMs && classified.retryAfterMs > pRetryDelay) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, classified.retryAfterMs! - pRetryDelay),
          );
        }
        throw classified; // rethrow to trigger p-retry delay
      }
    },
    {
      retries: 2, // 3 total attempts
      minTimeout: 1000,
      maxTimeout: 60_000,
      factor: 2,
      onFailedAttempt: (err) => {
        if (err.retriesLeft === 0) {
          logError("gateway", `All retries exhausted: ${err.error.message}`);
        }
      },
    },
  );
}

// ── Gateway class ────────────────────────────────────────────────────────────

export class Gateway {
  /**
   * Per-chat live state is owned by the Weaver's Loom. The gateway holds no
   * registry of its own — it delegates here, and only through the
   * `ContextRegistry` face (the gateway never creates or evicts Threads).
   * `getActiveLoom()` returns the Weaver's Loom once the dispatcher is wired;
   * the standalone fallback covers unit tests and the brief startup window
   * before init (when no turn — and so no context — can exist anyway).
   */
  private readonly ownLoom = new Loom();
  private get loom(): ContextRegistry {
    return getActiveLoom() ?? this.ownLoom;
  }

  private frontendHandler: FrontendActionHandler | null = null;
  private readonly frontendHandlers = new Map<string, FrontendActionHandler>();
  private readonly chatFrontendOwners = new Map<number, string>();
  private server: ReturnType<typeof createServer> | null = null;
  /**
   * In-flight `start()` bind, so concurrent callers share one HTTP server.
   * Non-null only between the first `start()` call and its bind settling.
   */
  private starting: Promise<number> | null = null;
  private port = 0;
  private readonly startedAt = new Date().toISOString();
  private startedListeners: Array<(port: number) => void> = [];
  private shutdownHandler: ((reason: string) => void) | null = null;

  /**
   * Process role advertised on /health — lets the daemon CLI
   * (core/daemon/discovery.ts) tell the background daemon apart from a
   * `talon chat` session, which runs its own gateway on a nearby port.
   */
  constructor(readonly mode: "daemon" | "chat" = "chat") {}

  /**
   * Register a callback invoked once the HTTP server has bound. The
   * gateway may fall back from the requested port on EADDRINUSE, so
   * the actual port is only known here — the daemon uses this to
   * record the port in its pidfile.
   */
  onStarted(cb: (port: number) => void): void {
    if (this.server) cb(this.port);
    else this.startedListeners.push(cb);
  }

  /**
   * Register the graceful-shutdown trigger for POST /shutdown. Only
   * the daemon composition root registers one; without it the endpoint
   * answers 501.
   */
  onShutdownRequest(cb: (reason: string) => void): void {
    this.shutdownHandler = cb;
  }

  /**
   * The active backend — set initially by bootstrap and updated by
   * the backend controller on hot-swap (`switchBackend`). Reads route
   * through this field so command handlers, callbacks, and shared-
   * action dispatch all see the same instance the dispatcher does.
   */
  backend: Backend | null = null;

  // ── Frontend handler registration ────────────────────────────────────────

  setFrontendHandler(handler: FrontendActionHandler | null): void {
    this.frontendHandler = handler;
  }

  registerFrontendHandler(
    name: string,
    handler: FrontendActionHandler | null,
  ): void {
    // Mirror into the cross-send broker so the chat-free `send_via`
    // action can dispatch to any enabled frontend by explicit name.
    registerCrossSendTarget(name, handler);
    if (handler === null) {
      this.frontendHandlers.delete(name);
      return;
    }
    this.frontendHandlers.set(name, handler);
  }

  private resolveOwnedFrontendName(
    rawChatId: string,
    chatId: number,
  ): string | null {
    const owned = this.chatFrontendOwners.get(chatId);
    if (owned) return owned;
    // Shape-convention fallback — the frontend registry owns chat-id
    // matchers, including any registered at runtime.
    return resolveOwnerFrontendId(rawChatId, { includeNonMessaging: true });
  }

  private resolveFrontendHandler(
    rawChatId: string,
    chatId: number,
  ): FrontendActionHandler | null {
    const ownedName = this.resolveOwnedFrontendName(rawChatId, chatId);
    if (ownedName) {
      const ownedHandler = this.frontendHandlers.get(ownedName);
      if (ownedHandler) return ownedHandler;
    }
    if (this.frontendHandler) return this.frontendHandler;
    if (this.frontendHandlers.size === 1) {
      return this.frontendHandlers.values().next().value ?? null;
    }
    return null;
  }

  // ── Per-chat context management ──────────────────────────────────────────

  setContext(chatId: number, stringId?: string, frontendName?: string): void {
    this.loom.acquireContext(chatId, stringId);
    if (frontendName) this.chatFrontendOwners.set(chatId, frontendName);
    else if (stringId !== undefined && !this.chatFrontendOwners.has(chatId)) {
      const inferred = this.resolveOwnedFrontendName(stringId, chatId);
      if (inferred) this.chatFrontendOwners.set(chatId, inferred);
    }
  }

  /** Find a numeric chatId by its string ID (used for Teams-style non-numeric chat IDs). */
  private findContextByStringId(stringId: string): number | null {
    if (!stringId) return null;
    return this.loom.numericForStringId(stringId);
  }

  clearContext(chatId?: number | string): void {
    if (chatId === undefined) return;
    // The Loom resolves numeric ids, numeric-looking strings, and Teams-style
    // non-numeric ids (e.g. "19:abc...") to the right Thread itself.
    this.loom.releaseContext(chatId);
    if (typeof chatId === "number") {
      this.chatFrontendOwners.delete(chatId);
    } else {
      const numericId = Number(chatId);
      if (!Number.isNaN(numericId)) this.chatFrontendOwners.delete(numericId);
    }
  }

  isChatBusy(chatId: number): boolean {
    return this.loom.hasActiveContext(chatId);
  }

  getMessageCount(chatId: number): number {
    return this.loom.messageCount(chatId);
  }

  incrementMessages(chatId: number): void {
    this.loom.noteMessageSent(chatId);
  }

  getPort(): number {
    return this.port;
  }

  getActiveChats(): number {
    return this.loom.activeContextCount();
  }

  // ── Action dispatch ────────────────────────────────────────────────────────

  /**
   * Dispatch the actions that resolve without a chat, or `null` when the
   * request needs one after all.
   *
   * Two families qualify, and they short-circuit routing for the same
   * reason: there is no chat to route to.
   *
   *   - **Chat-free** actions (the device mesh, cross-send) read daemon-wide
   *     state and ignore chatId. Gating them behind an active chat made the
   *     whole mesh unreachable from background runs — and unlike send/react
   *     they carry no `chat_id` param to promote.
   *   - **Sub-agent** actions arrive from a run whose `contextLabel` is
   *     `agent:<id>`; the MCP hub binds that to the tool session and the
   *     bridge sends it back as `_chatId`. Such a caller has an identity but
   *     no chat, so the key is handed through as the chatKey — which is how
   *     `report_result` knows which agent reported. Everything else a
   *     sub-agent calls still routes by an explicit `chat_id`, exactly as a
   *     heartbeat run does.
   */
  private async dispatchWithoutChat(
    body: Record<string, unknown>,
    rawChatId: string,
  ): Promise<unknown | null> {
    const action = typeof body.action === "string" ? body.action : "";
    const agentContext = rawChatId.startsWith(AGENT_CONTEXT_PREFIX);
    if (!action || (!agentContext && !isChatFreeAction(action))) return null;
    const where = agentContext ? rawChatId : "chat-free";
    const t0 = Date.now();
    try {
      // An agent context first tries the agent-only actions; if the action
      // isn't one of those it may still be a chat-free action (mesh, send_via,
      // backup, whatsapp_account), which a sub-agent is offered and must be
      // able to reach. Without this fall-through those calls returned null and
      // dropped into chat routing, failing with "No active chat context".
      const result = agentContext
        ? ((await handleAgentContextAction(body, rawChatId)) ??
          (isChatFreeAction(action) ? await handleChatFreeAction(body) : null))
        : await handleChatFreeAction(body);
      if (result) {
        logDebug("gateway", `${action} ${where} ${Date.now() - t0}ms`);
        return result;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("gateway", `${action} (${where}) failed: ${msg}`);
      return { ok: false, error: `${action}: ${msg}` };
    }
    return null;
  }

  /**
   * Run one bridge action inside the log scope of the turn that issued it
   * (the MCP subprocess reaches us over HTTP, a fresh async root), so the
   * action's own lines carry `turn=<id>`, and close it with one
   * `tool.action` summary line — debug on success, info with the error
   * text when the action answered `ok:false`.
   */
  private handleAction(body: Record<string, unknown>): Promise<unknown> {
    const rawChatId = body._chatId ? String(body._chatId) : "";
    const numericId = Number(rawChatId);
    const chatKeys = [
      rawChatId,
      rawChatId !== "" && !isNaN(numericId)
        ? this.loom.stringIdForNumeric(numericId)
        : null,
    ];
    return runInChatTurnScope(chatKeys, async () => {
      const t0 = Date.now();
      const result = await this.routeAction(body);
      logActionOutcome(body, rawChatId, Date.now() - t0, result);
      return result;
    });
  }

  private async routeAction(body: Record<string, unknown>): Promise<unknown> {
    // Route by _chatId from the MCP subprocess request.
    // _chatId may be a string (Teams: "teams_chat_19:...") or numeric string
    // (Telegram: "123456"). The context map is keyed by numeric chatId, so
    // try direct parse first, then fall back to searching active contexts.
    //
    // For heartbeat-initiated outbound (no active chat session), the bridge
    // promotes the tool's explicit `chat_id` param into `_chatId` AND keeps
    // `chat_id` in the body as a signal that this is explicit-routing. When
    // `body.chat_id` is present and parses as numeric, we skip the
    // active-context-required check — the action handler will reach the
    // chat directly via the Telegram Bot API. The legacy context-required
    // path remains for chat-mode calls where `chat_id` is absent.
    // Actions that need no chat at all (the device mesh, and a sub-agent's
    // own tool family) short-circuit routing — see `dispatchWithoutChat`.
    const rawChatId = body._chatId ? String(body._chatId) : "";
    const unrouted = await this.dispatchWithoutChat(body, rawChatId);
    if (unrouted) return unrouted;

    const numericId = Number(rawChatId);
    const explicitChatIdProvided = typeof body.chat_id !== "undefined";
    let chatId: number | null = null;
    if (
      explicitChatIdProvided &&
      !isNaN(numericId) &&
      rawChatId !== "" &&
      rawChatId !== "heartbeat"
    ) {
      // Explicit-routing branch: caller provided chat_id, trust it.
      chatId = numericId;
    } else if (
      rawChatId !== "" &&
      !isNaN(numericId) &&
      this.loom.hasActiveContext(numericId)
    ) {
      // Chat-mode branch: ambient _chatId must match an active context.
      chatId = numericId;
    } else {
      // String-id routing (Teams) — must match an active context.
      chatId = this.findContextByStringId(rawChatId);
    }
    if (chatId === null) {
      return { ok: false, error: "No active chat context" };
    }

    const action = typeof body.action === "string" ? body.action : "";
    if (!action) return { ok: false, error: "Missing action" };
    const t0 = Date.now();
    // The canonical string id for this chat. The bridge only carries the
    // numeric id, but the turn's Thread is keyed by the dispatcher's string
    // chatId — hand that to the handlers so a `d_…`/`wa_…` chat's cron jobs,
    // triggers and history land under the id the rest of the engine uses.
    const chatKey = this.loom.stringIdForNumeric(chatId) ?? String(chatId);

    try {
      // Try frontend first — it has richer implementations (e.g. userbot history)
      // and falls back to null when it can't handle the action.
      const frontendHandler = this.resolveFrontendHandler(rawChatId, chatId);
      if (frontendHandler) {
        const result = await frontendHandler(body, chatId);
        if (result) {
          logDebug("gateway", `${action} chat=${chatId} ${Date.now() - t0}ms`);
          return result;
        }
      }

      // Try plugin actions (loaded from external plugin packages)
      const pluginResult = await handlePluginAction(body, chatKey);
      if (pluginResult) {
        logDebug(
          "gateway",
          `${action} chat=${chatId} ${Date.now() - t0}ms (plugin)`,
        );
        return pluginResult;
      }

      // Shared actions last — provides in-memory fallbacks for history, cron, etc.
      const shared = await handleSharedAction(
        body,
        chatId,
        this.backend,
        chatKey,
      );
      if (shared) {
        logDebug(
          "gateway",
          `${action} chat=${chatId} ${Date.now() - t0}ms (shared)`,
        );
        return shared;
      }

      return { ok: false, error: `Unknown action: ${action}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("gateway", `${action} chat=${chatId} failed: ${msg}`);
      return { ok: false, error: `${action}: ${msg}` };
    }
  }

  // ── HTTP server ──────────────────────────────────────────────────────────

  /**
   * Bind the action gateway's HTTP server, returning the bound port.
   *
   * Single-flight: every frontend calls this from its own `start()`, and
   * `app.ts` starts the non-stdin frontends concurrently with `Promise.all`,
   * so two or more callers routinely land here at once. All of them await the
   * same bind and get the same port; the FIRST caller's requested port is the
   * one attempted (later callers' `port` arguments are ignored), and
   * `onStarted` listeners fire exactly once. Without this, each caller built
   * its own `http.Server` and `listenWithRetry` walked them onto consecutive
   * ports — one process listening on :19876 AND :19877, `/health` and the
   * pidfile disagreeing about which, and `stop()` leaking the other listener.
   *
   * A failed bind clears the in-flight state, so a later `start()` retries;
   * so does `stop()`, so start-after-stop binds afresh.
   */
  async start(port = 19876): Promise<number> {
    if (this.server) return this.port;
    if (this.starting) return this.starting;
    const attempt = this.bind(port);
    this.starting = attempt;
    try {
      return await attempt;
    } finally {
      // Only clear our own attempt — never a newer one started after a
      // stop() that raced this bind.
      if (this.starting === attempt) this.starting = null;
    }
  }

  /** The actual bind. Always called through `start()`'s single-flight guard. */
  private async bind(port: number): Promise<number> {
    const token = gatewayToken();
    const host: GatewayRouteHost = {
      port: () => this.port,
      token: () => token,
      healthSnapshot: (full) => this.healthSnapshot(full),
      requestShutdown: () => {
        const handler = this.shutdownHandler;
        if (!handler) return false;
        setImmediate(() => handler("gateway /shutdown"));
        return true;
      },
      reloadPlugins: async () => {
        const { performPluginReload } =
          await import("./gateway-actions/plugins.js");
        return (await performPluginReload(this.backend)).names;
      },
      hubOrigin: () => `http://127.0.0.1:${this.port}`,
      handleAction: (body) => this.handleAction(body),
    };
    const httpServer = createServer(
      (req, res) => void dispatchGatewayRoute(req, res, host),
    );
    const bound = await listenWithRetry(httpServer, port);
    this.server = httpServer;
    this.port = bound;
    log("gateway", `Action gateway on :${this.port}`);
    for (const cb of this.startedListeners.splice(0)) {
      try {
        cb(this.port);
      } catch (err) {
        logError("gateway", "onStarted listener failed", err);
      }
    }
    return this.port;
  }

  /**
   * The /health body. Identity fields first — daemon discovery matches on
   * them to tell a Talon daemon from chat sessions and unrelated localhost
   * services — then, for an authenticated caller only, live counters.
   */
  private healthSnapshot(full: boolean): Record<string, unknown> {
    const w = getHealthStatus();
    const identity = {
      app: "talon",
      mode: this.mode,
      pid: process.pid,
      port: this.port,
      startedAt: this.startedAt,
      ok: w.healthy,
    };
    if (!full) return identity;
    return {
      ...identity,
      uptime: Math.round(process.uptime()),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      bridge: {
        activeChats: this.loom.activeContextCount(),
        threads: this.loom.size(),
        hubSessions: getHubSessionCount(),
      },
      queue: getActiveCount(),
      sessions: getActiveSessionCount(),
      messages: w.totalMessagesProcessed,
      errors: w.recentErrorCount,
      lastActivity:
        w.msSinceLastMessage < 60000
          ? "just now"
          : `${Math.round(w.msSinceLastMessage / 60000)}m ago`,
      alerts: activeAlerts(),
    };
  }

  async stop(): Promise<void> {
    // A start() racing this stop() would otherwise hand us back a bound
    // server with nothing left to close it. Let it finish first.
    if (this.starting) {
      try {
        await this.starting;
      } catch {
        // The bind failed — nothing was left listening.
      }
    }
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      const server = this.server;
      const settle = (): void => {
        this.server = null;
        this.starting = null;
        this.port = 0;
        resolve();
      };
      // Bun's closeAllConnections() (≤1.3.x) doesn't sever live SSE
      // streams, so close()'s callback can never fire there and stop()
      // would hang shutdown (and every test teardown). Resolve on a
      // deadline either way: by then no new connections are accepted,
      // and the process this runs in is exiting anyway.
      const deadline = setTimeout(settle, 2_000);
      deadline.unref?.();
      server.close(() => {
        clearTimeout(deadline);
        settle();
      });
      // `close()` only stops NEW connections; MCP hub sessions hold
      // long-lived SSE streams that would keep the close callback from
      // ever firing. Terminate them — everything on this server is
      // localhost request/response or SSE, safe to drop at stop time.
      server.closeAllConnections();
    });
  }
}
