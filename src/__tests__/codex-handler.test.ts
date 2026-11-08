/**
 * Codex handler integration tests — exercise the main handleMessage
 * flow with a sophisticated `@openai/codex-sdk` mock.
 *
 * The handler's responsibility is to:
 *   1. Build the prompt + system prefix (first-turn only).
 *   2. Start or resume a Codex thread.
 *   3. Drive `runStreamed` and translate events into stream state.
 *   4. Abort the thread when a terminator tool fires.
 *   5. Route delivery (text-part / synthetic-error / empty / tool) via shared.
 *   6. Persist the thread id for future resume.
 *
 * These tests verify each path with hand-built event sequences.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getMetrics, resetMetrics } from "../storage/metrics.js";
import { CODEX_CHATGPT_DEFAULT_MODEL } from "../backend/codex/constants.js";

// ── Shared mock state ───────────────────────────────────────────────────────

interface MockEvent {
  type: string;
  [key: string]: unknown;
}

let MOCK_EVENTS: MockEvent[] = [];
// Per-call event queue. When non-empty, each `runStreamed` call shifts
// one entry off the front and yields those events INSTEAD of
// `MOCK_EVENTS`. Lets retry-path tests configure
// "fail-with-events-on-call-1, succeed-with-different-events-on-call-2".
let MOCK_EVENTS_QUEUE: MockEvent[][] = [];
let MOCK_RUN_STREAMED_CALLS: Array<{ input: string; signal?: AbortSignal }> =
  [];
let MOCK_THREAD_OPTIONS_SEEN: Array<Record<string, unknown>> = [];
let MOCK_RESUME_CALLS: string[] = [];
let MOCK_RUN_STREAMED_THROWS: Error | null = null;
// Per-call throw queue. Shifted on each runStreamed call; null entries
// behave like a normal (non-throwing) call. Empty queue → no throws.
// Lets retry-path tests configure "throw first, succeed second".
let MOCK_RUN_STREAMED_THROW_QUEUE: Array<Error | null> = [];
// Fires while `runStreamed` is mid-await — exposed so the
// active-abort-registry tests can inspect the handler's internal
// registry DURING the turn (before the `finally` cleanup runs). The
// callback receives no arguments; the test owns the chatId(s) it cares
// about and queries `getActiveAbort(chatId)` itself.
let MOCK_ACTIVE_ABORT_DURING_TURN: (() => void) | null = null;
let MOCK_ACTIVE_ABORT_SNAPSHOT: AbortController | undefined;
let originalCodexHome: string | undefined;
let tempCodexHome: string;

vi.mock("@openai/codex-sdk", () => {
  class MockThread {
    constructor(public id: string | null = null) {}
    async runStreamed(input: string, options?: { signal?: AbortSignal }) {
      MOCK_RUN_STREAMED_CALLS.push({ input, signal: options?.signal });
      // Snapshot the registry while the turn is mid-flight (before
      // the finally-block cleanup runs).
      if (MOCK_ACTIVE_ABORT_DURING_TURN) {
        MOCK_ACTIVE_ABORT_DURING_TURN();
      }
      if (MOCK_RUN_STREAMED_THROW_QUEUE.length > 0) {
        const next = MOCK_RUN_STREAMED_THROW_QUEUE.shift();
        if (next) throw next;
      }
      if (MOCK_RUN_STREAMED_THROWS) {
        throw MOCK_RUN_STREAMED_THROWS;
      }
      const eventsForThisCall =
        MOCK_EVENTS_QUEUE.length > 0
          ? (MOCK_EVENTS_QUEUE.shift() ?? MOCK_EVENTS)
          : MOCK_EVENTS;
      const events = (async function* (): AsyncGenerator<MockEvent> {
        for (const event of eventsForThisCall) {
          yield event;
        }
      })();
      return { events };
    }
  }
  return {
    Codex: class {
      constructor(public options: unknown) {}
      startThread(options?: Record<string, unknown>) {
        MOCK_THREAD_OPTIONS_SEEN.push(options ?? {});
        return new MockThread();
      }
      resumeThread(id: string, options?: Record<string, unknown>) {
        MOCK_RESUME_CALLS.push(id);
        MOCK_THREAD_OPTIONS_SEEN.push(options ?? {});
        return new MockThread(id);
      }
    },
  };
});

vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
  getPluginPromptAdditions: vi.fn(() => []),
}));

vi.mock("../util/trace.js", () => ({
  traceMessage: vi.fn(),
}));

// Modules under test (imported after mocks are wired)
const { handleMessage, getActiveAbort } =
  await import("../backend/codex/handler/index.js");
const { initCodexAgent } = await import("../backend/codex/init.js");
const { resetState } = await import("../backend/codex/state.js");
const sessions = await import("../storage/sessions.js");
const chatSettings = await import("../storage/chat-settings.js");
const coreModels = await import("../core/models/catalog.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function setupHandler(overrides: Record<string, unknown> = {}): void {
  // Pass an explicit `codexApiKey` so `detectCodexAuth` lands in
  // api-key mode (and doesn't read the host's `~/.codex/auth.json`,
  // which on developer machines may be in chatgpt OAuth mode and
  // would otherwise change the auth-aware default model under us).
  initCodexAgent(
    {
      model: "gpt-5-codex",
      codexApiKey: "test-api-key",
      workspace: "/tmp",
      systemPrompt: "Test system prompt.",
      frontend: "telegram",
      ...overrides,
    } as never,
    () => 19876,
    "telegram",
  );
}

function resetMocks(): void {
  MOCK_EVENTS = [];
  MOCK_EVENTS_QUEUE = [];
  MOCK_RUN_STREAMED_CALLS = [];
  MOCK_THREAD_OPTIONS_SEEN = [];
  MOCK_RESUME_CALLS = [];
  MOCK_RUN_STREAMED_THROWS = null;
  MOCK_RUN_STREAMED_THROW_QUEUE = [];
  MOCK_ACTIVE_ABORT_DURING_TURN = null;
  MOCK_ACTIVE_ABORT_SNAPSHOT = undefined;
}

function writeRollout(opts: {
  year: string;
  month: string;
  day: string;
  threadId: string;
  events: unknown[];
}): void {
  const dir = join(tempCodexHome, "sessions", opts.year, opts.month, opts.day);
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `rollout-${opts.year}-${opts.month}-${opts.day}T00-00-00-${opts.threadId}.jsonl`,
  );
  const body = opts.events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(file, body);
}

beforeEach(() => {
  originalCodexHome = process.env.CODEX_HOME;
  tempCodexHome = mkdtempSync(join(tmpdir(), "talon-codex-home-"));
  process.env.CODEX_HOME = tempCodexHome;
  resetMetrics();
  resetState();
  resetMocks();
  // Clear any stored session state from previous tests.
  sessions.resetSession("test-chat");
});

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  rmSync(tempCodexHome, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("codex / handleMessage — happy path", () => {
  it("starts a fresh thread on first turn + ships the agent message", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_test_1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "i1",
          type: "agent_message",
          text: "Hello from Codex.",
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cached_input_tokens: 10,
          reasoning_output_tokens: 5,
        },
      },
    ];

    const delivered: string[] = [];
    const result = await handleMessage({
      chatId: "test-chat",
      text: "Say hi",
      senderName: "Ada",
      isGroup: false,
      onTextBlock: async (text) => {
        delivered.push(text);
      },
    });

    expect(result.text).toBe("Hello from Codex.");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.cacheRead).toBe(10);
    expect(delivered).toEqual(["Hello from Codex."]);
    // Thread started fresh, not resumed
    expect(MOCK_RESUME_CALLS).toEqual([]);
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(1);
    // Thread id persisted in session storage
    expect(sessions.getSession("test-chat").sessionId).toBe("thr_test_1");
  });

  it("pipes rollout token_count events into session numApiCalls", async () => {
    setupHandler();
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "thr_test_1",
      events: [
        {
          timestamp: "2026-05-21T00:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 100 },
              last_token_usage: { input_tokens: 100 },
              model_context_window: 272000,
            },
            rate_limits: {
              limit_id: "codex",
              primary: { used_percent: 3 },
              secondary: { used_percent: 18 },
              credits: null,
              plan_type: "plus",
              rate_limit_reached_type: null,
            },
          },
        },
        {
          timestamp: "2026-05-21T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 200 },
              last_token_usage: { input_tokens: 200 },
              model_context_window: 272000,
            },
            rate_limits: {
              limit_id: "codex",
              primary: { used_percent: 4 },
              secondary: { used_percent: 18 },
              credits: null,
              plan_type: "plus",
              rate_limit_reached_type: null,
            },
          },
        },
      ],
    });

    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_test_1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "i1",
          type: "agent_message",
          text: "Hello from Codex.",
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cached_input_tokens: 10,
          reasoning_output_tokens: 5,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "Say hi",
      senderName: "Ada",
      isGroup: false,
    });

    expect(sessions.getSession("test-chat").usage.numApiCalls).toBe(2);
    const metrics = getMetrics();
    expect(metrics.counters["api_calls_total"]).toBe(2);
    expect(metrics.counters["backend.codex.queries"]).toBe(1);
    expect(metrics.histograms["api_calls_per_turn"]).toMatchObject({
      count: 1,
      avg: 2,
      min: 2,
      max: 2,
    });
    expect(metrics.histograms["tool_calls_per_turn"]).toMatchObject({
      count: 1,
      avg: 0,
      min: 0,
      max: 0,
    });
  });

  it("resumes existing thread on second turn", async () => {
    setupHandler();
    sessions.setSessionId("test-chat", "thr_resumed_42");

    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_resumed_42" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "Continuing." },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          cached_input_tokens: 5,
          reasoning_output_tokens: 0,
        },
      },
    ];

    // Mark previous turns so the system prompt isn't re-prepended.
    sessions.incrementTurns("test-chat");

    await handleMessage({
      chatId: "test-chat",
      text: "What did I say before?",
      senderName: "Ada",
      isGroup: false,
    });

    expect(MOCK_RESUME_CALLS).toEqual(["thr_resumed_42"]);
    // On resumed turn, the prompt does NOT carry the system-prefix preamble
    const sentInput = MOCK_RUN_STREAMED_CALLS[0].input;
    expect(sentInput).not.toMatch(/^Test system prompt/);
  });

  it("prepends system prompt on first turn", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_x" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "First message",
      senderName: "Ada",
      isGroup: false,
    });

    const sentInput = MOCK_RUN_STREAMED_CALLS[0].input;
    // System prompt is prepended (with Codex suffix added by prepareSystemPrompt)
    expect(sentInput).toMatch(/Response flow/);
    expect(sentInput).toContain("First message");
  });
});

describe("codex / handleMessage — context tokens wiring", () => {
  // Codex's `turn.completed.usage` is cumulative across all API calls
  // inside the turn, so it can't be used as a "current context fill"
  // signal. The handler reads the per-call `token_count` event from the
  // Codex CLI rollout JSONL to recover the last call's prompt size.
  //
  // These tests verify the wiring end-to-end: turn completes, rollout
  // file is read, session.usage.contextTokens reflects the LAST event,
  // and session.usage.contextWindow gets the rollout's reported value
  // (preferred over the static model catalog).

  let origCodexHome: string | undefined;
  let fakeCodexHome: string;

  beforeEach(() => {
    origCodexHome = process.env.CODEX_HOME;
    fakeCodexHome = mkdtempSync(join(tmpdir(), "talon-codex-ctx-"));
    process.env.CODEX_HOME = fakeCodexHome;
  });

  afterEach(() => {
    if (origCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = origCodexHome;
    }
    rmSync(fakeCodexHome, { recursive: true, force: true });
  });

  function writeRolloutWithTokens(
    threadId: string,
    lastInputTokens: number,
    contextWindow?: number,
  ): void {
    const dir = join(fakeCodexHome, "sessions", "2026", "05", "21");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-05-21T00-00-00-${threadId}.jsonl`);
    const event = {
      timestamp: "2026-05-21T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: lastInputTokens * 5 },
          last_token_usage: { input_tokens: lastInputTokens },
          model_context_window: contextWindow,
        },
      },
    };
    writeFileSync(file, JSON.stringify(event));
  }

  it("populates session.usage.contextTokens from rollout last_token_usage", async () => {
    setupHandler();
    writeRolloutWithTokens("thr_ctx_1", 98088, 258400);
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_ctx_1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        // Cumulative — wildly larger than the actual context fill, as
        // Codex aggregates across all API calls in the turn. This is
        // exactly the "context unknown" bug: relying on this value
        // either shows nonsense or "unknown" depending on the resolver.
        type: "turn.completed",
        usage: {
          input_tokens: 2811105, // ← cumulative across 20+ calls
          output_tokens: 50,
          cached_input_tokens: 2660352,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "hi",
      senderName: "Ada",
      isGroup: false,
    });

    // contextTokens reflects the rollout's LAST call (98088), NOT the
    // cumulative turn usage (2.8M).
    const usage = sessions.getSession("test-chat").usage;
    expect(usage.contextTokens).toBe(98088);
    // contextWindow comes from the rollout, not the static catalog.
    expect(usage.contextWindow).toBe(258400);
  });

  it("falls back gracefully when rollout file is missing", async () => {
    setupHandler();
    // No rollout file written for this thread_id.
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_missing_rollout" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cached_input_tokens: 10,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "hi",
      senderName: "Ada",
      isGroup: false,
    });

    // Rollout absent → contextTokens stays at 0 → /status shows
    // "unknown", which is the correct under-promise behaviour.
    const usage = sessions.getSession("test-chat").usage;
    expect(usage.contextTokens).toBe(0);
  });

  it("does not crash when rollout file is malformed", async () => {
    setupHandler();
    const dir = join(fakeCodexHome, "sessions", "2026", "05", "21");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rollout-2026-05-21T00-00-00-thr_garbage.jsonl"),
      "not json at all\n{partial: also bad",
    );
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_garbage" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await expect(
      handleMessage({
        chatId: "test-chat",
        text: "hi",
        senderName: "Ada",
        isGroup: false,
      }),
    ).resolves.toBeDefined();
    expect(sessions.getSession("test-chat").usage.contextTokens).toBe(0);
  });

  // ── Terminator-abort token fallback ────────────────────────────────
  //
  // Almost every Talon turn ends via the end_turn terminator, which
  // aborts the Codex stream BEFORE `turn.completed` fires — so the
  // SDK-side usage capture stays null and every token metric read 0
  // (the 2026-06-12 all-zeros bug). The handler must fall back to
  // diffing the rollout's cumulative `total_token_usage` against a
  // pre-turn baseline.

  function writeRolloutWithTotals(
    threadId: string,
    totals: { input: number; cached: number; output: number },
  ): void {
    const dir = join(fakeCodexHome, "sessions", "2026", "06", "12");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-06-12T00-00-00-${threadId}.jsonl`);
    const event = {
      timestamp: "2026-06-12T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: totals.input,
            cached_input_tokens: totals.cached,
            output_tokens: totals.output,
          },
          last_token_usage: { input_tokens: totals.input },
          model_context_window: 258400,
        },
      },
    };
    writeFileSync(file, JSON.stringify(event));
  }

  /** Event list for a turn that ends via end_turn with NO turn.completed. */
  function terminatedTurnEvents(threadId: string): unknown[] {
    return [
      { type: "thread.started", thread_id: threadId },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "i1",
          type: "mcp_tool_call",
          server: "telegram-tools",
          tool: "end_turn",
          arguments: { text: "done!" },
          status: "completed",
        },
      },
      // No turn.completed — the terminator abort kills the stream first.
    ];
  }

  it("records token usage from rollout totals when the terminator aborts before turn.completed", async () => {
    setupHandler();
    writeRolloutWithTotals("thr_term_fresh", {
      input: 21252,
      cached: 2432,
      output: 313,
    });
    MOCK_EVENTS = terminatedTurnEvents("thr_term_fresh") as never;

    const result = await handleMessage({
      chatId: "test-chat",
      text: "hi",
      senderName: "Ada",
      isGroup: false,
    });

    // Fresh thread → zero baseline → this turn's usage IS the totals.
    expect(result.inputTokens).toBe(21252);
    expect(result.outputTokens).toBe(313);
    expect(result.cacheRead).toBe(2432);

    const metrics = getMetrics();
    expect(metrics.counters["tokens.input_total"]).toBe(21252);
    expect(metrics.counters["tokens.output_total"]).toBe(313);
    expect(metrics.counters["backend.codex.tokens.input"]).toBe(21252);
    expect(metrics.counters["backend.codex.tokens.cache_read"]).toBe(2432);
  });

  it("records only this turn's delta on a resumed thread", async () => {
    setupHandler();
    sessions.setSessionId("test-chat", "thr_term_delta");
    // Previous turns left cumulative totals in the rollout…
    writeRolloutWithTotals("thr_term_delta", {
      input: 1000,
      cached: 800,
      output: 100,
    });
    MOCK_EVENTS = terminatedTurnEvents("thr_term_delta") as never;

    const result = await handleMessage({
      chatId: "test-chat",
      text: "hi again",
      senderName: "Ada",
      isGroup: false,
      // …and this turn's API calls grow them. Simulated mid-turn (the
      // baseline is captured before runStreamed; tool events fire after).
      onToolUse: () => {
        writeRolloutWithTotals("thr_term_delta", {
          input: 1500,
          cached: 1200,
          output: 160,
        });
      },
    });

    expect(result.inputTokens).toBe(500);
    expect(result.cacheRead).toBe(400);
    expect(result.outputTokens).toBe(60);
  });

  it("does not re-count previous turns' usage when the rollout didn't grow", async () => {
    setupHandler();
    sessions.setSessionId("test-chat", "thr_term_static");
    writeRolloutWithTotals("thr_term_static", {
      input: 1000,
      cached: 800,
      output: 100,
    });
    MOCK_EVENTS = terminatedTurnEvents("thr_term_static") as never;

    const result = await handleMessage({
      chatId: "test-chat",
      text: "hi again",
      senderName: "Ada",
      isGroup: false,
    });

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.cacheRead).toBe(0);
  });

  it("prefers the rollout delta over turn.completed's CUMULATIVE usage", async () => {
    // Codex's SDK Usage on turn.completed sums input across every API
    // call in the turn — a ~20-call turn reports ~20× the real context
    // fill. The regression: that figure was recorded as the turn's
    // input whenever turn.completed fired, so the companion UI showed
    // 812k-token "small conversations". The rollout delta is the only
    // per-turn source of truth; the SDK figure is unreliable.
    setupHandler();
    writeRolloutWithTotals("thr_cumulative", {
      input: 40_000,
      cached: 30_000,
      output: 900,
    });
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_cumulative" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "done" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 812_000, // cumulative across ~20 calls — wrong units
          output_tokens: 4_000,
          cached_input_tokens: 700_000,
          reasoning_output_tokens: 0,
        },
      },
    ] as never;

    const result = await handleMessage({
      chatId: "test-chat",
      text: "hi",
      senderName: "Ada",
      isGroup: false,
    });

    // Fresh thread → zero baseline → this turn's usage IS the rollout
    // totals, never the SDK's cumulative figure.
    expect(result.inputTokens).toBe(40_000);
    expect(result.cacheRead).toBe(30_000);
    expect(result.outputTokens).toBe(900);
  });
});

