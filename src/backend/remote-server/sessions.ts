/**
 * Shared session-lifecycle helpers for the remote-server backend family.
 *
 * Owns: `ensureRemoteSession` — resume the stored session id if valid,
 * otherwise create a fresh one with Talon's standard permission ruleset.
 *
 * What's NOT here: prompt dispatch (kilo uses `promptAsync` + SSE; opencode
 * uses sync `prompt`), question-watchdog loops (each backend has its own
 * driver), or the final messages-list walk (different SDK shapes).
 */

import {
  getSession,
  resetSession,
  setSessionId,
} from "../../storage/sessions.js";
import { log, logWarn } from "../../util/log.js";
import { TalonError } from "../../core/errors.js";
import type { RemoteAgentClient, RemotePermissionRule } from "./client.js";
import type { RemoteServerState } from "./state.js";
import {
  TALON_MCP_SERVER_NAME,
  TALON_PLUGIN_MCP_SERVER_NAME,
  getChatMcpServerName,
  getPluginMcpServerPrefix,
} from "./mcp.js";

/**
 * Build the per-session permission ruleset Talon installs on every fresh
 * session.
 *
 * Two jobs:
 *
 *   1. Hide other chats' MCP tools from this session. Upstream exposes
 *      every registered MCP server's tools to every session by default,
 *      so a model in chat A would happily call
 *      `talon-tools-<chatB>_send`. The bridge then routes to chat B,
 *      which fails the gateway's active-context check and returns
 *      "No active chat context". Or in the cross-chat case where chat B
 *      IS active, the model in chat A could leak content into chat B.
 *      Deny pattern blocks both. (Visibility is also blocked at the
 *      prompt layer by `buildToolOverrides`; this rule is defense in depth.)
 *
 *   2. Auto-allow built-in tools (`tool *`, `edit *`, `bash *`) and
 *      workspace paths outside the server process's launch directory so they
 *      don't sit in `permission.asked` waiting for a reply that never
 *      arrives. The permission watchdog is a fallback for new categories;
 *      this rule resolves the known path case without a polling round trip.
 *
 * Rules are evaluated in order; first match wins. (See upstream's
 * `PermissionRule` type — `permission` is the rule category, `pattern`
 * is a glob.)
 */
export function buildPermissionRuleset(chatId: string): RemotePermissionRule[] {
  const ourServerName = getChatMcpServerName(chatId);
  const ourPluginPrefix = getPluginMcpServerPrefix(chatId);
  return [
    { permission: "tool", pattern: `${ourServerName}_*`, action: "allow" },
    {
      permission: "tool",
      pattern: `${TALON_MCP_SERVER_NAME}-*`,
      action: "deny",
    },
    { permission: "tool", pattern: `${ourPluginPrefix}*`, action: "allow" },
    {
      permission: "tool",
      pattern: `${TALON_PLUGIN_MCP_SERVER_NAME}-*`,
      action: "deny",
    },
    { permission: "tool", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "allow" },
  ];
}

/** Pull an HTTP status out of whatever shape the SDK client threw. */
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  const cause = e.cause as Record<string, unknown> | undefined;
  const response = e.response as Record<string, unknown> | undefined;
  for (const candidate of [
    e.status,
    e.statusCode,
    response?.status,
    cause?.status,
  ]) {
    if (typeof candidate === "number") return candidate;
  }
  return undefined;
}

/** The error's `name`, from the thrown object or the parsed body behind it. */
function errorNames(err: unknown): string[] {
  if (typeof err !== "object" || err === null) return [];
  const e = err as Record<string, unknown>;
  const cause = e.cause as Record<string, unknown> | undefined;
  const body = (cause?.body ?? e.body) as Record<string, unknown> | undefined;
  return [e.name, body?.name, (e.data as Record<string, unknown>)?.name].filter(
    (name): name is string => typeof name === "string",
  );
}

/**
 * True only when the server definitely says the session does not exist:
 * an HTTP 404, or the server's `NotFoundError`. Everything else — a
 * refused connection while the server is still starting, a 5xx, a
 * timeout, a body that would not parse — is not proof the session is
 * gone, and must not cost the chat its session.
 */
export function isRemoteSessionNotFound(err: unknown): boolean {
  if (errorStatus(err) === 404) return true;
  return errorNames(err).includes("NotFoundError");
}

