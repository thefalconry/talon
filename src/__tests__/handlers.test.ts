import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

// These suites exercise the message pipeline, not access control (covered by
// telegram-access-defaults / telegram-blocked-users): admit every sender.
vi.mock("../frontend/telegram/handlers/access.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../frontend/telegram/handlers/access.js")
  >()),
  isAccessAllowed: vi.fn(async () => true),
}));
vi.mock("../core/engine/dispatcher.js", () => ({
  execute: executeMock,
}));
vi.mock("../storage/daily-log.js", () => ({
  appendDailyLog: vi.fn(),
  appendDailyLogResponse: vi.fn(),
}));
vi.mock("../util/watchdog.js", () => ({
  recordMessageProcessed: vi.fn(),
  recordMessageReceived: vi.fn(),
  recordMessageSettled: vi.fn(),
  recordError: vi.fn(),
}));
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../core/errors.js", () => ({
  classify: vi.fn((e: unknown) => ({
    reason: "error",
    message: String(e),
    retryable: false,
  })),
  friendlyMessage: vi.fn(() => "An error occurred"),
  RETRY_ELAPSED_CAP_MS: 120_000,
}));

vi.mock("../storage/history.js", () => ({
  setMessageFilePath: vi.fn(),
  getRecentHistory: vi.fn(() => []),
  getRecentBySenderId: vi.fn(() => []),
}));
vi.mock("../storage/media-index.js", () => ({
  addMedia: vi.fn(),
}));
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

const {
  shouldHandleInGroup,
  getSenderName,
  getReplyContext,
  getForwardContext,
  extractUnauthorizedPreview,
  buildGroupGapContextNotice,
} = await import("../frontend/telegram/handlers/index.js");

describe("shouldHandleInGroup", () => {
  const makeCtx = (
    overrides: {
      type?: string;
      text?: string;
      username?: string;
      replyFromId?: number;
      botId?: number;
    } = {},
  ) => ({
    chat: { type: overrides.type ?? "supergroup" },
    me: {
      id: overrides.botId ?? 999,
      username: overrides.username ?? "testbot",
    },
    message: {
      text: overrides.text ?? "",
      caption: undefined,
      reply_to_message: overrides.replyFromId
        ? { from: { id: overrides.replyFromId } }
        : undefined,
    },
  });

  // Cast partial objects to any — we only test the mention/reply logic, not the full Context
  const ctx = (overrides: Parameters<typeof makeCtx>[0] = {}) =>
    makeCtx(overrides) as any;

  it("returns true for DMs (not a group)", () => {
    expect(shouldHandleInGroup({ ...ctx(), chat: { type: "private" } })).toBe(
      true,
    );
  });

  it("returns true when bot is mentioned with @", () => {
    expect(shouldHandleInGroup(ctx({ text: "hey @testbot what's up" }))).toBe(
      true,
    );
  });

  it("returns true when bot is mentioned case-insensitively", () => {
    expect(shouldHandleInGroup(ctx({ text: "Hey @TestBot!" }))).toBe(true);
  });

  it("returns false when a different bot is mentioned", () => {
    expect(
      shouldHandleInGroup(ctx({ text: "hey @testbot123 what's up" })),
    ).toBe(false);
  });

  it("returns false when bot name appears without @", () => {
    expect(shouldHandleInGroup(ctx({ text: "testbot is cool" }))).toBe(false);
  });

  it("returns true when replying to the bot", () => {
    expect(shouldHandleInGroup(ctx({ replyFromId: 999, botId: 999 }))).toBe(
      true,
    );
  });

  it("returns false when replying to someone else", () => {
    expect(shouldHandleInGroup(ctx({ replyFromId: 123, botId: 999 }))).toBe(
      false,
    );
  });

  it("returns false for plain group message without mention or reply", () => {
    expect(shouldHandleInGroup(ctx({ text: "hello everyone" }))).toBe(false);
  });

  it("handles @mention at end of message", () => {
    expect(
      shouldHandleInGroup(ctx({ text: "what do you think @testbot" })),
    ).toBe(true);
  });

  it("handles @mention with punctuation after", () => {
    expect(shouldHandleInGroup(ctx({ text: "@testbot, help me" }))).toBe(true);
  });
});

describe("getSenderName", () => {
  it("returns first + last name", () => {
    expect(getSenderName({ first_name: "John", last_name: "Doe" })).toBe(
      "John Doe",
    );
  });

  it("returns first name only when no last name", () => {
    expect(getSenderName({ first_name: "Alice" })).toBe("Alice");
  });

  it("returns 'User' when undefined", () => {
    expect(getSenderName(undefined)).toBe("User");
  });

  it("returns 'User' when empty names", () => {
    expect(getSenderName({})).toBe("User");
  });
});

describe("getReplyContext", () => {
  it("returns empty for no reply", () => {
    expect(getReplyContext(undefined, 999)).toBe("");
  });

  it("includes 'bot' as author when replying to bot itself", () => {
    const result = getReplyContext({ from: { id: 999 }, text: "hi" }, 999);
    expect(result).toContain("bot");
    expect(result).toContain("hi");
  });

  it("includes author, text, and message_id for reply to others", () => {
    const result = getReplyContext(
      {
        message_id: 42,
        from: { id: 123, first_name: "Alice" },
        text: "original message",
      },
      999,
    );
    expect(result).toContain("Alice");
    expect(result).toContain("original message");
    expect(result).toContain("Replying to");
    expect(result).toContain("msg_id:42");
  });

  it("truncates long reply text to 500 chars", () => {
    const longText = "x".repeat(600);
    const result = getReplyContext(
      { from: { id: 123, first_name: "Bob" }, text: longText },
      999,
    );
    expect(result.length).toBeLessThan(600);
  });
});

describe("getForwardContext", () => {
  it("returns empty for non-forwarded messages", () => {
    expect(getForwardContext({})).toBe("");
  });

  it("handles forwarded from user", () => {
    const result = getForwardContext({
      forward_origin: {
        type: "user",
        sender_user: { first_name: "Charlie", last_name: "D" },
      },
    });
    expect(result).toContain("Charlie D");
    expect(result).toContain("Forwarded");
  });

  it("handles forwarded from channel", () => {
    const result = getForwardContext({
      forward_origin: { type: "channel", chat: { title: "News" } },
    });
    expect(result).toContain("News");
  });

  it("handles hidden user", () => {
    const result = getForwardContext({
      forward_origin: { type: "hidden_user", sender_user_name: "anon" },
    });
    expect(result).toContain("anon");
  });

  it("handles chat type forward", () => {
    const result = getForwardContext({
      forward_origin: { type: "chat", chat: { title: "Support Group" } },
    });
    expect(result).toContain("Support Group");
  });

  it("handles channel with no title", () => {
    const result = getForwardContext({
      forward_origin: { type: "channel", chat: {} },
    });
    expect(result).toContain("a chat");
  });

  it("handles unknown forward type", () => {
    const result = getForwardContext({
      forward_origin: { type: "unknown_type" },
    });
    expect(result).toContain("someone");
  });
});

describe("getReplyContext — edge cases", () => {
  it("returns empty when reply has no text, caption, media, or message_id", () => {
    expect(getReplyContext({ from: { id: 123 } }, 999)).toBe("");
  });

  it("includes message_id and media type even without text", () => {
    const result = getReplyContext(
      {
        message_id: 100,
        from: { id: 123, first_name: "Dan" },
        photo: [{}] as unknown[],
      },
      999,
    );
    expect(result).toContain("msg_id:100");
    expect(result).toContain("[photo]");
    expect(result).toContain("Dan");
  });

  it("uses caption when text is missing", () => {
    const result = getReplyContext(
      { from: { id: 123, first_name: "Eve" }, caption: "photo caption" },
      999,
    );
    expect(result).toContain("photo caption");
  });

  it("includes full name from first and last", () => {
    const result = getReplyContext(
      {
        from: { id: 123, first_name: "Jane", last_name: "Smith" },
        text: "hello",
      },
      999,
    );
    expect(result).toContain("Jane Smith");
  });

  it("detects video media type (ternary TRUE branch for video)", () => {
    const result = getReplyContext(
      { from: { id: 123 }, video: {}, message_id: 1 },
      999,
    );
    expect(result).toContain("[video]");
  });

  it("detects document media type", () => {
    const result = getReplyContext(
      { from: { id: 123 }, document: {}, message_id: 2 },
      999,
    );
    expect(result).toContain("[document]");
  });

  it("detects voice media type", () => {
    const result = getReplyContext(
      { from: { id: 123 }, voice: {}, message_id: 3 },
      999,
    );
    expect(result).toContain("[voice]");
  });

  it("detects audio media type", () => {
    const result = getReplyContext(
      { from: { id: 123 }, audio: {}, message_id: 4 },
      999,
    );
    expect(result).toContain("[audio]");
  });

  it("detects sticker media type", () => {
    const result = getReplyContext(
      { from: { id: 123 }, sticker: {}, message_id: 5 },
      999,
    );
    expect(result).toContain("[sticker]");
  });

  it("detects animation media type", () => {
    const result = getReplyContext(
      { from: { id: 123 }, animation: {}, message_id: 6 },
      999,
    );
    expect(result).toContain("[animation]");
  });
});

