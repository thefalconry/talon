/**
 * Agent-host protocol conformance — the daemon-side leg.
 *
 * `docs/agent-host-sidecar.md` Phase 1 ships the seam as a contract, not
 * a process, so this file is where the contract is actually pinned:
 *
 *   1. every sample in `protocol/fixtures/agent-host_v1.json` survives a
 *      round-trip through the real codec (`parseHostMessage` /
 *      `serializeHostMessage`), and the fixture covers EVERY member of
 *      every message union — compile-time exhaustiveness below means a
 *      new request, reply, notice or `AgentEvent` kind fails to build
 *      until a sample joins the fixture;
 *   2. the forward-compat rule holds: an unknown message type comes back
 *      as the typed `unknown` result a reader logs and drops (never a
 *      throw), and unknown FIELDS on a known type survive untouched;
 *   3. the in-process client is a pass-through — driven through a stubbed
 *      SDK turn it yields the same `AgentEvent` sequence `runChatTurn`
 *      yields when called directly. That is the whole zero-behaviour-change
 *      claim of Phase 1, asserted rather than asserted-in-the-PR-body.
 *
 * Phase 2's host binary replays the same fixture from the other side.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_NOTICE_TYPES,
  HOST_REPLY_TYPES,
  HOST_REQUEST_TYPES,
  parseHostMessage,
  serializeHostMessage,
  type HostEvent,
  type HostMessage,
  type HostNotice,
  type HostReply,
  type HostRequest,
} from "../core/agent-runtime/agent-host.js";
import type { AgentEvent } from "../core/agent-runtime/events.js";
import type { TalonConfig } from "../core/config/index.js";

// ── SDK + storage stubs (shared with the claude-sdk handler tests) ──────────

interface SystemInit {
  type: "system";
  subtype: "init";
  session_id: string;
}

interface AssistantTextMsg {
  type: "assistant";
  message: { content: Array<{ type: "text"; text: string }> };
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

let mockMessages: SdkMsg[] = [];

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
  }),
}));

vi.mock("../storage/sessions.js", () => ({
  getSession: () => ({
    sessionId: undefined,
    turns: 0,
    usage: { contextTokens: 0, contextWindow: 0 },
  }),
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

vi.mock("../core/plugin.js", () => ({
  getPluginMcpServers: () => ({}),
  getPluginPromptAdditions: () => [],
}));

vi.mock("../backend/claude-sdk/state.js", () => ({
  initAgent: vi.fn(async () => undefined),
  updateSystemPrompt: vi.fn(),
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
  getActiveFrontends: () => [] as string[],
}));

vi.mock("../util/trace.js", () => ({ traceMessage: vi.fn() }));

vi.mock("../storage/metrics.js", () => ({
  incrementCounter: vi.fn(),
  recordHistogram: vi.fn(),
}));

vi.mock("../backend/runtime/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../backend/runtime/index.js")>()),
  formatUserPrompt: ({ text }: { text: string }) => text,
  prepareSystemPrompt: vi.fn(),
  buildDeliveryContract: () => "",
  buildFlowViolationReminder: () => "",
  buildFirstTurnReminder: () => "",
}));

// ── Fixture ─────────────────────────────────────────────────────────────────

const FIXTURES = join(__dirname, "../../protocol/fixtures");

const fixture = JSON.parse(
  readFileSync(join(FIXTURES, "agent-host_v1.json"), "utf-8"),
) as {
  protocol: number;
  requests: HostRequest[];
  replies: HostReply[];
  events: HostEvent[];
  notices: HostNotice[];
  forwardCompat: Array<Record<string, unknown>>;
};

/**
 * Every `AgentEvent` kind, spelled out. `satisfies` rejects typos; the
 * `AssertNever` aliases below fail to compile when a new member joins any
 * of these unions without being listed — which forces a fixture sample
 * too, because the runtime tests assert fixture coverage === these lists.
 */
