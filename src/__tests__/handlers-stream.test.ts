/**
 * Tests for createStreamCallbacks — specifically the onStreamDelta path that
 * requires draftsSupported === null (fresh module state).
 *
 * This file uses vi.resetModules() in beforeEach to guarantee a fresh handlers.ts
 * where the module-level `draftsSupported` variable starts at null.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// These mocks are hoisted and apply to every fresh import within the test.
// These suites exercise the message pipeline, not access control (covered by
// telegram-access-defaults / telegram-blocked-users): admit every sender.
vi.mock("../frontend/telegram/handlers/access.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../frontend/telegram/handlers/access.js")
  >()),
  isAccessAllowed: vi.fn(async () => true),
}));
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/engine/dispatcher.js", () => ({
  execute: vi.fn(),
}));

vi.mock("../core/errors.js", () => ({
  classify: vi.fn(() => ({
    reason: "unknown",
    message: "error",
    retryable: false,
  })),
  friendlyMessage: vi.fn(() => "Something went wrong"),
  TalonError: class TalonError extends Error {},
  RETRY_ELAPSED_CAP_MS: 120_000,
}));

vi.mock("../storage/daily-log.js", () => ({
  appendDailyLog: vi.fn(),
  appendDailyLogResponse: vi.fn(),
}));

vi.mock("../storage/history.js", () => ({
  setMessageFilePath: vi.fn(),
  getHistory: vi.fn(() => []),
}));

vi.mock("../storage/media-index.js", () => ({
  addMedia: vi.fn(),
}));

vi.mock("../storage/sessions.js", () => ({
  getSession: vi.fn(() => ({
    turns: 0,
    lastActive: Date.now(),
    createdAt: Date.now(),
  })),
  incrementTurns: vi.fn(),
  recordUsage: vi.fn(),
  resetSession: vi.fn(),
  getSessionInfo: vi.fn(() => ({
    sessionId: undefined,
    turns: 0,
    lastActive: 0,
    createdAt: 0,
    usage: {},
  })),
  setSessionId: vi.fn(),
  setLastBotMessageId: vi.fn(),
  getLastBotMessageId: vi.fn(),
  getActiveSessionCount: vi.fn(() => 0),
  setSessionName: vi.fn(),
  getAllSessions: vi.fn(() => []),
  loadSessions: vi.fn(),
}));

vi.mock("../util/watchdog.js", () => ({
  recordMessageProcessed: vi.fn(),
  recordMessageReceived: vi.fn(),
  recordMessageSettled: vi.fn(),
  recordError: vi.fn(),
  getHealthStatus: vi.fn(() => ({
    healthy: true,
    totalMessagesProcessed: 0,
    recentErrorCount: 0,
    msSinceLastMessage: 0,
  })),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

vi.mock("../storage/cron.js", () => ({
  addCronJob: vi.fn(),
  getCronJob: vi.fn(),
  getCronJobsForChat: vi.fn(() => []),
  updateCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  validateCronExpression: vi.fn(() => ({
    valid: true,
    next: new Date().toISOString(),
  })),
  generateCronId: vi.fn(() => "test-id"),
  loadCronJobs: vi.fn(),
}));

const mockConfig = {
  botToken: "test-token",
  allowedUserIds: [],
  model: "claude-sonnet-4-6",
  systemPrompt: "You are helpful.",
  maxTokens: 8096,
  workspaceDir: "/tmp/test-workspace",
  plugins: [],
};

describe("createStreamCallbacks — onStreamDelta streaming disabled path", () => {
  let handleTextMessage: (
    ctx: unknown,
    bot: unknown,
    config: unknown,
  ) => Promise<void>;
  let executeMock: ReturnType<typeof vi.fn>;
  let sendMessageDraftMock: ReturnType<typeof vi.fn>;
  let logWarnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    delete process.env.TALON_DISABLE_LEGACY_IMPORT;
    vi.resetModules();
    // Fresh import gives us draftsSupported === null
    const handlers = await import("../frontend/telegram/handlers/index.js");
    handleTextMessage = handlers.handleTextMessage as unknown as (
      ctx: unknown,
      bot: unknown,
      config: unknown,
    ) => Promise<void>;

    const dispatcher = await import("../core/engine/dispatcher.js");
    executeMock = dispatcher.execute as ReturnType<typeof vi.fn>;

    const log = await import("../util/log.js");
    logWarnMock = log.logWarn as ReturnType<typeof vi.fn>;
  });

  it("disables streaming and logs warning when sendMessageDraft throws (draftsSupported=null)", async () => {
    sendMessageDraftMock = vi.fn(async () => {
      throw new Error("method not found");
    });

    const mockBot = {
      api: {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        sendMessageDraft: sendMessageDraftMock,
        getFile: vi.fn(async () => ({ file_path: "test" })),
      },
    };

    executeMock.mockImplementationOnce(
      async (params: Record<string, unknown>) => {
        const onEvent = params.onEvent as (
          event: Record<string, unknown>,
        ) => void | Promise<void>;
        // Wait for the 1000ms stream.started timer to fire
        await new Promise((r) => setTimeout(r, 1100));
        // With draftsSupported === null and state.started = true, the
        // text_delta event drives a draft edit (re-accumulated to 50 chars).
        await onEvent?.({ type: "text_delta", text: "x".repeat(50) });
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
      chat: { id: 99001, type: "private" },
      message: {
        text: "streaming disabled test",
        message_id: 980,
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 96, first_name: "TestUser" },
    };

    await handleTextMessage(ctx, mockBot, mockConfig);
    // Wait for debounce (500ms) + executeMock sleep (1100ms) + buffer
    await new Promise((r) => setTimeout(r, 2000));

    // sendMessageDraft was called, then threw → draftsSupported set to false
    expect(sendMessageDraftMock).toHaveBeenCalled();
    // logWarn should be called with the "streaming disabled" message
    expect(logWarnMock).toHaveBeenCalledWith(
      "bot",
      expect.stringContaining("streaming disabled"),
    );
  }, 5000);
});