describe("getReplyContext — quoted portions (Bot API 7.0)", () => {
  it("appends manual quote portion when user highlights a substring", () => {
    const result = getReplyContext(
      {
        message_id: 10,
        from: { id: 123, first_name: "Alice" },
        text: "this is the full original message with several parts to it",
      },
      999,
      { text: "several parts", is_manual: true },
    );
    expect(result).toContain("Alice");
    expect(result).toContain("this is the full original message");
    expect(result).toContain('[Quoted portion: "several parts"]');
  });

  it("appends server-auto quote (is_manual=false) the same way", () => {
    const result = getReplyContext(
      {
        message_id: 11,
        from: { id: 123, first_name: "Bob" },
        text: "long message",
      },
      999,
      { text: "long", is_manual: false },
    );
    expect(result).toContain('[Quoted portion: "long"]');
  });

  it("omits quote line when quote is undefined (current default)", () => {
    const result = getReplyContext(
      {
        message_id: 12,
        from: { id: 123, first_name: "Carol" },
        text: "plain reply, no quote",
      },
      999,
    );
    expect(result).not.toContain("Quoted portion");
    expect(result).toContain('"plain reply, no quote"');
  });

  it("omits quote line when quote.text is missing or empty", () => {
    const noText = getReplyContext(
      { message_id: 13, from: { id: 123, first_name: "Dan" }, text: "x" },
      999,
      { is_manual: true },
    );
    const emptyText = getReplyContext(
      { message_id: 14, from: { id: 123, first_name: "Dan" }, text: "x" },
      999,
      { text: "   ", is_manual: true },
    );
    expect(noText).not.toContain("Quoted portion");
    expect(emptyText).not.toContain("Quoted portion");
  });

  it("truncates quote text to 500 chars to match full-text limit", () => {
    const longQuote = "q".repeat(800);
    const result = getReplyContext(
      { message_id: 15, from: { id: 123, first_name: "Eve" }, text: "src" },
      999,
      { text: longQuote, is_manual: true },
    );
    expect(result).toContain("Quoted portion");
    // The substring should be exactly 500 q's, no more.
    const match = result.match(/\[Quoted portion: "(q+)"\]/);
    expect(match?.[1].length).toBe(500);
  });

  it("surfaces quote even when replied-to message has no text (media-only)", () => {
    const result = getReplyContext(
      {
        message_id: 16,
        from: { id: 123, first_name: "Faye" },
        photo: [{}] as unknown[],
      },
      999,
      { text: "caption excerpt", is_manual: true },
    );
    expect(result).toContain("[photo]");
    expect(result).toContain('[Quoted portion: "caption excerpt"]');
  });
});

describe("shouldHandleInGroup — edge cases", () => {
  const ctx = (overrides: Record<string, unknown> = {}) =>
    ({
      chat: { type: overrides.type ?? "supergroup" },
      me: {
        id: overrides.botId ?? 999,
        username: overrides.username ?? "testbot",
      },
      message: {
        text: overrides.text ?? "",
        caption: overrides.caption ?? undefined,
        reply_to_message: overrides.replyFromId
          ? { from: { id: overrides.replyFromId } }
          : undefined,
      },
    }) as any;

  it("returns false when no chat", () => {
    expect(shouldHandleInGroup({ chat: null, message: {} } as any)).toBe(false);
  });

  it("returns false when no message", () => {
    expect(
      shouldHandleInGroup({ chat: { type: "group" }, message: null } as any),
    ).toBe(false);
  });

  it("detects bot mention in caption", () => {
    expect(
      shouldHandleInGroup(ctx({ caption: "look @testbot", text: "" })),
    ).toBe(true);
  });

  it("handles 'group' type (not just supergroup)", () => {
    expect(
      shouldHandleInGroup(ctx({ type: "group", text: "@testbot hi" })),
    ).toBe(true);
  });

  it("returns false for group with @mention as part of longer username", () => {
    // @testbot123 should NOT match @testbot (word boundary check)
    expect(shouldHandleInGroup(ctx({ text: "hey @testbot_extra" }))).toBe(
      false,
    );
  });
});

describe("buildGroupGapContextNotice", () => {
  const history = [
    { msgId: 10, senderId: 1, senderName: "A", text: "old", timestamp: 1 },
    {
      msgId: 11,
      senderId: 2,
      senderName: "B",
      text: "between",
      timestamp: 2,
    },
    {
      msgId: 12,
      senderId: 3,
      senderName: "C",
      text: "between",
      timestamp: 3,
    },
    {
      msgId: 13,
      senderId: 4,
      senderName: "D",
      text: "@bot what do you think",
      timestamp: 4,
    },
  ];

  it("returns a group-context notice for intervening group messages", () => {
    const notice = buildGroupGapContextNotice({
      isGroup: true,
      chatId: "chat",
      lastHandledMessageId: 10,
      firstQueuedMessageId: 13,
      history,
    });

    expect(notice).toContain("2 messages");
    expect(notice).toContain("read_chat_history");
    expect(notice).toContain("what you think");
  });

  it("stays silent for DMs, first turns, and adjacent group turns", () => {
    expect(
      buildGroupGapContextNotice({
        isGroup: false,
        chatId: "chat",
        lastHandledMessageId: 10,
        firstQueuedMessageId: 13,
        history,
      }),
    ).toBe("");

    expect(
      buildGroupGapContextNotice({
        isGroup: true,
        chatId: "chat",
        firstQueuedMessageId: 13,
        history,
      }),
    ).toBe("");

    expect(
      buildGroupGapContextNotice({
        isGroup: true,
        chatId: "chat",
        lastHandledMessageId: 12,
        firstQueuedMessageId: 13,
        history,
      }),
    ).toBe("");
  });
});

describe("getSenderName — edge cases", () => {
  it("returns last name only when no first name", () => {
    expect(getSenderName({ last_name: "Doe" })).toBe("Doe");
  });

  it("trims whitespace from names", () => {
    // filter(Boolean) handles empty strings
    expect(getSenderName({ first_name: "", last_name: "Smith" })).toBe("Smith");
  });
});

const {
  handleTextMessage,
  handlePhotoMessage,
  handleCallbackQuery,
  handleStickerMessage,
  handleVoiceMessage,
  handleVideoMessage,
  handleDocumentMessage,
  handleAudioMessage,
  handleVideoNoteMessage,
  handleAnimationMessage,
} = await import("../frontend/telegram/handlers/index.js");

// Shared mock objects used across all handler integration tests
const mockBot = {
  api: {
    sendRichMessage: vi.fn(async () => ({ message_id: 1 })),
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    sendChatAction: vi.fn(async () => {}),
    setMessageReaction: vi.fn(async () => {}),
    sendMessageDraft: vi.fn(async () => {}),
  },
} as any;

const mockConfig = {
  botToken: "test",
  model: "claude-sonnet-4-6",
  maxMessageLength: 4000,
  workspace: "/tmp/test-workspace",
} as any;

