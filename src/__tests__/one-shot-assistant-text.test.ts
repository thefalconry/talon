/**
 * `OneShotAgentParams.onAssistantText` — the backend-agnostic hook that hands
 * a one-shot run's final answers to a caller as data instead of markdown.
 *
 * Covered here: the Claude SDK formatter (`formatAndAppendMessage`, driven
 * through `runOneShotAgent` with a mocked `query`) and the shared
 * remote-server runner that Kilo and OpenCode both bind. The Codex runner's
 * equivalent case lives beside its other event-translation tests in
 * `codex-one-shot.test.ts`.
 *
 * The invariants each backend owes the hook:
 *   - one call per assistant message, with the text blocks joined exactly as
 *     the run log joins them;
 *   - reasoning/thinking and tool-call payloads never reach it;
 *   - a run without the hook logs exactly what it logged before;
 *   - a throwing consumer is swallowed, not propagated into the run.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";

const hoisted = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() =>
    (async function* () {
      for (const msg of hoisted.messages) yield msg;
    })(),
  ),
}));

const { runOneShotAgent } = await import("../backend/claude-sdk/one-shot.js");
const { runRemoteOneShotAgent } =
  await import("../backend/remote-server/one-shot.js");

type RemoteOneShotArgs = Parameters<typeof runRemoteOneShotAgent>;

// ── Claude SDK ──────────────────────────────────────────────────────────────

function assistantMessage(): unknown {
  return {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "First half." },
        { type: "tool_use", name: "Read", input: { path: "/tmp/x" } },
        { type: "text", text: "Second half." },
      ],
    },
  };
}

function resultMessage(): unknown {
  return {
    type: "result",
    subtype: "success",
    // The SDK restates the last assistant turn here — the hook must not
    // report it a second time.
    result: "First half.\nSecond half.",
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

async function runClaude(
  onAssistantText?: (text: string) => void,
): Promise<string[]> {
  const lines: string[] = [];
  await runOneShotAgent({
    prompt: "hello",
    systemPrompt: "you are a test",
    workspace: "/tmp",
    model: "sonnet",
    contextLabel: "heartbeat",
    abortController: new AbortController(),
    appendLog: async (text) => {
      lines.push(text);
    },
    ...(onAssistantText ? { onAssistantText } : {}),
  });
  return lines;
}

describe("claude-sdk one-shot / onAssistantText", () => {
  beforeEach(() => {
    hoisted.messages = [assistantMessage(), resultMessage()];
  });

  it("reports one joined segment per assistant message, tool blocks excluded", async () => {
    const seen: string[] = [];
    await runClaude((text) => seen.push(text));

    expect(seen).toEqual(["First half.\nSecond half."]);
    expect(seen[0]).not.toContain("tool_use");
    expect(seen[0]).not.toContain("Read");
  });

  it("pins transcript retention on the spawned run", async () => {
    await runClaude();
    const call = vi.mocked(query).mock.calls.at(-1)?.[0];
    expect(call?.options?.settings).toEqual({ cleanupPeriodDays: 100_000 });
  });

  it("does not double-report the terminal result message", async () => {
    const seen: string[] = [];
    await runClaude((text) => seen.push(text));

    // Two SDK messages carry the same text; only the assistant one is a
    // hook call.
    expect(seen).toHaveLength(1);
  });

  it("skips assistant messages that carry no text blocks", async () => {
    hoisted.messages = [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { cmd: "ls" } }],
        },
      },
    ];
    const seen: string[] = [];
    await runClaude((text) => seen.push(text));

    expect(seen).toEqual([]);
  });

  it("logs identically with and without the hook", async () => {
    const withoutHook = await runClaude();
    const withHook = await runClaude(() => {});

    const strip = (lines: string[]): string[] =>
      // Drop the wall-clock stamps the formatter prefixes each block with.
      lines.map((line) => line.replace(/\[\d{2}:\d{2}:\d{2}\]/g, "[ts]"));

    expect(strip(withHook)).toEqual(strip(withoutHook));
    expect(withoutHook.join("")).toContain("First half.\nSecond half.");
    expect(withoutHook.join("")).toContain("**Tool call:** `Read`");
  });

  it("swallows a throwing hook and still settles the run", async () => {
    const lines: string[] = [];
    const usage = await runOneShotAgent({
      prompt: "hello",
      systemPrompt: "you are a test",
      workspace: "/tmp",
      model: "sonnet",
      contextLabel: "heartbeat",
      abortController: new AbortController(),
      appendLog: async (text) => {
        lines.push(text);
      },
      onAssistantText: () => {
        throw new Error("consumer blew up");
      },
    });

    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(lines.join("")).toContain("First half.\nSecond half.");
  });
});

// ── Remote server (Kilo / OpenCode) ─────────────────────────────────────────

function remoteClient(parts: unknown[]): unknown {
  return {
    session: {
      create: async () => ({ data: { id: "sess_1" } }),
      get: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      prompt: async () => ({
        data: {
          parts,
          info: { tokens: { input: 7, output: 3 } },
        },
      }),
      abort: async () => ({}),
      delete: async () => ({}),
    },
    question: {
      list: async () => ({ data: [] }),
      reply: async () => ({}),
      reject: async () => ({}),
    },
    permission: {
      list: async () => ({ data: [] }),
      reply: async () => ({}),
    },
  };
}

function remoteBindings(client: unknown): RemoteOneShotArgs[0] {
  return {
    label: "Fake",
    systemPromptSuffix: "",
    ensureServer: async () => client,
    parseModelSelection: (value: string) => ({
      providerID: "fake",
      modelID: value,
    }),
    resolveProviderID: async () => "fake",
    ensureChatMcpServer: async () => "talon-tools-heartbeat",
    ensurePluginMcpServers: async () => [],
    buildToolOverrides: async () => undefined,
    disconnectChatMcpServer: async () => {},
    errMsg: (e: unknown) => String(e),
  } as unknown as RemoteOneShotArgs[0];
}

async function runRemote(
  parts: unknown[],
  onAssistantText?: (text: string) => void,
): Promise<string[]> {
  const lines: string[] = [];
  await runRemoteOneShotAgent(remoteBindings(remoteClient(parts)), {
    prompt: "hello",
    systemPrompt: "you are a test",
    workspace: "/tmp",
    model: "fake/model",
    contextLabel: "heartbeat",
    abortController: new AbortController(),
    appendLog: async (text) => {
      lines.push(text);
    },
    ...(onAssistantText ? { onAssistantText } : {}),
  });
  return lines;
}

describe("remote-server one-shot / onAssistantText", () => {
  const parts = [
    { type: "reasoning", text: "thinking out loud" },
    { type: "text", text: "the answer" },
    { type: "tool", tool: "bash", input: { cmd: "ls" } },
    { type: "text", text: "a second segment" },
  ];

  it("reports the assistant text parts and not the reasoning or tool parts", async () => {
    const seen: string[] = [];
    const lines = await runRemote(parts, (text) => seen.push(text));

    expect(seen).toEqual(["the answer", "a second segment"]);
    expect(seen).not.toContain("thinking out loud");
    // The reasoning still reaches the run log — log-only, hook-silent.
    expect(lines.join("")).toContain("thinking out loud");
  });

  it("logs identically without the hook", async () => {
    const withoutHook = await runRemote(parts);
    const withHook = await runRemote(parts, () => {});

    const strip = (lines: string[]): string[] =>
      lines.map((line) => line.replace(/\[\d{2}:\d{2}:\d{2}\]/g, "[ts]"));

    expect(strip(withHook)).toEqual(strip(withoutHook));
  });

  it("swallows a throwing hook and still settles the run", async () => {
    const lines = await runRemote(parts, () => {
      throw new Error("consumer blew up");
    });

    expect(lines.join("")).toContain("the answer");
    expect(lines.join("")).toContain("a second segment");
  });
});