const AGENT_EVENT_KINDS = [
  "run_started",
  "text_delta",
  "assistant_message",
  "reasoning",
  "tool_call",
  "tool_result",
  "usage",
  "model_swapped",
  "warning",
  "error",
  "completed",
] as const satisfies readonly AgentEvent["type"][];

type AssertNever<T extends never> = T;
/* eslint-disable @typescript-eslint/no-unused-vars */
type _EveryEventKindListed = AssertNever<
  Exclude<AgentEvent["type"], (typeof AGENT_EVENT_KINDS)[number]>
>;
type _EveryRequestListed = AssertNever<
  Exclude<HostRequest["type"], (typeof HOST_REQUEST_TYPES)[number]>
>;
type _EveryReplyListed = AssertNever<
  Exclude<HostReply["type"], (typeof HOST_REPLY_TYPES)[number]>
>;
type _EveryNoticeListed = AssertNever<
  Exclude<HostNotice["type"], (typeof HOST_NOTICE_TYPES)[number]>
>;
/* eslint-enable @typescript-eslint/no-unused-vars */

const allFixtureMessages = (): HostMessage[] => [
  ...fixture.requests,
  ...fixture.replies,
  ...fixture.events,
  ...fixture.notices,
];

// ── 1. Fixture coverage ─────────────────────────────────────────────────────

describe("agent-host fixture (protocol/fixtures/agent-host_v1.json)", () => {
  it("carries the codec's protocol version", () => {
    expect(fixture.protocol).toBe(AGENT_HOST_PROTOCOL_VERSION);
  });

  it("covers every HostRequest type exactly", () => {
    const inFixture = new Set(fixture.requests.map((r) => r.type));
    expect([...inFixture].sort()).toEqual([...HOST_REQUEST_TYPES].sort());
  });

  it("covers every HostReply type exactly", () => {
    const inFixture = new Set(fixture.replies.map((r) => r.type));
    expect([...inFixture].sort()).toEqual([...HOST_REPLY_TYPES].sort());
  });

  it("covers every HostNotice type exactly", () => {
    const inFixture = new Set(fixture.notices.map((n) => n.type));
    expect([...inFixture].sort()).toEqual([...HOST_NOTICE_TYPES].sort());
  });

  it("covers every AgentEvent kind exactly, as one coherent turn", () => {
    const kinds = fixture.events.map((e) => e.event.type);
    expect([...new Set(kinds)].sort()).toEqual([...AGENT_EVENT_KINDS].sort());
    expect(kinds[0]).toBe("run_started");
    expect(kinds.at(-1)).toBe("completed");
  });

  it("stamps every request with an id and every stream frame with a runId", () => {
    for (const request of fixture.requests) {
      expect(request.id, `request ${request.type}`).toBeTypeOf("string");
    }
    for (const reply of fixture.replies) {
      expect(reply.id, `reply ${reply.type}`).toBeTypeOf("string");
    }
    for (const frame of fixture.events) {
      expect(frame.runId).toBe("run_7f3a");
    }
  });
});

// ── 2. The codec ────────────────────────────────────────────────────────────

describe("agent-host codec", () => {
  it("round-trips every fixture message through NDJSON", () => {
    for (const message of allFixtureMessages()) {
      const line = serializeHostMessage(message);
      expect(line).not.toContain("\n");
      expect(parseHostMessage(line)).toEqual(message);
    }
  });

  it("drops an unknown message type instead of throwing", () => {
    const unknownRequest = fixture.forwardCompat[0];
    const parsed = parseHostMessage(JSON.stringify(unknownRequest));
    expect(parsed).toEqual({
      type: "unknown",
      reason: "unknown_type",
      raw: unknownRequest,
    });
  });

  it("preserves unknown fields on a known type", () => {
    const extended = fixture.forwardCompat[1];
    const parsed = parseHostMessage(JSON.stringify(extended));
    expect(parsed.type).toBe("event");
    expect(parsed).toEqual(extended);
  });

  it("returns a typed unknown for malformed or non-object lines", () => {
    const reasonOf = (line: string): string | undefined => {
      const parsed = parseHostMessage(line);
      return parsed.type === "unknown" ? parsed.reason : undefined;
    };
    expect(reasonOf("{not json")).toBe("malformed_json");
    expect(reasonOf("")).toBe("malformed_json");
    expect(reasonOf("[1, 2]")).toBe("not_an_object");
    expect(reasonOf("null")).toBe("not_an_object");
    expect(reasonOf('"a string"')).toBe("not_an_object");
    expect(reasonOf('{"id":"req-1"}')).toBe("unknown_type");
  });
});