describe("codex / handleMessage — error paths", () => {
  it("re-prompts once when text-part delivery fails instead of completing silently", async () => {
    setupHandler();
    MOCK_EVENTS_QUEUE = [
      [
        { type: "thread.started", thread_id: "thr_delivery_retry" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: {
            id: "i1",
            type: "agent_message",
            text: "x".repeat(8101),
          },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 10,
            output_tokens: 10,
            cached_input_tokens: 0,
            reasoning_output_tokens: 0,
          },
        },
      ],
      [
        { type: "thread.started", thread_id: "thr_delivery_retry" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: {
            id: "i2",
            type: "agent_message",
            text: "short retry",
          },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 11,
            output_tokens: 2,
            cached_input_tokens: 0,
            reasoning_output_tokens: 0,
          },
        },
      ],
    ];

    const delivered: string[] = [];
    let attempts = 0;
    const result = await handleMessage({
      chatId: "test-chat",
      text: "write a long answer",
      senderName: "Ada",
      isGroup: false,
      onTextBlock: async (t) => {
        attempts++;
        if (attempts === 1) {
          throw new Error("Bad Request: message is too long");
        }
        delivered.push(t);
      },
    });

    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(2);
    expect(MOCK_RUN_STREAMED_CALLS[1].input).toContain("DELIVERY FAILURE");
    expect(MOCK_RUN_STREAMED_CALLS[1].input).toContain("message is too long");
    expect(delivered).toEqual(["short retry"]);
    expect(result.text).toBe("short retry");
    expect(sessions.getSession("test-chat").turns).toBe(1);
  });

  it("turn.failed event surfaces as syntheticError → delivery emits ⚠️", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_fail" },
      { type: "turn.started" },
      {
        type: "turn.failed",
        error: { message: "model overloaded" },
      },
    ];

    const delivered: string[] = [];
    const result = await handleMessage({
      chatId: "test-chat",
      text: "boom",
      senderName: "Ada",
      isGroup: false,
      onTextBlock: async (t) => {
        delivered.push(t);
      },
    });

    expect(delivered[0]).toBe("⚠️ Codex: model overloaded");
    // `result.text` is empty for the synthetic-error route
    expect(result.text).toBe("");
  });

  it("error event also surfaces as synthetic", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_err" },
      { type: "error", message: "fatal stream error" },
    ];

    const delivered: string[] = [];
    await handleMessage({
      chatId: "test-chat",
      text: "boom",
      senderName: "Ada",
      isGroup: false,
      onTextBlock: async (t) => {
        delivered.push(t);
      },
    });

    expect(delivered[0]).toBe("⚠️ Codex: fatal stream error");
  });

  it("empty turn (no agent_message, no failure) emits empty-turn notice", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_empty" },
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cached_input_tokens: 0,
          reasoning_output_tokens: 5,
        },
      },
    ];

    const delivered: string[] = [];
    await handleMessage({
      chatId: "test-chat",
      text: "say nothing",
      senderName: "Ada",
      isGroup: false,
      onTextBlock: async (t) => {
        delivered.push(t);
      },
    });

    // Empty turn → nothing delivered (no "(no reply …)" slop).
    expect(delivered).toHaveLength(0);
  });
});

