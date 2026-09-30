/**
 * Native chat registry — the set of conversations the bridge exposes.
 *
 * Each chat maps a string id (`d_…`) to the stable 32-bit numeric id the
 * engine routes on. Chats with a persisted session survive a daemon restart
 * (restored from the session/history stores); brand-new empty chats live only
 * in memory until their first message persists them.
 */

import {
  generateNativeChatId,
  deriveNumericChatId,
  isNativeChatId,
} from "../../../core/frontend-runtime/chat-id.js";
import {
  getAllSessions,
  setSessionName,
  deleteSession,
} from "../../../storage/sessions.js";
import {
  getRecentHistory,
  hideChatHistory,
  isChatHistoryHidden,
} from "../../../storage/history.js";
import { previewOf } from "../protocol.js";

export type ChatEntry = {
  id: string;
  numericId: number;
  title: string;
  createdAt: number;
  lastActive: number;
  preview: string;
  /**
   * False until a message actually lands in this chat (see {@link
   * NativeChats.touch}). "New chat" creates a real chat the moment it's
   * tapped, so a client that opens one and backs out leaves a permanent empty
   * row in every list — this flag is what lets the sweeper tell "never used"
   * apart from "used, then reset" (a reset chat has no history either).
   */
  used: boolean;
};

/** The placeholder title a chat carries until it earns a real one. */
export const DEFAULT_CHAT_TITLE = "New chat";

function defaultTitle(): string {
  return DEFAULT_CHAT_TITLE;
}

export class NativeChats {
  private byId = new Map<string, ChatEntry>();
  private byNum = new Map<number, ChatEntry>();

  /**
   * Re-hydrate chats that have a persisted session (i.e. at least one prior
   * turn). Called once at startup so the sidebar isn't empty after a restart.
   */
  restore(): void {
    for (const { chatId, info } of getAllSessions()) {
      if (!isNativeChatId(chatId)) continue;
      // Deleted by the user: its rows are kept, the chat stays gone.
      if (isChatHistoryHidden(chatId)) continue;
      const recent = getRecentHistory(chatId, 1);
      const entry: ChatEntry = {
        id: chatId,
        numericId: deriveNumericChatId(chatId),
        title: info.sessionName || defaultTitle(),
        createdAt: info.createdAt || Date.now(),
        lastActive: info.lastActive || Date.now(),
        preview: recent.length ? previewOf(recent[recent.length - 1].text) : "",
        // Restored from a persisted session: it has carried a turn, even if a
        // later reset cleared its history.
        used: true,
      };
      this.index(entry);
    }
  }

  create(title?: string): ChatEntry {
    const id = generateNativeChatId();
    const trimmed = title?.trim();
    const entry: ChatEntry = {
      id,
      numericId: deriveNumericChatId(id),
      title: trimmed || defaultTitle(),
      createdAt: Date.now(),
      lastActive: Date.now(),
      preview: "",
      used: false,
    };
    this.index(entry);
    if (trimmed) setSessionName(id, trimmed);
    return entry;
  }

  /** Return an existing chat, or adopt a client-supplied id (deep link / sync). */
  ensure(id: string): ChatEntry {
    const existing = this.byId.get(id);
    if (existing) return existing;
    const entry: ChatEntry = {
      id,
      numericId: deriveNumericChatId(id),
      title: defaultTitle(),
      createdAt: Date.now(),
      lastActive: Date.now(),
      preview: "",
      used: false,
    };
    this.index(entry);
    return entry;
  }

  get(id: string): ChatEntry | undefined {
    return this.byId.get(id);
  }

  byNumeric(numericId: number): ChatEntry | undefined {
    return this.byNum.get(numericId);
  }

  /** Most-recently-active first. */
  list(): ChatEntry[] {
    return [...this.byId.values()].sort((a, b) => b.lastActive - a.lastActive);
  }

  count(): number {
    return this.byId.size;
  }

  rename(id: string, title: string): ChatEntry | undefined {
    const entry = this.byId.get(id);
    if (!entry) return undefined;
    const trimmed = title.trim();
    if (trimmed) {
      entry.title = trimmed;
      setSessionName(id, trimmed);
    }
    return entry;
  }

  /**
   * Delete the chat from the app. A soft delete: the chat leaves every list
   * and its session goes, but its history rows are only hidden, never
   * deleted — the operator can still find them, and only an explicit
   * `talon history purge` removes them for good.
   */
  remove(id: string): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    this.byId.delete(id);
    this.byNum.delete(entry.numericId);
    deleteSession(id);
    hideChatHistory(id);
    return true;
  }

  /** Bump activity + refresh the preview when a message lands. */
  touch(id: string, preview?: string): ChatEntry | undefined {
    const entry = this.byId.get(id);
    if (!entry) return undefined;
    entry.lastActive = Date.now();
    entry.used = true;
    if (preview !== undefined) entry.preview = previewOf(preview);
    return entry;
  }

  /**
   * Chats that were created but never carried a message, and have been that
   * way for at least [minAgeMs] — the "New chat" someone opened and left.
   * Oldest first, so a sweep drops the stalest rows first.
   *
   * Emptiness is judged by {@link ChatEntry.used}, not by history: a chat
   * whose session was reset has no history either, and deleting THAT would
   * throw away a conversation the user deliberately kept.
   */
  unused(minAgeMs: number, now: number = Date.now()): ChatEntry[] {
    return [...this.byId.values()]
      .filter((e) => !e.used && now - e.createdAt >= minAgeMs)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private index(entry: ChatEntry): void {
    this.byId.set(entry.id, entry);
    this.byNum.set(entry.numericId, entry);
  }
}