// ── 3. The in-process client is a pass-through ──────────────────────────────

/**
 * Normalise a turn's events for comparison: `durationMs` is wall-clock and
 * `deliveryAck` carries callbacks, neither of which two runs can agree on.
 * Everything else must match exactly.
 */
function normalise(events: AgentEvent[]): unknown[] {
  return events.map((event) => {
    if (event.type === "completed" && event.result) {
      return { ...event, result: { ...event.result, durationMs: 0 } };
    }
    if (event.type === "assistant_message") {
      return { type: event.type, text: event.text };
    }
    return event;
  });
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const STUB_TURN: SdkMsg[] = [
  { type: "system", subtype: "init", session_id: "sess-1" },
  {
    type: "assistant",
    message: { content: [{ type: "text", text: "the fox is in protocol/" }] },
  },
  {
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
      input_tokens: 12,
      output_tokens: 7,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 9,
    },
    modelUsage: {
      "claude-sonnet-4-6": {
        inputTokens: 12,
        outputTokens: 7,
        cacheReadInputTokens: 9,
        cacheCreationInputTokens: 3,
        contextWindow: 200_000,
      },
    },
  },
];

describe("in-process agent host", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockMessages = STUB_TURN;

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

  it("yields the same AgentEvent sequence runChatTurn yields directly", async () => {
    const { makeBareModelRef } =
      await import("../core/agent-runtime/model-ref.js");
    const { runChatTurn } = await import("../backend/claude-sdk/handler.js");
    const { createInProcessAgentHost } =
      await import("../backend/claude-sdk/host/in-process.js");

    const params = {
      chatId: "d_abc123",
      model: makeBareModelRef("claude", "default"),
      text: "find the fox",
      senderName: "Ada",
      isGroup: false,
    };

    const direct = await drain(runChatTurn(params));
    const host = createInProcessAgentHost({} as unknown as TalonConfig);
    const viaHost = await drain(host.runTurn(params));

    expect(direct.at(-1)?.type).toBe("completed");
    expect(normalise(viaHost)).toEqual(normalise(direct));
  });

  it("answers hello with the codec's protocol version", async () => {
    const { createInProcessAgentHost } =
      await import("../backend/claude-sdk/host/in-process.js");
    const ready = await createInProcessAgentHost(
      {} as unknown as TalonConfig,
    ).hello();
    expect(ready.protocol).toBe(AGENT_HOST_PROTOCOL_VERSION);
    expect(ready.host).toBeTypeOf("string");
  });

  it("reports no tool refresh for a chat with no live query", async () => {
    const { createInProcessAgentHost } =
      await import("../backend/claude-sdk/host/in-process.js");
    const host = createInProcessAgentHost({} as unknown as TalonConfig);
    await expect(host.refreshTools("d_no_query")).resolves.toBeNull();
    await expect(host.setMcpServers("d_no_query", {})).resolves.toBeNull();
    await expect(host.interrupt("d_no_query")).resolves.toBe(false);
    await expect(host.resetSession("d_no_query")).resolves.toBe(false);
    await expect(host.shutdown()).resolves.toBeUndefined();
  });

  it("reads the session figures warm_session populates", async () => {
    const { createInProcessAgentHost } =
      await import("../backend/claude-sdk/host/in-process.js");
    const host = createInProcessAgentHost({} as unknown as TalonConfig);
    await expect(host.sessionInfo("d_abc123")).resolves.toEqual({
      chatId: "d_abc123",
      sessionId: undefined,
      turns: 0,
      contextTokens: 0,
      contextWindow: 0,
    });
  });
});