describe("codex / handleMessage — tool use", () => {
  it("mcp_tool_call items get recorded as toolCalls + onToolUse fires", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_tool" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "i1",
          type: "mcp_tool_call",
          server: "telegram-tools",
          tool: "react",
          arguments: { emoji: "🔥" },
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { id: "i2", type: "agent_message", text: "reacted" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const tools: Array<{ name: string; input: Record<string, unknown> }> = [];
    await handleMessage({
      chatId: "test-chat",
      text: "react with fire",
      senderName: "Ada",
      isGroup: false,
      onToolUse: (name, input) => {
        tools.push({ name, input });
      },
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("react");
    expect(tools[0].input).toEqual({ emoji: "🔥" });

    const metrics = getMetrics();
    expect(metrics.counters["backend.codex.tool_calls"]).toBe(1);
    expect(metrics.counters["tool_calls.react"]).toBe(1);
    expect(metrics.counters["tool_calls.react"]).toBe(1);
    expect(metrics.counters["turns_with_tools_total"]).toBe(1);
    expect(metrics.histograms["tool_calls_per_turn"]).toMatchObject({
      count: 1,
      avg: 1,
      min: 1,
      max: 1,
    });
  });

  it("end_turn-as-MCP-tool triggers abort", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_end_turn" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "i1",
          type: "mcp_tool_call",
          server: "telegram-tools",
          tool: "end_turn",
          arguments: { text: "done!" },
          status: "completed",
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "wrap up",
      senderName: "Ada",
      isGroup: false,
    });

    // The signal should have been aborted by the terminator path
    expect(MOCK_RUN_STREAMED_CALLS[0].signal?.aborted).toBe(true);
  });
});

