/**
 * Empty-chat sweeper.
 *
 * "New chat" creates a real chat on the daemon the instant it's tapped, so
 * opening one and backing out of it leaves an empty row in every client's
 * list forever. The app deletes an untouched chat as soon as you leave it,
 * which covers the normal case immediately; this is the backstop for the
 * ones no client got to clean up — the app was killed, the network dropped,
 * or the chat was created by something that never came back.
 *
 * Deliberately conservative: only chats that never carried a single message
 * (see ChatEntry.used, which a reset does NOT clear), only after an hour,
 * never one with a turn running or a message queued, and never one whose
 * history says otherwise. Deleting via the same path every client uses
 * means the removal is broadcast, so open lists update in place.
 */

import { log, logError } from "../../../util/log.js";
import { getRecentHistory } from "../../../storage/history.js";
import { deleteChat } from "./chat-lifecycle.js";
import type { NativeRuntime } from "../runtime.js";
import { isBusy } from "../turn/turn.js";

const EMPTY_CHAT_MIN_AGE_MS = 60 * 60_000;
const EMPTY_CHAT_SWEEP_INTERVAL_MS = 30 * 60_000;

function sweepEmptyChats(runtime: NativeRuntime): void {
  for (const entry of runtime.chats.unused(EMPTY_CHAT_MIN_AGE_MS)) {
    if (isBusy(runtime, entry.id) || runtime.queuedByChat.has(entry.id))
      continue;
    // Any stored row at all — even from before a reset — means the chat
    // was used; never sweep it.
    if (getRecentHistory(entry.id, 1, { includeCleared: true }).length > 0)
      continue;
    if (deleteChat(runtime, entry.id)) {
      log("native", `Swept empty chat ${entry.id}`);
    }
  }
}

/** Run the sweep on its interval; returns the function that stops it. */
export function startEmptyChatSweep(runtime: NativeRuntime): () => void {
  const timer = setInterval(() => {
    try {
      sweepEmptyChats(runtime);
    } catch (err) {
      logError("native", "Empty-chat sweep failed", err);
    }
  }, EMPTY_CHAT_SWEEP_INTERVAL_MS);
  // Housekeeping must never be the reason the process stays alive.
  timer.unref?.();
  return () => clearInterval(timer);
}
