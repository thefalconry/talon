/**
 * Kimi Code stream-json event tests.
 *
 * Tests event parsing and stream translation against real captured transcripts
 * from Moonshot's Kimi Code CLI (`kimi -p ... --output-format stream-json`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../storage/sessions.js", async (orig) => {
  const actual = await orig<typeof import("../storage/sessions.js")>();
  return { ...actual, updateLiveTurn: vi.fn() };
});
vi.mock("../backend/runtime/metrics.js", () => ({
  recordToolCall: vi.fn(),
}));

const {
  parseKimiLine,
  parseKimiStream,
  describeKimiTool,
  applyKimiEvent,
  createKimiEventContext,
  kimiUsageToTokens,
} = await import("../backend/kimi/events.js");
const { createStreamState, finalizeResponseText } =
  await import("../backend/runtime/index.js");
const { recordToolCall } = await import("../backend/runtime/metrics.js");

const FIXTURES = join(import.meta.dirname, "fixtures", "kimi");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf-8");

beforeEach(() => {
  vi.mocked(recordToolCall).mockClear();
});

describe("kimi events — parsing", () => {
  it("parses every line of the captured stream-bash-tool fixture", () => {
    const text = fixture("stream-bash-tool.jsonl");
    const lines = text.split("\n").filter((l) => l.trim());
    const events = parseKimiStream(text);
    expect(events).toHaveLength(lines.length);
    expect(events[0]).toMatchObject({
      role: "meta",
      type: "system.version",
      version: "2.0.2",
    });
    expect(events.at(-1)).toMatchObject({
      role: "meta",
      type: "session.resume_hint",
      session_id: "session_4e24f462-4142-44bf-aa56-0fa94c96942f",
    });
  });

  it("drops blank lines, non-JSON noise, and invalid roles", () => {
    expect(parseKimiLine("")).toBeNull();
    expect(parseKimiLine("   \n")).toBeNull();
    expect(parseKimiLine("not a json line")).toBeNull();
    expect(parseKimiLine('{"foo":"bar"}')).toBeNull();
    expect(parseKimiLine('{"role":"unknown_role"}')).toBeNull();
    expect(parseKimiLine("[1, 2, 3]")).toBeNull();
    expect(parseKimiLine('{"role":"assistant","content":"hello"}')).toEqual({
      role: "assistant",
      content: "hello",
    });
  });

  it("parses meta retrying events", () => {
    const line = JSON.stringify({
      role: "meta",
      type: "turn.step.retrying",
      failed_attempt: 1,
      next_attempt: 2,
      max_attempts: 10,
      delay_ms: 500,
      error_name: "APITimeoutError",
      error_message: "Request timed out.",
    });
    const parsed = parseKimiLine(line);
    expect(parsed).toMatchObject({
      role: "meta",
      type: "turn.step.retrying",
      failed_attempt: 1,
      error_name: "APITimeoutError",
    });
  });
});

describe("kimi events — tool unwrapping and execution", () => {
  it("unwraps JSON string arguments in tool calls", () => {
    const text = fixture("stream-bash-tool.jsonl");
    const events = parseKimiStream(text);
    const assistantWithTools = events.find(
      (e) => e.role === "assistant" && e.tool_calls && e.tool_calls.length > 0,
    );
    expect(assistantWithTools).toBeDefined();
    if (assistantWithTools?.role !== "assistant" || !assistantWithTools.tool_calls) {
      throw new Error("unreachable");
    }

    const shape = describeKimiTool(assistantWithTools.tool_calls[0]);
    expect(shape.name).toBe("Bash");
    expect(shape.input).toEqual({
      command: "ls -la",
      description: "List current directory entries",
      cwd: "/tmp",
      run_in_background: false,
      timeout: 60,
    });
  });

  it("handles malformed JSON in tool call arguments gracefully", () => {
    const shape = describeKimiTool({
      type: "function",
      id: "call_bad",
      function: {
        name: "test_tool",
        arguments: "not valid json {",
      },
    });
    expect(shape.name).toBe("test_tool");
    expect(shape.input).toEqual({ raw: "not valid json {" });
  });

  it("records tool calls and starts tool execution", () => {
    const state = createStreamState("-100test");
    const started: Array<[string, string]> = [];
    const ended: Array<[string, string, boolean]> = [];
    const ctx = createKimiEventContext(state, "-100test", {
      onToolStart: (id, name) => started.push([id, name]),
      onToolEnd: (id, name, meta) =>
        ended.push([id, name, Boolean(meta?.failed)]),
    });

    const events = parseKimiStream(fixture("stream-bash-tool.jsonl"));
    for (const event of events) {
      applyKimiEvent(event, ctx);
    }

    expect(started).toEqual([["call_794ffdb3c7064b348f363ae8", "Bash"]]);
    expect(ended).toEqual([["call_794ffdb3c7064b348f363ae8", "Bash", false]]);
    expect(ctx.toolMetrics.count).toBe(1);
    expect(vi.mocked(recordToolCall)).toHaveBeenCalledWith(
      "-100test",
      "Bash",
      "kimi",
    );
  });

  it("handles tool failure when tool is not found", () => {
    const state = createStreamState("-100test");
    const ended: Array<[string, string, boolean]> = [];
    const ctx = createKimiEventContext(state, "-100test", {
      onToolEnd: (id, name, meta) =>
        ended.push([id, name, Boolean(meta?.failed)]),
    });

    applyKimiEvent(
      {
        role: "assistant",
        tool_calls: [
          {
            type: "function",
            id: "call_missing",
            function: { name: "nonexistent_tool", arguments: "{}" },
          },
        ],
      },
      ctx,
    );

    applyKimiEvent(
      {
        role: "tool",
        tool_call_id: "call_missing",
        content: 'Tool "nonexistent_tool" not found',
      },
      ctx,
    );

    expect(ended).toEqual([["call_missing", "nonexistent_tool", true]]);
    expect(state.deliveredTextNorms).toEqual([]);
    expect(state.turnTerminated).toBe(false);
  });
});

describe("kimi events — assistant text and termination", () => {
  it("accumulates assistant text across events", () => {
    const state = createStreamState("-100test");
    const deltas: string[] = [];
    const ctx = createKimiEventContext(state, "-100test", {
      onStreamDelta: (accumulated) => deltas.push(accumulated),
    });

    const events = parseKimiStream(fixture("stream-bash-tool.jsonl"));
    for (const event of events) {
      applyKimiEvent(event, ctx);
    }

    expect(finalizeResponseText(state)).toBe("DONE");
    expect(deltas).toEqual(["DONE"]);
  });

  it("terminates turn when end_turn tool is called", () => {
    const state = createStreamState("-100test");
    const ctx = createKimiEventContext(state, "-100test");

    applyKimiEvent(
      {
        role: "assistant",
        tool_calls: [
          {
            type: "function",
            id: "call_end",
            function: {
              name: "end_turn",
              arguments: JSON.stringify({ text: "Goodbye!" }),
            },
          },
        ],
      },
      ctx,
    );

    applyKimiEvent(
      {
        role: "tool",
        tool_call_id: "call_end",
        content: "OK",
      },
      ctx,
    );

    expect(state.turnTerminated).toBe(true);
    expect(state.deliveredTextNorms).toContain("goodbye!");
  });
});

describe("kimi events — usage", () => {
  it("maps usage object to turn tokens", () => {
    const usage = kimiUsageToTokens({
      inputOther: 5722,
      output: 53,
      inputCacheRead: 16320,
      inputCacheCreation: 100,
    });
    expect(usage).toEqual({
      inputTokens: 5722,
      outputTokens: 53,
      cacheRead: 16320,
      cacheWrite: 100,
    });
  });

  it("handles undefined and missing fields safely", () => {
    expect(kimiUsageToTokens(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(kimiUsageToTokens({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