/** Waits between `session.get` attempts on a transient failure. */
const RESUME_RETRY_DELAYS_MS: readonly number[] = [500, 1_500];

/**
 * Ensure a session exists for this chat on the remote agent server.
 *
 * Resumes the stored session id if `session.get` confirms it's still
 * alive. Only a definite not-found (see {@link isRemoteSessionNotFound})
 * resets the chat — archiving the old id — and creates a fresh session
 * with Talon's standard permission ruleset (see
 * {@link buildPermissionRuleset}). Any other failure is retried a couple
 * of times and then fails the turn with the session left in place: a
 * server that is still starting after an update must not wipe every
 * chat's session mapping.
 */
export async function ensureRemoteSession<TClient extends RemoteAgentClient>(
  client: TClient,
  state: RemoteServerState<TClient>,
  chatId: string,
  retryDelaysMs: readonly number[] = RESUME_RETRY_DELAYS_MS,
): Promise<string> {
  const session = getSession(chatId);

  if (session.sessionId) {
    const sessionId = session.sessionId;
    for (let attempt = 0; ; attempt++) {
      try {
        await client.session.get({ sessionID: sessionId });
        return sessionId;
      } catch (err) {
        if (isRemoteSessionNotFound(err)) {
          logWarn(
            "agent",
            `[${chatId}] ${state.label} session ${sessionId} not found on the server, creating new`,
          );
          resetSession(chatId, "remote_session_not_found");
          break;
        }
        const delay = retryDelaysMs[attempt];
        const detail = err instanceof Error ? err.message : String(err);
        if (delay === undefined) {
          throw new TalonError(
            `Could not check ${state.label} session ${sessionId} (${detail}); ` +
              `kept it — try again once the server is up`,
            { reason: "network", retryable: true, cause: err },
          );
        }
        logWarn(
          "agent",
          `[${chatId}] ${state.label} session check failed (${detail}); ` +
            `retrying in ${delay}ms, session kept`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  const permission = buildPermissionRuleset(chatId);
  const resp = await client.session.create({
    title: `Chat ${chatId}`,
    permission,
  });
  const data = resp.data as Record<string, unknown> | undefined;
  const newId = (data?.id as string) ?? String(Date.now());
  setSessionId(chatId, newId);
  log(
    "agent",
    `[${chatId}] Created ${state.label} session: ${newId} ` +
      `(scoped to ${getChatMcpServerName(chatId)}_*)`,
  );

  return newId;
}

/**
 * The per-turn setup a warm-up front-loads. Both remote-server backends
 * expose these under identical signatures; the shape lets the helper stay
 * backend-agnostic without importing either SDK.
 */
export interface RemoteWarmDeps<TClient extends RemoteAgentClient> {
  ensureServer(): Promise<TClient>;
  ensureSession(client: TClient, chatId: string): Promise<string>;
  ensureChatMcpServer(client: TClient, chatId: string): Promise<string>;
  ensurePluginMcpServers(client: TClient, chatId: string): Promise<string[]>;
}

/**
 * Pre-pay a chat's cold start: spawn the server if it isn't up, create (or
 * resume) the session, and register the chat + plugin MCP servers.
 *
 * This is the remote-server analogue of the Claude backend's `warmSession`,
 * and closes the last `sessions` capability gap between the two families.
 * `performSessionReset` and the native frontend call it right after a reset,
 * so the first turn on a fresh session doesn't serially pay session creation
 * plus a full plugin-MCP registration sweep — the dominant cold-start cost
 * here, since each plugin server is a separate connect.
 *
 * Best-effort by contract: `/reset` has already succeeded by the time this
 * runs, and the same work is idempotent and repeated at the head of every
 * turn. A failure must degrade to a slow first turn, never surface as a
 * failed reset — so everything is caught and logged, not rethrown.
 */
export async function warmRemoteSession<TClient extends RemoteAgentClient>(
  state: RemoteServerState<TClient>,
  chatId: string,
  deps: RemoteWarmDeps<TClient>,
): Promise<void> {
  try {
    const client = await deps.ensureServer();
    await deps.ensureSession(client, chatId);
    await deps.ensureChatMcpServer(client, chatId);
    await deps.ensurePluginMcpServers(client, chatId);
    log("agent", `[${chatId}] Warmed ${state.label} session`);
  } catch (err) {
    logWarn(
      "agent",
      `[${chatId}] ${state.label} warm-up skipped (first turn pays cold start): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