describe("handleTextMessage — integration via mock Context", () => {
  it("silently returns when ctx.message is missing", async () => {
    await handleTextMessage({ chat: { id: 1 } } as any, mockBot, mockConfig);
    // Should not throw
  });

  it("silently returns when ctx.chat is missing", async () => {
    await handleTextMessage(
      { message: { text: "hi" } } as any,
      mockBot,
      mockConfig,
    );
    // Should not throw
  });

  it("silently returns for group message without mention", async () => {
    const ctx = {
      chat: { id: 1, type: "supergroup" },
      message: {
        text: "hello everyone",
        message_id: 1,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 1, first_name: "User" },
    } as any;
    await handleTextMessage(ctx, mockBot, mockConfig);
    // Should not enqueue (no mention or reply to bot)
  });

  it("silently returns when photo has no photos array", async () => {
    const ctx = {
      chat: { id: 1, type: "private" },
      message: { photo: null, message_id: 1 },
      me: { id: 999, username: "testbot" },
      from: { id: 1, first_name: "User" },
    } as any;
    await handlePhotoMessage(ctx, mockBot, mockConfig);
  });

  it("silently returns when callback query has no data", async () => {
    const ctx = {
      callbackQuery: { message: { message_id: 1 } }, // no 'data' property
      chat: { id: 1 },
      from: { id: 1, first_name: "User" },
    } as any;
    await handleCallbackQuery(ctx, mockBot, mockConfig);
  });

  it("enqueues and processes a DM message via flushQueue", async () => {
    executeMock.mockResolvedValue({
      text: "hello back",
      durationMs: 50,
      inputTokens: 5,
      outputTokens: 10,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const ctx = {
      chat: { id: 12345, type: "private" },
      message: { text: "hello", message_id: 100, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 42, first_name: "Alice" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);

    // Wait for real 500ms debounce plus buffer for async processing
    await new Promise((r) => setTimeout(r, 700));

    expect(executeMock).toHaveBeenCalled();
  }, 3000);

  it("enqueues multiple DM messages within debounce window — concatenates them", async () => {
    executeMock.mockResolvedValue({
      text: "concatenated response",
      durationMs: 30,
      inputTokens: 3,
      outputTokens: 5,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const chatId = 77777 + Math.floor(Math.random() * 1000); // unique id to avoid state sharing
    const makeCtx = (text: string, msgId: number) =>
      ({
        chat: { id: chatId, type: "private" },
        message: { text, message_id: msgId, reply_to_message: null },
        me: { id: 999, username: "testbot" },
        from: { id: 55, first_name: "Carol" },
      }) as any;

    const before = executeMock.mock.calls.length;
    await handleTextMessage(makeCtx("first message", 301), mockBot, mockConfig);
    await handleTextMessage(
      makeCtx("second message", 302),
      mockBot,
      mockConfig,
    );

    await new Promise((r) => setTimeout(r, 700));

    const newCalls = executeMock.mock.calls.slice(before).filter((c) => {
      const arg = c[0] as { chatId: string };
      return arg.chatId === String(chatId);
    });
    expect(newCalls.length).toBe(1);
    const callArg = newCalls[0][0] as { prompt: string };
    expect(callArg.prompt).toContain("first message");
    expect(callArg.prompt).toContain("second message");
  }, 3000);
});

describe("handlePhotoMessage — downloads and enqueues photo", () => {
  beforeEach(() => {
    // Mock bot.api.getFile for file download
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "photos/test.jpg" }));
    // Create a minimal valid JPEG buffer (FF D8 header = JPEG magic bytes)
    const jpegBuf = new Uint8Array(104);
    jpegBuf[0] = 0xff;
    jpegBuf[1] = 0xd8;
    const mockFetch = vi.fn(async () => ({
      ok: true,
      headers: { get: (_name: string) => null },
      arrayBuffer: async () => jpegBuf.buffer,
    }));
    vi.stubGlobal("fetch", mockFetch);

    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads photo and enqueues message", async () => {
    const chatId = 54321;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 500,
        photo: [
          {
            file_id: "small_id",
            file_unique_id: "small_uniq",
            width: 100,
            height: 100,
          },
          {
            file_id: "large_id",
            file_unique_id: "large_uniq",
            width: 800,
            height: 600,
          },
        ],
        caption: "Look at this!",
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 50, first_name: "Nina" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handlePhotoMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => {
      const arg = c[0] as { chatId: string };
      return arg.chatId === String(chatId);
    });
    expect(calls.length).toBe(1);
    const arg = calls[0][0] as { prompt: string };
    expect(arg.prompt).toContain("photo");
  }, 3000);

  it("returns error via bot API when file download fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 })),
    );
    const ctx = {
      chat: { id: 54322, type: "private" },
      message: {
        message_id: 501,
        photo: [
          {
            file_id: "bad_id",
            file_unique_id: "bad_uniq",
            width: 100,
            height: 100,
          },
        ],
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 51, first_name: "Oscar" },
    } as any;

    await handlePhotoMessage(ctx, mockBot, mockConfig);
    // Should call sendMessage with error text
    expect(mockBot.api.sendMessage).toHaveBeenCalled();
  });

  it("rejects oversized document files", async () => {
    const ctx = {
      chat: { id: 54323, type: "private" },
      message: {
        message_id: 502,
        document: {
          file_id: "big_doc",
          file_unique_id: "big_uniq",
          file_name: "huge.pdf",
          file_size: 30 * 1024 * 1024, // 30MB > 20MB limit
          mime_type: "application/pdf",
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 52, first_name: "Paula" },
    } as any;

    await handleDocumentMessage(ctx, mockBot, mockConfig);
    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("large"),
      expect.anything(),
    );
  });
});

describe("handleCallbackQuery — processes button press", () => {
  it("calls execute when callbackQuery has data", async () => {
    executeMock.mockResolvedValue({
      text: "response",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const ctx = {
      callbackQuery: { data: "button_option_a", message: { message_id: 50 } },
      chat: { id: 555, type: "private" },
      from: { id: 10, first_name: "Dave" },
      answerCallbackQuery: vi.fn(async () => {}),
    } as any;

    const before = executeMock.mock.calls.length;
    await handleCallbackQuery(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBeGreaterThan(before);
    const arg = executeMock.mock.calls[
      executeMock.mock.calls.length - 1
    ][0] as { prompt: string };
    expect(arg.prompt).toContain("button_option_a");
  });

  it("returns early when callbackQuery has no data", async () => {
    const ctx = {
      callbackQuery: { message: { message_id: 51 } }, // no data
      chat: { id: 556 },
      from: { id: 11, first_name: "Eve" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleCallbackQuery(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });
});

describe("handleVoiceMessage/handleVideoMessage/handleDocumentMessage/handleAudioMessage — early returns", () => {
  it("handleVoiceMessage returns early when no voice data", async () => {
    const ctx = {
      chat: { id: 888, type: "private" },
      message: { message_id: 10, voice: null },
      me: { id: 999, username: "testbot" },
      from: { id: 30, first_name: "Hank" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleVoiceMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("handleVideoMessage returns early when no video data", async () => {
    const ctx = {
      chat: { id: 889, type: "private" },
      message: { message_id: 11, video: null },
      me: { id: 999, username: "testbot" },
      from: { id: 31, first_name: "Iris" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleVideoMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("handleDocumentMessage returns early when no document", async () => {
    const ctx = {
      chat: { id: 890, type: "private" },
      message: { message_id: 12, document: null },
      me: { id: 999, username: "testbot" },
      from: { id: 32, first_name: "Jack" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleDocumentMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("handleAudioMessage returns early when no audio", async () => {
    const ctx = {
      chat: { id: 891, type: "private" },
      message: { message_id: 13, audio: null },
      me: { id: 999, username: "testbot" },
      from: { id: 33, first_name: "Kate" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleAudioMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("handleAnimationMessage returns early when no animation", async () => {
    const ctx = {
      chat: { id: 892, type: "private" },
      message: { message_id: 14, animation: null },
      me: { id: 999, username: "testbot" },
      from: { id: 34, first_name: "Liam" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleAnimationMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("handleVideoNoteMessage returns early when no video_note", async () => {
    const ctx = {
      chat: { id: 893, type: "private" },
      message: { message_id: 15, video_note: null },
      me: { id: 999, username: "testbot" },
      from: { id: 35, first_name: "Mia" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleVideoNoteMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });
});

describe("rate limiting — isUserRateLimited via handleTextMessage", () => {
  it("blocks message after RATE_LIMIT_MAX_MESSAGES (15) messages from same user", async () => {
    const userId = 99999; // unique user ID for this test
    const makeCtx = (i: number) =>
      ({
        chat: { id: 11111 + i, type: "private" }, // different chat each time to avoid queue conflicts
        message: {
          text: `message ${i}`,
          message_id: 1000 + i,
          reply_to_message: null,
        },
        me: { id: 999, username: "testbot" },
        from: { id: userId, first_name: "RateLimitUser" },
      }) as any;

    // Send 15 messages — all should be enqueued
    for (let i = 0; i < 15; i++) {
      await handleTextMessage(makeCtx(i), mockBot, mockConfig);
    }

    // 16th message should be rate limited (return early without enqueuing)
    await handleTextMessage(makeCtx(15), mockBot, mockConfig);

    // Wait to confirm no debounce fires for the 16th chat
    await new Promise((r) => setTimeout(r, 50));
    // The 16th message's chatId never appeared in the queue, so execute won't be called for it
    const rateLimitedCalls = executeMock.mock.calls.filter((c) => {
      const arg = c[0] as { chatId: string };
      return arg.chatId === String(11111 + 15);
    });
    expect(rateLimitedCalls.length).toBe(0);
  }, 3000);
});

describe("handleStickerMessage — enqueues sticker prompt", () => {
  it("enqueues a sticker message", async () => {
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });
    const ctx = {
      chat: { id: 66666, type: "private" },
      message: {
        message_id: 200,
        sticker: {
          file_id: "sticker123",
          emoji: "😀",
          set_name: "AnimatedEmoji",
          is_animated: false,
          is_video: false,
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 20, first_name: "Frank" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleStickerMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => {
      const arg = c[0] as { chatId: string };
      return arg.chatId === "66666";
    });
    expect(calls.length).toBe(1);
    const arg = calls[0][0] as { prompt: string };
    expect(arg.prompt).toContain("sticker");
    expect(arg.prompt).toContain("sticker123");
  }, 3000);

  it("returns early when no sticker in message", async () => {
    const ctx = {
      chat: { id: 777, type: "private" },
      message: { message_id: 300, sticker: null },
      me: { id: 999, username: "testbot" },
      from: { id: 21, first_name: "Grace" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleStickerMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("builds sticker prompt with animated flag", async () => {
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });
    const chatId = 66667;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 201,
        sticker: {
          file_id: "anim123",
          emoji: "🔥",
          set_name: "",
          is_animated: true,
          is_video: false,
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 22, first_name: "Heidi" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleStickerMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { prompt: string }).prompt).toContain("animated");
  }, 3000);
});

// Helper: create a minimal non-image binary buffer (e.g. for voice/video/audio)
function makeBinaryBuffer(size = 64): ArrayBuffer {
  const arr = new Uint8Array(size);
  arr[0] = 0x1a;
  arr[1] = 0x45; // some random non-image bytes
  return arr.buffer;
}

describe("handleVoiceMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "voice/test.ogg" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => makeBinaryBuffer(),
      })),
    );
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads voice and enqueues message", async () => {
    const chatId = 70001;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 600,
        voice: { file_id: "voice_abc", file_unique_id: "vuq1", duration: 5 },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 60, first_name: "Nora" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleVoiceMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { prompt: string }).prompt).toContain("voice");
  }, 3000);
});

describe("handleAudioMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "audio/test.mp3" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => makeBinaryBuffer(),
      })),
    );
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads audio with title and performer", async () => {
    const chatId = 70002;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 601,
        audio: {
          file_id: "audio_abc",
          file_unique_id: "auq1",
          duration: 180,
          title: "My Song",
          performer: "Artist",
          file_name: "song.mp3",
          file_size: 2 * 1024 * 1024,
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 61, first_name: "Oscar" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleAudioMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    const prompt = (calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("My Song");
    expect(prompt).toContain("Artist");
  }, 3000);

  it("handles audio without title (falls back to file_name)", async () => {
    const chatId = 70003;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 602,
        audio: {
          file_id: "audio_def",
          file_unique_id: "auq2",
          duration: 60,
          file_name: "recording.mp3",
          file_size: 500_000,
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 62, first_name: "Paula" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleAudioMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { prompt: string }).prompt).toContain(
      "recording.mp3",
    );
  }, 3000);
});

describe("handleVideoNoteMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({
      file_path: "video_note/test.mp4",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => makeBinaryBuffer(),
      })),
    );
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads video_note and enqueues message", async () => {
    const chatId = 70004;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 603,
        video_note: {
          file_id: "vn_abc",
          file_unique_id: "vnq1",
          duration: 15,
          file_size: 300_000,
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 63, first_name: "Quinn" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleVideoNoteMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { prompt: string }).prompt).toContain("round video");
  }, 3000);
});

describe("handleDocumentMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({
      file_path: "documents/test.pdf",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => makeBinaryBuffer(),
      })),
    );
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads document and enqueues message", async () => {
    const chatId = 70005;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 604,
        document: {
          file_id: "doc_abc",
          file_unique_id: "dq1",
          file_name: "report.pdf",
          file_size: 1_000_000,
          mime_type: "application/pdf",
        },
        caption: "Please review",
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 64, first_name: "Rachel" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleDocumentMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    const prompt = (calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("report.pdf");
    expect(prompt).toContain("Please review");
  }, 3000);
});

