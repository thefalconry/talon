/**
 * Chat reset and backend hand-off — what a native chat forgets when its
 * conversation restarts. Neither path deletes chat history: a reset is a
 * soft reset (the context floor moves, the rows stay searchable), and a
 * backend switch leaves history and the transcript exactly as they were.
 */

import { resetSession } from "../../../storage/sessions.js";
import { markContextCleared } from "../../../storage/history.js";
import { resetPulseCheckpoint } from "../../../core/background/pulse/pulse.js";
import { getBackendForChat } from "../../../core/engine/backend-controller/index.js";
import { broadcastChatUpdated } from "./chat-wire.js";
import { emitSystem } from "../turn/emit.js";
import type { NativeRuntime } from "../runtime.js";

/** Drop the per-process state tied to the chat's backend session. */
function dropSessionState(
  runtime: NativeRuntime,
  chatId: string,
  reason: string,
): void {
  resetSession(chatId, reason);
  runtime.contextByChat.delete(chatId);
  runtime.queuedByChat.delete(chatId);
  resetPulseCheckpoint(chatId);
}

/**
 * A backend switch: session ids aren't portable across backends, so the
 * session goes (its id is archived by resetSession). History, turn meta
 * and the transcript stay — a switch changes who answers, not what was
 * said.
 */
export function handOffChatBackend(
  runtime: NativeRuntime,
  chatId: string,
): void {
  dropSessionState(runtime, chatId, "backend-switch");
}

/**
 * An explicit reset: the session goes and the chat's context starts fresh
 * (a soft reset — every history row and its turn meta is kept, searchable
 * and recoverable; the transcript and the bot's history tools start after
 * the reset point).
 */
function resetChatContext(runtime: NativeRuntime, chatId: string): void {
  dropSessionState(runtime, chatId, "reset");
  markContextCleared(chatId);
}

export function resetChat(runtime: NativeRuntime, chatId: string): boolean {
  const entry = runtime.chats.get(chatId);
  if (!entry) return false;
  // Full reset, matching /reset on the other frontends: session, the
  // chat's context (soft — the app re-fetches a transcript that starts
  // after the reset; nothing is deleted), pulse checkpoint, and any
  // in-process backend memory. Warm the fresh session in the background —
  // the bridge handler is sync.
  resetChatContext(runtime, chatId);
  let backend = null;
  try {
    backend = getBackendForChat(chatId);
  } catch {
    // No pool binding — nothing to wipe or warm.
  }
  backend?.sessions?.resetChat?.(chatId);
  void backend?.sessions?.warmSession?.(chatId)?.catch(() => {});
  emitSystem(runtime, entry, "Session reset — starting a fresh conversation.");
  broadcastChatUpdated(runtime, entry);
  return true;
}
