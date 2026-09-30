import { describe, it, expect, vi, beforeEach } from "vitest";
import { stubBackend } from "./helpers/stub-backend.js";

// Mock dependencies
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("picocolors", () => ({
  default: {
    cyan: (s: string) => s,
    green: (s: string) => s,
    dim: (s: string) => s,
    red: (s: string) => s,
    bold: (s: string) => s,
    yellow: (s: string) => s,
    blue: (s: string) => s,
    magenta: (s: string) => s,
    underline: (s: string) => s,
  },
}));

const mockGetRecentHistory = vi.fn((_chatId: string, _limit?: number) => [
  { text: "hello there" },
  { text: "a reply" },
]);
vi.mock("../storage/history.js", () => ({
  getRecentHistory: (chatId: string, limit?: number) =>
    mockGetRecentHistory(chatId, limit),
}));

// Mock storage modules that commands import dynamically.
// We use wrapper functions so vi.fn() instances can be swapped per-test.
const mockGetChatSettings = vi.fn(
  (_chatId: string): Record<string, unknown> => ({}),
);
const mockSetChatModel = vi.fn();
const mockSetChatEffort = vi.fn();
const mockResolveModelName = vi.fn((s: string) => `claude-${s}`);
vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: (chatId: string) => mockGetChatSettings(chatId),
  setChatModel: (chatId: string, model: string) =>
    mockSetChatModel(chatId, model),
  setChatEffort: (chatId: string, effort: string | undefined) =>
    mockSetChatEffort(chatId, effort),
}));
vi.mock("../core/models/catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/models/catalog.js")>()),
  resolveModelId: (s: string) => mockResolveModelName(s),
}));

// /effort validates against the active model's levels, as on every
// other frontend. Pretend the active model registers these.
const mockReasoningLevels = vi.fn(() => ["low", "medium", "high", "max"]);
vi.mock(
  "../frontend/presentation/reasoning-levels.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../frontend/presentation/reasoning-levels.js")
    >()),
    getActiveReasoningLevels: async () => ({
      activeModel: "claude-sonnet-4-6",
      levels: mockReasoningLevels(),
    }),
  }),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetSession = vi.fn((_chatId: string): any => ({
  turns: 0,
  sessionName: undefined,
  usage: {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    lastPromptTokens: 0,
    estimatedCostUsd: 0,
    totalResponseMs: 0,
    lastResponseMs: 0,
    fastestResponseMs: Infinity,
  },
}));
const mockGetSessionInfo = vi.fn((_chatId: string): any => ({
  turns: 0,
  usage: {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    lastPromptTokens: 0,
    estimatedCostUsd: 0,
    totalResponseMs: 0,
    lastResponseMs: 0,
    fastestResponseMs: Infinity,
  },
}));
const mockSetSessionName = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAllSessions = vi.fn((): any[] => []);
vi.mock("../storage/sessions.js", () => ({
  getSession: (chatId: string) => mockGetSession(chatId),
  getSessionInfo: (chatId: string) => mockGetSessionInfo(chatId),
  setSessionName: (chatId: string, name: string) =>
    mockSetSessionName(chatId, name),
  getAllSessions: () => mockGetAllSessions(),
}));

const mockGetLoadedPlugins = vi.fn(
  () =>
    [] as Array<{
      plugin: Record<string, unknown>;
      config: Record<string, unknown>;
      envVars: Record<string, string>;
      path: string;
    }>,
);
vi.mock("../core/plugin/index.js", () => ({
  getLoadedPlugins: () => mockGetLoadedPlugins(),
}));

import {
  registerCommand,
  tryRunCommand,
  getCommands,
  clearCommands,
  registerBuiltinCommands,
  type CommandContext,
} from "../frontend/terminal/commands.js";

// ── Test helper ──────────────────────────────────────────────────────────────

function makeMockContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    chatId: () => "t_test_123",
    config: { model: "claude-sonnet-4-6" } as CommandContext["config"],
    renderer: {
      cols: 100,
      writeln: vi.fn(),
      writeSystem: vi.fn(),
      writeError: vi.fn(),
      renderAssistantMessage: vi.fn(),
      renderToolCall: vi.fn(),
      renderStatusLine: vi.fn(),
      startSpinner: vi.fn(),
      updateSpinnerLabel: vi.fn(),
      stopSpinner: vi.fn(),
    } as unknown as CommandContext["renderer"],
    reprompt: vi.fn(),
    initNewChat: vi.fn(),
    waitForInput: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
    ...overrides,
  };
}

// ── Registry ─────────────────────────────────────────────────────────────────

describe("command registry", () => {
  beforeEach(() => {
    clearCommands();
  });

  it("registers and retrieves commands", () => {
    registerCommand({
      name: "test",
      description: "A test command",
      handler: vi.fn(),
    });
    expect(getCommands()).toHaveLength(1);
    expect(getCommands()[0]!.name).toBe("test");
  });

  it("clearCommands empties the registry", () => {
    registerCommand({
      name: "test",
      description: "A test",
      handler: vi.fn(),
    });
    clearCommands();
    expect(getCommands()).toHaveLength(0);
  });

  it("tryRunCommand returns false for non-slash text", async () => {
    const ctx = makeMockContext();
    expect(await tryRunCommand("hello world", ctx)).toBe(false);
  });

  it("tryRunCommand returns false for unknown slash command", async () => {
    const ctx = makeMockContext();
    expect(await tryRunCommand("/unknown", ctx)).toBe(false);
  });

  it("tryRunCommand dispatches to registered handler", async () => {
    const handler = vi.fn();
    registerCommand({ name: "ping", description: "Ping", handler });
    const ctx = makeMockContext();

    const result = await tryRunCommand("/ping", ctx);
    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledWith("", ctx);
  });

  it("tryRunCommand passes args after command name", async () => {
    const handler = vi.fn();
    registerCommand({ name: "echo", description: "Echo", handler });
    const ctx = makeMockContext();

    await tryRunCommand("/echo hello world", ctx);
    expect(handler).toHaveBeenCalledWith("hello world", ctx);
  });

  it("tryRunCommand supports aliases", async () => {
    const handler = vi.fn();
    registerCommand({
      name: "quit",
      aliases: ["exit", "q"],
      description: "Quit",
      handler,
    });
    const ctx = makeMockContext();

    await tryRunCommand("/exit", ctx);
    expect(handler).toHaveBeenCalledTimes(1);

    await tryRunCommand("/q", ctx);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("tryRunCommand is case-insensitive for command names", async () => {
    const handler = vi.fn();
    registerCommand({ name: "test", description: "Test", handler });
    const ctx = makeMockContext();

    await tryRunCommand("/TEST", ctx);
    expect(handler).toHaveBeenCalled();
  });
});

// ── Built-in commands ────────────────────────────────────────────────────────

describe("built-in commands", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltinCommands();
    vi.clearAllMocks();
  });

  it("registers all expected commands", () => {
    const names = getCommands().map((c) => c.name);
    expect(names).toContain("model");
    expect(names).toContain("effort");
    expect(names).toContain("status");
    expect(names).toContain("context");
    expect(names).toContain("reset");
    expect(names).toContain("resume");
    expect(names).toContain("rename");
    expect(names).toContain("help");
    expect(names).toContain("quit");
  });

  it("/reset calls initNewChat and reprompt", async () => {
    const ctx = makeMockContext();
    await tryRunCommand("/reset", ctx);
    expect(ctx.initNewChat).toHaveBeenCalled();
    expect(ctx.renderer.writeSystem).toHaveBeenCalledWith("Session cleared.");
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  it("/quit calls close", async () => {
    const ctx = makeMockContext();
    await tryRunCommand("/quit", ctx);
    expect(ctx.close).toHaveBeenCalled();
  });

  it("/exit also calls close (alias)", async () => {
    const ctx = makeMockContext();
    await tryRunCommand("/exit", ctx);
    expect(ctx.close).toHaveBeenCalled();
  });

  it("/help lists commands via renderer.writeln", async () => {
    const ctx = makeMockContext();
    await tryRunCommand("/help", ctx);
    const writelnMock = ctx.renderer.writeln as ReturnType<typeof vi.fn>;
    expect(writelnMock.mock.calls.length).toBeGreaterThanOrEqual(
      getCommands().length,
    );
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  describe("/model", () => {
    it("shows current model when no arg given", async () => {
      // getChatSettings is called twice: once at handler entry, once in the
      // non-opencode branch — use mockReturnValue so both calls see the model.
      mockGetChatSettings.mockReturnValue({ model: "claude-opus-4-6" });
      const ctx = makeMockContext();
      await tryRunCommand("/model", ctx);
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        expect.stringContaining("claude-opus-4-6"),
      );
      mockGetChatSettings.mockImplementation(
        (_chatId: string): Record<string, unknown> => ({}),
      );
    });

    it("sets model when arg given", async () => {
      const ctx = makeMockContext();
      await tryRunCommand("/model opus", ctx);
      expect(mockSetChatModel).toHaveBeenCalledWith(
        "t_test_123",
        "claude-opus",
      );
    });

    it("stores provider-qualified model selections via backend.models?.resolveModelInfo", async () => {
      const ctx = makeMockContext({
        config: { model: "nemotron-3-super-free" } as any,
        backend: stubBackend({
          query: vi.fn() as any,
          resolveModel: vi.fn().mockResolvedValue({
            kind: "exact",
            model: {
              id: "gpt-5",
              displayName: "GPT-5",
              provider: "github-copilot",
              providerName: "GitHub Copilot",
              free: false,
              selectable: true,
            },
            storedValue: "github-copilot/gpt-5",
          }),
          formatModelError: vi.fn(),
        }),
      });

      await tryRunCommand("/model github-copilot/gpt-5", ctx);

      expect(mockSetChatModel).toHaveBeenCalledWith(
        "t_test_123",
        "github-copilot/gpt-5",
      );
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        expect.stringContaining("GPT-5"),
      );
    });
  });

  describe("/rename", () => {
    it("shows current name when session has one", async () => {
      mockGetSession.mockReturnValueOnce({ sessionName: "my session" });
      // Second call inside handler also returns the same
      mockGetSession.mockReturnValueOnce({ sessionName: "my session" });
      const ctx = makeMockContext();
      await tryRunCommand("/rename", ctx);
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        expect.stringContaining("my session"),
      );
    });

    it("shows 'no name' when session is unnamed", async () => {
      mockGetSession.mockReturnValueOnce({ sessionName: undefined });
      mockGetSession.mockReturnValueOnce({ sessionName: undefined });
      const ctx = makeMockContext();
      await tryRunCommand("/rename", ctx);
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        "Session has no name.",
      );
    });

    it("sets name when arg provided", async () => {
      const ctx = makeMockContext();
      await tryRunCommand("/rename new name", ctx);
      expect(mockSetSessionName).toHaveBeenCalledWith("t_test_123", "new name");
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        expect.stringContaining("new name"),
      );
    });
  });

  describe("/resume", () => {
    it("shows message when no sessions exist", async () => {
      mockGetAllSessions.mockReturnValueOnce([]);
      const ctx = makeMockContext();
      await tryRunCommand("/resume", ctx);
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        "No previous sessions to resume.",
      );
    });

    it("lists sessions and resumes on valid selection", async () => {
      mockGetAllSessions.mockReturnValueOnce([
        {
          chatId: "t_old_session",
          info: {
            turns: 5,
            lastActive: Date.now() - 3600_000,
            sessionName: "debugging",
            lastModel: "claude-opus-4-6",
          },
        },
      ]);
      const ctx = makeMockContext({
        waitForInput: vi.fn().mockResolvedValue("1"),
      });
      await tryRunCommand("/resume", ctx);
      expect(ctx.initNewChat).toHaveBeenCalledWith("t_old_session");
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        expect.stringContaining("Resumed"),
      );
    });

    it("cancels on empty input", async () => {
      mockGetAllSessions.mockReturnValueOnce([
        {
          chatId: "t_old",
          info: { turns: 1, lastActive: Date.now() },
        },
      ]);
      const ctx = makeMockContext({
        waitForInput: vi.fn().mockResolvedValue(""),
      });
      await tryRunCommand("/resume", ctx);
      expect(ctx.initNewChat).not.toHaveBeenCalled();
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith("Cancelled.");
    });

    it("cancels on invalid number", async () => {
      mockGetAllSessions.mockReturnValueOnce([
        {
          chatId: "t_old",
          info: { turns: 1, lastActive: Date.now() },
        },
      ]);
      const ctx = makeMockContext({
        waitForInput: vi.fn().mockResolvedValue("99"),
      });
      await tryRunCommand("/resume", ctx);
      expect(ctx.initNewChat).not.toHaveBeenCalled();
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith("Cancelled.");
    });

    it("shows turn count when session has no name (false ternary branch)", async () => {
      // Selected session has no sessionName → shows "(N turns)" instead of '"name"'
      mockGetAllSessions.mockReturnValueOnce([
        {
          chatId: "t_unnamed_session",
          info: { turns: 3, lastActive: Date.now(), sessionName: undefined },
        },
      ]);
      const ctx = makeMockContext({
        waitForInput: vi.fn().mockResolvedValue("1"),
      });
      await tryRunCommand("/resume", ctx);
      expect(ctx.initNewChat).toHaveBeenCalledWith("t_unnamed_session");
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        expect.stringContaining("3 turns"),
      );
    });
  });

  describe("/model — ?? fallback to config.model", () => {
    it("shows config model when getChatSettings has no model set", async () => {
      // Default mockGetChatSettings returns {} (no model) → triggers ?? ctx.config.model
      mockGetChatSettings.mockReturnValueOnce({});
      const ctx = makeMockContext();
      await tryRunCommand("/model", ctx);
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        expect.stringContaining("claude-sonnet-4-6"),
      );
    });
  });
});

