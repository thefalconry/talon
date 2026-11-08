/**
 * Context-window readout — compute a chat's fill from its session usage,
 * cache it on the runtime, and push changes to clients.
 */

import { getSessionInfo } from "../../../storage/sessions.js";
import { buildContextDisplay } from "../../presentation/status-context.js";
import { resolveActiveModelForChat } from "../../../core/models/active-model.js";
import {
  getBackendForChat,
  getBackendIdForChat,
} from "../../../core/engine/backend-controller/index.js";
import { broadcastChatUpdated } from "../chats/chat-wire.js";
import type { ChatEntry } from "../chats/chats.js";
import type { ContextInfo } from "../protocol.js";
import type { NativeRuntime } from "../runtime.js";

type ContextOptions = { resolveModel?: boolean };

/**
 * Compute the current context-window fill for a chat from its session
 * usage, reusing the same `buildContextDisplay` the terminal/Discord
 * `/status` line uses. When the session's usage doesn't carry a window
 * size yet (fresh session), fall back to the resolved model's window so
 * the readout still lands. Returns undefined when nothing is known — the
 * clients hide the indicator rather than render a bogus 0%.
 */
async function computeContext(
  runtime: NativeRuntime,
  chatId: string,
  options?: ContextOptions,
): Promise<ContextInfo | undefined> {
  try {
    const info = getSessionInfo(chatId);
    const u = info.usage;
    let ctxMax = u.contextWindow;
    // The model fallback touches the backend pool, which is fine for one
    // chat the user just opened and wrong for every chat at boot — the
    // startup warm asks for the cheap path and lets anything it can't
    // resolve fill in when that chat is next opened.
    if (!ctxMax && options?.resolveModel !== false) {
      try {
        const backend = getBackendForChat(chatId);
        const backendId = getBackendIdForChat(chatId);
        const { ref } = await resolveActiveModelForChat(
          chatId,
          backend,
          backendId,
          runtime.config,
        );
        if (ref?.contextWindow) ctxMax = ref.contextWindow;
      } catch {
        /* backend pool not ready — leave max unknown */
      }
    }
    const ctx = buildContextDisplay({
      contextTokens: u.contextTokens,
      lastPromptTokens: u.lastPromptTokens,
      contextWindow: ctxMax,
    });
    if (!ctx.known && ctx.max === 0) return undefined;
    return {
      known: ctx.known,
      used: ctx.used,
      max: ctx.max,
      pct: ctx.pct,
      warn: ctx.warn,
    };
  } catch {
    return undefined;
  }
}

/** Recompute a chat's context fill and, if it changed, push it to clients. */
export async function refreshContext(
  runtime: NativeRuntime,
  entry: ChatEntry,
  options?: ContextOptions,
): Promise<void> {
  const next = await computeContext(runtime, entry.id, options);
  if (!next) return;
  const prev = runtime.contextByChat.get(entry.id);
  if (prev && prev.used === next.used && prev.max === next.max) return;
  runtime.contextByChat.set(entry.id, next);
  broadcastChatUpdated(runtime, entry);
}

/**
 * Fill the context cache for chats restored at startup.
 *
 * The readout is served from an in-memory map otherwise written only at
 * turn end, so after a restart every chat would show no context until its
 * next turn, though the numbers are persisted with the session. This
 * re-reads them for the most recently active chats (bounded, and on the
 * cheap path that never touches the backend pool); anything it skips or
 * can't resolve is filled in the moment the chat is opened.
 */
const CONTEXT_WARM_LIMIT = 40;

export async function warmContextCache(runtime: NativeRuntime): Promise<void> {
  for (const entry of runtime.chats.list().slice(0, CONTEXT_WARM_LIMIT)) {
    await refreshContext(runtime, entry, { resolveModel: false });
  }
}
