/**
 * Chat history is never deleted by normal operation. A reset records a
 * per-chat context floor; the rows stay stored and searchable. A client
 * delete hides the chat. Only purgeChatHistory deletes rows.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  pushMessage,
  getRecentHistory,
  getHistoryBefore,
  getRecentFormatted,
  getFormattedBefore,
  getHistoryStats,
  searchHistory,
  searchHistoryMessages,
  getMessagesByUser,
  getMessageById,
  markContextCleared,
  hideChatHistory,
  isChatHistoryHidden,
  listHiddenChats,
  getChatHistoryState,
  purgeChatHistory,
  type HistoryMessage,
} from "../storage/history.js";
import { SCHEMA } from "../storage/sql/statements.generated.js";

let seq = 0;
const chat = () => `soft-${process.pid}-${++seq}-${Math.random()}`;

function msg(msgId: number, text: string, timestamp: number): HistoryMessage {
  return { msgId, senderId: 7, senderName: "Alice", text, timestamp };
}

/** Two pre-reset messages, a reset, then one post-reset message. */
function seedResetChat(): { id: string; resetAt: number } {
  const id = chat();
  const t0 = Date.now() - 60_000;
  pushMessage(id, msg(1, "old pineapple talk", t0));
  pushMessage(id, msg(2, "old banana talk", t0 + 1_000));
  const resetAt = Date.now() - 30_000;
  markContextCleared(id, resetAt);
  pushMessage(id, msg(3, "new pineapple talk", Date.now()));
  return { id, resetAt };
}

describe("soft reset (markContextCleared)", () => {
  it("context readers start after the reset, rows stay in the table", () => {
    const { id } = seedResetChat();
    expect(getRecentHistory(id, 50).map((m) => m.msgId)).toEqual([3]);
    expect(getHistoryBefore(id, 3, 50)).toEqual([]);
    // Nothing deleted.
    expect(getHistoryStats(id).totalMessages).toBe(3);
    expect(
      getRecentHistory(id, 50, { includeCleared: true }).map((m) => m.msgId),
    ).toEqual([1, 2, 3]);
    expect(
      getHistoryBefore(id, 3, 50, { includeCleared: true }).map((m) => m.msgId),
    ).toEqual([1, 2]);
  });

  it("read_history's view notes that older messages are kept", () => {
    const { id } = seedResetChat();
    const text = getRecentFormatted(id, 20);
    expect(text).toContain("new pineapple talk");
    expect(text).not.toContain("old pineapple talk");
    expect(text).toContain("Context was reset");
    expect(text).toContain("search_history");
    const before = getFormattedBefore(id, 3, 20);
    expect(before).toContain("No messages before that point.");
    expect(before).toContain("Context was reset");
  });

  it("search sees every row and labels the ones from before the reset", () => {
    const { id } = seedResetChat();
    const text = searchHistory(id, "pineapple");
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[before context reset\] .*old pineapple/);
    expect(lines[1]).not.toContain("[before context reset]");
    expect(lines[1]).toContain("new pineapple");
    expect(searchHistoryMessages(id, "banana").map((m) => m.msgId)).toEqual([
      2,
    ]);
    expect(getMessagesByUser(id, "Alice")).toContain("[before context reset]");
    expect(getMessageById(id, 1)).toContain("old pineapple talk");
  });

  it("a second reset moves the floor again", () => {
    const { id } = seedResetChat();
    markContextCleared(id);
    expect(getRecentHistory(id)).toEqual([]);
    pushMessage(id, msg(4, "newest", Date.now() + 1_000));
    expect(getRecentHistory(id).map((m) => m.msgId)).toEqual([4]);
    expect(getHistoryStats(id).totalMessages).toBe(4);
  });

  it("an untouched chat reads exactly as before (no note, no labels)", () => {
    const id = chat();
    pushMessage(id, msg(1, "hello kiwi", Date.now()));
    expect(getRecentFormatted(id)).not.toContain("Context was reset");
    expect(searchHistory(id, "kiwi")).not.toContain("[before context reset]");
    expect(getChatHistoryState(id)).toBeUndefined();
  });

  it("does not affect other chats", () => {
    const { id } = seedResetChat();
    const other = chat();
    pushMessage(other, msg(1, "other", Date.now()));
    markContextCleared(id);
    expect(getRecentHistory(other)).toHaveLength(1);
  });
});

describe("soft delete (hideChatHistory)", () => {
  it("hides the chat and starts its context fresh but keeps every row", () => {
    const id = chat();
    pushMessage(id, msg(1, "keep me", Date.now()));
    expect(isChatHistoryHidden(id)).toBe(false);
    hideChatHistory(id);
    expect(isChatHistoryHidden(id)).toBe(true);
    expect(getRecentHistory(id)).toEqual([]);
    expect(getHistoryStats(id).totalMessages).toBe(1);
    expect(searchHistoryMessages(id, "keep")).toHaveLength(1);
    const hidden = listHiddenChats().find((c) => c.chatId === id);
    expect(hidden?.total).toBe(1);
  });
});

describe("purgeChatHistory — the only hard delete", () => {
  it("deletes rows and the chat's state", () => {
    const { id } = seedResetChat();
    hideChatHistory(id);
    expect(purgeChatHistory(id)).toBe(3);
    expect(getHistoryStats(id).totalMessages).toBe(0);
    expect(getChatHistoryState(id)).toBeUndefined();
    expect(searchHistoryMessages(id, "pineapple")).toEqual([]);
    expect(listHiddenChats().some((c) => c.chatId === id)).toBe(false);
  });
});

describe("history_chat_state migration is additive", () => {
  const dir = mkdtempSync(join(tmpdir(), "talon-history-migrate-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("schema only creates the new table, IF NOT EXISTS", () => {
    const block = SCHEMA.slice(
      SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS history_chat_state"),
    );
    expect(block.startsWith("CREATE TABLE IF NOT EXISTS")).toBe(true);
    expect(SCHEMA).not.toMatch(/DROP\s+TABLE/i);
    expect(SCHEMA).not.toMatch(/DELETE\s+FROM\s+history_messages/i);
  });

  it("applying the schema to a pre-existing database keeps its rows", () => {
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    // The shape history_messages shipped with before this change.
    old.exec(`CREATE TABLE history_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL,
      msg_id INTEGER NOT NULL, sender_id INTEGER NOT NULL,
      sender_name TEXT NOT NULL, sender_handle TEXT, text TEXT NOT NULL,
      reply_to_msg_id INTEGER, timestamp INTEGER NOT NULL, media_type TEXT,
      sticker_file_id TEXT, file_path TEXT, attachments TEXT)`);
    old.exec(
      "INSERT INTO history_messages (chat_id, msg_id, sender_id, sender_name, text, timestamp) VALUES ('c', 1, 1, 'A', 'weeks of history', 1)",
    );
    old.exec(SCHEMA);
    old.exec(SCHEMA); // idempotent: a second open is a no-op
    const rows = old
      .prepare("SELECT COUNT(*) AS n FROM history_messages")
      .get() as { n: number };
    expect(rows.n).toBe(1);
    const state = old
      .prepare("SELECT COUNT(*) AS n FROM history_chat_state")
      .get() as { n: number };
    expect(state.n).toBe(0);
    old.close();
  });
});