describe("codex / handleMessage — thread options", () => {
  it("propagates the hard-coded thread options on a fresh thread", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_opts_1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "ping",
      senderName: "Ada",
      isGroup: false,
    });

    expect(MOCK_THREAD_OPTIONS_SEEN).toHaveLength(1);
    const opts = MOCK_THREAD_OPTIONS_SEEN[0];
    // Model passthrough — defaults to config.model
    expect(opts.model).toBe("gpt-5-codex");
    // Codex normally insists on git; Talon is an assistant, not a coding session.
    expect(opts.skipGitRepoCheck).toBe(true);
    // Full-access permission triple (CODEX_THREAD_PERMISSIONS). Talon
    // runs every other backend with the equivalent (bypassPermissions
    // / allowDangerouslySkipPermissions in Claude SDK, etc); restricting
    // Codex tighter just silently fails its shell/file/network tool
    // calls without changing the security model.
    expect(opts.sandboxMode).toBe("danger-full-access");
    expect(opts.approvalPolicy).toBe("never");
    expect(opts.networkAccessEnabled).toBe(true);
  });

  it("passes the same options when resuming an existing thread", async () => {
    setupHandler();
    sessions.setSessionId("test-chat", "thr_resumed");
    sessions.incrementTurns("test-chat");

    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_resumed" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "ping",
      senderName: "Ada",
      isGroup: false,
    });

    expect(MOCK_RESUME_CALLS).toEqual(["thr_resumed"]);
    // resumeThread receives the same threadOptions shape as startThread.
    // Full-access permission triple (CODEX_THREAD_PERMISSIONS) — see the
    // sibling test above for the security-boundary reasoning.
    expect(MOCK_THREAD_OPTIONS_SEEN[0]).toMatchObject({
      model: "gpt-5-codex",
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
    });
  });
});

describe("codex / handleMessage — active abort registry", () => {
  it("getActiveAbort returns undefined for a chat with no in-flight turn", () => {
    expect(getActiveAbort("idle-chat")).toBeUndefined();
  });

  it("registers an abort controller while the turn is in flight", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_abort_lifecycle" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    // Capture the controller at the moment the runStreamed mock is reached.
    MOCK_ACTIVE_ABORT_DURING_TURN = () => {
      MOCK_ACTIVE_ABORT_SNAPSHOT = getActiveAbort("test-chat");
    };

    await handleMessage({
      chatId: "test-chat",
      text: "hi",
      senderName: "Ada",
      isGroup: false,
    });

    // While the SDK loop ran, the registry had a controller for the chat.
    expect(MOCK_ACTIVE_ABORT_SNAPSHOT).toBeInstanceOf(AbortController);
    // The signal hooked into runStreamed is the SAME controller's signal.
    expect(MOCK_RUN_STREAMED_CALLS[0].signal).toBe(
      MOCK_ACTIVE_ABORT_SNAPSHOT?.signal,
    );
    // After the turn completes, the registry no longer holds it.
    expect(getActiveAbort("test-chat")).toBeUndefined();
  });

  it("scopes abort controllers per chat — different chats get different controllers", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_chat_a" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "a" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const seen: AbortController[] = [];
    MOCK_ACTIVE_ABORT_DURING_TURN = () => {
      // The mock fires once per turn; query both possible chats and push
      // whichever one is currently registered.
      const a = getActiveAbort("chat-a");
      if (a) seen.push(a);
      const b = getActiveAbort("chat-b");
      if (b) seen.push(b);
    };

    // Two sequential turns for distinct chats — each registers its own
    // controller and tears it down before the next runs.
    await handleMessage({
      chatId: "chat-a",
      text: "hi",
      senderName: "A",
      isGroup: false,
    });
    sessions.resetSession("chat-a");
    await handleMessage({
      chatId: "chat-b",
      text: "hi",
      senderName: "B",
      isGroup: false,
    });

    // Both turns saw a distinct controller while in flight, neither leaked
    // into the other's registry slot.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(getActiveAbort("chat-a")).toBeUndefined();
    expect(getActiveAbort("chat-b")).toBeUndefined();
    // Cleanup
    sessions.resetSession("chat-a");
    sessions.resetSession("chat-b");
  }, 10_000);
});

