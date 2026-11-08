/**
 * Antigravity handler tests.
 *
 * The CLI is faked at the `child_process.spawn` seam — the fake speaks
 * the real stream-json protocol (one `init`, N `step_update`s, one
 * `result` per line written to stdin), so everything above it is the
 * production code path: the process layer, the event translation, the
 * shared turn phases and delivery.
 */

import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── The fake CLI ────────────────────────────────────────────────────────────

interface SpawnRecord {
  command: string;
  args: string[];
  cwd?: string;
}

const spawned: SpawnRecord[] = [];
/** One entry per turn: the NDJSON lines the fake writes back. */
let turnScript: string[][] = [];
/** Lines emitted once, before the first turn (the `init` event). */
let initLines: string[] = [];
let stderrScript: string[] = [];
/** Children created so far, newest last. */
const children: FakeChild[] = [];
/** The `content` of every user message written to a child's stdin. */
const promptLog: string[] = [];

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;
  signals: string[] = [];
  turns = 0;
  private initSent = false;
  stdin = {
    write: (line: string, cb?: (e?: Error) => void) => {
      this.onPrompt(line);
      cb?.();
      return true;
    },
    end: () => {},
  };

  private onPrompt(line: string): void {
    const parsed = JSON.parse(line) as {
      event: string;
      message: { content: string };
    };
    expect(parsed.event).toBe("user");
    promptLog.push(parsed.message.content);
    const script = turnScript[this.turns] ?? [];
    this.turns += 1;
    queueMicrotask(() => {
      if (this.killed) return;
      if (!this.initSent) {
        this.initSent = true;
        for (const l of initLines) this.stdout.emit("data", `${l}\n`);
      }
      for (const l of script) {
        if (this.killed) return;
        this.stdout.emit("data", `${l}\n`);
      }
    });
  }

  kill(signal: string): boolean {
    this.signals.push(signal);
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => this.emit("close", 0));
    return true;
  }
}

vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: { cwd?: string }) => {
      spawned.push({ command, args, cwd: options?.cwd });
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => {
        for (const line of stderrScript) child.stderr.emit("data", line);
      });
      return child as unknown as ReturnType<typeof actual.spawn>;
    },
  };
});

vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
  getPluginPromptAdditions: vi.fn(() => []),
}));
vi.mock("../util/trace.js", () => ({ traceMessage: vi.fn() }));
/** The catalog the mocked models module serves; empty = cold/failed probe. */
const catalogStub = vi.hoisted(() => ({
  models: [] as import("../backend/agy/models.js").AgyModelInfo[],
}));
vi.mock("../backend/agy/models.js", async (orig) => {
  const actual = await orig<typeof import("../backend/agy/models.js")>();
  return {
    ...actual,
    // Never spawn `agy models` from the handler path.
    refreshModels: vi.fn(async () => catalogStub.models),
    getCachedModels: vi.fn(() => catalogStub.models),
    catalogForSelection: vi.fn(async () => catalogStub.models),
    getModelInfo: vi.fn(async (id: string) =>
      actual.synthesizeUnknownModel(id),
    ),
  };
});

const { handleMessage } = await import("../backend/agy/handler/index.js");
const { initAgyAgent } = await import("../backend/agy/init.js");
const { resetState } = await import("../backend/agy/state.js");
const { killAllChildren } = await import("../backend/agy/process/child.js");
const { resetOwnership } = await import("../backend/agy/mcp/register.js");
const sessions = await import("../storage/sessions.js");
const chatSettings = await import("../storage/chat-settings.js");
const { resetMetrics, getMetrics } = await import("../storage/metrics.js");

// ── Protocol helpers ────────────────────────────────────────────────────────

const CONV = "conv-1234";

const init = (tools: string[] = ["call_mcp_tool", "run_command"]): string =>
  JSON.stringify({
    event: "init",
    conversation_id: CONV,
    init: { cwd: "/tmp", tools, permission_mode: "always-proceed" },
  });

const step = (patch: Record<string, unknown>): string =>
  JSON.stringify({
    event: "step_update",
    step_update: { conversation_id: CONV, ...patch },
  });

