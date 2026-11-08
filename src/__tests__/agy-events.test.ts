/**
 * Antigravity stream-json event tests.
 *
 * Every fixture under `fixtures/agy/` is a verbatim capture from the
 * real `agy` 1.2.7 binary, so these assertions are about the actual
 * wire format rather than an idealised one.
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
  parseAgyLine,
  parseAgyStream,
  describeAgyTool,
  agyToolCallId,
  applyAgyStep,
  createAgyEventContext,
  agyUsageToTokens,
  agyUsageDelta,
} = await import("../backend/agy/events.js");
const { createStreamState, finalizeResponseText } =
  await import("../backend/runtime/index.js");
const { recordToolCall } = await import("../backend/runtime/metrics.js");

type AgyEvent = ReturnType<typeof parseAgyStream>[number];

const FIXTURES = join(import.meta.dirname, "fixtures", "agy");
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf-8");

const steps = (events: AgyEvent[]) =>
  events.flatMap((e) =>
    e.event === "step_update" && e.step_update ? [e.step_update] : [],
  );

/** Replay a whole fixture into a fresh state, returning what it produced. */
function replay(name: string) {
  const state = createStreamState("-100test");
  const deltas: string[] = [];
  const started: Array<[string, string]> = [];
  const ended: Array<[string, string, boolean]> = [];
  const used: Array<[string, boolean]> = [];
  const ctx = createAgyEventContext(state, "-100test", {
    onStreamDelta: (accumulated) => deltas.push(accumulated),
    onToolStart: (id, name_) => started.push([id, name_]),
    onToolEnd: (id, name_, meta) =>
      ended.push([id, name_, Boolean(meta?.failed)]),
    onToolUse: (name_, _input, meta) =>
      used.push([name_, Boolean(meta?.failed)]),
  });
  const events = parseAgyStream(fixture(name));
  for (const step of steps(events)) applyAgyStep(step, ctx);
  return { state, ctx, events, deltas, started, ended, used };
}

beforeEach(() => {
  vi.mocked(recordToolCall).mockClear();
});

describe("agy events — parsing", () => {
  it("parses every line of every fixture", () => {
    for (const name of [
      "stream-mcp-tool-call.ndjson",
      "stream-mcp-tool-error.ndjson",
      "stream-native-run-command.ndjson",
      "stream-stdin-two-turns.ndjson",
    ]) {
      const text = fixture(name);
      const lines = text.split("\n").filter((l) => l.trim());
      const events = parseAgyStream(text);
      expect(events, name).toHaveLength(lines.length);
      expect(events[0].event, name).toBe("init");
      expect(events.at(-1)?.event, name).toBe("result");
    }
  });

  it("drops blank lines, non-JSON noise, and unknown event names", () => {
    expect(parseAgyLine("")).toBeNull();
    expect(parseAgyLine("   ")).toBeNull();
    expect(parseAgyLine("not json at all")).toBeNull();
    expect(parseAgyLine('{"event":"future_thing"}')).toBeNull();
    expect(parseAgyLine("[1,2,3]")).toBeNull();
    expect(
      parseAgyLine('{"event":"result","result":{"status":"SUCCESS"}}'),
    ).toMatchObject({ event: "result" });
  });

  it("reads the init payload: conversation id, tools, permission mode", () => {
    const [init] = parseAgyStream(fixture("stream-mcp-tool-call.ndjson"));
    expect(init.event).toBe("init");
    if (init.event !== "init") throw new Error("unreachable");
    expect(init.conversation_id).toBe("7f088b6c-e2e6-4acb-b842-3b3a880b30ad");
    expect(init.init?.permission_mode).toBe("always-proceed");
    // The whole MCP surface is one generic native tool.
    expect(init.init?.tools).toContain("call_mcp_tool");
    expect(init.init?.tools).toContain("run_command");
  });
});