describe("codex / handleMessage — tool call accounting", () => {
  it("dedups tool calls by id when the same id arrives twice", async () => {
    setupHandler();
    const dupItem = {
      id: "tool_dup",
      type: "mcp_tool_call",
      server: "telegram-tools",
      tool: "react",
      arguments: { emoji: "🔥" },
      status: "completed",
    };
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_dedup" },
      { type: "turn.started" },
      { type: "item.completed", item: dupItem },
      // Same tool_use_id arriving again with the same `completed`
      // status — Codex occasionally re-emits the completion event for
      // the same item. The `seenToolCallIds` gate must dedup it.
      //
      // (The `in_progress` → `completed` lifecycle is handled by the
      // status filter in `handleMcpToolCall`, not by this dedup — see
      // the dedicated regression test below.)
      { type: "item.completed", item: dupItem },
      {
        type: "item.completed",
        item: { id: "i2", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const tools: Array<{ name: string; input: Record<string, unknown> }> = [];
    await handleMessage({
      chatId: "test-chat",
      text: "react please",
      senderName: "Ada",
      isGroup: false,
      onToolUse: (name, input) => {
        tools.push({ name, input });
      },
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("react");
  });

  it("skips `in_progress` mcp_tool_call items entirely and only acts on `completed`", async () => {
    // Regression: Codex SDK emits each mcp_tool_call item twice — once
    // when the tool is dispatched (`status: "in_progress"`) and again
    // after the MCP server returns the result (`status: "completed"`).
    //
    // The old code accepted both states; combined with the dedup-on-id
    // gate, that meant we acted on whichever arrived first. For a
    // terminator tool, that flipped `turnTerminated` (and aborted the
    // Codex subprocess) BEFORE the bridge had executed the delivery.
    //
    // The handler must wait for `completed` before recording the tool
    // use, firing onToolUse, or detecting a terminator.
    setupHandler();
    const endTurnItem = {
      id: "tool_in_progress_then_completed",
      type: "mcp_tool_call",
      server: "telegram-tools",
      tool: "end_turn",
      arguments: { text: "delivered" },
    };
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_in_progress" },
      { type: "turn.started" },
      // First emit: in_progress — must be ignored entirely.
      {
        type: "item.completed",
        item: { ...endTurnItem, status: "in_progress" },
      },
      // Some plain agent_message text in between so we can sanity-check
      // that the in_progress emit didn't already flip turnTerminated and
      // race the abort.
      {
        type: "item.completed",
        item: { id: "msg1", type: "agent_message", text: "thinking..." },
      },
      // Second emit: completed — this is the one we act on.
      {
        type: "item.completed",
        item: { ...endTurnItem, status: "completed" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const tools: string[] = [];
    await handleMessage({
      chatId: "test-chat",
      text: "say hi",
      senderName: "Ada",
      isGroup: false,
      onToolUse: (name) => {
        tools.push(name);
      },
    });

    // Exactly one fire — only the `completed` event drove onToolUse.
    expect(tools).toEqual(["end_turn"]);
    // Terminator fired (signal aborted) — but only after `completed`.
    // The fact that we got the in_progress event first and the next
    // agent_message text still came through (i.e. the loop wasn't
    // already aborted) confirms the race is gone.
    expect(MOCK_RUN_STREAMED_CALLS[0].signal?.aborted).toBe(true);
  });

  it("counts mcp_tool_call items with status `failed` without mutating turn state", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_failed_status" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "tool_failed",
          type: "mcp_tool_call",
          server: "telegram-tools",
          tool: "react",
          arguments: { emoji: "💩" },
          status: "failed",
        },
      },
      {
        type: "item.completed",
        item: { id: "i2", type: "agent_message", text: "tried but failed" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const tools: string[] = [];
    const result = await handleMessage({
      chatId: "test-chat",
      text: "react please",
      senderName: "Ada",
      isGroup: false,
      onToolUse: (name) => {
        tools.push(name);
      },
    });

    // A failed call is still a call: it counts in the tool metrics and
    // fires onToolUse (matching the Claude SDK backend, which counts
    // every tool_use block regardless of outcome)…
    expect(tools).toEqual(["react"]);
    const metrics = getMetrics();
    expect(metrics.counters["tool_calls.react"]).toBe(1);
    expect(metrics.counters["backend.codex.tool_calls"]).toBe(1);

    // …but it must NOT terminate the turn: a failed `react` delivered
    // nothing, so the agent_message text still has to reach the user.
    expect(result.text).toBe("tried but failed");
  });

  it("processes multiple tool calls in order in a single turn", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_multi_tool" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "tool_1",
          type: "mcp_tool_call",
          server: "mempalace-tools",
          tool: "mempalace_search",
          arguments: { query: "Ada" },
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "tool_2",
          type: "mcp_tool_call",
          server: "telegram-tools",
          tool: "react",
          arguments: { emoji: "👍" },
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "tool_3",
          type: "mcp_tool_call",
          server: "telegram-tools",
          tool: "end_turn",
          arguments: { text: "found it" },
          status: "completed",
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 30,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const calls: string[] = [];
    await handleMessage({
      chatId: "test-chat",
      text: "look up Ada and react",
      senderName: "Ada",
      isGroup: false,
      onToolUse: (name) => {
        calls.push(name);
      },
    });

    // Order preserved — important for the rate-limiter and metrics view.
    expect(calls).toEqual(["mempalace_search", "react", "end_turn"]);
    // Terminator fired on the last tool — the signal got aborted.
    expect(MOCK_RUN_STREAMED_CALLS[0].signal?.aborted).toBe(true);
  });
});

describe("codex / handleMessage — model resolution", () => {
  it("prefers the chat-settings model over config.model", async () => {
    setupHandler();
    chatSettings.setChatModel("test-chat", "gpt-5");

    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_chatmodel" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "hi",
      senderName: "Ada",
      isGroup: false,
    });

    expect(MOCK_THREAD_OPTIONS_SEEN[0].model).toBe("gpt-5");
    // Reset for downstream tests
    chatSettings.setChatModel("test-chat", undefined);
  });

  it("falls back to CODEX_DEFAULT_MODEL when config.model is absent", async () => {
    // Init without an explicit model — handler should fall back to
    // CODEX_DEFAULT_MODEL ("gpt-5-codex") on the api-key auth path.
    // `codexApiKey` forces api-key mode so the auth-aware default
    // is the api-key default and not the chatgpt fallback.
    initCodexAgent(
      {
        codexApiKey: "test-api-key",
        workspace: "/tmp",
        systemPrompt: "Test system prompt.",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_defmodel" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "hi",
      senderName: "Ada",
      isGroup: false,
    });

    expect(MOCK_THREAD_OPTIONS_SEEN[0].model).toBe("gpt-5-codex");
  });
});

describe("codex / handleMessage — agent_message edge cases", () => {
  it("ignores agent_message items with empty text", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_empty_text" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cached_input_tokens: 0,
          reasoning_output_tokens: 5,
        },
      },
    ];

    const delivered: string[] = [];
    const result = await handleMessage({
      chatId: "test-chat",
      text: "say nothing",
      senderName: "Ada",
      isGroup: false,
      onTextBlock: async (t) => {
        delivered.push(t);
      },
    });

    // Empty agent_message → no response text → empty turn stays silent.
    expect(result.text).toBe("");
    expect(delivered).toHaveLength(0);
  });

  it("ignores agent_message items with whitespace-only text", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_ws_text" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "   \n\t   " },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const delivered: string[] = [];
    const result = await handleMessage({
      chatId: "test-chat",
      text: "say nothing",
      senderName: "Ada",
      isGroup: false,
      onTextBlock: async (t) => {
        delivered.push(t);
      },
    });

    expect(result.text).toBe("");
    expect(delivered).toHaveLength(0);
  });
});

describe("codex / handleMessage — non-MCP items", () => {
  it("keeps native Codex items off the reply surface but counts tool-like items", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_other_items" },
      { type: "turn.started" },
      // None of these item types should affect the assistant's reply
      // surface — they're CLI ambient activity from Codex's shell mode
      // that doesn't map to Talon's chat channel.
      {
        type: "item.completed",
        item: { id: "r1", type: "reasoning", text: "thinking…" },
      },
      {
        type: "item.completed",
        item: {
          id: "c1",
          type: "command_execution",
          command: "ls",
          status: "completed",
          exit_code: 0,
        },
      },
      {
        type: "item.completed",
        item: {
          id: "f1",
          type: "file_change",
          status: "completed",
          changes: [{ kind: "modify", path: "/tmp/x" }],
        },
      },
      {
        type: "item.completed",
        item: { id: "w1", type: "web_search", query: "anthropic" },
      },
      {
        type: "item.completed",
        item: {
          id: "t1",
          type: "todo_list",
          items: [{ text: "step 1", completed: true }],
        },
      },
      {
        type: "item.completed",
        item: {
          id: "img1",
          type: "image_generation",
        },
      },
      {
        type: "item.completed",
        item: { id: "a1", type: "agent_message", text: "done" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 30,
          output_tokens: 5,
          cached_input_tokens: 0,
          reasoning_output_tokens: 10,
        },
      },
    ];

    const tools: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await handleMessage({
      chatId: "test-chat",
      text: "do a thing",
      senderName: "Ada",
      isGroup: false,
      onToolUse: (name, input) => {
        tools.push({ name, input });
      },
    });

    // Only the agent_message contributes to the reply text. Native
    // Codex tools surface under the fleet-wide vocabulary (Bash /
    // Edit / WebSearch) so metrics line up with the Claude SDK
    // backend; unknown item types keep their raw type name.
    expect(result.text).toBe("done");
    expect(tools).toEqual([
      {
        name: "Bash",
        input: { command: "ls", status: "completed", exit_code: 0 },
      },
      {
        name: "Edit",
        input: {
          status: "completed",
          changes: [{ kind: "modify", path: "/tmp/x" }],
        },
      },
      { name: "WebSearch", input: { query: "anthropic" } },
      { name: "image_generation", input: {} },
    ]);

    const metrics = getMetrics();
    expect(metrics.counters["backend.codex.tool_calls"]).toBe(4);
    expect(metrics.counters["tool_calls.Bash"]).toBe(1);
    expect(metrics.counters["tool_calls.Edit"]).toBe(1);
    expect(metrics.counters["tool_calls.WebSearch"]).toBe(1);
    expect(metrics.counters["tool_calls.image_generation"]).toBe(1);
    expect(metrics.counters["turns_with_tools_total"]).toBe(1);
    expect(metrics.histograms["tool_calls_per_turn"]).toMatchObject({
      count: 1,
      avg: 4,
      min: 4,
      max: 4,
    });
  });

  it("logs `error` items as warnings but does not break the turn", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_error_item" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "e1", type: "error", message: "tool call failed upstream" },
      },
      {
        type: "item.completed",
        item: { id: "a1", type: "agent_message", text: "continued" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const result = await handleMessage({
      chatId: "test-chat",
      text: "go",
      senderName: "Ada",
      isGroup: false,
    });

    // `error` item is informational — the turn proceeds and the
    // agent_message becomes the reply.
    expect(result.text).toBe("continued");
  });
});

