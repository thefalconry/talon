/**
 * Chat lifecycle — create, rename and delete, each broadcast so every open
 * client list updates in place.
 */

import { toClientChat } from "./chat-wire.js";
import type { ClientChat } from "../protocol.js";
import type { NativeRuntime } from "../runtime.js";

export function createChat(runtime: NativeRuntime, title?: string): ClientChat {
  const entry = runtime.chats.create(title);
  const chat = toClientChat(runtime, entry);
  runtime.broadcast({ kind: "chat_created", chat });
  return chat;
}

export function renameChat(
  runtime: NativeRuntime,
  chatId: string,
  title: string,
): ClientChat | null {
  const entry = runtime.chats.rename(chatId, title);
  if (!entry) return null;
  const chat = toClientChat(runtime, entry);
  runtime.broadcast({ kind: "chat_updated", chat });
  return chat;
}

/**
 * Soft delete (see NativeChats.remove): the chat disappears from every
 * client, but its history rows and their turn meta are kept for the
 * operator — `talon history purge` is the only hard delete.
 */
export function deleteChat(runtime: NativeRuntime, chatId: string): boolean {
  const ok = runtime.chats.remove(chatId);
  if (ok) {
    runtime.contextByChat.delete(chatId);
    runtime.queuedByChat.delete(chatId);
    runtime.broadcast({ kind: "chat_deleted", chatId });
  }
  return ok;
}
