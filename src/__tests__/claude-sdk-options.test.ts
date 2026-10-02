import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
const mockGetChatSettings = vi.fn();
const mockGetPluginMcpServers = vi.fn();
const mockGetConfig = vi.fn();
const mockGetBridgePort = vi.fn();

vi.mock("../storage/sessions.js", () => ({
  getSession: (...args: unknown[]) =>
    mockGetSession(...(args as Parameters<typeof mockGetSession>)),
}));

vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: (...args: unknown[]) =>
    mockGetChatSettings(...(args as Parameters<typeof mockGetChatSettings>)),
}));

vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: (...args: unknown[]) =>
    mockGetPluginMcpServers(
      ...(args as Parameters<typeof mockGetPluginMcpServers>),
    ),
}));

vi.mock("../backend/claude-sdk/state.js", () => ({
  getConfig: (...args: unknown[]) =>
    mockGetConfig(...(args as Parameters<typeof mockGetConfig>)),
  getBridgePort: (...args: unknown[]) =>
    mockGetBridgePort(...(args as Parameters<typeof mockGetBridgePort>)),
}));

describe("buildSdkOptions", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetSession.mockReturnValue({ sessionId: null });
    mockGetChatSettings.mockReturnValue({});
    mockGetPluginMcpServers.mockReturnValue({});
    mockGetConfig.mockReturnValue({
      model: "claude-sonnet-4-6",
      frontend: "terminal",
      systemPrompt: "test prompt",
      workspace: "/tmp/workspace",
    });
    mockGetBridgePort.mockReturnValue(19876);

    const { clearModels, registerModels } =
      await import("../core/models/catalog.js");
    clearModels();
    registerModels([
      {
        id: "default",
        displayName: "Default (recommended)",
        description: "Sonnet 4.6 · Best for everyday tasks",
        aliases: ["claude-sonnet-4-6"],
        provider: "anthropic",
        fallback: "haiku",
      },
      {
        id: "sonnet[1m]",
        displayName: "Sonnet (1M context)",
        description:
          "Sonnet 4.6 with 1M context · Billed as extra usage · $3/$15 per Mtok",
        aliases: ["claude-sonnet-4-6[1m]"],
        provider: "anthropic",
        fallback: "haiku",
      },
      {
        id: "haiku",
        displayName: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
        aliases: ["claude-haiku-4-5"],
        provider: "anthropic",
      },
    ]);
  });

  it("resolves legacy aliases to canonical model ID and passes through", async () => {
    const { buildSdkOptions } =
      await import("../backend/claude-sdk/options.js");

    const { activeModel, options } = buildSdkOptions("chat-1");

    expect(activeModel).toBe("claude-sonnet-4-6");
    // Model is passed through as resolved — SDK handles context window
    expect(options.model).toBe("default");
  }, 10_000);

  it("passes model through unchanged when no alias resolution needed", async () => {
    mockGetChatSettings.mockReturnValue({ model: "haiku" });

    const { buildSdkOptions } =
      await import("../backend/claude-sdk/options.js");
    const { options } = buildSdkOptions("chat-2");

    expect(options.model).toBe("haiku");
  });

  it("resolves 1M aliases to their canonical SDK model ID", async () => {
    mockGetChatSettings.mockReturnValue({ model: "claude-sonnet-4-6[1m]" });

    const { buildSdkOptions } =
      await import("../backend/claude-sdk/options.js");
    const { activeModel, options } = buildSdkOptions("chat-3");

    expect(activeModel).toBe("claude-sonnet-4-6[1m]");
    expect(options.model).toBe("sonnet[1m]");
  });

  it("the default account inherits the daemon's environment", async () => {
    const { buildSdkOptions } =
      await import("../backend/claude-sdk/options.js");
    const { options } = buildSdkOptions("chat-default-account");
    expect(options.env).toBeUndefined();
  });

  it("an extra account's spawn gets its CLAUDE_CONFIG_DIR; the daemon env is untouched", async () => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    const { buildSdkOptions } =
      await import("../backend/claude-sdk/options.js");
    const { options } = buildSdkOptions(
      "chat-account-2",
      undefined,
      undefined,
      undefined,
      {
        backendId: "claude-2",
        label: "Claude (account 2)",
        configDir: "/srv/talon-test/accounts/claude-2",
      },
    );
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(
      "/srv/talon-test/accounts/claude-2",
    );
    // Starts from the daemon's env (the SDK replaces, not merges, `env`).
    expect(options.env?.PATH).toBe(process.env.PATH);
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);
  });

  it("pins transcript retention so the CLI's sweep never deletes chats", async () => {
    const { buildSdkOptions } =
      await import("../backend/claude-sdk/options.js");
    const { options } = buildSdkOptions("chat-retention");

    expect(options.settings).toEqual({ cleanupPeriodDays: 100_000 });
  });

  describe("systemPrompt cache boundary", () => {
    it("falls back to the plain string when config has no parts", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-sp-1");
      expect(options.systemPrompt).toBe("test prompt");
    });

    it("splits config parts on the dynamic boundary when present", async () => {
      mockGetConfig.mockReturnValue({
        model: "claude-sonnet-4-6",
        frontend: "terminal",
        systemPrompt: "static stuff\n\n---\n\nvolatile stuff",
        systemPromptParts: {
          staticText: "static stuff",
          dynamicText: "volatile stuff",
        },
        workspace: "/tmp/workspace",
      });
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } =
        await import("@anthropic-ai/claude-agent-sdk");

      const { options } = buildSdkOptions("chat-sp-2");
      expect(options.systemPrompt).toEqual([
        "static stuff",
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        "volatile stuff",
      ]);
    });

    it("prefers the caller's prepared per-session prompt", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } =
        await import("@anthropic-ai/claude-agent-sdk");

      const prepared = {
        text: "frozen static\n\n---\n\nfrozen dynamic",
        staticText: "frozen static",
        dynamicText: "frozen dynamic",
      };
      const { options } = buildSdkOptions(
        "chat-sp-3",
        undefined,
        undefined,
        prepared,
      );
      expect(options.systemPrompt).toEqual([
        "frozen static",
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        "frozen dynamic",
      ]);
    });

    it("omits the boundary when the dynamic part is empty", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");

      const prepared = {
        text: "all static",
        staticText: "all static",
        dynamicText: "",
      };
      const { options } = buildSdkOptions(
        "chat-sp-4",
        undefined,
        undefined,
        prepared,
      );
      expect(options.systemPrompt).toBe("all static");
    });
  });

  describe("PostToolBatch turn-terminator hook", () => {
    type HookCallback = (
      input: unknown,
      toolUseID?: string,
      ctx?: { signal: AbortSignal },
    ) => Promise<{ continue?: boolean; stopReason?: string }>;

    const callHook = async (toolNames: string[]): Promise<unknown> => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-hook-test");

      const matchers = options.hooks?.PostToolBatch;
      expect(matchers).toBeDefined();
      expect(matchers!.length).toBe(1);
      const hook = matchers![0]!.hooks[0] as unknown as HookCallback;

      return hook(
        {
          hook_event_name: "PostToolBatch",
          tool_calls: toolNames.map((name, i) => ({
            tool_name: name,
            tool_input: {},
            tool_use_id: `tu_${i}`,
          })),
        },
        undefined,
        { signal: new AbortController().signal },
      );
    };

    it("registers a PostToolBatch hook on the options object", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-hook-1");
      expect(options.hooks?.PostToolBatch).toBeDefined();
      expect(options.hooks!.PostToolBatch!.length).toBe(1);
      expect(options.hooks!.PostToolBatch![0]!.hooks.length).toBe(1);
    });

    it("returns continue:false when an MCP-prefixed end_turn is in the batch", async () => {
      const result = (await callHook([
        "mcp__telegram-tools__send",
        "mcp__telegram-tools__end_turn",
      ])) as { continue: boolean; stopReason?: string };
      expect(result.continue).toBe(false);
      expect(result.stopReason).toMatch(/end_turn/i);
    });

    it("returns continue:false when a bare end_turn is in the batch", async () => {
      const result = (await callHook(["end_turn"])) as {
        continue: boolean;
      };
      expect(result.continue).toBe(false);
    });

    it("returns continue:true when no terminator is in the batch", async () => {
      const result = (await callHook([
        "mcp__telegram-tools__send",
        "Read",
        "Bash",
      ])) as { continue: boolean };
      expect(result.continue).toBe(true);
    });

    it("returns continue:true on an empty batch", async () => {
      const result = (await callHook([])) as { continue: boolean };
      expect(result.continue).toBe(true);
    });

    it("ignores non-PostToolBatch events defensively", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-hook-defensive");
      const hook = options.hooks!.PostToolBatch![0]!.hooks[0] as unknown as (
        input: unknown,
        id?: string,
        ctx?: { signal: AbortSignal },
      ) => Promise<{ continue: boolean }>;

      const result = await hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "mcp__telegram-tools__end_turn",
          tool_input: {},
          tool_response: {},
          tool_use_id: "tu_0",
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });
  });

  // Failure-recovery regression suite. When a turn-terminator tool's
  // `execute()` throws (e.g. `end_turn` throws because the bridge returned
  // `{ok:false}`), the SDK fires PostToolUseFailure. The hook pair must
  // preserve the loop so the model can read the error and retry / message
  // the user. Without this, the failed terminator silently ends the turn
  // and the user sees nothing — canonical incident 2026-05-13 13:11Z
  // 4096-char overflow.
  describe("PostToolUseFailure + PostToolBatch coordination", () => {
    type HookCallback = (
      input: unknown,
      toolUseID?: string,
      ctx?: { signal: AbortSignal },
    ) => Promise<{ continue?: boolean; stopReason?: string }>;

    interface HookPair {
      failure: HookCallback;
      batch: HookCallback;
    }

    const buildHookPair = async (chatId: string): Promise<HookPair> => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions(chatId);
      const failure = options.hooks!.PostToolUseFailure![0]!
        .hooks[0] as unknown as HookCallback;
      const batch = options.hooks!.PostToolBatch![0]!
        .hooks[0] as unknown as HookCallback;
      return { failure, batch };
    };

    const fireFailure = (
      failure: HookCallback,
      tool_name: string,
      tool_use_id: string,
      opts: {
        is_interrupt?: boolean;
        tool_input?: unknown;
        error?: string;
      } = {},
    ): Promise<unknown> =>
      failure(
        {
          hook_event_name: "PostToolUseFailure",
          tool_name,
          tool_input: opts.tool_input ?? {},
          tool_use_id,
          error: opts.error ?? "delivery failed",
          is_interrupt: opts.is_interrupt,
        },
        undefined,
        { signal: new AbortController().signal },
      );

    const fireBatch = (
      batch: HookCallback,
      tools: { name: string; tool_use_id: string; tool_input?: unknown }[],
    ): Promise<unknown> =>
      batch(
        {
          hook_event_name: "PostToolBatch",
          tool_calls: tools.map((t) => ({
            tool_name: t.name,
            tool_input: t.tool_input ?? {},
            tool_use_id: t.tool_use_id,
          })),
        },
        undefined,
        { signal: new AbortController().signal },
      );

    it("registers a PostToolUseFailure hook on the options object", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-fail-1");
      expect(options.hooks?.PostToolUseFailure).toBeDefined();
      expect(options.hooks!.PostToolUseFailure!.length).toBe(1);
      expect(options.hooks!.PostToolUseFailure![0]!.hooks.length).toBe(1);
    });

    it("flags failed end_turn → PostToolBatch preserves loop", async () => {
      const { failure, batch } = await buildHookPair("chat-coord-1");

      await fireFailure(failure, "mcp__telegram-tools__end_turn", "tu_failed", {
        error: "Message too long (4326 chars, max 4096)",
      });
      const result = (await fireBatch(batch, [
        { name: "mcp__telegram-tools__end_turn", tool_use_id: "tu_failed" },
      ])) as { continue: boolean };

      expect(result.continue).toBe(true);
    });

    it("flags failed react (strict) → PostToolBatch preserves loop", async () => {
      const { failure, batch } = await buildHookPair("chat-coord-2");

      await fireFailure(failure, "mcp__telegram-tools__react", "tu_react", {
        error: "REACTION_INVALID",
      });
      const result = (await fireBatch(batch, [
        { name: "mcp__telegram-tools__react", tool_use_id: "tu_react" },
      ])) as { continue: boolean };

      expect(result.continue).toBe(true);
    });

    it("end_turn that didn't fail → PostToolBatch terminates as usual", async () => {
      const { batch } = await buildHookPair("chat-coord-3");

      // No failure hook call — Set stays empty.
      const result = (await fireBatch(batch, [
        { name: "mcp__telegram-tools__end_turn", tool_use_id: "tu_ok" },
      ])) as { continue: boolean; stopReason?: string };

      expect(result.continue).toBe(false);
      expect(result.stopReason).toMatch(/end_turn/i);
    });

    it("failure hook ignores is_interrupt=true (not a real failure)", async () => {
      const { failure, batch } = await buildHookPair("chat-coord-4");

      await fireFailure(
        failure,
        "mcp__telegram-tools__end_turn",
        "tu_interrupted",
        { is_interrupt: true, error: "aborted" },
      );
      // Set should be empty → batch terminates normally.
      const result = (await fireBatch(batch, [
        {
          name: "mcp__telegram-tools__end_turn",
          tool_use_id: "tu_interrupted",
        },
      ])) as { continue: boolean };

      expect(result.continue).toBe(false);
    });

    it("failure hook ignores non-terminator tool failures", async () => {
      const { failure, batch } = await buildHookPair("chat-coord-5");

      // `send` is not a terminator. Even if it fails, the batch hook would
      // never reach the terminate branch for it, so flagging it would be
      // wasted state.
      await fireFailure(failure, "mcp__telegram-tools__send", "tu_send", {
        error: "Message too long",
      });
      // Now run a batch with a successful end_turn — should terminate
      // (different tool_use_id, the send failure flag isn't in the set).
      const result = (await fireBatch(batch, [
        { name: "mcp__telegram-tools__send", tool_use_id: "tu_send" },
        {
          name: "mcp__telegram-tools__end_turn",
          tool_use_id: "tu_end_turn",
        },
      ])) as { continue: boolean };

      expect(result.continue).toBe(false);
    });

    it("failure hook ignores soft-terminator react with end_turn:false", async () => {
      const { failure, batch } = await buildHookPair("chat-coord-6");

      // react with end_turn:false is not a terminator → flagging it would
      // confuse subsequent batches.
      await fireFailure(failure, "mcp__telegram-tools__react", "tu_soft", {
        tool_input: { end_turn: false },
        error: "REACTION_INVALID",
      });
      const result = (await fireBatch(batch, [
        {
          name: "mcp__telegram-tools__end_turn",
          tool_use_id: "tu_other_end",
        },
      ])) as { continue: boolean };

      expect(result.continue).toBe(false);
    });

    it("ignores non-PostToolUseFailure events defensively", async () => {
      const { failure } = await buildHookPair("chat-coord-7");
      const result = (await failure(
        {
          hook_event_name: "PostToolUse",
          tool_name: "anything",
          tool_input: {},
          tool_response: {},
          tool_use_id: "tu_0",
        },
        undefined,
        { signal: new AbortController().signal },
      )) as { continue: boolean };
      expect(result.continue).toBe(true);
    });

    it("flagged tool_use_id is consumed (deleted on first terminate match)", async () => {
      const { failure, batch } = await buildHookPair("chat-coord-8");

      await fireFailure(failure, "end_turn", "tu_once", {
        error: "delivery failed",
      });

      // First batch with the failed id → loop preserved.
      const first = (await fireBatch(batch, [
        { name: "end_turn", tool_use_id: "tu_once" },
      ])) as { continue: boolean };
      expect(first.continue).toBe(true);

      // Second batch with the SAME id (no new failure) → terminates.
      // Defensive: prevents a stale flag from spuriously preserving the loop
      // on a subsequent successful terminator.
      const second = (await fireBatch(batch, [
        { name: "end_turn", tool_use_id: "tu_once" },
      ])) as { continue: boolean };
      expect(second.continue).toBe(false);
    });

    it("per-session isolation: failure in chat A doesn't preserve chat B", async () => {
      const a = await buildHookPair("chat-iso-A");
      const b = await buildHookPair("chat-iso-B");

      await fireFailure(a.failure, "end_turn", "tu_chat_a", {
        error: "delivery failed",
      });

      // Same tool_use_id in chat B — shouldn't be in chat B's Set.
      const result = (await fireBatch(b.batch, [
        { name: "end_turn", tool_use_id: "tu_chat_a" },
      ])) as { continue: boolean };
      expect(result.continue).toBe(false);
    });
  });

  describe("Notification hook", () => {
    type HookCallback = (
      input: unknown,
      toolUseID?: string,
      ctx?: { signal: AbortSignal },
    ) => Promise<{ continue: boolean }>;

    const getNotifHook = async (): Promise<HookCallback> => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-notif");
      const matchers = options.hooks?.Notification;
      expect(matchers).toBeDefined();
      return matchers![0]!.hooks[0] as unknown as HookCallback;
    };

    it("registers a Notification hook on the options object", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-notif-1");
      expect(options.hooks?.Notification).toBeDefined();
      expect(options.hooks!.Notification!.length).toBe(1);
      expect(options.hooks!.Notification![0]!.hooks.length).toBe(1);
    });

    it("returns continue:true for Notification events", async () => {
      const hook = await getNotifHook();
      const result = await hook(
        {
          hook_event_name: "Notification",
          message: "Compacting context...",
          notification_type: "compaction",
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });

    it("returns continue:true for Notification events with optional title", async () => {
      const hook = await getNotifHook();
      const result = await hook(
        {
          hook_event_name: "Notification",
          message: "Switched to claude-haiku-4-5",
          title: "Model switch",
          notification_type: "model_switch",
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });

    it("ignores non-Notification events defensively", async () => {
      const hook = await getNotifHook();
      const result = await hook(
        {
          hook_event_name: "PostToolBatch",
          tool_calls: [],
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });
  });

  describe("StopFailure hook", () => {
    type HookCallback = (
      input: unknown,
      toolUseID?: string,
      ctx?: { signal: AbortSignal },
    ) => Promise<{ continue: boolean }>;

    const getStopFailureHook = async (): Promise<HookCallback> => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-sf");
      const matchers = options.hooks?.StopFailure;
      expect(matchers).toBeDefined();
      return matchers![0]!.hooks[0] as unknown as HookCallback;
    };

    it("registers a StopFailure hook on the options object", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-sf-1");
      expect(options.hooks?.StopFailure).toBeDefined();
      expect(options.hooks!.StopFailure!.length).toBe(1);
      expect(options.hooks!.StopFailure![0]!.hooks.length).toBe(1);
    });

    it("returns continue:true for StopFailure events with error_details", async () => {
      const hook = await getStopFailureHook();
      const result = await hook(
        {
          hook_event_name: "StopFailure",
          error: {
            type: "error",
            error: { type: "api_error", message: "upstream failure" },
          },
          error_details: "raw response body here",
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });

    it("returns continue:true for StopFailure events without error_details", async () => {
      const hook = await getStopFailureHook();
      const result = await hook(
        {
          hook_event_name: "StopFailure",
          error: {
            type: "error",
            error: { type: "overloaded_error", message: "rate limited" },
          },
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });

    it("ignores non-StopFailure events defensively", async () => {
      const hook = await getStopFailureHook();
      const result = await hook(
        {
          hook_event_name: "Notification",
          message: "context compacting",
          notification_type: "compaction",
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });
  });
});

// ── getActiveFrontends ────────────────────────────────────────────────────
//
// Direct unit tests for the helper added alongside the heartbeat outbound
// refactor. Used by the heartbeat agent to build a frontend-agnostic system
// prompt (lists every `${frontend}-tools` MCP server actually available
// instead of hard-coding "telegram-tools").

describe("getActiveFrontends", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns [] when frontend is scalar 'terminal'", async () => {
    mockGetConfig.mockReturnValue({ frontend: "terminal" });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual([]);
  });

  it("returns ['telegram'] when frontend is scalar 'telegram'", async () => {
    mockGetConfig.mockReturnValue({ frontend: "telegram" });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual(["telegram"]);
  });

  it("returns ['teams'] when frontend is scalar 'teams'", async () => {
    mockGetConfig.mockReturnValue({ frontend: "teams" });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual(["teams"]);
  });

  it("returns full array when frontend is ['telegram', 'teams']", async () => {
    mockGetConfig.mockReturnValue({ frontend: ["telegram", "teams"] });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual(["telegram", "teams"]);
  });

  it("filters terminal out of mixed arrays", async () => {
    mockGetConfig.mockReturnValue({
      frontend: ["telegram", "terminal", "teams"],
    });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual(["telegram", "teams"]);
  });

  it("returns [] when array contains only terminal", async () => {
    mockGetConfig.mockReturnValue({ frontend: ["terminal"] });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual([]);
  });

  it("preserves array order (heartbeat prompt uses [0] as example)", async () => {
    mockGetConfig.mockReturnValue({ frontend: ["teams", "telegram"] });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual(["teams", "telegram"]);
  });

  it("propagates getConfig() throw (callers wrap in try/catch)", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("config not initialised");
    });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(() => getActiveFrontends()).toThrow("config not initialised");
  });
});

