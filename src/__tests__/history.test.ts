import { describe, it, expect } from "vitest";
import {
  pushMessage,
  getRecentHistory,
  searchHistory,
  getMessagesByUser,
  getKnownUsers,
  getRecentBySenderId,
  getLatestMessageId,
  getRecentFormatted,
  getMessageById,
  getHistoryStats,
  purgeChatHistory,
  setMessageFilePath,
  type HistoryMessage,
} from "../storage/history.js";

function makeMsg(
  overrides: Partial<HistoryMessage> & { msgId: number },
): HistoryMessage {
  return {
    senderId: 1,
    senderName: "TestUser",
    text: `Message ${overrides.msgId}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("history", () => {
  const chatId = () => `test-${Math.random().toString(36).slice(2)}`;

  describe("pushMessage", () => {
    it("adds a message to the history buffer", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1 }));
      const history = getRecentHistory(id);
      expect(history).toHaveLength(1);
      expect(history[0].msgId).toBe(1);
    });

    it("adds multiple messages in order", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1 }));
      pushMessage(id, makeMsg({ msgId: 2 }));
      pushMessage(id, makeMsg({ msgId: 3 }));
      const history = getRecentHistory(id, 100);
      expect(history).toHaveLength(3);
      expect(history[0].msgId).toBe(1);
      expect(history[2].msgId).toBe(3);
    });

    it("retains messages past the legacy 500-message cap", () => {
      const id = chatId();
      for (let i = 0; i < 550; i++) {
        pushMessage(id, makeMsg({ msgId: i }));
      }
      const history = getRecentHistory(id, 1000);
      expect(history).toHaveLength(550);
      expect(history[0].msgId).toBe(0);
      expect(history[549].msgId).toBe(549);
    });

    it("preserves all optional fields on the message", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderName: "Alice",
          text: "photo msg",
          replyToMsgId: 99,
          mediaType: "photo",
          stickerFileId: "stk123",
          filePath: "/tmp/photo.jpg",
        }),
      );
      const history = getRecentHistory(id);
      expect(history[0].replyToMsgId).toBe(99);
      expect(history[0].mediaType).toBe("photo");
      expect(history[0].stickerFileId).toBe("stk123");
      expect(history[0].filePath).toBe("/tmp/photo.jpg");
    });
  });

  describe("getRecentHistory", () => {
    it("returns empty array for unknown chat", () => {
      expect(getRecentHistory("nonexistent-chat")).toEqual([]);
    });

    it("respects the limit parameter", () => {
      const id = chatId();
      for (let i = 0; i < 20; i++) {
        pushMessage(id, makeMsg({ msgId: i }));
      }
      const history = getRecentHistory(id, 5);
      expect(history).toHaveLength(5);
      // Should return the 5 most recent
      expect(history[0].msgId).toBe(15);
      expect(history[4].msgId).toBe(19);
    });

    it("defaults to 50 messages", () => {
      const id = chatId();
      for (let i = 0; i < 100; i++) {
        pushMessage(id, makeMsg({ msgId: i }));
      }
      const history = getRecentHistory(id);
      expect(history).toHaveLength(50);
    });
  });

  describe("setMessageFilePath", () => {
    it("updates filePath on an existing message", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 10, text: "photo" }));
      setMessageFilePath(id, 10, "/tmp/downloaded.jpg");
      const history = getRecentHistory(id);
      expect(history[0].filePath).toBe("/tmp/downloaded.jpg");
    });

    it("is a no-op for nonexistent chat", () => {
      // Should not throw
      expect(() =>
        setMessageFilePath("no-such-chat", 1, "/tmp/x.jpg"),
      ).not.toThrow();
    });

    it("is a no-op for nonexistent message", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1 }));
      setMessageFilePath(id, 999, "/tmp/x.jpg");
      const history = getRecentHistory(id);
      expect(history[0].filePath).toBeUndefined();
    });
  });

  describe("searchHistory", () => {
    it("finds messages matching text (case-insensitive)", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1, text: "Hello world" }));
      pushMessage(id, makeMsg({ msgId: 2, text: "Goodbye world" }));
      pushMessage(id, makeMsg({ msgId: 3, text: "Something else" }));

      const result = searchHistory(id, "world");
      expect(result).toContain("Hello world");
      expect(result).toContain("Goodbye world");
      expect(result).not.toContain("Something else");
    });

    it("finds messages matching sender name", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1, senderName: "Alice", text: "hi" }));
      pushMessage(id, makeMsg({ msgId: 2, senderName: "Bob", text: "hello" }));

      const result = searchHistory(id, "alice");
      expect(result).toContain("Alice");
      expect(result).not.toContain("Bob");
    });

    it("returns 'No messages' for empty history", () => {
      const result = searchHistory("empty-chat", "test");
      expect(result).toContain("No messages in history");
    });

    it("returns 'No messages matching' when no results", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1, text: "hello" }));
      const result = searchHistory(id, "xyzzy");
      expect(result).toContain("No messages matching");
    });

    it("respects the limit parameter", () => {
      const id = chatId();
      for (let i = 0; i < 10; i++) {
        pushMessage(id, makeMsg({ msgId: i, text: `match ${i}` }));
      }
      // All 10 messages match "match", but limit to 3
      const result = searchHistory(id, "match", 3);
      // Should contain only the 3 most recent matches
      const lines = result.split("\n");
      expect(lines).toHaveLength(3);
      expect(result).toContain("match 9");
      expect(result).toContain("match 7");
    });
  });

  describe("getMessagesByUser", () => {
    it("filters messages by user name (case-insensitive)", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({ msgId: 1, senderName: "Alice", text: "msg from alice" }),
      );
      pushMessage(
        id,
        makeMsg({ msgId: 2, senderName: "Bob", text: "msg from bob" }),
      );
      pushMessage(
        id,
        makeMsg({ msgId: 3, senderName: "Alice", text: "another from alice" }),
      );

      const result = getMessagesByUser(id, "alice");
      expect(result).toContain("msg from alice");
      expect(result).toContain("another from alice");
      expect(result).not.toContain("msg from bob");
    });

    it("returns 'No messages from' when user not found", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1, senderName: "Alice", text: "hi" }));
      const result = getMessagesByUser(id, "Charlie");
      expect(result).toContain('No messages from "Charlie"');
    });

    it("returns 'No messages in history' for empty chat", () => {
      const result = getMessagesByUser("empty-chat-users", "anyone");
      expect(result).toContain("No messages in history");
    });

    it("respects the limit parameter", () => {
      const id = chatId();
      for (let i = 0; i < 10; i++) {
        pushMessage(
          id,
          makeMsg({ msgId: i, senderName: "Alice", text: `msg ${i}` }),
        );
      }
      const result = getMessagesByUser(id, "Alice", 3);
      const lines = result.split("\n");
      expect(lines).toHaveLength(3);
    });
  });

  describe("purgeChatHistory", () => {
    it("empties the history buffer for a chat", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1 }));
      pushMessage(id, makeMsg({ msgId: 2 }));
      expect(getRecentHistory(id)).toHaveLength(2);

      purgeChatHistory(id);
      expect(getRecentHistory(id)).toEqual([]);
    });

    it("does not affect other chats", () => {
      const id1 = chatId();
      const id2 = chatId();
      pushMessage(id1, makeMsg({ msgId: 1 }));
      pushMessage(id2, makeMsg({ msgId: 2 }));

      purgeChatHistory(id1);
      expect(getRecentHistory(id1)).toEqual([]);
      expect(getRecentHistory(id2)).toHaveLength(1);
    });

    it("subsequent operations on cleared chat work correctly", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1 }));
      purgeChatHistory(id);

      // Search returns "No messages"
      expect(searchHistory(id, "anything")).toContain("No messages in history");
      // getKnownUsers returns "No users"
      expect(getKnownUsers(id)).toContain("No users seen yet.");
      // Can push new messages after clearing
      pushMessage(id, makeMsg({ msgId: 99 }));
      expect(getRecentHistory(id)).toHaveLength(1);
      expect(getRecentHistory(id)[0].msgId).toBe(99);
    });
  });

  describe("getKnownUsers", () => {
    it("returns formatted user list with message counts", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({ msgId: 1, senderId: 100, senderName: "Alice", text: "hi" }),
      );
      pushMessage(
        id,
        makeMsg({ msgId: 2, senderId: 200, senderName: "Bob", text: "hey" }),
      );
      pushMessage(
        id,
        makeMsg({
          msgId: 3,
          senderId: 100,
          senderName: "Alice",
          text: "how are you",
        }),
      );

      const result = getKnownUsers(id);
      expect(result).toContain("Alice");
      expect(result).toContain("Bob");
      expect(result).toContain("user_id: 100");
      expect(result).toContain("user_id: 200");
      expect(result).toContain("2 msgs"); // Alice has 2 messages
      expect(result).toContain("1 msgs"); // Bob has 1 message
    });

    it("returns 'No users seen yet.' for empty chat", () => {
      const result = getKnownUsers("empty-users-chat");
      expect(result).toContain("No users seen yet.");
    });

    it("returns 'No users seen yet.' for nonexistent chat", () => {
      const result = getKnownUsers("nonexistent-chat-xyz");
      expect(result).toContain("No users seen yet.");
    });

    it("shows time ago for users seen minutes ago", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderId: 100,
          senderName: "Alice",
          timestamp: Date.now() - 5 * 60_000, // 5 minutes ago
        }),
      );
      const result = getKnownUsers(id);
      expect(result).toContain("5m ago");
    });

    it("shows time ago for users seen hours ago", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderId: 100,
          senderName: "Alice",
          timestamp: Date.now() - 3 * 3_600_000, // 3 hours ago
        }),
      );
      const result = getKnownUsers(id);
      expect(result).toContain("3h ago");
    });

    it("shows time ago for users seen days ago", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderId: 100,
          senderName: "Alice",
          timestamp: Date.now() - 2 * 86_400_000, // 2 days ago
        }),
      );
      const result = getKnownUsers(id);
      expect(result).toContain("2d ago");
    });

    it("shows 'just now' for users seen less than a minute ago", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderId: 100,
          senderName: "Alice",
          timestamp: Date.now() - 10_000, // 10 seconds ago
        }),
      );
      const result = getKnownUsers(id);
      expect(result).toContain("just now");
    });

    it("sorts users by last seen (most recent first)", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderId: 100,
          senderName: "OldUser",
          timestamp: Date.now() - 86_400_000,
        }),
      );
      pushMessage(
        id,
        makeMsg({
          msgId: 2,
          senderId: 200,
          senderName: "NewUser",
          timestamp: Date.now() - 60_000,
        }),
      );
      const result = getKnownUsers(id);
      const newIdx = result.indexOf("NewUser");
      const oldIdx = result.indexOf("OldUser");
      expect(newIdx).toBeLessThan(oldIdx);
    });

    it("updates user name to the latest seen name", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderId: 100,
          senderName: "OldName",
          timestamp: Date.now() - 60_000,
        }),
      );
      pushMessage(
        id,
        makeMsg({
          msgId: 2,
          senderId: 100,
          senderName: "NewName",
          timestamp: Date.now(),
        }),
      );
      const result = getKnownUsers(id);
      expect(result).toContain("NewName");
      expect(result).not.toContain("OldName");
    });
  });

  describe("getRecentBySenderId", () => {
    it("returns messages from a specific sender", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({ msgId: 1, senderId: 100, senderName: "Alice" }),
      );
      pushMessage(id, makeMsg({ msgId: 2, senderId: 200, senderName: "Bob" }));
      pushMessage(
        id,
        makeMsg({ msgId: 3, senderId: 100, senderName: "Alice" }),
      );
      pushMessage(id, makeMsg({ msgId: 4, senderId: 200, senderName: "Bob" }));

      const result = getRecentBySenderId(id, 100);
      expect(result).toHaveLength(2);
      expect(result[0].msgId).toBe(1);
      expect(result[1].msgId).toBe(3);
    });

    it("returns empty array for unknown sender", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({ msgId: 1, senderId: 100, senderName: "Alice" }),
      );
      const result = getRecentBySenderId(id, 999);
      expect(result).toEqual([]);
    });

    it("respects limit parameter", () => {
      const id = chatId();
      for (let i = 0; i < 10; i++) {
        pushMessage(
          id,
          makeMsg({ msgId: i, senderId: 100, senderName: "Alice" }),
        );
      }
      const result = getRecentBySenderId(id, 100, 3);
      expect(result).toHaveLength(3);
      // Should be the 3 most recent
      expect(result[0].msgId).toBe(7);
      expect(result[2].msgId).toBe(9);
    });

    it("returns empty array for nonexistent chat", () => {
      const result = getRecentBySenderId("nonexistent-sender-chat", 100);
      expect(result).toEqual([]);
    });
  });

  describe("getLatestMessageId", () => {
    it("returns the ID of the most recent message", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 10 }));
      pushMessage(id, makeMsg({ msgId: 20 }));
      pushMessage(id, makeMsg({ msgId: 30 }));

      expect(getLatestMessageId(id)).toBe(30);
    });

    it("returns undefined for empty/nonexistent chat", () => {
      expect(getLatestMessageId("nonexistent-latest")).toBeUndefined();
    });
  });

  describe("getRecentFormatted", () => {
    it("returns formatted message strings", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderName: "Alice",
          text: "Hello there!",
          timestamp: new Date("2025-01-15T10:30:00Z").getTime(),
        }),
      );

      const result = getRecentFormatted(id, 5);
      expect(result).toContain("Alice");
      expect(result).toContain("Hello there!");
      expect(result).toContain("msg:1");
      expect(result).toContain("10:30");
    });

    it("returns 'No messages in history.' for empty chat", () => {
      const result = getRecentFormatted("empty-formatted-chat");
      expect(result).toBe("No messages in history.");
    });

    it("includes media type tags", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderName: "Bob",
          text: "a photo",
          mediaType: "photo",
        }),
      );

      const result = getRecentFormatted(id, 5);
      expect(result).toContain("[photo]");
    });

    it("includes sticker file_id", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderName: "Bob",
          text: "sticker",
          mediaType: "sticker",
          stickerFileId: "CAACAgIAAxk",
        }),
      );

      const result = getRecentFormatted(id, 5);
      expect(result).toContain("sticker_file_id: CAACAgIAAxk");
    });

    it("includes reply tag", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 2,
          senderName: "Alice",
          text: "replying",
          replyToMsgId: 1,
        }),
      );

      const result = getRecentFormatted(id, 5);
      expect(result).toContain("replying to msg:1");
    });

    it("includes file path tag", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderName: "Bob",
          text: "a file",
          filePath: "/tmp/downloaded.pdf",
        }),
      );

      const result = getRecentFormatted(id, 5);
      expect(result).toContain("(file: /tmp/downloaded.pdf)");
    });

    it("formats multiple messages joined by newlines", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({ msgId: 1, text: "first", timestamp: 1000000000000 }),
      );
      pushMessage(
        id,
        makeMsg({ msgId: 2, text: "second", timestamp: 1000000060000 }),
      );
      const result = getRecentFormatted(id, 5);
      const lines = result.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("first");
      expect(lines[1]).toContain("second");
    });

    it("includes all media type variants in tags", () => {
      const id = chatId();
      const types: Array<HistoryMessage["mediaType"]> = [
        "document",
        "voice",
        "video",
        "animation",
      ];
      types.forEach((type, i) => {
        pushMessage(
          id,
          makeMsg({ msgId: i + 1, text: `media ${type}`, mediaType: type }),
        );
      });
      const result = getRecentFormatted(id, 10);
      expect(result).toContain("[document]");
      expect(result).toContain("[voice]");
      expect(result).toContain("[video]");
      expect(result).toContain("[animation]");
    });
  });

  describe("getMessageById", () => {
    it("returns formatted message when found", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({ msgId: 42, senderName: "Alice", text: "specific message" }),
      );
      pushMessage(id, makeMsg({ msgId: 43, senderName: "Bob", text: "other" }));

      const result = getMessageById(id, 42);
      expect(result).toContain("Alice");
      expect(result).toContain("specific message");
      expect(result).toContain("msg:42");
    });

    it("returns 'not found' for missing message", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1 }));
      const result = getMessageById(id, 999);
      expect(result).toContain("Message 999 not found");
    });

    it("returns 'No messages' for empty chat", () => {
      const result = getMessageById("empty-by-id-chat", 1);
      expect(result).toContain("No messages in history");
    });
  });

  describe("getHistoryStats", () => {
    it("returns correct stats", () => {
      const id = chatId();
      const ts1 = Date.now() - 10000;
      const ts2 = Date.now() - 5000;
      pushMessage(id, makeMsg({ msgId: 1, senderId: 100, timestamp: ts1 }));
      pushMessage(id, makeMsg({ msgId: 2, senderId: 200, timestamp: ts2 }));

      const stats = getHistoryStats(id);
      expect(stats.totalMessages).toBe(2);
      expect(stats.uniqueUsers).toBe(2);
      expect(stats.oldestTimestamp).toBe(ts1);
      expect(stats.newestTimestamp).toBe(ts2);
    });

    it("returns zeroes for empty chat", () => {
      const stats = getHistoryStats("nonexistent-stats-chat");
      expect(stats.totalMessages).toBe(0);
      expect(stats.uniqueUsers).toBe(0);
      expect(stats.oldestTimestamp).toBe(0);
      expect(stats.newestTimestamp).toBe(0);
    });
  });

  describe("chat retention", () => {
    // 1001 separate writes, each its own SQLite transaction. On
    // windows-latest that regularly runs past the global 15s testTimeout
    // (observed on CI for #736), so give this one case room.
    it("retains every chat past the legacy MAX_CHAT_COUNT eviction threshold", () => {
      // The JSON buffer evicted ~10% of chats past 1000 to bound process
      // memory; SQLite holds nothing in memory, so all chats survive.
      for (let i = 0; i < 1001; i++) {
        pushMessage(`evict-chat-${i}`, makeMsg({ msgId: 1 }));
      }
      expect(getRecentHistory("evict-chat-1000")).toHaveLength(1);
      for (const i of [0, 1, 50, 99]) {
        expect(getRecentHistory(`evict-chat-${i}`)).toHaveLength(1);
      }
    }, 60_000);
  });
});

describe("sender handles", () => {
  const chatId = () => `handle-${Math.random().toString(36).slice(2)}`;

  it("round-trips the handle through storage", () => {
    const id = chatId();
    pushMessage(
      id,
      makeMsg({ msgId: 1, senderName: "Paweł", senderHandle: "PawiX25" }),
    );
    expect(getRecentHistory(id)[0].senderHandle).toBe("PawiX25");
  });

  it("formats history as `Name (@handle)` so a reader can mention them", () => {
    const id = chatId();
    pushMessage(
      id,
      makeMsg({ msgId: 1, senderName: "Paweł", senderHandle: "PawiX25" }),
    );
    expect(getRecentFormatted(id)).toContain("Paweł (@PawiX25)");
  });

  it("leaves handle-less users exactly as before", () => {
    const id = chatId();
    pushMessage(id, makeMsg({ msgId: 1, senderName: "Anon" }));
    const out = getRecentFormatted(id);
    expect(out).toContain("Anon");
    expect(out).not.toContain("(@");
  });

  it("known users carry the latest non-null handle", () => {
    const id = chatId();
    // First message predates the username being set — the newest row is
    // NOT the one that knows the handle.
    pushMessage(id, makeMsg({ msgId: 1, senderId: 7, senderName: "Risen" }));
    pushMessage(
      id,
      makeMsg({
        msgId: 2,
        senderId: 7,
        senderName: "Risen",
        senderHandle: "RisenID",
      }),
    );
    pushMessage(id, makeMsg({ msgId: 3, senderId: 7, senderName: "Risen" }));
    expect(getKnownUsers(id)).toContain("Risen (@RisenID)");
  });
});
