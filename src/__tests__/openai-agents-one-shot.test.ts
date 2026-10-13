/**
 * OpenAI Agents one-shot runner — the backend's `BackgroundRunner`, which is
 * what lets it host sub-agents, cron query jobs and the heartbeat.
 *
 * The real `@openai/agents` SDK runs here against a fake OpenAI-compatible
 * endpoint (a stubbed `fetch` serving Chat Completions SSE, the shape a
 * llama.cpp server behind a local router produces — `reasoning_content`
 * deltas included). Only the MCP bundle is faked: it hands the agent one
 * hub server exposing the sub-agent `report_result` tool, so a run can be
 * driven through a real tool call and into its final answer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OneShotAgentParams } from "../core/types.js";

// ── Fake MCP bundle ─────────────────────────────────────────────────────────

const bundleCalls: Array<{ chatId: string; frontends: readonly string[] }> = [];
const toolCalls: Array<{ name: string; args: unknown }> = [];
let bundleClosed = 0;

function fakeHubServer() {
  return {
    name: "telegram-tools",
    cacheToolsList: true,
    async connect() {},
    async close() {},
    async invalidateToolsCache() {},
    async listTools() {
      return [
        {
          name: "report_result",
          description: "Report your result to whoever spawned you.",
          inputSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
        },
      ];
    },
    async callTool(name: string, args: unknown) {
      toolCalls.push({ name, args });
      return [{ type: "text", text: "Result recorded." }];
    },
  };
}

vi.mock("../backend/openai-agents/mcp-pool.js", async (orig) => {
  const actual =
    await orig<typeof import("../backend/openai-agents/mcp-pool.js")>();
  return {
    ...actual,
    openUnpooledBundle: async (args: {
      chatId: string;
      frontends: readonly string[];
    }) => {
      bundleCalls.push({ chatId: args.chatId, frontends: args.frontends });
      return {
        servers: [fakeHubServer()],
        failed: [],
        close: async () => {
          bundleClosed += 1;
        },
      };
    },
  };
});

// ── Fake OpenAI-compatible endpoint ─────────────────────────────────────────

const BASE_URL = "http://127.0.0.1:1/v1";
const MODEL = "local/qwen-abliterated";

interface ChatRequest {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

const requests: ChatRequest[] = [];
let script: Array<() => Response> = [];

function sse(chunks: unknown[]): Response {
  const body =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function usageChunk(prompt: number, completion: number) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  };
}

/** Turn 1: think, then call report_result. */
const toolCallTurn = () =>
  sse([
    chunk({ role: "assistant", reasoning_content: "Let me report." }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: {
            name: "mcp_telegram_tools__report_result",
            arguments: '{"summary":"found it"}',
          },
        },
      ],
    }),
    chunk({}, "tool_calls"),
    usageChunk(100, 10),
  ]);

