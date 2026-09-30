/**
 * Antigravity one-shot runner tests — heartbeat / dream / sub-agent
 * runs use a FRESH `agy -p` process, get their own MCP scope, and
 * must clean that scope up whatever happens.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunKilledError } from "../util/abort-reason.js";
import { IsolatedAgentTimeoutError } from "../core/background/isolated-agent.js";

interface SpawnRecord {
  command: string;
  args: string[];
  cwd?: string;
}

const spawned: SpawnRecord[] = [];
let stdoutLines: string[] = [];
let stderrChunks: string[] = [];
let exitCode = 0;
let children: FakeChild[] = [];

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  signals: string[] = [];
  kill(signal: string): boolean {
    this.signals.push(signal);
    this.emit("close", 143);
    return true;
  }
  play(): void {
    for (const chunk of stderrChunks) this.stderr.emit("data", chunk);
    for (const line of stdoutLines) this.stdout.emit("data", `${line}\n`);
    this.emit("close", exitCode);
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
      setTimeout(() => child.play(), 1);
      return child as unknown as ReturnType<typeof actual.spawn>;
    },
  };
});
vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
  getPluginPromptAdditions: vi.fn(() => []),
}));

const { runOneShotAgent, oneShotScope, buildOneShotArgs } =
  await import("../backend/agy/one-shot.js");
const { initAgyAgent } = await import("../backend/agy/init.js");
const { resetState } = await import("../backend/agy/state.js");
const { resetOwnership } = await import("../backend/agy/mcp/register.js");
const { resetModelCache } = await import("../backend/agy/models.js");

let home: string;
let configPath: string;
let logged: string;

function params(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "do the thing",
    systemPrompt: "You are the heartbeat.",
    workspace: home,
    model: "gemini-3.1-pro-high",
    contextLabel: "heartbeat",
    abortController: new AbortController(),
    appendLog: async (t: string) => {
      logged += t;
    },
    ...overrides,
  } as never;
}

const servers = () =>
  (
    JSON.parse(readFileSync(configPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    }
  ).mcpServers;

const RESULT = JSON.stringify({
  event: "result",
  result: {
    conversation_id: "c1",
    status: "SUCCESS",
    response: "the answer\n",
    num_turns: 1,
    usage: {
      input_tokens: 90,
      output_tokens: 12,
      thinking_tokens: 4,
      cache_read_tokens: 30,
      total_tokens: 102,
    },
  },
});

/**
 * Sink the MCP-config env points at between tests, so nothing can ever
 * fall back to the real `~/.gemini/config/mcp_config.json`.
 */
const SINK = mkdtempSync(join(tmpdir(), "agy-sink-"));
process.env.TALON_AGY_MCP_CONFIG = join(SINK, "mcp_config.json");
process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(SINK, "snapshots");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agy-oneshot-"));
  mkdirSync(join(home, "config"), { recursive: true });
  configPath = join(home, "config", "mcp_config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { "user-own": { serverUrl: "http://u" } } }),
  );
  process.env.TALON_AGY_MCP_CONFIG = configPath;
  process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(home, "snapshots");
  spawned.length = 0;
  children = [];
  stdoutLines = [RESULT];
  stderrChunks = [];
  exitCode = 0;
  logged = "";
  resetState();
  resetModelCache();
  resetOwnership();
  initAgyAgent(
    {
      model: "gemini-3.8-flash-high",
      workspace: home,
      systemPrompt: "x",
      frontend: "telegram",
      agyBinary: "/fake/agy",
    } as never,
    () => 19876,
    "telegram",
  );
});

afterEach(() => {
  // Never unset the injection env: a late async write (a retry ladder
  // resolving after the test returned) would otherwise land in the
  // developer's REAL ~/.gemini/config/mcp_config.json. Point it at a
  // per-file sink instead.
  process.env.TALON_AGY_MCP_CONFIG = join(SINK, "mcp_config.json");
  process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(SINK, "snapshots");
  rmSync(home, { recursive: true, force: true });
});

describe("agy one-shot — argv", () => {
  it("uses a fresh `-p` process, never the stdin stream", () => {
    const args = buildOneShotArgs({
      prompt: "P",
      model: "m",
      effort: "high",
      workspace: "/w",
    });
    expect(args.slice(0, 2)).toEqual(["-p", "P"]);
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("stream-json");
    expect(args).not.toContain("--input-format");
    expect(args.slice(-2)).toEqual(["--effort", "high"]);
  });

  it("omits --effort for a level agy cannot express", () => {
    expect(
      buildOneShotArgs({ prompt: "P", model: "m", workspace: "/w" }),
    ).not.toContain("--effort");
  });
});

