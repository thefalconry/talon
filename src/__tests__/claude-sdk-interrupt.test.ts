/**
 * User-interrupt close-out for the Claude SDK chat handler.
 *
 * `interruptChatTurn` documents the contract: a stopped turn "ends as a
 * normal completion (turn_end + usage), NOT an error, and never trips the
 * model-fallback retry path". SDK 0.3.270 stopped honouring that on its
 * own — after `Query.interrupt()` the CLI emits an `is_error` result whose
 * `errors[]` carries only an `[ede_diagnostic] …` line, and when the
 * underlying stream then errors the SDK REPLACES that error with
 * `Error("Claude Code returned an error result: " + lastErrorResultText)`.
 *
 * Observed 17x in production between 2026-08-31 and 2026-09-18: every
 * `/stop` produced a level-50 `SDK error:` log, an `errors.unknown`
 * increment, failed-turn accounting, and an `error` AgentEvent — for an
 * outcome the user asked for.
 *
 * These tests pin the fix at the backend seam: the turn is MARKED
 * interrupted, so its close-out is quiet and ends as a completion — and
 * the identical error on a turn nobody stopped is still a failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Stub query() ─────────────────────────────────────────────────────────────
// The scripted iterator replays SDKMessages and then throws the SDK's
// re-labelled error-result error, exactly as the production traces show.

const EDE_ERROR_TEXT =
  "Claude Code returned an error result: [ede_diagnostic] " +
  "result_type=user last_content_type=n/a stop_reason=tool_use";

type SdkMsg = Record<string, unknown>;

let mockMessages: SdkMsg[] = [];
let mockThrowAtEnd: Error | undefined;
let mockInterruptCalls = 0;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
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
        if (mockThrowAtEnd) throw mockThrowAtEnd;
        return { done: true, value: undefined };
      },
      async return(): Promise<IteratorResult<SdkMsg, void>> {
        return { done: true, value: undefined };
      },
      async throw(err: unknown): Promise<IteratorResult<SdkMsg, void>> {
        throw err;
      },
      interrupt: async (): Promise<void> => {
        mockInterruptCalls++;
      },
    };
    return iter as unknown as AsyncGenerator<SdkMsg, void>;
  }),
}));

// ── Mock the rest of the handler's surface ──────────────────────────────────

const recordSessionMetricsSpy = vi.fn();
const recordUsageSpy = vi.fn();

vi.mock("../storage/sessions.js", () => ({
  getSession: () => ({ sessionId: null, turns: 0 }),
  incrementTurns: vi.fn(),
  recordUsage: (...args: unknown[]) => recordUsageSpy(...args),
  resetSession: vi.fn(),
  setSessionId: vi.fn(),
  setSessionName: vi.fn(),
  updateLiveTurn: vi.fn(),
  clearLiveTurn: vi.fn(),
  recordSessionMetrics: (...args: unknown[]) =>
    recordSessionMetricsSpy(...args),
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

const logErrorSpy = vi.fn();
vi.mock("../util/log.js", async (importActual) => ({
  ...(await importActual<typeof import("../util/log.js")>()),
  logError: (...args: unknown[]) => logErrorSpy(...args),
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

// ── Script ──────────────────────────────────────────────────────────────────

const systemInit: SdkMsg = {
  type: "system",
  subtype: "init",
  session_id: "sess-int",
};

/** Text + a tool call — the event the test hangs the interrupt off. */
const assistantWithTool: SdkMsg = {
  type: "assistant",
  session_id: "sess-int",
  message: {
    content: [
      { type: "text", text: "Working on it…" },
      { type: "tool_use", id: "tool-1", name: "Bash", input: { cmd: "ls" } },
    ],
    usage: {
      input_tokens: 120,
      output_tokens: 34,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 10,
    },
  },
};

/**
 * What the CLI emits after an interrupt: an error subtype whose only
 * diagnostic is the `[ede_diagnostic]` line `readResultError` filters out.
 */
const edeErrorResult: SdkMsg = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: [
    "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
  ],
  duration_ms: 1000,
  duration_api_ms: 900,
  num_turns: 25,
  session_id: "sess-int",
  total_cost_usd: 0.42,
  usage: {
    input_tokens: 120,
    output_tokens: 34,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 900,
  },
  modelUsage: {
    "claude-sonnet-4-6": {
      inputTokens: 120,
      outputTokens: 34,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 10,
      contextWindow: 200_000,
    },
  },
};