describe("codex / handleMessage — session name", () => {
  it("derives the session name from text on the first turn only", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_name_1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "Help me debug the gateway please",
      senderName: "Ada",
      isGroup: false,
    });

    const info = sessions.getSessionInfo("test-chat");
    // `extractSessionName` produces a short label from the first message.
    expect(info.sessionName).toBeTruthy();
    expect(info.sessionName?.length ?? 0).toBeGreaterThan(0);
  });

  it("does not overwrite the session name on subsequent turns", async () => {
    setupHandler();
    sessions.setSessionName("test-chat", "Original name");
    // Mark a previous turn so the handler treats this as a continuation.
    sessions.incrementTurns("test-chat");

    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_name_2" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "A totally different second-turn topic about Marrow",
      senderName: "Ada",
      isGroup: false,
    });

    const info = sessions.getSessionInfo("test-chat");
    expect(info.sessionName).toBe("Original name");
  });
});

describe("codex / handleMessage — terminal failure accounting", () => {
  it("records a failed-turn metric when both attempts throw", async () => {
    setupHandler();
    MOCK_RUN_STREAMED_THROW_QUEUE = [
      new Error("upstream exploded"),
      new Error("upstream exploded again"),
    ];
    MOCK_EVENTS = [];

    await expect(
      handleMessage({
        chatId: "test-chat",
        text: "hi",
        senderName: "Ada",
        isGroup: false,
      }),
    ).rejects.toThrow();

    const metrics = getMetrics();
    // Only the TERMINAL attempt records (the first attempt's retry path
    // defers to the recursive call) — exactly one failed turn.
    expect(metrics.counters["backend.codex.turn_failed"]).toBe(1);
    expect(metrics.counters["backend.codex.queries"]).toBe(1);
    // Nothing streamed before the failure → no phantom usage.
    expect(metrics.counters["tokens.input_total"] ?? 0).toBe(0);
  });
});

describe("codex / handleMessage — error recovery", () => {
  // The classifyRetry-driven recovery ladder is shared with every other
  // backend (see backend/runtime/turn/model-retry.ts). These tests verify that
  // the Codex handler routes its errors through it correctly — resets
  // the session on session_expired / context_length, falls back on
  // retryable, propagates after a single retry.
  it("resets the session and retries on a session_expired error", async () => {
    setupHandler();
    sessions.setSessionId("test-chat", "thr_will_be_reset");
    sessions.incrementTurns("test-chat");

    // First runStreamed throws session_expired; second call (after reset
    // + retry) is the happy path.
    MOCK_RUN_STREAMED_THROW_QUEUE = [
      new Error("session expired or invalid resume"),
      null,
    ];
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_fresh_after_reset" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "back online" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const result = await handleMessage({
      chatId: "test-chat",
      text: "resume me",
      senderName: "Ada",
      isGroup: false,
    });

    // Two runStreamed calls — the original + the retry after reset.
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(2);
    // After reset, the second call hits startThread (no session id).
    // First call hit resumeThread (we'd set a sessionId), so the call
    // sequence reads: resume → reset → start.
    expect(MOCK_RESUME_CALLS).toEqual(["thr_will_be_reset"]);
    // The retry's reply lands in the result.
    expect(result.text).toBe("back online");
    // After the successful retry, the new thread id was persisted.
    expect(sessions.getSession("test-chat").sessionId).toBe(
      "thr_fresh_after_reset",
    );
  });

  it("resets the session and retries on a context_length error", async () => {
    setupHandler();
    sessions.setSessionId("test-chat", "thr_too_long");
    sessions.incrementTurns("test-chat");

    MOCK_RUN_STREAMED_THROW_QUEUE = [
      new Error("context length exceeded — too long"),
      null,
    ];
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_fresh_after_overflow" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "starting over" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const result = await handleMessage({
      chatId: "test-chat",
      text: "huge message",
      senderName: "Ada",
      isGroup: false,
    });

    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(2);
    expect(result.text).toBe("starting over");
  });

  it("falls back to the configured fallback model on a retryable error", async () => {
    setupHandler();
    // Register a Codex-shaped model with a fallback in the global model
    // registry so `getFallbackModel("gpt-5-codex")` returns "gpt-5". The
    // handler's recovery ladder calls this for retryable errors.
    coreModels.registerModels([
      {
        id: "gpt-5-codex",
        aliases: [],
        provider: "openai",
        displayName: "GPT-5 Codex",
        fallback: "gpt-5",
      },
      {
        id: "gpt-5",
        aliases: [],
        provider: "openai",
        displayName: "GPT-5",
      },
    ]);

    try {
      // First call: network blip (retryable). Second call: succeeds on
      // the fallback model.
      MOCK_RUN_STREAMED_THROW_QUEUE = [
        new Error("fetch failed — network unreachable"),
        null,
      ];
      MOCK_EVENTS = [
        { type: "thread.started", thread_id: "thr_after_fallback" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: { id: "i1", type: "agent_message", text: "on fallback" },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 5,
            output_tokens: 3,
            cached_input_tokens: 0,
            reasoning_output_tokens: 0,
          },
        },
      ];

      const result = await handleMessage({
        chatId: "test-chat",
        text: "retry me",
        senderName: "Ada",
        isGroup: false,
      });

      expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(2);
      // First attempt was on the primary model, retry on the fallback.
      expect(MOCK_THREAD_OPTIONS_SEEN[0].model).toBe("gpt-5-codex");
      expect(MOCK_THREAD_OPTIONS_SEEN[1].model).toBe("gpt-5");
      expect(result.text).toBe("on fallback");

      // Critical: the chat's persisted model is RESTORED after the retry
      // — the fallback was a one-shot, not a permanent switch.
      expect(chatSettings.getChatSettings("test-chat").model).toBeUndefined();
    } finally {
      // Restore the global registry for downstream tests.
      coreModels.clearModels();
    }
  });

  it("propagates the original error when the retry also fails", async () => {
    setupHandler();
    sessions.setSessionId("test-chat", "thr_doomed");
    sessions.incrementTurns("test-chat");

    // Both attempts throw the same session_expired error — the second
    // attempt has `_retried = true` so classifyRetry returns
    // `{ kind: "propagate" }` and the handler throws.
    const sessionExpired = new Error("session expired again");
    MOCK_RUN_STREAMED_THROW_QUEUE = [sessionExpired, sessionExpired];

    await expect(
      handleMessage({
        chatId: "test-chat",
        text: "doomed",
        senderName: "Ada",
        isGroup: false,
      }),
    ).rejects.toThrow();
    // Confirms the retry actually fired (two calls), but the second
    // failure was propagated rather than triggering a third attempt.
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(2);
  });

  it("propagates non-recoverable errors without retrying", async () => {
    setupHandler();

    // A 401 auth error is classified as non-retryable + not a
    // reset-eligible reason. classifyRetry returns `propagate`, the
    // handler throws on the first attempt.
    MOCK_RUN_STREAMED_THROW_QUEUE = [
      new Error("unauthorized — invalid api key"),
    ];

    await expect(
      handleMessage({
        chatId: "test-chat",
        text: "auth failure",
        senderName: "Ada",
        isGroup: false,
      }),
    ).rejects.toThrow();
    // Only one attempt — no retry on non-recoverable errors.
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(1);
  });
});

describe("codex / handleMessage — usage propagation", () => {
  it("propagates Codex usage into the QueryResult", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_usage" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "answer" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1234,
          output_tokens: 567,
          cached_input_tokens: 89,
          reasoning_output_tokens: 12,
        },
      },
    ];

    const result = await handleMessage({
      chatId: "test-chat",
      text: "q",
      senderName: "Ada",
      isGroup: false,
    });

    expect(result.inputTokens).toBe(1234);
    expect(result.outputTokens).toBe(567);
    expect(result.cacheRead).toBe(89);
    // Codex doesn't surface cache writes
    expect(result.cacheWrite).toBe(0);
    expect(sessions.getSession("test-chat").usage.contextWindow).toBe(400_000);
  });
});