const text = (delta: string, state = "ACTIVE", index = 1): string =>
  step({
    step_index: index,
    state,
    step_type: "agent_response",
    text_delta: delta,
  });

const mcpTool = (
  name: string,
  args: Record<string, unknown>,
  state: string,
  index = 2,
): string =>
  step({
    step_index: index,
    state,
    step_type: "tool",
    tool_name: "call_mcp_tool",
    tool_info: {
      name: "call_mcp_tool",
      parameters: {
        ServerName: "__talon__x__telegram-tools",
        ToolName: name,
        Arguments: args,
      },
      ...(state === "DONE" ? { output: "ok" } : {}),
    },
  });

const result = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    event: "result",
    result: {
      conversation_id: CONV,
      status: "SUCCESS",
      response: "hello",
      num_turns: 1,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        thinking_tokens: 5,
        cache_read_tokens: 40,
        total_tokens: 120,
      },
      ...patch,
    },
  });

// ── Fixture harness ─────────────────────────────────────────────────────────

let home: string;
let configPath: string;
const CHAT = "-100agy";

function setup(overrides: Record<string, unknown> = {}): void {
  initAgyAgent(
    {
      model: "gemini-3.8-flash-high",
      workspace: home,
      systemPrompt: "Test system prompt.",
      frontend: "telegram",
      agyBinary: "/fake/agy",
      ...overrides,
    } as never,
    () => 19876,
    "telegram",
  );
}

function run(extra: Record<string, unknown> = {}) {
  return handleMessage({
    chatId: CHAT,
    text: "hello there",
    senderName: "Ada",
    ...extra,
  } as never);
}

/**
 * Sink the MCP-config env points at between tests, so nothing can ever
 * fall back to the real `~/.gemini/config/mcp_config.json`.
 */
const SINK = mkdtempSync(join(tmpdir(), "agy-sink-"));
process.env.TALON_AGY_MCP_CONFIG = join(SINK, "mcp_config.json");
process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(SINK, "snapshots");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agy-handler-"));
  mkdirSync(join(home, "config"), { recursive: true });
  configPath = join(home, "config", "mcp_config.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
  process.env.TALON_AGY_MCP_CONFIG = configPath;
  process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(home, "snapshots");
  spawned.length = 0;
  children.length = 0;
  turnScript = [];
  promptLog.length = 0;
  initLines = [init()];
  stderrScript = [];
  resetMetrics();
  resetState();
  resetOwnership();
  killAllChildren("test");
  sessions.resetSession(CHAT);
  chatSettings.setChatModel(CHAT, undefined);
  setup();
});