describe("/status command", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltinCommands();
  });

  it("displays session stats without plugins", async () => {
    mockGetSessionInfo.mockReturnValueOnce({
      turns: 5,
      sessionName: undefined,
      usage: {
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCacheRead: 200,
        totalCacheWrite: 0,
        lastPromptTokens: 100,
        contextTokens: 100,
        contextWindow: 200_000,
        estimatedCostUsd: 0.01,
        totalResponseMs: 5000,
        lastResponseMs: 1000,
        fastestResponseMs: 500,
      },
    });
    const ctx = makeMockContext();
    await tryRunCommand("/status", ctx);
    const output = (ctx.renderer.writeln as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(" ");
    expect(output).toContain("Context");
    expect(output).toContain("0%");
    expect(output).toContain("$0.0100");
    expect(output).toContain("response last 1s");
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  it("warns when the current context is at least 80% full", async () => {
    mockGetSessionInfo.mockReturnValueOnce({
      turns: 2,
      usage: {
        totalInputTokens: 10_000,
        totalOutputTokens: 500,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        lastPromptTokens: 160_000,
        contextTokens: 160_000,
        contextWindow: 200_000,
        estimatedCostUsd: 0,
        totalResponseMs: 2000,
        lastResponseMs: 1000,
        fastestResponseMs: 1000,
      },
    });

    const ctx = makeMockContext();
    await tryRunCommand("/status", ctx);
    const output = (ctx.renderer.writeln as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(" ");
    expect(output).toContain("80%");
    expect(output).toContain("nearing limit");
  });

  it("displays session name when set", async () => {
    mockGetSessionInfo.mockReturnValueOnce({
      turns: 3,
      sessionName: "My Work Session",
      usage: {
        totalInputTokens: 500,
        totalOutputTokens: 200,
        totalCacheRead: 100,
        totalCacheWrite: 0,
        lastPromptTokens: 50,
        estimatedCostUsd: 0.005,
        totalResponseMs: 2000,
        lastResponseMs: 500,
        fastestResponseMs: 300,
      },
    });
    const ctx = makeMockContext();
    await tryRunCommand("/status", ctx);
    // Should mention the session name
    const calls = (
      ctx.renderer.writeln as ReturnType<typeof vi.fn>
    ).mock.calls.flat();
    const output = calls.join(" ");
    expect(output).toContain("My Work Session");
  });

  it("/status shows plugins section when plugins are loaded", async () => {
    mockGetLoadedPlugins.mockReturnValueOnce([
      {
        plugin: {
          name: "my-plugin",
          version: "1.0",
          description: "A test plugin",
          mcpServerPath: "/path/tools.ts",
        },
        config: {},
        envVars: {},
        path: "/fake/my-plugin",
      },
    ]);
    const ctx = makeMockContext();
    await tryRunCommand("/status", ctx);
    const calls = (
      ctx.renderer.writeln as ReturnType<typeof vi.fn>
    ).mock.calls.flat();
    const out = calls.join(" ");
    expect(out).toContain("my-plugin");
    expect(out).toContain("Plugins");
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  it("/status shows 'actions only' for plugin without mcpServerPath", async () => {
    mockGetLoadedPlugins.mockReturnValueOnce([
      {
        plugin: { name: "actions-only-plugin" },
        config: {},
        envVars: {},
        path: "/fake/ao-plugin",
      },
    ]);
    const ctx = makeMockContext();
    await tryRunCommand("/status", ctx);
    const calls = (
      ctx.renderer.writeln as ReturnType<typeof vi.fn>
    ).mock.calls.flat();
    expect(calls.join(" ")).toContain("actions only");
  });

  it("/status uses live backend usage totals via getSessionSnapshot", async () => {
    mockGetSessionInfo.mockReturnValueOnce({
      turns: 14,
      sessionId: "ses_live",
      sessionName: undefined,
      lastModel: "big-pickle",
      usage: {
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        lastPromptTokens: 10,
        estimatedCostUsd: 0,
        totalResponseMs: 60_000,
        lastResponseMs: 6_000,
        fastestResponseMs: 5_000,
      },
    });
    mockGetChatSettings.mockReturnValueOnce({ model: "big-pickle" });

    const ctx = makeMockContext({
      config: {
        model: "big-pickle",
      } as CommandContext["config"],
      backend: stubBackend({
        label: "OpenCode",
        query: vi.fn() as any,
        getModelInfo: vi.fn().mockResolvedValue({
          id: "big-pickle",
          displayName: "Big Pickle",
          provider: "opencode",
          providerName: "OpenCode Zen",
          free: true,
          contextWindow: 204800,
          selectable: true,
        }),
        getSessionSnapshot: vi.fn().mockResolvedValue({
          inputTokens: 1389045,
          outputTokens: 3675,
          cacheRead: 0,
          cacheWrite: 0,
          contextModelId: "big-pickle",
        }),
      }),
    });
    await tryRunCommand("/status", ctx);

    const output = (ctx.renderer.writeln as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(" ");
    expect(output).toContain("1,389,045");
    expect(output).toContain("3,675");
    expect(output).toContain("204.8k");
  });
});

describe("/context command", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltinCommands();
    mockGetRecentHistory.mockClear();
  });

  it("breaks the window into System / Tools / Conversation + Free", async () => {
    mockGetSessionInfo.mockReturnValueOnce({
      turns: 4,
      usage: {
        contextTokens: 40_000,
        contextWindow: 200_000,
        lastPromptTokens: 40_000,
      },
    });
    const ctx = makeMockContext({
      config: {
        model: "claude-sonnet-4-6",
        // ~2k system tokens (8000 chars / 4).
        systemPromptParts: { staticText: "s".repeat(8_000), dynamicText: "" },
      } as unknown as CommandContext["config"],
    });
    await tryRunCommand("/context", ctx);
    const output = (ctx.renderer.writeln as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(" ");
    expect(output).toContain("Context");
    expect(output).toContain("System");
    expect(output).toContain("Tools");
    expect(output).toContain("Conversation");
    expect(output).toContain("Free");
    expect(output).toContain("20% used"); // 40k / 200k
    expect(mockGetRecentHistory).toHaveBeenCalled();
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  it("warns and omits Tools appropriately, and never throws before a first turn", async () => {
    // No contextTokens reported yet: tools can't be derived, but System still
    // shows and the command must not crash.
    mockGetSessionInfo.mockReturnValueOnce({
      turns: 0,
      usage: { contextTokens: 0, contextWindow: 200_000 },
    });
    const ctx = makeMockContext({
      config: {
        model: "claude-sonnet-4-6",
        systemPromptParts: { staticText: "s".repeat(4_000), dynamicText: "" },
      } as unknown as CommandContext["config"],
    });
    await tryRunCommand("/context", ctx);
    const output = (ctx.renderer.writeln as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(" ");
    expect(output).toContain("System");
    expect(output).toContain("Free");
    expect(output).not.toContain("Tools");
    expect(ctx.reprompt).toHaveBeenCalled();
  });
});

describe("/effort command", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltinCommands();
    vi.clearAllMocks();
    mockReasoningLevels.mockReset();
    mockReasoningLevels.mockReturnValue(["low", "medium", "high", "max"]);
  });

  it("shows current effort when no arg given", async () => {
    mockGetChatSettings.mockReturnValueOnce({ effort: "high" });
    const ctx = makeMockContext();
    await tryRunCommand("/effort", ctx);
    expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
      expect.stringContaining("high"),
    );
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  it("shows adaptive when effort is not set", async () => {
    mockGetChatSettings.mockReturnValueOnce({});
    const ctx = makeMockContext();
    await tryRunCommand("/effort", ctx);
    expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
      expect.stringContaining("adaptive"),
    );
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  it("sets effort and reprompts when arg given", async () => {
    const ctx = makeMockContext();
    await tryRunCommand("/effort max", ctx);
    expect(mockSetChatEffort).toHaveBeenCalledWith("t_test_123", "max");
    expect(ctx.renderer.writeSystem).toHaveBeenCalledWith("Effort set to max.");
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  it("sets effort to undefined for 'adaptive' arg", async () => {
    const ctx = makeMockContext();
    await tryRunCommand("/effort adaptive", ctx);
    expect(mockSetChatEffort).toHaveBeenCalledWith("t_test_123", undefined);
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  it("rejects a value that is not a reasoning level", async () => {
    const ctx = makeMockContext();
    await tryRunCommand("/effort banana", ctx);
    expect(mockSetChatEffort).not.toHaveBeenCalled();
    expect(ctx.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining("Valid: low, medium, high, max, or adaptive"),
    );
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  it("rejects a level the active model does not register", async () => {
    mockReasoningLevels.mockReturnValue(["low", "high"]);
    const ctx = makeMockContext();
    await tryRunCommand("/effort max", ctx);
    expect(mockSetChatEffort).not.toHaveBeenCalled();
    expect(ctx.renderer.writeError).toHaveBeenCalled();
  });

  it("accepts adaptive on a model with no levels", async () => {
    mockReasoningLevels.mockReturnValue([]);
    const ctx = makeMockContext();
    await tryRunCommand("/effort adaptive", ctx);
    expect(mockSetChatEffort).toHaveBeenCalledWith("t_test_123", undefined);
  });
});

describe("/resume sort order", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltinCommands();
    vi.clearAllMocks();
  });

  it("sorts sessions by lastActive descending", async () => {
    const now = Date.now();
    mockGetAllSessions.mockReturnValueOnce([
      {
        chatId: "t_older",
        info: { turns: 2, lastActive: now - 7200_000, sessionName: "older" },
      },
      {
        chatId: "t_newer",
        info: { turns: 3, lastActive: now - 3600_000, sessionName: "newer" },
      },
    ]);
    const ctx = makeMockContext({
      waitForInput: vi.fn().mockResolvedValue("1"),
    });
    await tryRunCommand("/resume", ctx);
    // Selection "1" should pick the first listed session (most recent = t_newer)
    expect(ctx.initNewChat).toHaveBeenCalledWith("t_newer");
  });
});