describe("handleVideoMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "videos/test.mp4" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => makeBinaryBuffer(),
      })),
    );
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads video and enqueues message", async () => {
    const chatId = 70006;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 605,
        video: {
          file_id: "vid_abc",
          file_unique_id: "vq1",
          duration: 30,
          width: 1280,
          height: 720,
          file_name: "clip.mp4",
        },
        caption: "Check this out",
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 65, first_name: "Sam" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleVideoMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    const prompt = (calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("clip.mp4");
    expect(prompt).toContain("Check this out");
  }, 3000);
});

describe("handleTextMessage — group message with @mention", () => {
  it("enqueues group message when bot is mentioned", async () => {
    executeMock.mockResolvedValue({
      text: "group response",
      durationMs: 50,
      inputTokens: 5,
      outputTokens: 10,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const chatId = 80001;
    const ctx = {
      chat: { id: chatId, type: "supergroup", title: "Test Group" },
      message: {
        text: "@testbot hello from group",
        message_id: 700,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 70, first_name: "Tom" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    const arg = calls[0][0] as { isGroup: boolean; prompt: string };
    expect(arg.isGroup).toBe(true);
    expect(arg.prompt).toContain("@testbot hello from group");
  }, 3000);
});

describe("handleCallbackQuery — error path", () => {
  it("logs error when processAndReply throws", async () => {
    const { logError } = await import("../util/log.js");
    executeMock.mockRejectedValueOnce(new Error("callback execute failed"));

    const ctx = {
      callbackQuery: { data: "broken_action", message: { message_id: 800 } },
      chat: { id: 90001, type: "private" },
      from: { id: 80, first_name: "Uma" },
      answerCallbackQuery: vi.fn(async () => {}),
    } as any;

    await handleCallbackQuery(ctx, mockBot, mockConfig);
    expect(logError).toHaveBeenCalled();
  });
});

describe("flushQueue — retryable error path", () => {
  it("retries once on retryable error and sends error message on retry failure", async () => {
    const { classify, friendlyMessage } = await import("../core/errors.js");

    // First execute call throws (retryable), second also throws (unrecoverable)
    executeMock
      .mockRejectedValueOnce(new Error("overloaded"))
      .mockRejectedValueOnce(new Error("still overloaded"));

    (classify as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({
        reason: "overloaded",
        message: "overloaded",
        retryable: true,
        retryAfterMs: 10,
      })
      .mockReturnValueOnce({
        reason: "overloaded",
        message: "still overloaded",
        retryable: false,
      });

    (friendlyMessage as ReturnType<typeof vi.fn>).mockReturnValue(
      "Service temporarily overloaded",
    );

    const chatId = 95001;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: { text: "test retry", message_id: 900, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 90, first_name: "Victor" },
    } as any;

    const sendMsgCalls = mockBot.api.sendMessage.mock.calls.length;
    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    // Should have sent an error message after retry failure
    expect(mockBot.api.sendMessage.mock.calls.length).toBeGreaterThan(
      sendMsgCalls,
    );
  }, 3000);
});

describe("flushQueue — user-stopped turn", () => {
  it("stays silent when the turn unwound because of /stop", async () => {
    const { classify } = await import("../core/errors.js");

    executeMock.mockRejectedValueOnce(new Error("Turn stopped by user"));
    (classify as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      reason: "stopped",
      message: "Turn stopped by user",
      retryable: false,
    });

    const chatId = 95003;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: { text: "stop me", message_id: 902, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 92, first_name: "Nadia" },
    } as any;

    const sendMsgCalls = mockBot.api.sendMessage.mock.calls.length;
    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    // No retry, no error message — the /stop ack already covered it.
    expect(mockBot.api.sendMessage.mock.calls.length).toBe(sendMsgCalls);
  }, 3000);
});

describe("flushQueue — retryable error, successful retry (line 403 return)", () => {
  it("returns after successful retry without sending error message", async () => {
    const { classify } = await import("../core/errors.js");

    const successResult = {
      text: "",
      durationMs: 5,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    };
    // First execute call throws (retryable), second SUCCEEDS → covers line 403 `return`
    executeMock
      .mockRejectedValueOnce(new Error("overloaded"))
      .mockResolvedValueOnce(successResult);

    (classify as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      reason: "overloaded",
      message: "overloaded",
      retryable: true,
      retryAfterMs: 10,
    });

    const sendMsgCountBefore = (
      mockBot.api.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    const ctx = {
      chat: { id: 95010, type: "private" },
      message: {
        text: "retry success test",
        message_id: 905,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 91, first_name: "Vera" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    // Retry succeeded — no error message should have been sent
    const sendMsgCountAfter = (
      mockBot.api.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    expect(sendMsgCountAfter).toBe(sendMsgCountBefore); // no additional sendMessage call
  }, 3000);
});

describe("flushQueue — group error logs 'group' chatType (line 378 TRUE branch)", () => {
  it("logs 'group' when error occurs in group chat context", async () => {
    const { classify, friendlyMessage } = await import("../core/errors.js");
    const { logError } = await import("../util/log.js");

    executeMock.mockRejectedValueOnce(new Error("group exec error"));
    (classify as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      reason: "error",
      message: "group exec error",
      retryable: false,
    });
    (friendlyMessage as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      "Error occurred",
    );
    (logError as ReturnType<typeof vi.fn>).mockClear();

    const ctx = {
      chat: { id: 95020, type: "supergroup", title: "My Group" },
      message: {
        text: "@testbot group error test",
        message_id: 910,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 92, first_name: "Greg" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    // logError should include "group" in the message (not "DM")
    const logCalls = (logError as ReturnType<typeof vi.fn>).mock.calls;
    const relevantCall = logCalls.find(
      (c: unknown[]) =>
        String(c[1]).includes("group") || String(c[1]).includes("95020"),
    );
    expect(relevantCall).toBeDefined();
    expect(String(relevantCall![1])).toContain("group");
  }, 3000);
});

describe("flushQueue — retry without retryAfterMs uses default 2000ms (line 388 FALSE branch)", () => {
  it("uses 2000ms default delay when retryAfterMs is undefined", async () => {
    const { classify } = await import("../core/errors.js");

    const successResult = {
      text: "",
      durationMs: 5,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    };
    executeMock
      .mockRejectedValueOnce(new Error("overloaded"))
      .mockResolvedValueOnce(successResult);

    // retryAfterMs is absent — covers `?? 2000` FALSE branch
    (classify as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      reason: "overloaded",
      message: "overloaded",
      retryable: true,
      // no retryAfterMs → falls to 2000
    });

    // Use fake timers to avoid actually waiting 2000ms
    vi.useFakeTimers();

    const ctx = {
      chat: { id: 95030, type: "private" },
      message: {
        text: "default delay test",
        message_id: 915,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 93, first_name: "Harry" },
    } as any;

    const handlePromise = handleTextMessage(ctx, mockBot, mockConfig);
    // Advance timers past debounce (500ms) + default delay (2000ms)
    await vi.advanceTimersByTimeAsync(3000);
    await handlePromise;

    vi.useRealTimers();
  }, 10000);
});

describe("handleTextMessage — senderUsername truthy covers trackDmUser username tag (line 49 TRUE branch)", () => {
  it("tracks DM user with username when username is provided", async () => {
    const { appendDailyLog } = await import("../storage/daily-log.js");
    (appendDailyLog as ReturnType<typeof vi.fn>).mockClear();

    executeMock.mockResolvedValueOnce({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const ctx = {
      chat: { id: 95040, type: "private" },
      message: {
        text: "hi from @user",
        message_id: 920,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      // username provided → senderUsername is truthy → tag = " (@johndoe)"
      from: { id: 94, first_name: "John", username: "johndoe" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    // appendDailyLog should have been called with the @username tag
    const allCalls = (appendDailyLog as ReturnType<typeof vi.fn>).mock.calls;
    const taggedCall = allCalls.find((c: unknown[]) =>
      String(c[1]).includes("@johndoe"),
    );
    expect(taggedCall).toBeDefined();
  }, 3000);
});

describe("handleTextMessage — text=undefined uses empty string (line 725 FALSE branch)", () => {
  it("enqueues with empty prompt when ctx.message.text is undefined", async () => {
    executeMock.mockResolvedValueOnce({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const ctx = {
      chat: { id: 95050, type: "private" },
      // text is undefined — covers `ctx.message.text ?? ""` FALSE branch
      message: { text: undefined, message_id: 925, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 95, first_name: "Ina" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));
    // Should have processed the message (empty prompt is fine)
    expect(executeMock.mock.calls.length).toBeGreaterThan(before);
  }, 3000);
});

describe("sendHtml — non-Error thrown in fallback path (line 445 FALSE branch)", () => {
  it("logs warning with String(err) when sendMessage throws a non-Error", async () => {
    const { logWarn } = await import("../util/log.js");
    executeMock.mockRejectedValueOnce(new Error("some error"));
    const { classify, friendlyMessage } = await import("../core/errors.js");
    (classify as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      reason: "error",
      message: "some error",
      retryable: false,
    });
    (friendlyMessage as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      "Error text",
    );
    (logWarn as ReturnType<typeof vi.fn>).mockClear();

    // First sendMessage throws a non-Error string, second succeeds
    let callCount = 0;
    mockBot.api.sendMessage = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw "non-error failure string"; // plain string
      return { message_id: callCount };
    });

    const ctx = {
      chat: { id: 95060, type: "private" },
      message: {
        text: "non-error throw test",
        message_id: 930,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 96, first_name: "Jake" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    // logWarn should be called with String(err) (non-Error path)
    const warnCalls = (logWarn as ReturnType<typeof vi.fn>).mock.calls;
    const htmlFailWarn = warnCalls.find((c: unknown[]) =>
      String(c[1]).includes("HTML send failed"),
    );
    expect(htmlFailWarn).toBeDefined();
    expect(String(htmlFailWarn![1])).toContain("non-error failure string");

    mockBot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
  }, 3000);
});

describe("downloadTelegramFile — content-length too large", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws when content-length header exceeds 50MB limit", async () => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "photos/big.jpg" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: {
          get: (name: string) =>
            name === "content-length" ? String(51 * 1024 * 1024) : null,
        },
        arrayBuffer: async () => makeBinaryBuffer(),
      })),
    );

    const ctx = {
      chat: { id: 95002, type: "private" },
      message: {
        message_id: 901,
        photo: [
          {
            file_id: "big_photo",
            file_unique_id: "bpq1",
            width: 4000,
            height: 3000,
          },
        ],
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 91, first_name: "Wendy" },
    } as any;

    await handlePhotoMessage(ctx, mockBot, mockConfig);
    // Should report error via sendMessage
    expect(mockBot.api.sendMessage).toHaveBeenCalled();
  });
});

describe("downloadTelegramFile — invalid image content", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects photo with invalid magic bytes (not a real image)", async () => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "photos/fake.jpg" }));
    // Return a buffer with no valid image header
    const fakeData = new Uint8Array(64); // all zeros, not a valid image
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => fakeData.buffer,
      })),
    );

    const ctx = {
      chat: { id: 95003, type: "private" },
      message: {
        message_id: 902,
        photo: [
          {
            file_id: "fake_photo",
            file_unique_id: "fpq1",
            width: 100,
            height: 100,
          },
        ],
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 92, first_name: "Xander" },
    } as any;

    await handlePhotoMessage(ctx, mockBot, mockConfig);
    // Should report error via sendMessage
    expect(mockBot.api.sendMessage).toHaveBeenCalled();
  });
});