describe("agy events — MCP tool unwrapping", () => {
  it("reports the bare MCP tool name, not call_mcp_tool", () => {
    const { started, ended } = replay("stream-mcp-tool-call.ndjson");
    expect(started.map(([, n]) => n)).toEqual(["view_file", "check_time"]);
    expect(ended.map(([, n]) => n)).toEqual(["view_file", "check_time"]);
    expect(started.map(([, n]) => n)).not.toContain("call_mcp_tool");
  });

  it("carries the server name and the unwrapped Arguments", () => {
    const events = parseAgyStream(fixture("stream-mcp-tool-call.ndjson"));
    const mcpStep = steps(events).find(
      (s) => s.tool_name === "call_mcp_tool" && s.state === "DONE",
    );
    const shape = describeAgyTool(mcpStep!);
    expect(shape).toEqual({
      name: "check_time",
      server: "__talon_probe",
      input: { timezone: "Europe/London" },
    });
  });

  it("falls back to the wrapper name when ToolName is missing", () => {
    expect(
      describeAgyTool({
        tool_name: "call_mcp_tool",
        tool_info: { name: "call_mcp_tool", parameters: { ServerName: "x" } },
      }),
    ).toMatchObject({ name: "call_mcp_tool", server: "x", input: {} });
  });

  it("pairs start and end on one stable id per step", () => {
    const { started, ended } = replay("stream-mcp-tool-call.ndjson");
    expect(started.map(([id]) => id)).toEqual(ended.map(([id]) => id));
    expect(agyToolCallId({ conversation_id: "abc", step_index: 4 })).toBe(
      "abc:4",
    );
  });

  it("counts every tool call under its bare name", () => {
    replay("stream-mcp-tool-call.ndjson");
    const names = vi.mocked(recordToolCall).mock.calls.map((c) => c[1]);
    expect(names).toEqual(["view_file", "check_time"]);
    expect(vi.mocked(recordToolCall).mock.calls[0][2]).toBe("agy");
  });
});

describe("agy events — native tools", () => {
  it("reports a native run_command under its own name", () => {
    const { started, ended, state } = replay(
      "stream-native-run-command.ndjson",
    );
    expect(started.map(([, n]) => n)).toEqual(["run_command"]);
    expect(ended.map(([, n]) => n)).toEqual(["run_command"]);
    expect(finalizeResponseText(state)).toBe("18:40:48");
  });

  it("carries the native tool's own parameters through", () => {
    const events = parseAgyStream(fixture("stream-native-run-command.ndjson"));
    const step = steps(events).find((s) => s.step_type === "tool")!;
    const shape = describeAgyTool(step);
    expect(shape.server).toBeUndefined();
    expect(String(shape.input.CommandLine)).toContain("python3");
  });
});

describe("agy events — failures", () => {
  it("marks an ERROR tool step as failed and does not terminate the turn", () => {
    const { ended, state } = replay("stream-mcp-tool-error.ndjson");
    expect(ended).toEqual([
      [expect.stringContaining(":2"), "check_time", true],
    ]);
    // A failed call must not count as a delivery.
    expect(state.deliveredTextNorms).toEqual([]);
    expect(state.turnTerminated).toBe(false);
  });

  it("still counts a failed call in the tool metrics", () => {
    const { ctx } = replay("stream-mcp-tool-error.ndjson");
    expect(ctx.toolMetrics.count).toBe(1);
    expect(vi.mocked(recordToolCall)).toHaveBeenCalledWith(
      "-100test",
      "check_time",
      "agy",
    );
  });

  it("exposes the transport error message on the step", () => {
    const events = parseAgyStream(fixture("stream-mcp-tool-error.ndjson"));
    const errored = steps(events).find((s) => s.state === "ERROR")!;
    expect(errored.tool_info?.error?.type).toBe("TOOL_ERROR");
    expect(errored.tool_info?.error?.message).toContain("connection refused");
  });
});

