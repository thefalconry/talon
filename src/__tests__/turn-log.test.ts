import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryParams } from "../backend/runtime/turn/handler-types.js";
import type { ExecuteParams } from "../core/types.js";
import type { Backend } from "../core/agent-runtime/capabilities.js";
import { AgentRunError } from "../core/agent-runtime/events.js";
import { TalonError } from "../core/errors.js";
import { stubBackend, stubResolveActiveModel } from "./helpers/stub-backend.js";

// Capture every line the real log.ts writes: the turn tag is appended
// inside log.ts, so the logger underneath is what the assertions read.
type Line = { level: string; msg: string };
const lines: Line[] = [];
const sink = (level: string) => (_obj: unknown, msg: string) => {
  lines.push({ level, msg });
};
vi.mock("pino", () => ({
  default: Object.assign(
    () => ({
      info: sink("info"),
      error: sink("error"),
      warn: sink("warn"),
      debug: sink("debug"),
    }),
    { multistream: vi.fn(() => ({ write: vi.fn() })) },
  ),
}));
vi.mock("pino-pretty", () => ({
  default: () => ({ write: vi.fn(), on: vi.fn() }),
}));

const { log } = await import("../util/log.js");
const { Weaver } = await import("../core/weaver/index.js");
const { TurnToolLog, classifyTurnError } =
  await import("../core/weaver/turn-log.js");

function params(input: Partial<ExecuteParams> = {}): ExecuteParams {
  return {
    chatId: input.chatId ?? "chat",
    numericChatId: input.numericChatId ?? 1,
    prompt: input.prompt ?? "hello",
    senderName: "User",
    isGroup: false,
    source: input.source ?? "message",
  };
}

function makeWeaver(backend: Backend) {
  return new Weaver({
    getBackend: () => backend,
    resolveActiveModel: stubResolveActiveModel("claude", "stub-model"),
    context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
    sendTyping: vi.fn(async () => {}),
  });
}

const okResult = (text: string) => ({
  text,
  durationMs: 1,
  inputTokens: 11,
  outputTokens: 7,
  cacheRead: 5,
  cacheWrite: 2,
});

/** The one line starting with `prefix`; fails loudly on zero or several. */
function only(prefix: string): string {
  const hits = lines.filter((l) => l.msg.startsWith(prefix));
  expect(hits, `lines starting with "${prefix}"`).toHaveLength(1);
  return hits[0].msg;
}

function field(line: string, key: string): string | undefined {
  return new RegExp(`(?:^| )${key}=(\\S+)`).exec(line)?.[1];
}

beforeEach(() => {
  lines.length = 0;
});