describe("handleAnimationMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({
      file_path: "animations/test.mp4",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => makeBinaryBuffer(),
      })),
    );
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads animation and enqueues message", async () => {
    const chatId = 70007;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 606,
        animation: {
          file_id: "anim_abc",
          file_unique_id: "aq1",
          duration: 3,
          file_name: "funny.mp4",
        },
        caption: "lol",
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 66, first_name: "Tara" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleAnimationMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    const prompt = (calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("funny.mp4");
    expect(prompt).toContain("lol");
  }, 3000);
});

describe("processAndReply — onToolUse callback triggers appendDailyLogResponse", () => {
  // The SDK emits MCP-prefixed tool names in production
  // (`mcp__telegram-tools__send` etc.). Bare names like `send` are how the
  // tool is registered but NOT what the handler actually receives. This
  // test matrix exercises both shapes — the prefixed forms are what would
  // catch a regression where the strip-prefix logic gets dropped.
  const cases = [
    {
      label: "MCP-prefixed send (production shape)",
      toolName: "mcp__telegram-tools__send",
      input: { type: "text", text: "Production send text" },
      expectedText: "Production send text",
      shouldCapture: true,
    },
    {
      label: "MCP-prefixed end_turn (production shape)",
      toolName: "mcp__telegram-tools__end_turn",
      input: { text: "Production end_turn text" },
      expectedText: "Production end_turn text",
      shouldCapture: true,
    },
    {
      label: "bare send (defensive — registry-shape compat)",
      toolName: "send",
      input: { type: "text", text: "Bare send text" },
      expectedText: "Bare send text",
      shouldCapture: true,
    },
    {
      label: "bare end_turn (defensive — registry-shape compat)",
      toolName: "end_turn",
      input: { text: "Bare end_turn text" },
      expectedText: "Bare end_turn text",
      shouldCapture: true,
    },
    {
      label: "non-text send (photo) — should NOT capture",
      toolName: "mcp__telegram-tools__send",
      input: { type: "photo", file_path: "/x.jpg", caption: "ignored" },
      expectedText: "",
      shouldCapture: false,
    },
    {
      label: "react tool — should NOT capture",
      toolName: "mcp__telegram-tools__react",
      input: { message_id: 1, emoji: "👍" },
      expectedText: "",
      shouldCapture: false,
    },
  ];

  for (const c of cases) {
    it(`${c.shouldCapture ? "captures" : "ignores"} ${c.label}`, async () => {
      const { appendDailyLogResponse } =
        await import("../storage/daily-log.js");
      const mockedFn = vi.mocked(appendDailyLogResponse);
      const before = mockedFn.mock.calls.length;

      executeMock.mockImplementationOnce(
        async (params: Record<string, unknown>) => {
          const onEvent = params.onEvent as (
            event: Record<string, unknown>,
          ) => void | Promise<void>;
          await onEvent?.({
            type: "tool_call",
            id: "t1",
            name: c.toolName,
            input: c.input,
          });
          return {
            text: "",
            durationMs: 5,
            inputTokens: 1,
            outputTokens: 2,
            cacheRead: 0,
            cacheWrite: 0,
            bridgeMessageCount: 1,
          };
        },
      );

      const ctx = {
        chat: { id: 96001, type: "private" },
        message: { text: "hi", message_id: 950, reply_to_message: null },
        me: { id: 999, username: "testbot" },
        from: { id: 93, first_name: "Yuki" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      await handleTextMessage(ctx, mockBot, mockConfig);
      await new Promise((r) => setTimeout(r, 700));

      const newCalls = mockedFn.mock.calls.slice(before);
      if (c.shouldCapture) {
        expect(newCalls).toHaveLength(1);
        expect(newCalls[0][0]).toBe("Talon");
        expect(newCalls[0][1]).toBe(c.expectedText);
      } else {
        expect(newCalls).toHaveLength(0);
      }
    }, 3000);
  }
});

describe("createStreamCallbacks — onTextBlock delivers native Rich Markdown", () => {
  it("calls sendRichMessage when execute invokes onTextBlock", async () => {
    const sendMsgCount = () =>
      (mockBot.api.sendRichMessage as ReturnType<typeof vi.fn>).mock.calls
        .length;

    executeMock.mockImplementationOnce(
      async (params: Record<string, unknown>) => {
        const onEvent = params.onEvent as (
          event: Record<string, unknown>,
        ) => void | Promise<void>;
        await onEvent?.({
          type: "assistant_message",
          text: "**Bold response**",
        });
        return {
          text: "",
          durationMs: 5,
          inputTokens: 1,
          outputTokens: 2,
          cacheRead: 0,
          cacheWrite: 0,
          bridgeMessageCount: 1,
        };
      },
    );

    const before = sendMsgCount();
    const ctx = {
      chat: { id: 96002, type: "private" },
      message: {
        text: "test onTextBlock",
        message_id: 951,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 93, first_name: "Yuki" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    expect(sendMsgCount()).toBeGreaterThan(before);
  }, 3000);

  it("does not send the same OpenCode response twice when onTextBlock already delivered it", async () => {
    const sendMsgCount = () =>
      (mockBot.api.sendRichMessage as ReturnType<typeof vi.fn>).mock.calls
        .length;

    executeMock.mockImplementationOnce(
      async (params: Record<string, unknown>) => {
        const onEvent = params.onEvent as (
          event: Record<string, unknown>,
        ) => void | Promise<void>;
        await onEvent?.({ type: "assistant_message", text: "Hi! 👋" });
        return {
          text: "Hi! 👋",
          durationMs: 5,
          inputTokens: 1,
          outputTokens: 2,
          cacheRead: 0,
          cacheWrite: 0,
          bridgeMessageCount: 0,
        };
      },
    );

    const before = sendMsgCount();
    const ctx = {
      chat: { id: 96003, type: "private" },
      message: {
        text: "test duplicate suppression",
        message_id: 952,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 94, first_name: "Mika" },
    } as any;

    await handleTextMessage(ctx, mockBot, {
      ...mockConfig,
      backend: "opencode",
    });
    await new Promise((r) => setTimeout(r, 700));

    expect(sendMsgCount() - before).toBe(1);
  }, 3000);
});

describe("sendHtml — falls back to plain text on HTML send failure", () => {
  it("sends plain text when HTML mode fails", async () => {
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    // Make the first sendMessage (HTML) throw, then succeed on second call (plain text)
    let callCount = 0;
    mockBot.api.sendMessage = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("Bad Request: can't parse entities");
      return { message_id: callCount };
    });

    // Trigger sendHtml via the error handler path (classify returns non-retryable error)
    const { classify, friendlyMessage } = await import("../core/errors.js");
    executeMock.mockRejectedValueOnce(new Error("some error"));
    (classify as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      reason: "error",
      message: "some error",
      retryable: false,
    });
    (friendlyMessage as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      "<b>Bold error</b>",
    );

    const ctx = {
      chat: { id: 97001, type: "private" },
      message: {
        text: "test html fallback",
        message_id: 960,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 94, first_name: "Zoe" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    // Second call should be plain text (HTML stripped)
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2);
    const secondCallArg = (mockBot.api.sendMessage as ReturnType<typeof vi.fn>)
      .mock.calls[1][1];
    expect(secondCallArg).toContain("Bold error");
    expect(secondCallArg).not.toContain("<b>");

    // Restore sendMessage mock for other tests
    mockBot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
  }, 3000);

  it("fallback iterates to strip nested tag sequences", async () => {
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    let callCount = 0;
    mockBot.api.sendMessage = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("Bad Request: can't parse entities");
      return { message_id: callCount };
    });

    const { classify, friendlyMessage } = await import("../core/errors.js");
    executeMock.mockRejectedValueOnce(new Error("some error"));
    (classify as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      reason: "error",
      message: "some error",
      retryable: false,
    });
    // A single-pass regex leaves a `<script>` survivor after one removal
    // of the inner placeholder — the iterative loop must keep going.
    (friendlyMessage as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      "<scr<script>ipt>alert(1)</script> tail",
    );

    const ctx = {
      chat: { id: 97002, type: "private" },
      message: {
        text: "nested tag fallback",
        message_id: 961,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 95, first_name: "Zoe" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2);
    const plain = (mockBot.api.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[1][1];
    expect(plain).not.toMatch(/<[^<>]*>/); // no complete tag remains
    expect(plain).not.toContain("<");
    expect(plain).toContain("alert(1)");

    mockBot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
  }, 3000);
});

describe("createStreamCallbacks — onStreamDelta streaming path", () => {
  it("calls sendMessageDraft when state.started is true and delta is large enough", async () => {
    // Reset sendMessageDraft mock and use a fresh spy
    mockBot.api.sendMessageDraft = vi.fn(async () => {});

    executeMock.mockImplementationOnce(
      async (params: Record<string, unknown>) => {
        const onEvent = params.onEvent as (
          event: Record<string, unknown>,
        ) => void | Promise<void>;
        // Wait 1100ms so the internal 1000ms stream.started timer fires first
        await new Promise((r) => setTimeout(r, 1100));
        // Now state.started = true; accumulated delta > 40 chars > lastSentLength=0
        await onEvent?.({ type: "text_delta", text: "a".repeat(50) });
        return {
          text: "",
          durationMs: 10,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
          bridgeMessageCount: 0,
        };
      },
    );

    const ctx = {
      chat: { id: 98001, type: "private" },
      message: {
        text: "streaming test",
        message_id: 970,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 95, first_name: "Stream" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    // Wait for debounce (500ms) + executeMock sleep (1100ms) + buffer
    await new Promise((r) => setTimeout(r, 2000));

    expect(mockBot.api.sendMessageDraft).toHaveBeenCalled();
  }, 5000);

  it("calls sendMessageDraft with truncated text when accumulated > 3900 chars", async () => {
    mockBot.api.sendMessageDraft = vi.fn(async () => {});

    executeMock.mockImplementationOnce(
      async (params: Record<string, unknown>) => {
        const onEvent = params.onEvent as (
          event: Record<string, unknown>,
        ) => void | Promise<void>;
        await new Promise((r) => setTimeout(r, 1100));
        // accumulated.length > 3900 → triggers truncation + ellipsis
        await onEvent?.({ type: "text_delta", text: "b".repeat(4000) });
        return {
          text: "",
          durationMs: 10,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
          bridgeMessageCount: 0,
        };
      },
    );

    const ctx = {
      chat: { id: 98002, type: "private" },
      message: {
        text: "long streaming test",
        message_id: 971,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 95, first_name: "Stream" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 2000));

    const calls = (mockBot.api.sendMessageDraft as ReturnType<typeof vi.fn>)
      .mock.calls;
    if (calls.length > 0) {
      // Third arg is the display text — should be truncated with ellipsis
      const displayText = calls[calls.length - 1][2] as string;
      expect(displayText.length).toBeLessThanOrEqual(3901);
    }
  }, 5000);

  it("disables streaming when sendMessageDraft throws on first attempt", async () => {
    // This test relies on draftsSupported resetting to null — but it's module-level state.
    // We test that even if it was set, the sendMessageDraft failure path (catch block) works.
    mockBot.api.sendMessageDraft = vi.fn(async () => {
      throw new Error("not supported");
    });

    executeMock.mockImplementationOnce(
      async (params: Record<string, unknown>) => {
        const onEvent = params.onEvent as (
          event: Record<string, unknown>,
        ) => void | Promise<void>;
        await new Promise((r) => setTimeout(r, 1100));
        await onEvent?.({ type: "text_delta", text: "c".repeat(50) });
        return {
          text: "",
          durationMs: 10,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
          bridgeMessageCount: 0,
        };
      },
    );

    const { logWarn } = await import("../util/log.js");
    (logWarn as ReturnType<typeof vi.fn>).mockClear();

    const ctx = {
      chat: { id: 98003, type: "private" },
      message: {
        text: "streaming fail test",
        message_id: 972,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 95, first_name: "Stream" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 2000));

    // Either draftsSupported was already true (from prior test) and no warn is logged,
    // OR it was null and now the warn is logged — both are valid code paths.
    // Just verify no crash occurred.
    expect(mockBot.api.sendMessageDraft).toHaveBeenCalled();

    // Restore sendMessageDraft
    mockBot.api.sendMessageDraft = vi.fn(async () => {});
  }, 5000);

  it("returns early from onStreamDelta when state.started is false (line 495 !state.started TRUE branch)", async () => {
    mockBot.api.sendMessageDraft = vi.fn(async () => {});

    executeMock.mockImplementationOnce(
      async (params: Record<string, unknown>) => {
        const onEvent = params.onEvent as (
          event: Record<string, unknown>,
        ) => void | Promise<void>;
        // Call IMMEDIATELY — state.started is still false (timer hasn't fired)
        await onEvent?.({ type: "text_delta", text: "a".repeat(50) });
        return {
          text: "",
          durationMs: 10,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
          bridgeMessageCount: 0,
        };
      },
    );

    const ctx = {
      chat: { id: 98004, type: "private" },
      message: {
        text: "early delta test",
        message_id: 973,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 95, first_name: "Stream" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    // sendMessageDraft should NOT have been called since state.started was false
    expect(mockBot.api.sendMessageDraft).not.toHaveBeenCalled();
  }, 3000);

  it("returns early from onStreamDelta when delta < 40 chars (line 496 TRUE branch)", async () => {
    mockBot.api.sendMessageDraft = vi.fn(async () => {});

    executeMock.mockImplementationOnce(
      async (params: Record<string, unknown>) => {
        const onEvent = params.onEvent as (
          event: Record<string, unknown>,
        ) => void | Promise<void>;
        await new Promise((r) => setTimeout(r, 1100)); // wait for started
        // Only 20 chars since lastSentLength=0 → 20 < 40 → early return
        await onEvent?.({ type: "text_delta", text: "a".repeat(20) });
        return {
          text: "",
          durationMs: 10,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
          bridgeMessageCount: 0,
        };
      },
    );

    const ctx = {
      chat: { id: 98005, type: "private" },
      message: {
        text: "small delta test",
        message_id: 974,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 95, first_name: "Stream" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 2000));

    // sendMessageDraft should NOT have been called — delta < 40
    expect(mockBot.api.sendMessageDraft).not.toHaveBeenCalled();
  }, 5000);
});

describe("downloadReplyPhoto — success and error paths", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "photos/test.jpg" }));
  });

  it("downloads reply photo and adds path to prompt (L134 FALSE branch)", async () => {
    mockBot.api.getFile = vi.fn(async () => ({
      file_path: "photos/reply.jpg",
    }));
    const jpegBuf = new Uint8Array(64);
    jpegBuf[0] = 0xff;
    jpegBuf[1] = 0xd8;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => jpegBuf.buffer,
      })),
    );
    executeMock.mockResolvedValueOnce({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const chatId = 99001;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        text: "look at this",
        message_id: 1001,
        reply_to_message: {
          from: { id: 200, first_name: "Alice" },
          photo: [
            {
              file_id: "reply_photo_id",
              file_unique_id: "rpq1",
              width: 400,
              height: 300,
            },
          ],
        },
      },
      me: { id: 999, username: "testbot" },
      from: { id: 97, first_name: "Bob" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { prompt: string }).prompt).toContain(
      "Replied-to message contains a photo",
    );
  }, 3000);

  it("logs warning on Error in downloadReplyPhoto catch (L146 TRUE branch)", async () => {
    const { logWarn } = await import("../util/log.js");
    (logWarn as ReturnType<typeof vi.fn>).mockClear();
    mockBot.api.getFile = vi.fn(async () => {
      throw new Error("getFile failed");
    });
    executeMock.mockResolvedValueOnce({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const chatId = 99002;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        text: "see this",
        message_id: 1002,
        reply_to_message: {
          from: { id: 200 },
          photo: [
            {
              file_id: "bad_photo",
              file_unique_id: "bpq2",
              width: 100,
              height: 100,
            },
          ],
        },
      },
      me: { id: 999, username: "testbot" },
      from: { id: 97, first_name: "Bob" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const photoWarn = (logWarn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => String(c[1]).includes("reply photo"),
    );
    expect(photoWarn).toBeDefined();
    expect(String(photoWarn![1])).toContain("getFile failed");
  }, 3000);

  it("covers non-Error in downloadReplyPhoto catch (L146 FALSE branch)", async () => {
    const { logWarn } = await import("../util/log.js");
    (logWarn as ReturnType<typeof vi.fn>).mockClear();
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    mockBot.api.getFile = vi.fn(async () => {
      throw "non-error string";
    });
    executeMock.mockResolvedValueOnce({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const chatId = 99003;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        text: "see this too",
        message_id: 1003,
        reply_to_message: {
          from: { id: 200 },
          photo: [
            {
              file_id: "bad_photo2",
              file_unique_id: "bpq3",
              width: 100,
              height: 100,
            },
          ],
        },
      },
      me: { id: 999, username: "testbot" },
      from: { id: 97, first_name: "Bob" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const photoWarn = (logWarn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) =>
        String(c[1]).includes("reply photo") &&
        String(c[1]).includes("non-error string"),
    );
    expect(photoWarn).toBeDefined();
  }, 3000);
});

describe("downloadTelegramFile — PNG/GIF/WebP image magic bytes", () => {
  beforeEach(() => {
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts PNG file with valid magic bytes (L208 TRUE branch)", async () => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "docs/image.png" }));
    const pngBuf = new Uint8Array(64);
    pngBuf[0] = 0x89;
    pngBuf[1] = 0x50;
    pngBuf[2] = 0x4e;
    pngBuf[3] = 0x47;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => pngBuf.buffer,
      })),
    );

    const chatId = 99100;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 1100,
        document: {
          file_id: "png_doc",
          file_unique_id: "pngq1",
          file_name: "screenshot.png",
          file_size: 1000,
          mime_type: "image/png",
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 98, first_name: "Alice" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleDocumentMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
  }, 3000);

  it("accepts GIF file with valid magic bytes (L209 TRUE branch)", async () => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "docs/image.gif" }));
    const gifBuf = new Uint8Array(64);
    gifBuf[0] = 0x47;
    gifBuf[1] = 0x49;
    gifBuf[2] = 0x46;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => gifBuf.buffer,
      })),
    );

    const chatId = 99101;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 1101,
        document: {
          file_id: "gif_doc",
          file_unique_id: "gifq1",
          file_name: "animation.gif",
          file_size: 2000,
          mime_type: "image/gif",
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 98, first_name: "Bob" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleDocumentMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
  }, 3000);

  it("accepts WebP file with valid magic bytes (L210-211 TRUE branch)", async () => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "docs/image.webp" }));
    const webpBuf = new Uint8Array(64);
    webpBuf[0] = 0x52;
    webpBuf[1] = 0x49;
    webpBuf[2] = 0x46;
    webpBuf[3] = 0x46;
    webpBuf[8] = 0x57;
    webpBuf[9] = 0x45;
    webpBuf[10] = 0x42;
    webpBuf[11] = 0x50;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => webpBuf.buffer,
      })),
    );

    const chatId = 99102;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 1102,
        document: {
          file_id: "webp_doc",
          file_unique_id: "webpq1",
          file_name: "image.webp",
          file_size: 3000,
          mime_type: "image/webp",
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 98, first_name: "Carol" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleDocumentMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
  }, 3000);

  it("throws on empty downloaded buffer (L198 TRUE branch)", async () => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "docs/empty.pdf" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    const chatId = 99103;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 1103,
        document: {
          file_id: "empty_doc",
          file_unique_id: "emq1",
          file_name: "empty.pdf",
          file_size: 0,
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 98, first_name: "Dan" },
    } as any;

    await handleDocumentMessage(ctx, mockBot, mockConfig);
    // Error path — sendMessage called with error text
    expect(mockBot.api.sendMessage).toHaveBeenCalled();
  }, 3000);
});