// ── buildMcpServers — heartbeat-tier coverage ─────────────────────────────
//
// Tests focused on the heartbeat sentinel pathway and multi-frontend
// correctness. The chat-mode happy path is covered by integration tests
// (talon-mcp-functional*.test.ts).

describe("buildMcpServers (heartbeat-tier paths)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetBridgePort.mockReturnValue(19876);
  });

  it("returns empty map when frontend is 'terminal' and no braveApiKey", async () => {
    mockGetConfig.mockReturnValue({ frontend: "terminal" });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    expect(buildMcpServers("heartbeat")).toEqual({});
  });

  it("spawns one '<frontend>-tools' server per non-terminal frontend", async () => {
    mockGetConfig.mockReturnValue({ frontend: ["telegram", "teams"] });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("heartbeat");
    expect(Object.keys(servers).sort()).toEqual([
      "teams-tools",
      "telegram-tools",
    ]);
  });

  it("teams-only config produces teams-tools, not telegram-tools", async () => {
    mockGetConfig.mockReturnValue({ frontend: "teams" });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("heartbeat");
    expect(servers).toHaveProperty("teams-tools");
    expect(servers).not.toHaveProperty("telegram-tools");
  });

  it("hub URL carries chatId + frontend and targets the bridge port", async () => {
    mockGetConfig.mockReturnValue({ frontend: "telegram" });
    mockGetBridgePort.mockReturnValue(31337);
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("424242420");
    expect(servers["telegram-tools"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:31337/mcp/talon/telegram/424242420",
      // A reference the CLI expands from its env — the token itself never
      // rides the CLI's command line.
      headers: { Authorization: "Bearer ${TALON_GATEWAY_TOKEN}" },
      alwaysLoad: true,
      // Sits above the bridge's 1h transfer budget so the bridge's
      // descriptive timeout error fires before the SDK's generic one.
      timeout: 3_900_000,
    });
  });

  it("heartbeat sentinel: hub URL carries 'heartbeat' when chatId='heartbeat'", async () => {
    mockGetConfig.mockReturnValue({ frontend: "telegram" });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("heartbeat");
    expect(servers["telegram-tools"].url).toMatch(
      /\/mcp\/talon\/telegram\/heartbeat$/,
    );
  });

  it("multi-frontend + brave produces 3 servers", async () => {
    mockGetConfig.mockReturnValue({
      frontend: ["telegram", "teams"],
      braveApiKey: "bsa_test_key",
    });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("heartbeat");
    expect(Object.keys(servers).sort()).toEqual([
      "brave-search",
      "teams-tools",
      "telegram-tools",
    ]);
    // Both frontend servers get the heartbeat sentinel.
    expect(servers["telegram-tools"].url).toMatch(/\/heartbeat$/);
    expect(servers["teams-tools"].url).toMatch(/\/heartbeat$/);
  });

  it("each frontend gets its own hub URL (no cross-pollination)", async () => {
    mockGetConfig.mockReturnValue({ frontend: ["telegram", "teams"] });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("heartbeat");
    expect(servers["telegram-tools"].url).toContain("/mcp/talon/telegram/");
    expect(servers["teams-tools"].url).toContain("/mcp/talon/teams/");
  });

  it("includes brave-search when braveApiKey set, even for terminal-only", async () => {
    mockGetConfig.mockReturnValue({
      frontend: "terminal",
      braveApiKey: "bsa_test_key",
    });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    expect(Object.keys(buildMcpServers("heartbeat"))).toEqual(["brave-search"]);
  });
});