describe("agy events — text deltas", () => {
  it("accumulates ACTIVE fragments and the final DONE fragment", () => {
    const { state, deltas } = replay("stream-mcp-tool-error.ndjson");
    const events = parseAgyStream(fixture("stream-mcp-tool-error.ndjson"));
    const result = events.at(-1);
    expect(result?.event).toBe("result");
    if (result?.event !== "result") throw new Error("unreachable");
    // What we accumulated must equal what the CLI reported as the reply.
    expect(state.currentBlockText).toBe(result.result?.response);
    // Every delta callback carries the running total, growing monotonically.
    expect(deltas.length).toBeGreaterThan(5);
    expect(deltas.at(-1)).toBe(result.result?.response);
    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i].startsWith(deltas[i - 1])).toBe(true);
    }
  });

  it("handles a turn whose whole reply arrives on one DONE event", () => {
    const events = parseAgyStream(fixture("stream-stdin-two-turns.ndjson"));
    const state = createStreamState();
    const ctx = createAgyEventContext(state, "-100test");
    // Second turn only: everything after the first `result`.
    const all = steps(events);
    const secondTurn = all.slice(all.findIndex((s) => s.step_index === 2));
    for (const step of secondTurn) applyAgyStep(step, ctx);
    expect(finalizeResponseText(state)).toBe("apple");
  });

  it("emits nothing for user_input and checkpoint steps", () => {
    const state = createStreamState();
    const ctx = createAgyEventContext(state, "-100test");
    applyAgyStep({ step_type: "user_input", state: "DONE" }, ctx);
    applyAgyStep({ step_type: "checkpoint", state: "DONE" }, ctx);
    expect(finalizeResponseText(state)).toBe("");
    expect(ctx.toolMetrics.count).toBe(0);
  });
});

describe("agy events — usage", () => {
  it("maps cache_read_tokens to cacheRead and reports no cache writes", () => {
    const events = parseAgyStream(fixture("stream-mcp-tool-call.ndjson"));
    const result = events.at(-1);
    if (result?.event !== "result") throw new Error("unreachable");
    expect(agyUsageToTokens(result.result?.usage)).toEqual({
      inputTokens: 40046,
      outputTokens: 519,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("does not add thinking_tokens to output (they are already inside it)", () => {
    // stdin turn 1: 28 output / 27 thinking for a two-token "apple\n".
    expect(
      agyUsageToTokens({ output_tokens: 28, thinking_tokens: 27 }).outputTokens,
    ).toBe(28);
  });

  it("deltas the cumulative session counters into a per-turn cost", () => {
    const events = parseAgyStream(fixture("stream-stdin-two-turns.ndjson"));
    const results = events.flatMap((e) =>
      e.event === "result" && e.result ? [e.result] : [],
    );
    const first = agyUsageToTokens(results[0].usage);
    const second = agyUsageToTokens(results[1].usage);
    // The CLI's second result is cumulative (25621 in), so turn two's
    // real input cost is the difference, not the raw number.
    expect(second.inputTokens).toBe(25621);
    expect(agyUsageDelta(first, second)).toEqual({
      inputTokens: 12861,
      outputTokens: 60,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("treats the first turn as its own delta and never goes negative", () => {
    const after = {
      inputTokens: 5,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
    };
    expect(agyUsageDelta(undefined, after)).toEqual(after);
    expect(
      agyUsageDelta(
        { inputTokens: 99, outputTokens: 99, cacheRead: 99, cacheWrite: 0 },
        after,
      ),
    ).toEqual({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("agy events — the json envelope", () => {
  it("matches the stream result shape field for field", () => {
    const envelope = JSON.parse(fixture("print-json-envelope.json")) as Record<
      string,
      unknown
    >;
    expect(envelope.status).toBe("SUCCESS");
    expect(agyUsageToTokens(envelope.usage as never)).toEqual({
      inputTokens: 12754,
      outputTokens: 34,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