describe("turn lifecycle lines", () => {
  it("brackets a successful turn with turn.start / tool.call / turn.end", async () => {
    const backend = stubBackend({
      query: vi.fn(async (q: QueryParams) => {
        await new Promise((r) => setTimeout(r, 1));
        log("agent", "backend working");
        q.onToolStart?.("call-1", "Bash", { command: "ls -la" });
        q.onToolEnd?.("call-1", "Bash");
        q.onToolStart?.("call-2", "Read", { path: "/nope" });
        q.onToolEnd?.("call-2", "Read", { failed: true });
        return okResult("done");
      }),
    });

    await makeWeaver(backend).runTurn(params({ chatId: "123456" }));

    const start = only("turn.start ");
    const turnId = field(start, "turn")!;
    expect(turnId).toMatch(/^t-/);
    expect(field(start, "chat")).toBe("123456");
    expect(field(start, "frontend")).toBe("telegram");
    expect(field(start, "backend")).toBe("claude");
    expect(field(start, "model")).toBe("stub-model");
    expect(field(start, "trigger")).toBe("message");
    expect(field(start, "queue")).toBe("0");

    const end = only("turn.end ");
    expect(field(end, "turn")).toBe(turnId);
    expect(field(end, "outcome")).toBe("ok");
    expect(field(end, "tools")).toBe("2");
    expect(field(end, "in_tokens")).toBe("11");
    expect(field(end, "out_tokens")).toBe("7");
    expect(field(end, "cache_read")).toBe("5");
    expect(field(end, "ms")).toMatch(/^\d+$/);
    expect(lines.some((l) => l.msg.startsWith("turn.error"))).toBe(false);

    // The backend's own line, written deep in the handler, joins the turn.
    expect(lines.find((l) => l.msg.startsWith("backend working"))?.msg).toBe(
      `backend working turn=${turnId}`,
    );

    const toolLines = lines.filter((l) => l.msg.startsWith("tool.call "));
    expect(toolLines.map((l) => [l.level, field(l.msg, "name")])).toEqual([
      ["info", "Bash"],
      ["warn", "Read"],
    ]);
    expect(field(toolLines[0].msg, "ok")).toBe("true");
    expect(field(toolLines[1].msg, "ok")).toBe("false");
    expect(toolLines[1].msg).toMatch(/ err=tool call failed/);
    expect(
      lines.find((l) => l.msg.startsWith("tool.start") && l.level === "debug")
        ?.msg,
    ).toContain('args={"command":"ls -la"}');
  });

  it("classifies a failed turn and still closes it with turn.end", async () => {
    const backend = stubBackend({
      query: vi.fn(async () => {
        throw new Error("401 Unauthorized: invalid x-api-key");
      }),
    });

    await expect(
      makeWeaver(backend).runTurn(params({ chatId: "c-fail", source: "cron" })),
    ).rejects.toThrow();

    const error = only("turn.error ");
    const end = only("turn.end ");
    expect(field(error, "turn")).toBe(field(end, "turn"));
    expect(field(error, "chat")).toBe("c-fail");
    expect(field(error, "class")).toBe("auth");
    expect(error).toMatch(/ msg=401 Unauthorized: invalid x-api-key$/);
    expect(field(end, "outcome")).toBe("error");
    expect(field(end, "trigger")).toBe("cron");
    expect(field(end, "backend")).toBe("claude");
    expect(field(end, "tools")).toBe("0");
  });

  it("logs a turn queued behind a running one, and why a queued kill dropped it", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const query = vi.fn(async (q: QueryParams) => {
      if (q.text === "first") await gate;
      return okResult(q.text);
    });
    const weaver = makeWeaver(stubBackend({ query }));

    const p1 = weaver.runTurn(params({ chatId: "c-q", prompt: "first" }));
    const p2 = weaver.runTurn(params({ chatId: "c-q", prompt: "second" }));
    const p3 = weaver.runTurn(params({ chatId: "c-q", prompt: "third" }));
    const queued = lines.filter((l) => l.msg.startsWith("turn.queued "));
    expect(queued.map((l) => field(l.msg, "depth"))).toEqual(["1", "2"]);
    releaseFirst();
    await Promise.all([p1, p2, p3]);

    const starts = lines.filter((l) => l.msg.startsWith("turn.start "));
    expect(starts.map((l) => field(l.msg, "queue"))).toEqual(["0", "1", "2"]);
    expect(field(queued[0].msg, "turn")).toBe(field(starts[1].msg, "turn"));
  });

  it("says a turn was refused when no model resolves", async () => {
    const weaver = new Weaver({
      getBackend: () => stubBackend({}),
      resolveActiveModel: async () => ({
        model: null,
        ref: null,
        backendId: "claude",
      }),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
    });
    await weaver.runTurn(params({ chatId: "c-ref" }));
    expect(field(only("turn.start "), "model")).toBe("none");
    const end = only("turn.end ");
    expect(field(end, "outcome")).toBe("refused");
    expect(field(end, "reason")).toBe("no-model");
  });
});

describe("tool log", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notes a tool still running at 60s, and its result size", () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    const tools = new TurnToolLog("t-abc", "c9");
    tools.onCall({ type: "tool_call", id: "x", name: "web_fetch", input: {} });
    vi.advanceTimersByTime(60_000);
    expect(only("tool.slow ")).toMatch(
      /^tool\.slow turn=t-abc chat=c9 name=web_fetch id=x running_ms=60000$/,
    );
    tools.onResult({
      type: "tool_result",
      id: "x",
      name: "web_fetch",
      result: "héllo",
    });
    const call = only("tool.call ");
    expect(field(call, "ms")).toBe("60000");
    expect(field(call, "bytes")).toBe("6");
    // A settled call leaves no timer behind.
    expect(vi.getTimerCount()).toBe(before);
    tools.close();
  });
});

describe("classifyTurnError", () => {
  it.each([
    [
      new AgentRunError({ kind: "rate_limit", message: "x", retryable: true }),
      "quota",
    ],
    [
      new AgentRunError({
        kind: "tool_failure",
        message: "x",
        retryable: false,
      }),
      "tool",
    ],
    [
      new AgentRunError({ kind: "timeout", message: "x", retryable: false }),
      "timeout",
    ],
    [
      new AgentRunError({
        kind: "subprocess_exit",
        message: "x",
        retryable: false,
      }),
      "backend",
    ],
    [
      new AgentRunError({
        kind: "unknown",
        message: "You've hit your weekly limit",
        retryable: false,
      }),
      "quota",
    ],
    [new TalonError("x", { reason: "overloaded" }), "backend"],
    [Object.assign(new Error("deadline"), { name: "TimeoutError" }), "timeout"],
    [new Error("something odd"), "unknown"],
  ])("%s → %s", (err, cls) => {
    expect(classifyTurnError(err)).toBe(cls);
  });
});