describe("codex / handleMessage — ChatGPT-auth model fallback", () => {
  // These tests assert the two recovery paths around ChatGPT-OAuth
  // accounts: (1) pre-emptive swap at request build time when the
  // configured model is known-incompatible, (2) post-hoc retry when
  // the model passed validation but Codex returned a 400 anyway.

  it("pre-emptively swaps gpt-5-codex → the ChatGPT default under ChatGPT auth", async () => {
    // Set up a fake HOME with a chatgpt auth.json so this test is
    // self-contained and works on CI (not just on Ada's machine where
    // the real ~/.codex/auth.json happens to be in chatgpt mode).
    const fakeHome = mkdtempSync(join(tmpdir(), "talon-codex-handler-"));
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".codex", "auth.json"),
      '{"auth_mode":"chatgpt"}',
    );
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origApiKey = process.env.OPENAI_API_KEY;
    process.env.HOME = fakeHome;
    delete process.env.USERPROFILE;
    // Suppress OPENAI_API_KEY so this test exercises the auth file.
    delete process.env.OPENAI_API_KEY;
    try {
      // No codexApiKey + no OPENAI_API_KEY env → init reads the fake
      // ~/.codex/auth.json we just created (chatgpt mode). With
      // `gpt-5-codex` set in config, the handler should detect the
      // mismatch before calling `runStreamed` and pass the ChatGPT default to
      // ThreadOptions.
      initCodexAgent(
        {
          model: "gpt-5-codex",
          workspace: "/tmp",
          systemPrompt: "Test system prompt.",
          frontend: "telegram",
        } as never,
        () => 19876,
        "telegram",
      );
    } finally {
      // Restore environment regardless of init outcome.
      if (origHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = origHome;
      }
      if (origUserProfile !== undefined) {
        process.env.USERPROFILE = origUserProfile;
      }
      if (origApiKey !== undefined) {
        process.env.OPENAI_API_KEY = origApiKey;
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }

    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_preempt" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "hi",
      senderName: "Ada",
      isGroup: false,
    });

    // ThreadOptions saw the ChatGPT default even though config said `gpt-5-codex`.
    expect(MOCK_THREAD_OPTIONS_SEEN[0].model).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
    // No retry needed — the pre-emptive swap means runStreamed is
    // called exactly once.
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(1);
  });

  it("post-hoc retries with the ChatGPT default when Codex returns the ChatGPT 400", async () => {
    // Api-key auth so the pre-emptive swap doesn't fire — the handler
    // believes gpt-5-codex is valid, hands it to Codex, and Codex
    // returns the chatgpt-mismatch 400. The handler should classify
    // the error, reset the session, and retry on the ChatGPT default.
    setupHandler();

    const chatgptMismatch = new Error(
      `Codex Exec exited with code 1: Reading prompt from stdin...\n` +
        `{"type":"error","status":400,"error":{"type":"invalid_request_error",` +
        `"message":"The 'gpt-5-codex' model is not supported when using Codex ` +
        `with a ChatGPT account."}}`,
    );
    MOCK_RUN_STREAMED_THROW_QUEUE = [chatgptMismatch, null];
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_after_fallback" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "on fallback" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const result = await handleMessage({
      chatId: "test-chat",
      text: "force the 400",
      senderName: "Ada",
      isGroup: false,
    });

    // Two runStreamed calls — the original + the retry on the
    // chatgpt-compatible model.
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(2);
    expect(MOCK_THREAD_OPTIONS_SEEN[0].model).toBe("gpt-5-codex");
    expect(MOCK_THREAD_OPTIONS_SEEN[1].model).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
    expect(result.text).toBe("on fallback");

    // Chat-settings restored to the original after the retry — the
    // fallback is one-shot, not a permanent switch.
    expect(chatSettings.getChatSettings("test-chat").model).toBeUndefined();
  });

  it("retries via the turn.failed event channel (no thrown error)", async () => {
    // Some failure modes surface only as `turn.failed` events without
    // the SDK rethrowing — the handler still has to detect the
    // mismatch text and retry. (The current SDK does both; this test
    // covers the event-only path defensively via the post-loop check.)
    setupHandler();

    // First call: events include the mismatch turn.failed, then the
    // generator ends cleanly (no throw). The handler sets
    // `turnFailedError` during iteration, the loop exits normally,
    // the post-loop ChatGPT-mismatch check fires the retry.
    // Second call: clean recovery on the ChatGPT default.
    MOCK_EVENTS_QUEUE = [
      // Call 1 — events only, no throw
      [
        { type: "thread.started", thread_id: "thr_event_path_1" },
        { type: "turn.started" },
        {
          type: "turn.failed",
          error: {
            message:
              'The "gpt-5-codex" model is not supported when using Codex with a ChatGPT account.',
          },
        },
      ],
      // Call 2 — clean recovery
      [
        { type: "thread.started", thread_id: "thr_event_path_2" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: { id: "i1", type: "agent_message", text: "recovered" },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cached_input_tokens: 0,
            reasoning_output_tokens: 0,
          },
        },
      ],
    ];

    const result = await handleMessage({
      chatId: "test-chat",
      text: "force the event-path failure",
      senderName: "Ada",
      isGroup: false,
    });

    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(2);
    expect(MOCK_THREAD_OPTIONS_SEEN[1].model).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
    expect(result.text).toBe("recovered");
  });

  it("does not retry when the chatgpt-mismatch fires a second time", async () => {
    // Defensive: if the post-hoc retry ALSO returns the 400 (shouldn't
    // happen since the ChatGPT default is supported, but guards against a future
    // breakage), don't loop. `_retried` is true on the recursive call
    // so the chatgpt-mismatch branch short-circuits.
    setupHandler();

    const mismatch = new Error(
      "not supported when using Codex with a ChatGPT account",
    );
    MOCK_RUN_STREAMED_THROW_QUEUE = [mismatch, mismatch];

    await expect(
      handleMessage({
        chatId: "test-chat",
        text: "double-failure",
        senderName: "Ada",
        isGroup: false,
      }),
    ).rejects.toThrow();
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(2);
  });
});

// ── Silent OAuth exit-1 recovery (the 2026-05-20 silent-exit regression) ────

