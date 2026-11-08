/**
 * **Turn retrieval** — the per-turn tier of docs/memory-persona-plan.md
 * §3.4, behind `TALON_MEMORY_STORE`. Four properties are load-bearing
 * and each has a case here:
 *
 *   - **Trust (plan §5, #373).** Only `operator` and `agent` rows are
 *     ever auto-injected. A `user_claim` or `group_chat` row that
 *     matches the query perfectly is still left out — auto-injecting
 *     one turns anything said in a group into a standing prompt
 *     injection. They stay reachable through the explicit `recall`
 *     tool. `reflection` is excluded too: the diary is never a fact
 *     source (plan §3.5).
 *   - **Fail closed.** A broken store must never block chat delivery:
 *     one warning per process, and the turn runs without memory.
 *   - **The cache invariant (plan §3.6).** Retrieval touches the USER
 *     turn only. The assembled system prompt is byte-identical across
 *     a retrieval hit, and nothing here reaches
 *     `notifyPromptInputsChanged()`.
 *   - **The seam.** One field on `ChatRunParams`, one renderer in
 *     `formatUserPrompt`, and the Weaver as the only producer — which
 *     is what #639's `retrievedMemory` lacked when two backends read it
 *     and four dropped it in silence.
 *
 * The worker-shared SQLite database outlives this file, so every case
 * writes rows carrying its own nonce token and queries by that token.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  retrieveForTurn,
  TURN_MEMORY_MAX_CHARS,
} from "../core/memory/turn-retrieval.js";
import { onPromptInputsChanged } from "../core/prompt/invalidation.js";
import { assembleSystemPrompt } from "../core/prompt/assemble.js";
import { formatUserPrompt } from "../backend/runtime/prompt/prompt-format.js";
import { Weaver } from "../core/weaver/index.js";
import { stubResolveActiveModel } from "./helpers/stub-backend.js";
import { composeBackend } from "../core/agent-runtime/capabilities.js";
import type { ChatRunParams } from "../core/agent-runtime/capabilities.js";
import type { AgentEvent } from "../core/agent-runtime/events.js";
import type { ContextManager } from "../core/types.js";
import {
  assertMemory,
  dropMemory,
  getMemory,
  searchMemories,
  type MemoryInput,
  type MemoryTrust,
} from "../storage/memory.js";
import { logWarn } from "../util/log.js";

vi.mock("../util/log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util/log.js")>();
  return { ...actual, log: vi.fn(), logDebug: vi.fn(), logWarn: vi.fn() };
});

vi.mock("../storage/memory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/memory.js")>();
  return { ...actual, searchMemories: vi.fn(actual.searchMemories) };
});

const searchSpy = vi.mocked(searchMemories);
const warnSpy = vi.mocked(logWarn);

let seq = 0;
/** A token no other row in the shared DB carries. */
function freshToken(): string {
  return `zqxturn${++seq}x${Date.now()}`;
}

/** Rows written by a case, dropped again so later cases see a clean store. */
const written: number[] = [];

function write(input: Partial<MemoryInput> & { text: string }): number {
  const { id } = assertMemory({
    kind: "fact",
    subject: `turn-retrieval-${seq}`,
    trust: "operator",
    ...input,
  });
  written.push(id);
  return id;
}

beforeEach(() => {
  process.env.TALON_MEMORY_STORE = "1";
  searchSpy.mockClear();
  warnSpy.mockClear();
});

afterEach(() => {
  delete process.env.TALON_MEMORY_STORE;
  for (const id of written.splice(0)) {
    try {
      dropMemory(id, "test cleanup");
    } catch {
      /* already gone */
    }
  }
});

function retrieve(text: string) {
  return retrieveForTurn({ chatId: "chat-1", text, isGroup: false });
}

// ── The flag ────────────────────────────────────────────────────────────────