/** Turn 2: the final answer. */
const finalTurn = () =>
  sse([
    chunk({ role: "assistant", content: "All " }),
    chunk({ content: "done." }),
    chunk({}, "stop"),
    usageChunk(150, 5),
  ]);

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = typeof input === "string" ? input : String(input);
  if (url.endsWith("/models")) {
    return new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  requests.push(JSON.parse(String(init?.body ?? "{}")) as ChatRequest);
  const next = script.shift();
  if (!next) {
    return new Response(JSON.stringify({ error: { message: "no script" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  return next();
});

// ── Harness ─────────────────────────────────────────────────────────────────

async function initBackend() {
  const { initOpenAIAgentsAgent } =
    await import("../backend/openai-agents/init.js");
  initOpenAIAgentsAgent(
    {
      model: MODEL,
      openaiBaseUrl: BASE_URL,
      openaiApiKey: "test-key",
      frontend: "telegram",
    } as never,
    () => 4321,
    "telegram",
  );
}

function makeParams(overrides: Partial<OneShotAgentParams> = {}) {
  const log: string[] = [];
  const answers: string[] = [];
  const params: OneShotAgentParams = {
    prompt: "investigate the thing",
    systemPrompt: "You are a sub-agent.",
    workspace: process.cwd(),
    model: MODEL,
    contextLabel: "agent:agt_test1234",
    abortController: new AbortController(),
    appendLog: async (text) => {
      log.push(text);
    },
    onAssistantText: (text) => answers.push(text),
    ...overrides,
  };
  return { params, log, answers };
}

beforeEach(async () => {
  bundleCalls.length = 0;
  toolCalls.length = 0;
  requests.length = 0;
  bundleClosed = 0;
  script = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  await initBackend();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const { resetState } = await import("../backend/openai-agents/state.js");
  resetState();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("openai-agents / factory background capability", () => {
  it("exposes a background runner, so it can host sub-agents", async () => {
    await import("../backend/openai-agents/factory.js");
    const { getBackend } =
      await import("../core/agent-runtime/backend-registry.js");
    const factory = getBackend("openai-agents");
    expect(factory).toBeDefined();
    const { backend, cleanup } = await factory!.init(
      {
        model: MODEL,
        openaiBaseUrl: BASE_URL,
        openaiApiKey: "test-key",
      } as never,
      { getBridgePort: () => 4321, frontendName: "telegram" } as never,
    );
    try {
      // The runner refuses any backend whose `background` slot is empty
      // ("cannot host a sub-agent").
      expect(backend.background).toBeDefined();
      expect(typeof backend.background?.runOneShotAgent).toBe("function");
      // Runs start fresh — an interrupted sub-agent is re-briefed.
      expect(backend.background?.supportsResume).toBeFalsy();
    } finally {
      await cleanup?.();
    }
  });
});

describe("openai-agents / one-shot run", () => {
  it("drives a tool call and a final answer against an OpenAI-compatible endpoint", async () => {
    const { runOneShotAgent } =
      await import("../backend/openai-agents/one-shot.js");
    script = [toolCallTurn, finalTurn];
    const { params, log, answers } = makeParams();

    const usage = await runOneShotAgent(params);

    // The tool session is bound to the run's own context label, so the
    // gateway sees `report_result` as coming from this agent.
    expect(bundleCalls).toEqual([
      { chatId: "agent:agt_test1234", frontends: ["telegram"] },
    ]);
    expect(toolCalls).toEqual([
      { name: "report_result", args: { summary: "found it" } },
    ]);

    // The endpoint saw the configured model id verbatim, a fresh
    // conversation, the namespaced hub tool and the built-ins. The SDK
    // turns the `-` in the server name into `_`, which is what the
    // system prompt has to tell the model.
    expect(requests).toHaveLength(2);
    const first = requests[0]!;
    expect(first.model).toBe(MODEL);
    const toolNames = (first.tools ?? []).map((t) => t.function.name);
    expect(toolNames).toContain("mcp_telegram_tools__report_result");
    expect(toolNames).toContain("Bash");
    const system = first.messages.find((m) => m.role === "system");
    expect(String(system?.content)).toContain("You are a sub-agent.");
    expect(String(system?.content)).toContain("mcp_<serverName>__");
    expect(String(system?.content)).toContain(
      "mcp_telegram_tools__report_result",
    );
    expect(first.messages.filter((m) => m.role === "user")).toHaveLength(1);

    // The final answer is the run's result; reasoning stays log-only.
    expect(answers).toEqual(["All done."]);
    const text = log.join("");
    expect(text).toContain("mcp_telegram_tools__report_result");
    expect(text).toContain("Result recorded.");
    expect(text).toContain("All done.");

    expect(usage).toMatchObject({ inputTokens: 250, outputTokens: 15 });
    expect(bundleClosed).toBe(1);
  });

  it("throws (and closes its bundle) when the endpoint fails", async () => {
    const { runOneShotAgent, OpenAIAgentsOneShotError } =
      await import("../backend/openai-agents/one-shot.js");
    script = []; // the fake endpoint answers 500
    const { params, log, answers } = makeParams();

    await expect(runOneShotAgent(params)).rejects.toBeInstanceOf(
      OpenAIAgentsOneShotError,
    );
    expect(log.join("")).toContain("Error");
    expect(answers).toEqual([]);
    expect(bundleClosed).toBe(1);
  });

  it("returns quietly when aborted before it starts", async () => {
    const { runOneShotAgent } =
      await import("../backend/openai-agents/one-shot.js");
    const { params, log } = makeParams();
    params.abortController.abort();

    await expect(runOneShotAgent(params)).resolves.toBeUndefined();
    expect(log.join("")).toContain("Aborted");
    expect(requests).toHaveLength(0);
  });

  it("refuses to run before the backend is initialised", async () => {
    const { resetState } = await import("../backend/openai-agents/state.js");
    resetState();
    const { runOneShotAgent } =
      await import("../backend/openai-agents/one-shot.js");
    const { params } = makeParams();
    await expect(runOneShotAgent(params)).rejects.toThrow(/not initialized/);
  });
});