describe("codex / handleMessage — silent OAuth exit-1 recovery", () => {
  // Set up a temp HOME with an OAuth auth.json so this whole describe
  // block exercises chatgpt mode without depending on the host machine.
  // (Mirrors the pre-emptive-swap test in the previous describe.)
  let fakeHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origApiKey: string | undefined;

  beforeEach(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), "talon-codex-silent-exit-"));
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".codex", "auth.json"),
      '{"auth_mode":"chatgpt"}',
    );
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    origApiKey = process.env.OPENAI_API_KEY;
    // Set BOTH HOME and USERPROFILE so `os.homedir()` resolves to
    // fakeHome on POSIX AND Windows (Node uses USERPROFILE on win32;
    // leaving it unset would fall back to HOMEDRIVE+HOMEPATH = real
    // user profile = test cross-pollution).
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    delete process.env.OPENAI_API_KEY;
    // Reset the OAuth-incompat learning store so tests don't leak.
    const oauthIncompat = await import("../backend/codex/oauth-incompat.js");
    oauthIncompat.resetOAuthIncompatForTests();
    // The store now persists in the shared per-worker kv table (not a
    // per-fakeHome file), so a learned model outlives resetModules —
    // clear the row so each test starts from an empty set.
    const kv = await import("../storage/kv.js");
    kv.kvDelete("codex.oauth-incompat");
  });

  afterEach(async () => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    if (origUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = origUserProfile;
    }
    if (origApiKey !== undefined) {
      process.env.OPENAI_API_KEY = origApiKey;
    }
    // Reset in-memory oauth-incompat state so a learned model from
    // one test doesn't bleed into the next via the module singleton.
    const oauthIncompat = await import("../backend/codex/oauth-incompat.js");
    oauthIncompat.resetOAuthIncompatForTests();
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("retries silent exit-1 on a cache-discovered model under ChatGPT OAuth", async () => {
    // 2026-05-20 23:13Z replay: `gpt-5.4-mini` was selected (cache says
    // `supported_in_api: true`), pre-emptive swap didn't fire (not
    // curated as apiKeyOnly, not in learned set yet), Codex CLI
    // silently exited 1, SDK surfaced opaque error. The new code path
    // should detect the silent-exit pattern, retry on the ChatGPT default, AND
    // record the failing model into the learning store.
    initCodexAgent(
      {
        model: "gpt-5.4-mini",
        workspace: "/tmp",
        systemPrompt: "Test system prompt.",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    const silentExit = new Error(
      "Codex Exec exited with code 1: Reading prompt from stdin...\n",
    );
    MOCK_RUN_STREAMED_THROW_QUEUE = [silentExit, null];
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_silent_recovery" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "recovered on 5.5" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const result = await handleMessage({
      chatId: "test-chat",
      text: "hi",
      senderName: "Ada",
      isGroup: false,
    });

    // Two runStreamed calls — the silent-exit + the recovery.
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(2);
    expect(MOCK_THREAD_OPTIONS_SEEN[0].model).toBe("gpt-5.4-mini");
    expect(MOCK_THREAD_OPTIONS_SEEN[1].model).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
    expect(result.text).toBe("recovered on 5.5");

    // Silent-exit is ambiguous (transient outage vs real incompat),
    // so it does NOT persist into the learning store — only explicit
    // mismatches do. This avoids over-poisoning future runs from a
    // one-off blip. The in-session retry above is the bounded
    // recovery; permanent demotion needs a stronger signal.
    const oauthIncompat = await import("../backend/codex/oauth-incompat.js");
    expect(oauthIncompat.isKnownOAuthIncompat("gpt-5.4-mini")).toBe(false);
  });

  it("surfaces an expired login as an auth error without resetting or retrying", async () => {
    // Daemon log 2026-08-24: the refresh token was invalidated, the CLI
    // exited 1 behind the same banner the silent-incompat exit uses, and
    // the handler reset the thread and retried on the ChatGPT default — which failed
    // identically. Now the exit is classified as an expired login first.
    initCodexAgent(
      {
        model: "gpt-5.4-mini",
        workspace: "/tmp",
        systemPrompt: "Test system prompt.",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );
    sessions.setSessionId("test-chat", "thr_existing");

    MOCK_RUN_STREAMED_THROWS = new Error(
      "Codex Exec exited with code 1: Reading prompt from stdin...\n" +
        "2026-08-24T15:54:53.665546Z ERROR codex_login::auth::manager: " +
        "Failed to refresh token: 401 Unauthorized: {\n" +
        '  "error": {\n' +
        '    "message": "Your session has ended. Please log in again.",\n' +
        '    "type": "invalid_request_error",\n' +
        '    "param": null,\n' +
        '    "code": "refresh_token_invalidated"\n' +
        "  }\n}\n",
    );

    await expect(
      handleMessage({
        chatId: "test-chat",
        text: "hi",
        senderName: "Ada",
        isGroup: false,
      }),
    ).rejects.toMatchObject({
      name: "TalonError",
      reason: "auth",
      retryable: false,
      message: expect.stringContaining("codex login"),
    });

    // One attempt, on the requested model — no fallback swap.
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(1);
    expect(MOCK_THREAD_OPTIONS_SEEN).toHaveLength(1);
    expect(MOCK_THREAD_OPTIONS_SEEN[0].model).toBe("gpt-5.4-mini");
    expect(MOCK_RESUME_CALLS).toEqual(["thr_existing"]);
    // The thread survives: nothing about the conversation was at fault.
    expect(sessions.getSession("test-chat").sessionId).toBe("thr_existing");
    expect(getMetrics().counters["errors.auth"]).toBe(1);
  });

  it("DOES persist on explicit mismatch (unambiguous server signal)", async () => {
    // Use a hypothetical future model id that's NOT curated and NOT
    // already in the learned set — so the pre-empt skips and the
    // model gets passed through to runStreamed, which throws the
    // explicit-mismatch error. The post-hoc retry then both swaps to
    // the ChatGPT default AND records the model into the persistent store.
    initCodexAgent(
      {
        model: "gpt-future-model",
        workspace: "/tmp",
        systemPrompt: "Test system prompt.",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    const explicitMismatch = new Error(
      `400 Bad Request: The "gpt-future-model" model is not supported when ` +
        `using Codex with a ChatGPT account.`,
    );
    MOCK_RUN_STREAMED_THROW_QUEUE = [explicitMismatch, null];
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_explicit_recovery" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok on 5.5" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "hi",
      senderName: "Ada",
      isGroup: false,
    });

    // Both runs fired (original + retry on the ChatGPT default).
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(2);
    expect(MOCK_THREAD_OPTIONS_SEEN[1].model).toBe(CODEX_CHATGPT_DEFAULT_MODEL);

    // The explicit-mismatch retry path persisted to the store —
    // unambiguous signal justifies the permanent record.
    const oauthIncompat = await import("../backend/codex/oauth-incompat.js");
    expect(oauthIncompat.isKnownOAuthIncompat("gpt-future-model")).toBe(true);
  });

  it("pre-emptively swaps a previously-learned OAuth-incompat model", async () => {
    // After one failure (test above), the next turn should pre-empt:
    // the configured model is now in the learned set, so the swap
    // fires before the first runStreamed call.
    const oauthIncompat = await import("../backend/codex/oauth-incompat.js");
    await oauthIncompat.loadOAuthIncompatStore(
      "chatgpt:file:~/.codex/auth.json",
    );
    await oauthIncompat.markOAuthIncompat("gpt-5.4-mini");

    initCodexAgent(
      {
        model: "gpt-5.4-mini",
        workspace: "/tmp",
        systemPrompt: "Test system prompt.",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_preempt_dyn" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "hi",
      senderName: "Ada",
      isGroup: false,
    });

    // Single runStreamed call (pre-empt fired) and it saw the ChatGPT default.
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(1);
    expect(MOCK_THREAD_OPTIONS_SEEN[0].model).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
  });

  it("does NOT retry a silent exit on api-key auth (different bug class)", async () => {
    // Restore environment to api-key mode for this single test.
    delete process.env.HOME; // bypass the fakeHome chatgpt auth file
    process.env.OPENAI_API_KEY = "sk-real-api-key";
    try {
      setupHandler({ codexApiKey: "sk-real-api-key", model: "gpt-5-codex" });

      const silentExit = new Error(
        "Codex Exec exited with code 1: Reading prompt from stdin...\n",
      );
      MOCK_RUN_STREAMED_THROW_QUEUE = [silentExit];

      await expect(
        handleMessage({
          chatId: "test-chat",
          text: "hi",
          senderName: "Ada",
          isGroup: false,
        }),
      ).rejects.toThrow();
      // Only ONE runStreamed call — no recovery attempted because
      // the auth mode isn't chatgpt.
      expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(1);
    } finally {
      // Restore fakeHome for the next test's afterEach cleanup.
      process.env.HOME = fakeHome;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("does NOT retry when the active model is already the ChatGPT default", async () => {
    // Pathological case — if even the ChatGPT default silent-exits, the credential
    // is broken; retrying would loop or swap to itself.
    initCodexAgent(
      {
        model: CODEX_CHATGPT_DEFAULT_MODEL,
        workspace: "/tmp",
        systemPrompt: "Test system prompt.",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    const silentExit = new Error(
      "Codex Exec exited with code 1: Reading prompt from stdin...\n",
    );
    MOCK_RUN_STREAMED_THROW_QUEUE = [silentExit];

    await expect(
      handleMessage({
        chatId: "test-chat",
        text: "hi",
        senderName: "Ada",
        isGroup: false,
      }),
    ).rejects.toThrow();
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(1);
  });
});
