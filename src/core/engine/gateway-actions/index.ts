/**
 * Shared gateway actions — platform-agnostic handlers that work with any
 * frontend.
 *
 * Each domain module exports a `SharedActionHandlers` map keyed by action
 * name; they're merged into one registry here. `handleSharedAction` looks the
 * action up and returns null when it isn't recognized, so the gateway
 * delegates to the frontend.
 *
 *   - `history`   — in-memory history queries (read/search/users/media)
 *   - `fetch-url` — fetch a URL (text extraction or binary download)
 *   - `cron`      — scheduled-job CRUD
 *   - `triggers`  — long-running watcher-script CRUD
 *   - `agents`    — sub-agent spawn / inspect / message, and the agent-side
 *                   report / inbox tools
 *   - `goals`     — persistent multi-turn objectives
 *   - `memory`    — remember / recall / forget over the typed memory store
 *   - `scripts`   — reusable agent-authored scripts
 *   - `skills`    — markdown workflows
 *   - `plugins`   — plugin hot-reload
 *   - `models`    — model / backend discovery
 *   - `mesh`      — companion device mesh (presence + location)
 *   - `cross-send` — explicit-target sends through any enabled frontend
 *   - `backup`    — snapshots and checkpoints (chat-free; no restore)
 *   - `secrets`   — secret-drop links (core/secrets; needs the chat)
 */

import type { ActionResult } from "../../types.js";
import type { Backend } from "../../agent-runtime/capabilities.js";
import type { SharedActionHandlers } from "./types.js";
import { historyHandlers } from "./history.js";
import { fetchUrlHandlers } from "./fetch-url/index.js";
import { cronHandlers } from "./cron.js";
import { triggerHandlers } from "./triggers.js";
import { agentContextActions, agentHandlers } from "./agents/index.js";
import { goalHandlers } from "./goals.js";
import { memoryHandlers } from "./memory.js";
import { scriptHandlers } from "./scripts.js";
import { skillHandlers } from "./skills.js";
import { pluginHandlers } from "./plugins.js";
import { modelHandlers } from "./models.js";
import {
  meshHandlers,
  chatFreeActions as meshChatFreeActions,
} from "./mesh.js";
import { crossSendHandlers, crossSendChatFreeActions } from "./cross-send.js";
import {
  whatsappAccountHandlers,
  whatsappAccountChatFreeActions,
} from "./whatsapp-account.js";
import { nativeActionRefusal, nativeHandlers } from "./native/index.js";
import { backupChatFreeActions, backupHandlers } from "./backup/index.js";
import { secretHandlers } from "../../secrets/actions.js";
import { attachInboxNotice } from "./agents/inbox-notice.js";

// Null-prototype so a request `action` of "toString" / "constructor" / etc.
// can't resolve an inherited Object.prototype method — `handlers[action]` only
// ever finds an own handler key (the original switch had no such hazard).
const handlers: SharedActionHandlers = Object.assign(Object.create(null), {
  ...historyHandlers,
  ...fetchUrlHandlers,
  ...cronHandlers,
  ...triggerHandlers,
  ...agentHandlers,
  ...goalHandlers,
  ...memoryHandlers,
  ...scriptHandlers,
  ...skillHandlers,
  ...pluginHandlers,
  ...modelHandlers,
  ...meshHandlers,
  ...crossSendHandlers,
  ...whatsappAccountHandlers,
  ...nativeHandlers,
  ...backupHandlers,
  ...secretHandlers,
});

/**
 * All chat-free actions — each domain module declares its own set, merged
 * here into the one view the gateway (and `isChatFreeAction`) consults.
 */
const chatFreeActions: ReadonlySet<string> = new Set([
  ...meshChatFreeActions,
  ...crossSendChatFreeActions,
  ...whatsappAccountChatFreeActions,
  ...backupChatFreeActions,
]);

/**
 * `chatKey` is the chat's canonical string id (see `SharedActionHandler`).
 * It defaults to `String(chatId)`, which is exact for Telegram and for the
 * numeric-only callers (tests, chat-free dispatch); the gateway passes the
 * real string id it holds for the active turn.
 */
export async function handleSharedAction(
  body: Record<string, unknown>,
  chatId: number,
  backend?: Backend | null,
  chatKey: string = String(chatId),
): Promise<ActionResult | null> {
  const action = body.action as string;
  const handler = handlers[action];
  if (!handler) return null; // not a shared action — delegate to frontend
  const refusal = nativeActionRefusal(action);
  if (refusal) return refusal;
  const result = await handler(body, chatId, backend, chatKey);
  return result ? attachInboxNotice(result, chatKey) : null;
}

/**
 * True when the action needs no chat context at all (see `chatFreeActions`).
 * The gateway checks this before resolving a chat so mesh tools stay reachable
 * from heartbeat/background runs.
 */
export function isChatFreeAction(action: string): boolean {
  return chatFreeActions.has(action);
}

/**
 * True when the action belongs to the sub-agent family, i.e. the gateway may
 * dispatch it for an `agent:<id>` chat key (which has an identity but no
 * chat). Anything else stays chat-routed.
 */
export function isAgentContextAction(action: string): boolean {
  return agentContextActions.has(action);
}

/**
 * Dispatch a sub-agent action on behalf of a running agent. `contextKey` is
 * the agent's `agent:<id>` label, handed through as the `chatKey` so the
 * handlers can identify the caller; `0` is the explicit "no chat" chatId,
 * same sentinel the chat-free path uses.
 */
export async function handleAgentContextAction(
  body: Record<string, unknown>,
  contextKey: string,
): Promise<ActionResult | null> {
  const action = body.action as string;
  if (!isAgentContextAction(action)) return null;
  const handler = handlers[action];
  if (!handler) return null;
  const result = await handler(body, 0, undefined, contextKey);
  return result ? attachInboxNotice(result, contextKey) : null;
}

/**
 * Dispatch a chat-free action. The handler signature still takes a chatId
 * (they all share one type); chat-free handlers ignore it, and `0` is passed
 * as an explicit "no chat" sentinel rather than a real id.
 */
export async function handleChatFreeAction(
  body: Record<string, unknown>,
): Promise<ActionResult | null> {
  const action = body.action as string;
  if (!isChatFreeAction(action)) return null;
  const handler = handlers[action];
  if (!handler) return null;
  return handler(body, 0, undefined, "0");
}