/**
 * Drain `runChatTurn` for one chat turn, optionally stopping the turn the
 * moment the first `tool_call` event lands — the production shape of a
 * `/stop` (or a shutdown drain) arriving mid-turn.
 */
async function drainChatTurn(chatId: string, opts: { stop: boolean }) {
  const { runChatTurn, interruptChatTurn } =
    await import("../backend/claude-sdk/handler.js");
  const { makeBareModelRef } =
    await import("../core/agent-runtime/model-ref.js");
  const events = [];
  let stopped = false;
  for await (const event of runChatTurn({
    chatId,
    model: makeBareModelRef("claude", "default"),
    text: "hello",
    senderName: "Ada",
    isGroup: false,
  })) {
    events.push(event);
    if (opts.stop && !stopped && event.type === "tool_call") {
      stopped = true;
      expect(await interruptChatTurn(chatId)).toBe(true);
    }
  }
  return events;
}

describe("Claude SDK chat handler — a user interrupt is a stop, not an error", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockMessages = [systemInit, assistantWithTool, edeErrorResult];
    mockThrowAtEnd = new Error(EDE_ERROR_TEXT);
    mockInterruptCalls = 0;
    incrementCounterSpy.mockReset();
    logErrorSpy.mockReset();
    recordSessionMetricsSpy.mockReset();
    recordUsageSpy.mockReset();

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

  it("closes an interrupted turn as a completion — no error log, no retry path", async () => {
    const events = await drainChatTurn("chat-stopped", { stop: true });

    expect(mockInterruptCalls).toBe(1);

    // The contract: turn_end + usage, never an `error` event.
    expect(events.some((e) => e.type === "error")).toBe(false);
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect(events.some((e) => e.type === "usage")).toBe(true);

    // Not a fault: no level-50 log and no classify/retry bookkeeping.
    expect(logErrorSpy).not.toHaveBeenCalled();
    expect(incrementCounterSpy).not.toHaveBeenCalledWith("errors.unknown");
    expect(
      incrementCounterSpy.mock.calls.some((c) =>
        String(c[0]).startsWith("errors."),
      ),
    ).toBe(false);
    expect(incrementCounterSpy).toHaveBeenCalledWith("sdk.turn_interrupted");
    expect(incrementCounterSpy).toHaveBeenCalledWith(
      "sdk.interrupt_closed_stream",
    );
  });

  it("accounts an interrupted turn's real burn as a normal (not failed) turn", async () => {
    await drainChatTurn("chat-accounting", { stop: true });

    expect(recordSessionMetricsSpy).toHaveBeenCalledTimes(1);
    const metrics = recordSessionMetricsSpy.mock.calls[0][1] as {
      failed?: boolean;
      usage?: { inputTokens: number; cacheRead: number };
    };
    expect(metrics.failed).not.toBe(true);
    // The result message landed before the stream broke, so its totals —
    // not zeroes — are what the turn is charged.
    expect(metrics.usage?.inputTokens).toBe(120);
    expect(metrics.usage?.cacheRead).toBe(900);
    expect(recordUsageSpy).toHaveBeenCalledTimes(1);
  });

  it("still fails the SAME error when nobody stopped the turn", async () => {
    const events = await drainChatTurn("chat-genuine-error", { stop: false });

    expect(mockInterruptCalls).toBe(0);
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(logErrorSpy).toHaveBeenCalled();
    expect(String(logErrorSpy.mock.calls[0][1])).toContain("SDK error:");
    // Classified + accounted as the failure it is.
    expect(incrementCounterSpy).toHaveBeenCalledWith("errors.unknown");
    const metrics = recordSessionMetricsSpy.mock.calls[0][1] as {
      failed?: boolean;
    };
    expect(metrics.failed).toBe(true);
  });

  it("a turn interrupted before the SDK breaks still completes quietly", async () => {
    // No stream error at all — the SDK closes cleanly after the
    // error-flagged result. `state.resultErrorText` must not be thrown on.
    mockThrowAtEnd = undefined;

    const events = await drainChatTurn("chat-clean-close", { stop: true });

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(logErrorSpy).not.toHaveBeenCalled();
  });
});