describe("retrieveForTurn / the flag", () => {
  it("returns undefined and never reaches the store when off", () => {
    const token = freshToken();
    write({ text: `the store holds ${token}` });

    delete process.env.TALON_MEMORY_STORE;
    expect(retrieve(token)).toBeUndefined();
    process.env.TALON_MEMORY_STORE = "0";
    expect(retrieve(token)).toBeUndefined();
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("returns undefined when nothing matched", () => {
    expect(retrieve(freshToken())).toBeUndefined();
  });
});

// ── Trust policy (plan §5, #373) ────────────────────────────────────────────

describe("retrieveForTurn / trust policy", () => {
  it("injects operator and agent rows and never user_claim or group_chat", () => {
    const token = freshToken();
    const ids: Record<MemoryTrust, number> = {
      operator: write({ text: `operator says ${token}`, trust: "operator" }),
      agent: write({ text: `agent says ${token}`, trust: "agent" }),
      user_claim: write({
        text: `a user claims ${token}`,
        trust: "user_claim",
      }),
      group_chat: write({ text: `overheard ${token}`, trust: "group_chat" }),
    };

    // All four match the query — trust, not relevance, is what decides.
    expect(
      searchMemories(token, { match: "any", limit: 20 })
        .map((r) => r.id)
        .sort(),
    ).toEqual(Object.values(ids).sort());

    const memory = retrieve(token);
    expect(memory).toBeDefined();
    expect(memory!.rows).toBe(2);
    expect(memory!.text).toContain(`operator says ${token}`);
    expect(memory!.text).toContain(`agent says ${token}`);
    expect(memory!.text).not.toContain("a user claims");
    expect(memory!.text).not.toContain("overheard");
  });

  it("injects nothing when only low-trust rows match", () => {
    const token = freshToken();
    write({ text: `claimed ${token}`, trust: "user_claim" });
    write({ text: `group said ${token}`, trust: "group_chat" });

    expect(retrieve(token)).toBeUndefined();
  });

  it("excludes reflection rows — the diary is never a fact source", () => {
    const token = freshToken();
    write({ text: `diary entry about ${token}`, kind: "reflection" });
    const fact = write({ text: `fact about ${token}` });

    const memory = retrieve(token);
    expect(memory!.text).toContain(`#${fact} `);
    expect(memory!.text).not.toContain("diary entry");
  });

  it("retrieves episodes, which the static core view never carries", () => {
    const token = freshToken();
    const episode = write({ text: `that time with ${token}`, kind: "episode" });

    expect(retrieve(token)!.text).toContain(`#${episode} `);
  });
});

// ── Budget ──────────────────────────────────────────────────────────────────

describe("retrieveForTurn / budget", () => {
  it("caps at whole rows, never mid-row", () => {
    const token = freshToken();
    const body = "x".repeat(900);
    for (let i = 0; i < 8; i++) write({ text: `${token} ${i} ${body}` });

    const memory = retrieve(token)!;
    expect(memory.chars).toBe(memory.text.length);
    expect(memory.chars).toBeLessThanOrEqual(TURN_MEMORY_MAX_CHARS);
    // Every emitted line is a complete `#id [kind] subject: text` row.
    const lines = memory.text.split("\n");
    expect(lines).toHaveLength(memory.rows);
    for (const line of lines) {
      expect(line).toMatch(/^#\d+ \[\w+\] /);
      expect(line).toContain(body);
    }
  });
});

// ── The feedback loop ───────────────────────────────────────────────────────

describe("retrieveForTurn / feedback loop", () => {
  it("touches every injected row and leaves the rest alone", () => {
    const token = freshToken();
    const injected = write({ text: `trusted ${token}` });
    const skipped = write({ text: `claimed ${token}`, trust: "user_claim" });

    const before = getMemory(injected)!.hitCount;
    retrieve(token);

    expect(getMemory(injected)!.hitCount).toBe(before + 1);
    expect(getMemory(skipped)!.hitCount).toBe(0);
  });
});

// ── Fail closed ─────────────────────────────────────────────────────────────

describe("retrieveForTurn / fail closed", () => {
  it("swallows a store failure, warns once per process, runs the turn", () => {
    const real = searchSpy.getMockImplementation()!;
    searchSpy.mockImplementation(() => {
      throw new Error("database is locked");
    });
    try {
      expect(retrieve("anything")).toBeUndefined();
      expect(retrieve("anything else")).toBeUndefined();
      expect(retrieve("and again")).toBeUndefined();
    } finally {
      searchSpy.mockImplementation(real);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![1]).toContain("database is locked");
  });
});

// ── The prompt seam ─────────────────────────────────────────────────────────

describe("formatUserPrompt / retrieved memory", () => {
  const base = {
    text: "what did I say about the cache?",
    senderName: "Ada",
    messageId: 42,
    omitTimeTag: true,
  };

  it("is byte-identical when the field is absent, empty, or blank", () => {
    const expected = "[msg_id:42] what did I say about the cache?";
    expect(formatUserPrompt(base)).toBe(expected);
    expect(formatUserPrompt({ ...base, retrievedMemory: undefined })).toBe(
      expected,
    );
    expect(formatUserPrompt({ ...base, retrievedMemory: "" })).toBe(expected);
    expect(formatUserPrompt({ ...base, retrievedMemory: "   \n " })).toBe(
      expected,
    );
  });

  it("appends the verify-first block after the message text", () => {
    const out = formatUserPrompt({
      ...base,
      retrievedMemory: "#1 [fact] a: b",
    });
    expect(out).toBe(
      "[msg_id:42] what did I say about the cache?\n\n" +
        "[Recalled from memory — verify before relying on it]\n" +
        "#1 [fact] a: b",
    );
  });

  it("keeps the group framing intact around the block", () => {
    const out = formatUserPrompt({
      ...base,
      isGroup: true,
      senderHandle: "ada",
      retrievedMemory: "#1 [fact] a: b",
    });
    expect(out.startsWith("[Ada (@ada)] [msg_id:42]: ")).toBe(true);
    expect(out.endsWith("#1 [fact] a: b")).toBe(true);
  });
});

/**
 * #639's post-mortem: `retrievedMemory` existed on the params for
 * months while only two backends out of six read it — "a latent
 * divergence that would have become a real bug the day a retriever was
 * installed". The retriever is now installed, so the divergence is
 * checked instead of assumed: every `formatUserPrompt` call site in
 * `src/backend/` forwards the field.
 */
describe("the prompt seam / no backend forgets the field", () => {
  it("every formatUserPrompt call site forwards retrievedMemory", () => {
    const root = join(__dirname, "..", "backend");
    const callSites: string[] = [];
    for (const file of walk(root)) {
      const source = readFileSync(file, "utf-8");
      let at = source.indexOf("formatUserPrompt({");
      while (at !== -1) {
        callSites.push(file);
        expect(objectLiteralAt(source, at)).toContain("retrievedMemory");
        at = source.indexOf("formatUserPrompt({", at + 1);
      }
    }
    // The five production backends: claude-sdk, codex, agy,
    // openai-agents, remote-server (kilo + opencode share it).
    expect(callSites).toHaveLength(5);
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

/** The `{...}` argument starting at `formatUserPrompt(` in `source`. */
function objectLiteralAt(source: string, at: number): string {
  const start = source.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(start, i + 1);
  }
  throw new Error("unbalanced object literal");
}

// ── The Weaver passes it through ────────────────────────────────────────────

describe("weaver / turn memory", () => {
  function captureBackend(): {
    backend: ReturnType<typeof composeBackend>;
    seen: ChatRunParams[];
  } {
    const seen: ChatRunParams[] = [];
    const backend = composeBackend({
      id: "claude",
      label: "Capture",
      cacheMetrics: "none",
      chat: {
        runChatTurn: (params) => {
          seen.push(params);
          return (async function* (): AsyncIterable<AgentEvent> {
            yield { type: "run_started" };
            yield {
              type: "completed",
              result: {
                text: "ok",
                durationMs: 1,
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
              },
            };
          })();
        },
      },
    });
    return { backend, seen };
  }

  const context: ContextManager = {
    acquire: vi.fn(),
    release: vi.fn(),
    getMessageCount: () => 0,
  };

  async function runTurn(prompt: string): Promise<ChatRunParams> {
    const { backend, seen } = captureBackend();
    const weaver = new Weaver({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context,
      sendTyping: vi.fn(async () => {}),
    });
    await weaver.runTurn({
      chatId: "weaver-memory",
      numericChatId: 1,
      prompt,
      senderName: "Ada",
      isGroup: false,
      source: "message",
    });
    return seen[0]!;
  }

  it("hands the backend the retrieved block for this turn", async () => {
    const token = freshToken();
    const id = write({ text: `the answer about ${token} is 42` });

    const params = await runTurn(`remind me about ${token}`);
    expect(params.retrievedMemory).toContain(`#${id} `);
    expect(params.retrievedMemory).toContain(`the answer about ${token} is 42`);
  });

  it("leaves the field absent when the flag is off", async () => {
    const token = freshToken();
    write({ text: `the answer about ${token} is 42` });
    delete process.env.TALON_MEMORY_STORE;

    const params = await runTurn(`remind me about ${token}`);
    expect(params.retrievedMemory).toBeUndefined();
  });
});

// ── The cache invariant (plan §3.6) ─────────────────────────────────────────

describe("turn retrieval / prompt-cache invariant", () => {
  it("never invalidates a prompt snapshot", () => {
    const invalidated = vi.fn();
    onPromptInputsChanged(invalidated);
    const token = freshToken();
    write({ text: `something about ${token}` });

    expect(retrieve(token)).toBeDefined();
    expect(invalidated).not.toHaveBeenCalled();
  });

  it("leaves the assembled system prompt byte-identical across a hit", () => {
    const token = freshToken();
    // `episode` rows are retrievable but structurally absent from the
    // core view, so the touch this retrieval performs cannot reorder
    // the static block even in principle.
    write({ text: `that time with ${token}`, kind: "episode" });

    const before = assembleSystemPrompt({ frontend: "terminal" });
    const memory = retrieve(token);
    const after = assembleSystemPrompt({ frontend: "terminal" });

    expect(memory).toBeDefined();
    expect(after.staticText).toBe(before.staticText);
    expect(after.dynamicText).toBe(before.dynamicText);
    expect(before.staticText).not.toContain(token);
    expect(before.dynamicText).not.toContain(token);
  });
});