describe("agy one-shot — running", () => {
  it("prepends the system prompt and returns the run's usage", async () => {
    const usage = await runOneShotAgent(params());
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe("/fake/agy");
    expect(spawned[0].cwd).toBe(home);
    const prompt = spawned[0].args[1];
    expect(prompt).toContain("You are the heartbeat.");
    expect(prompt).toContain("\n\n---\n\n");
    expect(prompt.endsWith("do the thing")).toBe(true);
    expect(usage).toEqual({
      inputTokens: 90,
      outputTokens: 12,
      cacheRead: 30,
      cacheWrite: 0,
    });
  });

  it("honours the requested model and effort", async () => {
    await runOneShotAgent(params({ reasoningEffort: "medium" }));
    expect(spawned[0].args).toContain("gemini-3.1-pro-high");
    expect(spawned[0].args).toContain("medium");
  });

  it("reports the final answer through onAssistantText and the log", async () => {
    const seen: string[] = [];
    await runOneShotAgent(
      params({ onAssistantText: (t: string) => seen.push(t) }),
    );
    expect(seen).toEqual(["the answer\n"]);
    expect(logged).toContain("Assistant");
    expect(logged).toContain("the answer");
  });

  it("logs tool steps live, with the unwrapped MCP name", async () => {
    stdoutLines = [
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "DONE",
          step_type: "tool",
          tool_name: "call_mcp_tool",
          tool_info: {
            name: "call_mcp_tool",
            parameters: {
              ServerName: "extras",
              ToolName: "check_time",
              Arguments: { timezone: "Europe/London" },
            },
            output: "18:41",
          },
        },
      }),
      RESULT,
    ];
    await runOneShotAgent(params());
    expect(logged).toContain("extras.check_time");
    expect(logged).not.toContain("call_mcp_tool");
    expect(logged).toContain("Europe/London");
  });

  it("records a failed tool step as FAILED with its message", async () => {
    stdoutLines = [
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "ERROR",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "false" },
            error: { type: "TOOL_ERROR", message: "exit 1" },
          },
        },
      }),
      RESULT,
    ];
    await runOneShotAgent(params());
    expect(logged).toContain("FAILED");
    expect(logged).toContain("exit 1");
  });
});

describe("agy one-shot — MCP scoping", () => {
  it("registers under its own oneshot scope and removes it afterwards", async () => {
    expect(oneShotScope("heartbeat")).toBe("oneshot-heartbeat");
    let sawScopeDuringRun: string[] = [];
    const original = params();
    await runOneShotAgent({
      ...(original as object),
      appendLog: async (t: string) => {
        logged += t;
        if (sawScopeDuringRun.length === 0) {
          sawScopeDuringRun = Object.keys(servers());
        }
      },
    } as never);
    expect(
      sawScopeDuringRun.some((k) =>
        k.startsWith("__talon__oneshot-heartbeat__"),
      ),
    ).toBe(true);
    // Afterwards: only the user's own entry is left.
    expect(Object.keys(servers())).toEqual(["user-own"]);
  });

  it("removes its scope even when the run fails", async () => {
    stdoutLines = [];
    exitCode = 1;
    stderrChunks = ["something exploded\n"];
    await runOneShotAgent(params());
    expect(Object.keys(servers())).toEqual(["user-own"]);
    expect(logged).toContain("something exploded");
  });
});

describe("agy one-shot — failure paths", () => {
  it("names the interactive-login fix when the CLI is unauthenticated", async () => {
    stdoutLines = [];
    exitCode = 1;
    stderrChunks = ["authentication required\n"];
    await runOneShotAgent(params());
    expect(logged).toMatch(/interactively/i);
    expect(logged).toContain("agy");
  });

  it("logs an abort rather than an error when the timeout fires", async () => {
    const abortController = new AbortController();
    abortController.abort();
    await runOneShotAgent(params({ abortController }));
    expect(logged).toContain("Aborted");
    expect(spawned).toHaveLength(0);
  });

  it("says 'killed', not 'timeout', for a deliberate kill", async () => {
    const abortController = new AbortController();
    abortController.abort(new RunKilledError());
    await runOneShotAgent(params({ abortController }));
    expect(logged).toContain("Run killed on request.");
    expect(logged).not.toContain("timeout");
  });

  it("still says 'timeout' when the timeout is the reason", async () => {
    const abortController = new AbortController();
    abortController.abort(new IsolatedAgentTimeoutError(1000));
    await runOneShotAgent(params({ abortController }));
    expect(logged).toContain("Run aborted by timeout.");
  });

  it("kills the child when the abort fires mid-run", async () => {
    const abortController = new AbortController();
    const run = runOneShotAgent(params({ abortController }));
    abortController.abort();
    await run;
    expect(children[0].signals).toContain("SIGTERM");
  });
});