afterEach(() => {
  // Never unset the injection env: a late async write (a retry ladder
  // resolving after the test returned) would otherwise land in the
  // developer's REAL ~/.gemini/config/mcp_config.json. Point it at a
  // per-file sink instead.
  process.env.TALON_AGY_MCP_CONFIG = join(SINK, "mcp_config.json");
  process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(SINK, "snapshots");
  killAllChildren("test");
  rmSync(home, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("agy handler — spawn shape", () => {
  it("spawns one stream-json child with the resolved model and workspace", async () => {
    turnScript = [[text("hi", "ACTIVE"), text("!", "DONE"), result()]];
    await run();
    expect(spawned).toHaveLength(1);
    const { command, args, cwd } = spawned[0];
    expect(command).toBe("/fake/agy");
    expect(args).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "0s",
      "--model",
      "gemini-3.8-flash-high",
      "--add-dir",
      home,
    ]);
    expect(cwd).toBe(home);
    // -p must never be combined with stdin streaming.
    expect(args).not.toContain("-p");
  });

  it("keeps ONE child warm across turns in the same chat", async () => {
    turnScript = [
      [text("one", "DONE"), result()],
      [text("two", "DONE"), result({ num_turns: 2 })],
    ];
    await run();
    await run();
    expect(spawned).toHaveLength(1);
    expect(children[0].turns).toBe(2);
  });

  it("expresses a requested level through the sibling slug, never a conflicting --effort", async () => {
    // agy >= 1.4: `--model gemini-3.8-flash-high --effort low` exits 1.
    const { parseAgyModels } = await import("../backend/agy/models.js");
    catalogStub.models = parseAgyModels(
      "gemini-3.8-flash-high\tH\ngemini-3.8-flash-medium\tM\ngemini-3.8-flash-low\tL\n",
    );
    try {
      chatSettings.setChatEffort(CHAT, "low");
      turnScript = [[text("hi", "DONE"), result()]];
      await run();
      const args = spawned[0].args;
      expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
      expect(args).not.toContain("--effort");
    } finally {
      catalogStub.models = [];
    }
  });

  it("drops the level rather than send a conflicting pair when the catalog is cold", async () => {
    chatSettings.setChatEffort(CHAT, "low");
    turnScript = [[text("hi", "DONE"), result()]];
    await run();
    const args = spawned[0].args;
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
    expect(args).not.toContain("--effort");
  });

  it("passes --effort for a suffix-less model id", async () => {
    chatSettings.setChatModel(CHAT, "claude-sonnet-5-5");
    chatSettings.setChatEffort(CHAT, "high");
    turnScript = [[text("hi", "DONE"), result()]];
    await run();
    const args = spawned[0].args;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });
});

describe("agy handler — the first-turn system prompt", () => {
  it("prepends the assembled system prompt on turn one only", async () => {
    turnScript = [
      [text("one", "DONE"), result()],
      [text("two", "DONE"), result({ num_turns: 2 })],
    ];
    await run();
    await run();
    const prompts = promptLog;

    // Turn one carries the assembled prompt (which ends with agy's
    // delivery contract) fenced off from the user's message.
    expect(prompts[0]).toContain("\n\n---\n\n");
    expect(prompts[0]).toContain("end_turn");
    expect(prompts[0]).toContain("hello there");
    expect(prompts[0].endsWith(prompts[0].split("\n\n---\n\n").at(-1)!)).toBe(
      true,
    );
    // Turn two inherits the prompt from the conversation: user text only.
    expect(prompts[1]).not.toContain("\n\n---\n\n");
    expect(prompts[1]).toContain("hello there");
    expect(prompts[1].length).toBeLessThan(prompts[0].length / 5);
  });
});

describe("agy handler — resume", () => {
  it("stores the conversation id from the stream", async () => {
    turnScript = [[text("hi", "DONE"), result()]];
    await run();
    expect(sessions.getSession(CHAT).sessionId).toBe(CONV);
  });

  it("respawns with --conversation after the child is gone", async () => {
    turnScript = [
      [text("hi", "DONE"), result()],
      [text("again", "DONE"), result({ num_turns: 2 })],
    ];
    await run();
    killAllChildren("test-kill");
    await run();
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args).toContain("--conversation");
    expect(spawned[1].args[spawned[1].args.indexOf("--conversation") + 1]).toBe(
      CONV,
    );
  });
});