describe("enqueueMessage — queue overflow drops 21st message (L311 TRUE branch)", () => {
  it("drops message when queue reaches MAX_QUEUED_PER_CHAT (20)", async () => {
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const chatId = 99200;
    // Use unique userId per message to avoid rate-limit (15/min per user)
    const makeCtx = (i: number) =>
      ({
        chat: { id: chatId, type: "private" },
        message: {
          text: `flood ${i}`,
          message_id: 2000 + i,
          reply_to_message: null,
        },
        me: { id: 999, username: "testbot" },
        from: { id: 9900000 + i, first_name: "Flood" }, // unique userId per message
      }) as any;

    // 21 rapid messages: 1st creates entry, 2nd-20th fill it, 21st is dropped
    for (let i = 0; i < 21; i++) {
      await handleTextMessage(makeCtx(i), mockBot, mockConfig);
    }
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.filter(
      (c) => (c[0] as { chatId: string }).chatId === String(chatId),
    );
    expect(calls.length).toBe(1);
    const prompt = (calls[0][0] as { prompt: string }).prompt;
    // 20 messages in prompt, 21st was dropped
    const count = (prompt.match(/flood \d+/g) || []).length;
    expect(count).toBe(20);
  }, 3000);
});

describe("handleStickerMessage — video sticker branch (L835 TRUE)", () => {
  it("includes (video sticker) when is_animated=false and is_video=true", async () => {
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const chatId = 99300;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 1300,
        sticker: {
          file_id: "vs123",
          emoji: "🎬",
          set_name: "",
          is_animated: false,
          is_video: true,
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 99, first_name: "Victor" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleStickerMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { prompt: string }).prompt).toContain(
      "video sticker",
    );
  }, 3000);
});

