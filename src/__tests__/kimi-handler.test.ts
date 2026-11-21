/**
 * Kimi handler tests.
 *
 * The CLI is faked at the `child_process.spawn` seam. Each spawn is one
 * `kimi -p` turn: the fake writes its scripted NDJSON lines and exits,
 * unless the turn is scripted to hang until it is killed. Everything above
 * the seam is the production path.
 *
 * What would reveal a regression: an interrupted first turn being counted
 * (the next turn then runs in a fresh kimi session with no system prompt),
 * or a plugin-reload override replacing the assembled prompt wholesale
 * (dropping the delivery contract).
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface SpawnRecord {
  args: string[];
}

const spawned: SpawnRecord[] = [];
/** One entry per spawn: the lines to emit, and whether to then hang. */
let turnScript: { lines: string[]; hang?: boolean }[] = [];
const children: FakeChild[] = [];

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;

  start(script: { lines: string[]; hang?: boolean }): void {
    queueMicrotask(() => {
      for (const l of script.lines) this.stdout.emit("data", `${l}\n`);
      if (!script.hang) this.emit("close", 0);
    });
  }

  kill(): boolean {
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
}

vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_command: string, args: string[]) => {
      spawned.push({ args });
      const child = new FakeChild();
      children.push(child);
      child.start(turnScript[spawned.length - 1] ?? { lines: [] });
      return child as unknown as ReturnType<typeof actual.spawn>;
    },
  };
});

vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
  getPluginPromptAdditions: vi.fn(() => []),
}));
vi.mock("../util/trace.js", () => ({ traceMessage: vi.fn() }));
vi.mock("../backend/kimi/models.js", async (orig) => {
  const actual = await orig<typeof import("../backend/kimi/models.js")>();
  return {
    ...actual,
    refreshModels: vi.fn(async () => []),
    getDefaultModelId: vi.fn(() => "test/model"),
  };
});

const { handleMessage } = await import("../backend/kimi/handler/index.js");
const { initKimiAgent } = await import("../backend/kimi/init.js");
const { resetState, getState } = await import("../backend/kimi/state.js");
const { killAllChildren } = await import("../backend/kimi/process/child.js");
const { interruptChatTurn } =
  await import("../backend/runtime/turn/turn-interrupt.js");
const sessions = await import("../storage/sessions.js");

const CHAT = "-100kimi";
let home: string;

const assistant = (content: string): string =>
  JSON.stringify({ role: "assistant", content });
const resumeHint = (id: string): string =>
  JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: id });

/** The `-p` argument of the n-th spawn. */
const promptOf = (n: number): string => {
  const args = spawned[n].args;
  return args[args.indexOf("-p") + 1];
};

function run(text = "hello there") {
  return handleMessage({ chatId: CHAT, text, senderName: "Ada" } as never);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kimi-handler-"));
  vi.stubEnv("KIMI_CODE_HOME", join(home, "kimi-home"));
  spawned.length = 0;
  children.length = 0;
  turnScript = [];
  resetState();
  killAllChildren("test");
  sessions.resetSession(CHAT);
  initKimiAgent(
    {
      model: "test/model",
      workspace: home,
      systemPrompt: "",
      frontend: "telegram",
      kimiBinary: "/fake/kimi",
    } as never,
    () => 19876,
    "telegram",
  );
});

afterEach(() => {
  killAllChildren("test");
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("kimi handler — session continuity", () => {
  it("stores the session id and resumes it without the system prompt", async () => {
    turnScript = [
      { lines: [assistant("hi"), resumeHint("session_a")] },
      { lines: [assistant("again"), resumeHint("session_a")] },
    ];
    await run();
    expect(sessions.getSession(CHAT)).toMatchObject({
      sessionId: "session_a",
      turns: 1,
    });
    await run("second");
    expect(promptOf(0)).toContain("## Response flow");
    expect(promptOf(1)).not.toContain("## Response flow");
    expect(spawned[1].args).toEqual(
      expect.arrayContaining(["-S", "session_a"]),
    );
  });

  it("does not count an interrupted first turn that never reported a session", async () => {
    turnScript = [
      { lines: [assistant("working on it")], hang: true },
      { lines: [assistant("ok"), resumeHint("session_b")] },
    ];
    const first = run();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    interruptChatTurn(CHAT);
    await first;

    expect(sessions.getSession(CHAT).sessionId).toBeUndefined();
    expect(sessions.getSession(CHAT).turns).toBe(0);

    // The next turn starts a new kimi session, so it must carry the
    // system prompt again rather than run without it.
    await run("second");
    expect(spawned[1].args).not.toContain("-S");
    expect(promptOf(1)).toContain("## Response flow");
    expect(sessions.getSession(CHAT)).toMatchObject({
      sessionId: "session_b",
      turns: 1,
    });
  });
});

describe("kimi handler — system prompt override", () => {
  it("still assembles the full prompt, delivery contract included", async () => {
    turnScript = [{ lines: [assistant("hi"), resumeHint("session_c")] }];
    // What a plugin reload hands updateSystemPrompt: the bare global prompt.
    getState().systemPromptOverride = "RELOADED BASE PROMPT";
    await run();
    const full = promptOf(0);
    const systemPart = full.slice(0, full.lastIndexOf("\n\n---\n\n"));
    expect(systemPart).not.toBe("RELOADED BASE PROMPT");
    expect(systemPart).toContain("## Response flow");
    expect(systemPart).toMatch(/plain assistant text is the reply/i);
  });
});
