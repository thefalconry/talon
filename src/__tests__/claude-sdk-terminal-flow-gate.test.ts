/**
 * Regression coverage for the Claude SDK terminal-mode flow-violation gate.
 *
 * Terminal mode has no outbound delivery tools, so a trailing assistant text
 * block is the reply and must not be passed through detectFlowViolation().
 * Messaging frontends still enforce the tool-only delivery contract.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface SystemInit {
  type: "system";
  subtype: "init";
  session_id: string;
}

interface AssistantTextMsg {
  type: "assistant";
  message: {
    content: Array<{ type: "text"; text: string }>;
  };
}

interface ResultMsg {
  type: "result";
  subtype: "success";
  result: string;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  modelUsage: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      contextWindow: number;
    }
  >;
}

type SdkMsg = SystemInit | AssistantTextMsg | ResultMsg;

let activeFrontends: string[] = [];
let mockMessages: SdkMsg[] = [];

const notePromptCacheRequest = vi.fn();
const notePromptCacheRateLimit = vi.fn();
const detectFlowViolationSpy = vi.fn(() => ({ violated: false }) as const);

const mockSdkScript = (messages: SdkMsg[]): void => {
  mockMessages = messages;
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(
    (_args: {
      prompt: string;
      options: { abortController?: AbortController };
    }) => {
      let i = 0;
      const iter = {
        [Symbol.asyncIterator]() {
          return this;
        },
        [Symbol.asyncDispose]: async () => {
          /* no-op for tests */
        },
        async next(): Promise<IteratorResult<SdkMsg, void>> {
          if (i < mockMessages.length) {
            return { done: false, value: mockMessages[i++] };
          }
          return { done: true, value: undefined };
        },
        async return(): Promise<IteratorResult<SdkMsg, void>> {
          return { done: true, value: undefined };
        },
        async throw(err: unknown): Promise<IteratorResult<SdkMsg, void>> {
          throw err;
        },
      };
      return iter as unknown as AsyncGenerator<SdkMsg, void>;
    },
  ),
}));

vi.mock("../storage/sessions.js", () => ({
  getSession: () => ({ sessionId: null, turns: 0 }),
  incrementTurns: vi.fn(),
  recordUsage: vi.fn(),
  resetSession: vi.fn(),
  setSessionId: vi.fn(),
  setSessionName: vi.fn(),
  updateLiveTurn: vi.fn(),
  notePromptCacheRequest: (...a: unknown[]) => notePromptCacheRequest(...a),
  notePromptCacheRateLimit: (...a: unknown[]) => notePromptCacheRateLimit(...a),
  clearLiveTurn: vi.fn(),
  recordSessionMetrics: vi.fn(),
  recordSessionMetricEvent: vi.fn(),
}));

vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: () => ({}),
  setChatModel: vi.fn(),
}));

vi.mock("../core/plugin.js", () => ({
  getPluginMcpServers: () => ({}),
  getPluginPromptAdditions: () => [],
}));

vi.mock("../backend/claude-sdk/state.js", () => ({
  getConfig: () => ({
    model: "claude-sonnet-4-6",
    frontend: "terminal",
    systemPrompt: "test prompt",
    workspace: "/tmp/workspace",
  }),
  getBridgePort: () => 19876,
}));

vi.mock("../backend/claude-sdk/options.js", async (importActual) => ({
  ...((await importActual()) as Record<string, unknown>),
  getActiveFrontends: () => activeFrontends,
}));

vi.mock("../util/trace.js", () => ({
  traceMessage: vi.fn(),
}));

vi.mock("../storage/metrics.js", () => ({
  incrementCounter: vi.fn(),
  recordHistogram: vi.fn(),
}));

// The shared post-stream phases run for real (against the storage stubs
// above); only the prompt assembly is stubbed out. The flow-violation
// detector is spied at its own module so the spy sees the call the shared
// `enforceTrailingProse` phase makes.
vi.mock("../backend/runtime/turn/flow-violation.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../backend/runtime/turn/flow-violation.js")
  >()),
  detectFlowViolation: (...args: Parameters<typeof detectFlowViolationSpy>) =>
    detectFlowViolationSpy(...args),
}));

vi.mock("../backend/runtime/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../backend/runtime/index.js")>()),
  formatUserPrompt: ({ text }: { text: string }) => text,
  prepareSystemPrompt: vi.fn(),
  buildDeliveryContract: () => "",
  buildFlowViolationReminder: () => "",
  buildFirstTurnReminder: () => "",
}));