describe("agy handler — tools and the terminator", () => {
  it("reports MCP tools under their unwrapped names", async () => {
    turnScript = [
      [
        mcpTool("check_time", { timezone: "Europe/London" }, "ACTIVE"),
        mcpTool("check_time", { timezone: "Europe/London" }, "DONE"),
        text("18:41", "DONE", 3),
        result(),
      ],
    ];
    const starts: string[] = [];
    const ends: string[] = [];
    await run({
      onToolStart: (_id: string, name: string) => starts.push(name),
      onToolEnd: (_id: string, name: string) => ends.push(name),
    });
    expect(starts).toEqual(["check_time"]);
    expect(ends).toEqual(["check_time"]);
    expect(getMetrics().counters["tool_calls.check_time"]).toBe(1);
  });

  it("kills the child when a delivery tool terminates the turn", async () => {
    turnScript = [
      [
        mcpTool("end_turn", { text: "done!" }, "ACTIVE"),
        mcpTool("end_turn", { text: "done!" }, "DONE"),
        // The CLI would keep going; we must not wait for its result.
      ],
    ];
    const res = await run();
    expect(children[0].killed).toBe(true);
    expect(children[0].signals).toContain("SIGTERM");
    // The terminator close is a clean completion, not an error.
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("respawns lazily with --conversation after a terminator kill", async () => {
    turnScript = [
      [mcpTool("end_turn", { text: "done!" }, "DONE")],
      [text("second", "DONE"), result({ num_turns: 2 })],
    ];
    await run();
    await run();
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args).toContain("--conversation");
  });

  it("does not deliver a text part when a delivery tool already shipped one", async () => {
    turnScript = [[mcpTool("end_turn", { text: "done!" }, "DONE")]];
    const blocks: string[] = [];
    await run({ onTextBlock: async (t: string) => void blocks.push(t) });
    expect(blocks).toEqual([]);
  });

  it("a failed tool neither terminates the turn nor counts as delivery", async () => {
    turnScript = [
      [
        step({
          step_index: 2,
          state: "ERROR",
          step_type: "tool",
          tool_name: "call_mcp_tool",
          tool_info: {
            name: "call_mcp_tool",
            parameters: {
              ServerName: "s",
              ToolName: "end_turn",
              Arguments: { text: "x" },
            },
            error: { type: "TOOL_ERROR", message: "connection refused" },
          },
        }),
        text("sorry", "DONE", 3),
        result({ response: "sorry" }),
      ],
    ];
    const blocks: string[] = [];
    await run({ onTextBlock: async (t: string) => void blocks.push(t) });
    expect(children[0].killed).toBe(false);
    expect(blocks).toEqual(["sorry"]);
  });
});

describe("agy handler — usage", () => {
  it("records the turn's usage, delta'd off the cumulative counters", async () => {
    turnScript = [
      [text("one", "DONE"), result()],
      [
        text("two", "DONE"),
        result({
          num_turns: 2,
          usage: {
            input_tokens: 250,
            output_tokens: 35,
            thinking_tokens: 9,
            cache_read_tokens: 100,
            total_tokens: 285,
          },
        }),
      ],
    ];
    const first = await run();
    expect(first).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheRead: 40,
      cacheWrite: 0,
    });
    const second = await run();
    // 250-100 in, 35-20 out, 100-40 cached — not the raw cumulative values.
    expect(second).toMatchObject({
      inputTokens: 150,
      outputTokens: 15,
      cacheRead: 60,
      cacheWrite: 0,
    });
  });

  it("files the /status snapshot under the conversation id, not just the chat", async () => {
    turnScript = [[text("one", "DONE"), result()]];
    await run();
    const { getState } = await import("../backend/agy/state.js");
    // `/status` looks this up by the STORED session id — which for agy
    // is the CLI's conversation id, not the chat id.
    expect(sessions.getSession(CHAT).sessionId).toBe(CONV);
    expect(getState().lastUsage.get(CONV)).toMatchObject({
      inputTokens: 100,
      cacheRead: 40,
      contextModelId: "gemini-3.8-flash-high",
    });
    expect(getState().lastUsage.get(CHAT)).toBeDefined();
  });
});

describe("agy handler — failures", () => {
  it("surfaces an authentication failure with the fix named", async () => {
    stderrScript = ["error: authentication required\n"];
    turnScript = [[]];
    // No result event; the fake exits instead.
    queueMicrotask(() => {
      setTimeout(() => children[0]?.emit("close", 1), 5);
    });
    await expect(run()).rejects.toThrow(
      /agy.*interactively|not authenticated/is,
    );
  });

  it("turns a non-SUCCESS result into a synthetic error, not a chat reply", async () => {
    turnScript = [
      [
        result({
          status: "ERROR",
          response: "",
          error: "invalid model selection",
        }),
      ],
    ];
    const blocks: string[] = [];
    await run({ onTextBlock: async (t: string) => void blocks.push(t) });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toBe("");
    // The raw upstream string must not be shipped verbatim as the reply.
    expect(blocks[0]).not.toBe("invalid model selection");
  });
});

describe("agy handler — MCP registration", () => {
  it("writes the chat's MCP entries before the child spawns", async () => {
    turnScript = [[text("hi", "DONE"), result()]];
    await run();
    const written = JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<string, { serverUrl: string }>;
    };
    const keys = Object.keys(written.mcpServers);
    expect(keys.some((k) => k.startsWith("__talon__"))).toBe(true);
    expect(keys.some((k) => k.endsWith("__telegram-tools"))).toBe(true);
    expect(Object.values(written.mcpServers)[0].serverUrl).toContain(
      "127.0.0.1:19876/mcp/",
    );
  });
});