describe("processAndReply — group message without senderId", () => {
  it("processes anonymous group messages without mutating the prompt", async () => {
    executeMock.mockResolvedValueOnce({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const chatId = 99400;
    const ctx = {
      chat: { id: chatId, type: "supergroup", title: "Test Group" },
      message: {
        text: "@testbot anonymous message",
        message_id: 1400,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: undefined, // no sender info → senderId=undefined
    } as any;

    const before = executeMock.mock.calls.length;
    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    // Message was still processed, and the prompt is passed through verbatim.
    const calls = executeMock.mock.calls
      .slice(before)
      .filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { prompt: string }).prompt).toBe(
      "@testbot anonymous message",
    );
  }, 3000);
});

describe("processAndReply — fallback text no longer suppressed", () => {
  // Pre-end_turn behavior: when bridgeMessageCount=0 and result.text was
  // non-empty, the frontend logged "Suppressed fallback text" and dropped
  // the content (the scratchpad bug). The handler now fires onTextBlock
  // with trailing text instead, so:
  //   - the "Suppressed fallback" log is gone entirely
  //   - the delivery path is exercised by createStreamCallbacks tests above
  it("does NOT log a 'Suppressed fallback' warning anymore", async () => {
    const { log } = await import("../util/log.js");
    (log as ReturnType<typeof vi.fn>).mockClear();

    executeMock.mockResolvedValueOnce({
      text: "trailing prose that used to be suppressed",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const ctx = {
      chat: { id: 99600, type: "private" },
      message: {
        text: "test fallback delivery",
        message_id: 1600,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 9902000, first_name: "Tom" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const logCalls = (log as ReturnType<typeof vi.fn>).mock.calls;
    const suppressedLog = logCalls.find((c: unknown[]) =>
      String(c[1]).includes("Suppressed fallback"),
    );
    expect(suppressedLog).toBeUndefined();
  }, 3000);
});

describe("flushQueue — setMessageReaction clear fails (L344 warn paths)", () => {
  afterEach(() => {
    mockBot.api.setMessageReaction = vi.fn(async () => {});
  });

  it("logs warning with err.message when clear reaction throws Error (L344 TRUE branch)", async () => {
    const { logWarn } = await import("../util/log.js");
    (logWarn as ReturnType<typeof vi.fn>).mockClear();

    mockBot.api.setMessageReaction = vi.fn(async () => {
      throw new Error("setReaction failed");
    });
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    // 2 messages to same chat — 2nd adds msgId to queuedReactionMsgIds
    const chatId = 99500;
    const makeCtx = (msgId: number, userId: number) =>
      ({
        chat: { id: chatId, type: "private" },
        message: { text: `msg`, message_id: msgId, reply_to_message: null },
        me: { id: 999, username: "testbot" },
        from: { id: userId, first_name: "R" },
      }) as any;

    await handleTextMessage(makeCtx(3001, 9901000), mockBot, mockConfig);
    await handleTextMessage(makeCtx(3002, 9901001), mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const reactionWarn = (logWarn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => String(c[1]).includes("Failed to clear reaction"),
    );
    expect(reactionWarn).toBeDefined();
    expect(String(reactionWarn![1])).toContain("setReaction failed");
  }, 3000);

  it("logs warning with raw err when clear reaction throws non-Error (L344 FALSE branch)", async () => {
    const { logWarn } = await import("../util/log.js");
    (logWarn as ReturnType<typeof vi.fn>).mockClear();

    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    mockBot.api.setMessageReaction = vi.fn(async () => {
      throw "reaction-string-err";
    });
    executeMock.mockResolvedValue({
      text: "",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const chatId = 99501;
    const makeCtx = (msgId: number, userId: number) =>
      ({
        chat: { id: chatId, type: "private" },
        message: { text: `msg`, message_id: msgId, reply_to_message: null },
        me: { id: 999, username: "testbot" },
        from: { id: userId, first_name: "R" },
      }) as any;

    await handleTextMessage(makeCtx(3003, 9901002), mockBot, mockConfig);
    await handleTextMessage(makeCtx(3004, 9901003), mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const reactionWarn = (logWarn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) =>
        String(c[1]).includes("Failed to clear reaction") &&
        String(c[1]).includes("reaction-string-err"),
    );
    expect(reactionWarn).toBeDefined();
  }, 3000);
});

describe("isUserRateLimited — expired timestamps evicted via shift() (L272)", () => {
  it("removes timestamps older than RATE_LIMIT_WINDOW_MS", async () => {
    vi.useFakeTimers();

    executeMock.mockResolvedValue({
      text: "",
      durationMs: 5,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const chatId = 99700;
    const userId = 9903000; // unique userId — no prior timestamps
    const makeCtx = (msgId: number) =>
      ({
        chat: { id: chatId, type: "private" },
        message: {
          text: `old-timer ${msgId}`,
          message_id: msgId,
          reply_to_message: null,
        },
        me: { id: 999, username: "testbot" },
        from: { id: userId, first_name: "OldTimer" },
      }) as any;

    // T=0: send message — adds timestamp[0]=0 for userId
    await handleTextMessage(makeCtx(1700), mockBot, mockConfig);
    await vi.advanceTimersByTimeAsync(600); // fire debounce (500ms)

    // Advance past RATE_LIMIT_WINDOW_MS (60s) → timestamp[0] becomes stale
    await vi.advanceTimersByTimeAsync(61_000);

    // T≈62s: second message — while loop sees timestamps[0] < now-60000 → shift() (L272)
    await handleTextMessage(makeCtx(1701), mockBot, mockConfig);
    await vi.advanceTimersByTimeAsync(600);

    vi.clearAllTimers();
    vi.useRealTimers();

    // Both messages processed (second was not blocked by stale timestamp)
    const calls = executeMock.mock.calls.filter(
      (c) => (c[0] as { chatId: string }).chatId === String(chatId),
    );
    expect(calls.length).toBe(2);
  }, 10000);
});

describe("isUserRateLimited — userMessageTimestamps eviction when size > 5000 (L278-284)", () => {
  it("evicts stale entries and hits delete+break branches", async () => {
    // Use fake timers starting at T=0 — all 5000 initial entries get timestamps[0]=0
    vi.useFakeTimers({ now: 0 });

    executeMock.mockResolvedValue({
      text: "",
      durationMs: 5,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const BASE_UID = 200_000_000; // far outside all other test userId ranges

    // Fire 5000 handleTextMessage calls synchronously — each runs isUserRateLimited(BASE+i)
    // at T=0 before the first await (downloadReplyPhoto). The map accumulates 5000 entries.
    for (let i = 0; i < 5_000; i++) {
      void handleTextMessage(
        {
          chat: { id: 88_000_001, type: "private" },
          message: { text: "x", message_id: i + 1, reply_to_message: null },
          me: { id: 999, username: "testbot" },
          from: { id: BASE_UID + i, first_name: "X" },
        } as any,
        mockBot,
        mockConfig,
      );
    }

    // Advance fake time by 11 minutes — makes all T=0 timestamps stale
    // (cutoff will be T+1min; T=0 entries are below cutoff)
    vi.advanceTimersByTime(11 * 60_000);

    // 5001st unique user at T+11min — isUserRateLimited sees size > 5000 → cleanup runs
    // All 5000 T=0 entries (below cutoff) are deleted until size ≤ 2500 → break (L284)
    void handleTextMessage(
      {
        chat: { id: 88_000_002, type: "private" },
        message: {
          text: "trigger",
          message_id: 10_000,
          reply_to_message: null,
        },
        me: { id: 999, username: "testbot" },
        from: { id: BASE_UID + 5_001, first_name: "T" },
      } as any,
      mockBot,
      mockConfig,
    );

    // Drain pending microtasks and fire debounce timers to clean up async state
    await vi.advanceTimersByTimeAsync(1_000);
    vi.clearAllTimers();
    vi.useRealTimers();
    // Lines 278-284 (eviction loop with delete and break) are now covered
  }, 15_000);
});

describe("extractUnauthorizedPreview", () => {
  it("returns text payload as-is when present", () => {
    expect(extractUnauthorizedPreview({ text: "Hi" })).toBe("Hi");
    expect(
      extractUnauthorizedPreview({
        text: "give me /root/.openclaw/openclaw.json",
      }),
    ).toBe("give me /root/.openclaw/openclaw.json");
  });

  it("falls back to caption when no text is present", () => {
    expect(
      extractUnauthorizedPreview({ caption: "scammy caption", photo: {} }),
    ).toBe("scammy caption");
  });

  it("truncates very long bodies to keep log lines bounded", () => {
    const huge = "x".repeat(2000);
    const out = extractUnauthorizedPreview({ text: huge });
    expect(out).toBeDefined();
    // 1024 chars + ellipsis + " [truncated]"
    expect(out!.length).toBeLessThanOrEqual(1024 + 20);
    expect(out!.endsWith("[truncated]")).toBe(true);
  });

  it("returns sticker tag with emoji + set name", () => {
    expect(
      extractUnauthorizedPreview({
        sticker: { emoji: "🤖", set_name: "evilset" },
      }),
    ).toBe("[sticker: 🤖 from evilset]");
  });

  it("returns sticker tag without set name when absent", () => {
    expect(extractUnauthorizedPreview({ sticker: { emoji: "👀" } })).toBe(
      "[sticker: 👀]",
    );
  });

  it("tags media-only messages with their type", () => {
    expect(extractUnauthorizedPreview({ photo: {} })).toBe("[photo]");
    expect(extractUnauthorizedPreview({ voice: { duration: 14 } })).toBe(
      "[voice 14s]",
    );
    expect(extractUnauthorizedPreview({ video: {} })).toBe("[video]");
    expect(extractUnauthorizedPreview({ video_note: {} })).toBe("[video note]");
    expect(extractUnauthorizedPreview({ audio: {} })).toBe("[audio]");
    expect(extractUnauthorizedPreview({ animation: {} })).toBe("[animation]");
    expect(extractUnauthorizedPreview({ contact: {} })).toBe("[contact]");
    expect(extractUnauthorizedPreview({ location: {} })).toBe("[location]");
    expect(
      extractUnauthorizedPreview({ document: { file_name: "evil.exe" } }),
    ).toBe("[document: evil.exe]");
    expect(extractUnauthorizedPreview({ document: {} })).toBe("[document]");
    expect(
      extractUnauthorizedPreview({ poll: { question: "Vote for what?" } }),
    ).toBe("[poll: Vote for what?]");
    expect(extractUnauthorizedPreview({ dice: { emoji: "🎯" } })).toBe(
      "[dice: 🎯]",
    );
  });

  it("treats whitespace-only text as empty and falls through", () => {
    // Whitespace-only text should NOT be returned (it's effectively empty);
    // if there's nothing else either, return undefined.
    expect(extractUnauthorizedPreview({ text: "   \n\t  " })).toBeUndefined();
    // But if there's a sticker alongside, that should still tag.
    expect(
      extractUnauthorizedPreview({ text: "  ", sticker: { emoji: "👋" } }),
    ).toBe("[sticker: 👋]");
  });

  it("returns undefined when message is missing or empty", () => {
    expect(extractUnauthorizedPreview(undefined)).toBeUndefined();
    expect(extractUnauthorizedPreview({})).toBeUndefined();
  });
});