describe("buildSdkOptions — guest turn scope", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetSession.mockReturnValue({ sessionId: null });
    mockGetChatSettings.mockReturnValue({});
    mockGetPluginMcpServers.mockReturnValue({
      "email-tools": { command: "x" },
      "extras-tools": { command: "x" },
      "ssh-tools": { command: "x" },
    });
    mockGetConfig.mockReturnValue({
      model: "claude-sonnet-4-6",
      frontend: "telegram",
      systemPrompt: "test prompt",
      workspace: "/tmp/workspace",
      nativeTools: true,
    });
    mockGetBridgePort.mockReturnValue(19876);
  });

  it("drops SDK built-ins and non-guest plugins for a guest turn", async () => {
    const { initGuestDmScope, enterTurnScope } =
      await import("../core/mcp-hub/guest-scope.js");
    initGuestDmScope({ enabled: true }, 111);
    const { buildSdkOptions } =
      await import("../backend/claude-sdk/options.js");
    const release = enterTurnScope("999", "guest");
    const { options } = buildSdkOptions("999");
    release();
    expect(options.tools).toEqual([]);
    const servers = Object.keys(options.mcpServers ?? {});
    expect(servers).toContain("extras-tools");
    expect(servers).not.toContain("email-tools");
    expect(servers).not.toContain("ssh-tools");
  });

  it("keeps everything for an operator turn", async () => {
    const { initGuestDmScope, enterTurnScope } =
      await import("../core/mcp-hub/guest-scope.js");
    initGuestDmScope({ enabled: true }, 111);
    const { buildSdkOptions } =
      await import("../backend/claude-sdk/options.js");
    const release = enterTurnScope("-100123", "operator");
    const { options } = buildSdkOptions("-100123");
    release();
    expect((options.tools as string[]).length).toBeGreaterThan(0);
    expect(Object.keys(options.mcpServers ?? {})).toContain("email-tools");
  });
});
