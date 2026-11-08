/**
 * Post-result watchdog tests for the Claude SDK chat handler.
 *
 * Regression for the 2026-05-19 wedge: SDK emits the final `result`
 * SDKMessage, the handler logs "SDK result: …", but the async iterator
 * never closes — `for await` hangs forever, the dispatcher lock stays
 * held, and the typing indicator pulses for the rest of the chat's life.
 *
 * The watchdog arms a short timer when `result` is processed; if the
 * iterator doesn't close within the grace window, it calls
 * `abortController.abort()` AND `qi.return(undefined)` to force the
 * for-await loop to exit cleanly. The post-loop accounting code then
 * runs as usual, the dispatcher releases the context, and life
 * continues.
 *
 * Tests drive `runChatTurn` directly — the native `AgentEvent`
 * generator the factory wires onto `ChatBackend.runChatTurn` — and
 * assert on the drained event stream.
 *
 * Happy-path assertion lives here too: when the iterator closes
 * normally before the grace window, no abort is requested and no
 * `iterator_force_close_after_result` counter is incremented.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Stub query() ─────────────────────────────────────────────────────────────
// We synthesize an async iterator the handler can iterate. Each test
// installs the SDKMessage sequence (and optional "hang after the last
// message" flag) via `mockSdkScript`.

interface SystemInit {
  type: "system";
  subtype: "init";
  session_id: string;
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
type SdkMsg = SystemInit | ResultMsg;

let mockMessages: SdkMsg[] = [];
let mockHangAfterLastMessage = false;
let mockReturnCalled = false;
let mockAbortSignal: AbortSignal | undefined;

const mockSdkScript = (opts: {
  messages: SdkMsg[];
  hangAfterLastMessage?: boolean;
}): void => {
  mockMessages = opts.messages;
  mockHangAfterLastMessage = opts.hangAfterLastMessage ?? false;
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(
    (args: {
      prompt: string;
      options: { abortController?: AbortController };
    }) => {
      mockAbortSignal = args.options.abortController?.signal;
      let i = 0;
      let resolveHang: (() => void) | undefined;

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
          if (mockHangAfterLastMessage) {
            // Park forever — resolved only by .return() (our watchdog) or
            // .throw() (test cleanup).
            return new Promise<IteratorResult<SdkMsg, void>>((resolve) => {
              resolveHang = () => resolve({ done: true, value: undefined });
            });
          }
          return { done: true, value: undefined };
        },
        async return(): Promise<IteratorResult<SdkMsg, void>> {
          mockReturnCalled = true;
          if (resolveHang) resolveHang();
          return { done: true, value: undefined };
        },
        async throw(err: unknown): Promise<IteratorResult<SdkMsg, void>> {
          if (resolveHang) resolveHang();
          throw err;
        },
      };
      return iter as unknown as AsyncGenerator<SdkMsg, void>;
    },
  ),
}));

// ── Mock the rest of the handler's surface ──────────────────────────────────
// We don't care about session storage, plugin MCP, traces, or metrics in
// these tests — just that the handler returns within the grace window when
// the SDK hangs after `result`, and runs normally otherwise.

vi.mock("../storage/sessions.js", () => ({
  getSession: () => ({ sessionId: null, turns: 0 }),
  incrementTurns: vi.fn(),
  recordUsage: vi.fn(),
  resetSession: vi.fn(),
  setSessionId: vi.fn(),
  setSessionName: vi.fn(),
  updateLiveTurn: vi.fn(),
  clearLiveTurn: vi.fn(),
  recordSessionMetrics: vi.fn(),
  recordSessionMetricEvent: vi.fn(),
}));

vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: () => ({}),
  setChatModel: vi.fn(),
}));

vi.mock("../core/plugin/index.js", () => ({
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

vi.mock("../util/trace.js", () => ({
  traceMessage: vi.fn(),
}));

const incrementCounterSpy = vi.fn();
vi.mock("../storage/metrics.js", () => ({
  incrementCounter: (...args: unknown[]) =>
    incrementCounterSpy(...(args as Parameters<typeof incrementCounterSpy>)),
  recordHistogram: vi.fn(),
}));

// The shared post-stream phases run for real (against the storage stubs
// above); only the prompt assembly is stubbed out.
vi.mock("../backend/runtime/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../backend/runtime/index.js")>()),
  formatUserPrompt: ({ text }: { text: string }) => text,
  prepareSystemPrompt: vi.fn(),
  buildDeliveryContract: () => "",
  buildFlowViolationReminder: () => "",
  buildFirstTurnReminder: () => "",
}));

/**
 * Drain `runChatTurn`'s event stream for one chat turn — the same
 * production surface the factory wires onto `ChatBackend.runChatTurn`.
 * Imported per-call because `vi.resetModules()` in `beforeEach` gives
 * each test a fresh handler module (the grace constant is module-scoped).
 */
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

describe("Claude SDK chat handler — post-result watchdog", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockMessages = [];
    mockHangAfterLastMessage = false;
    mockReturnCalled = false;
    mockAbortSignal = undefined;
    incrementCounterSpy.mockReset();
    // Short grace window so the test runs in <1s. The grace constant is
    // module-scoped, so envMs() reads this when the handler module loads
    // — `vi.resetModules()` above ensures we get a fresh module per test.
    vi.stubEnv("TALON_SDK_POST_RESULT_GRACE_MS", "50");

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
    // Warm the fresh module graph so the timed drain below measures the
    // watchdog, not the import of the handler and its shared phases.
    await import("../backend/claude-sdk/handler.js");
  });

  it("returns within the grace window when the SDK iterator hangs after `result`", async () => {
    mockSdkScript({
      messages: [
        { type: "system", subtype: "init", session_id: "sess-1" },
        stdResult,
      ],
      hangAfterLastMessage: true,
    });

    const t0 = Date.now();
    const events = await drainChatTurn("test-wedge", "hello");
    const elapsed = Date.now() - t0;

    // Stream terminated normally with a `completed` event — no `error`
    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);

    // Returned within the grace window (50ms) plus generous slack for
    // test-runner scheduling on loaded CI/workstations. Without the watchdog
    // this would never resolve.
    expect(elapsed).toBeLessThan(1000);

    // The watchdog signalled both the SDK and the generator
    expect(mockAbortSignal?.aborted).toBe(true);
    expect(mockReturnCalled).toBe(true);

    // And bookkeeping fired exactly once
    expect(incrementCounterSpy).toHaveBeenCalledWith(
      "sdk.iterator_force_close_after_result",
    );
  });

  it("happy path: returns immediately and never aborts when the iterator closes naturally", async () => {
    mockSdkScript({
      messages: [
        { type: "system", subtype: "init", session_id: "sess-2" },
        stdResult,
      ],
      hangAfterLastMessage: false,
    });

    const events = await drainChatTurn("test-happy", "hi");

    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(mockAbortSignal?.aborted).toBe(false);
    expect(mockReturnCalled).toBe(false);
    expect(incrementCounterSpy).not.toHaveBeenCalledWith(
      "sdk.iterator_force_close_after_result",
    );
  });

  it("doesn't arm the watchdog when the iterator closes before `result` is seen", async () => {
    // No `result` message — iterator just closes. (This isn't a real SDK
    // path but proves the timer is only armed on `result`.)
    mockSdkScript({
      messages: [{ type: "system", subtype: "init", session_id: "sess-3" }],
      hangAfterLastMessage: false,
    });

    const events = await drainChatTurn("test-no-result", "ping");

    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(mockAbortSignal?.aborted).toBe(false);
    expect(mockReturnCalled).toBe(false);
  });
});