async function drainChatTurn(chatId: string, text: string) {
  const { runChatTurn } = await import("../backend/claude-sdk/handler.js");
  const { makeBareModelRef } =
    await import("../core/agent-runtime/model-ref.js");
  const events = [];
  for await (const event of runChatTurn({
    chatId,
    model: makeBareModelRef("claude", "default"),
    text,
    senderName: "Ada",
    isGroup: false,
  })) {
    events.push(event);
  }
  return events;
}

const assistantText = (text: string): AssistantTextMsg => ({
  type: "assistant",
  message: {
    content: [{ type: "text", text }],
  },
});

const stdResult: ResultMsg = {
  type: "result",
  subtype: "success",
  result: "",
  duration_ms: 0,
  duration_api_ms: 0,
  is_error: false,
  num_turns: 1,
  session_id: "sess-1",
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  modelUsage: {
    "claude-sonnet-4-6": {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      contextWindow: 200_000,
    },
  },
};

function installTrailingTextScript(): void {
  mockSdkScript([
    { type: "system", subtype: "init", session_id: "sess-1" },
    assistantText("This is the terminal reply."),
    stdResult,
  ]);
}

describe("Claude SDK terminal flow-violation gate", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    activeFrontends = [];
    mockMessages = [];
    detectFlowViolationSpy.mockReset();
    detectFlowViolationSpy.mockReturnValue({ violated: false });

    const { clearModels, registerModels } =
      await import("../core/models/catalog.js");
    clearModels();
    registerModels([
      {
        id: "default",
        displayName: "Default",
        description: "test",
        aliases: ["claude-sonnet-4-6"],
        provider: "anthropic",
      },
    ]);
  });

  it("does not check flow violations in terminal mode", async () => {
    activeFrontends = [];
    installTrailingTextScript();

    const events = await drainChatTurn("terminal-chat", "hello");

    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(detectFlowViolationSpy).not.toHaveBeenCalled();
  });

  it("checks flow violations for messaging frontends", async () => {
    activeFrontends = ["telegram"];
    installTrailingTextScript();

    const events = await drainChatTurn("telegram-chat", "hello");

    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(detectFlowViolationSpy).toHaveBeenCalledTimes(1);
  });
});

// Idle compaction (core/weaver/idle-compact.ts) is anchored on what the
// turn's main-session requests said about the prompt cache. Lives here for
// the turn-handler harness above; the TTL rule itself is pinned in
// prompt-cache.test.ts against the real store.
describe("Claude SDK prompt-cache observation", () => {
  beforeEach(() => {
    vi.resetModules();
    activeFrontends = [];
    notePromptCacheRequest.mockClear();
    notePromptCacheRateLimit.mockClear();
  });

  const withUsage = (
    usage: Record<string, unknown>,
    parent: string | null = null,
  ) =>
    ({
      type: "assistant",
      parent_tool_use_id: parent,
      message: { content: [{ type: "text", text: "x" }], usage },
    }) as unknown as AssistantTextMsg;

  it("notes each main-thread request with its send time, write breakdown and model; skips sidechains", async () => {
    const started = Date.now();
    mockSdkScript([
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning" },
      } as unknown as SdkMsg,
      withUsage({
        input_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 250_000,
        cache_creation: {
          ephemeral_1h_input_tokens: 250_000,
          ephemeral_5m_input_tokens: 0,
        },
      }),
      {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [] },
      } as unknown as SdkMsg,
      withUsage({
        input_tokens: 5,
        cache_read_input_tokens: 250_000,
        cache_creation_input_tokens: 0,
      }),
      // A sub-agent's request is not the main session's cache.
      withUsage(
        {
          input_tokens: 5,
          cache_creation_input_tokens: 9_000,
          cache_creation: { ephemeral_1h_input_tokens: 0 },
        },
        "toolu_1",
      ),
      stdResult,
    ]);

    await drainChatTurn("cache-chat", "hello");

    expect(notePromptCacheRateLimit).toHaveBeenCalledWith(
      "cache-chat",
      "allowed_warning",
    );
    expect(notePromptCacheRequest).toHaveBeenCalledTimes(2);
    const [first, second] = notePromptCacheRequest.mock.calls.map(
      (c) => c[1] as { at: number },
    );
    expect(first).toMatchObject({
      modelId: "default",
      guest: false,
      cacheRead: 0,
      cacheWrite: 250_000,
      cacheWrite1h: 250_000,
      cacheWrite5m: 0,
    });
    expect(first!.at).toBeGreaterThanOrEqual(started);
    // The second request went out after the tool result, not at turn start.
    expect(second).toMatchObject({ cacheRead: 250_000, cacheWrite: 0 });
    expect(second).not.toHaveProperty("cacheWrite1h");
    expect(second!.at).toBeGreaterThanOrEqual(first!.at);
  });
});
