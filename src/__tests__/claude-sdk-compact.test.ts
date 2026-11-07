/**
 * Claude SDK `compactChat` (backend/claude-sdk/session/compact.ts):
 * resumes the chat's session (or a fork of it) in streaming-input mode,
 * checks the CLI offers `/compact`, waits for the frontend's MCP server
 * like a turn does, sends the command, and reads the `compact_boundary`
 * back. A caller abort before the boundary leaves the session untouched.
 * The SDK `query()` is faked; what is pinned is the protocol around it.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type FakeQuery = AsyncGenerator<SDKMessage> & {
  supportedCommands: () => Promise<{ name: string }[]>;
};

const sdk = {
  commands: ["compact", "context"] as string[],
  replies: [] as SDKMessage[],
  sent: [] as unknown[],
  resume: "sess-1" as string | undefined,
  /** supportedCommands() never settles — a wedged CLI. */
  hang: false,
  /** After the command is sent, the CLI works until it is killed. */
  busy: false,
  /** After the replies, the CLI keeps working until it is killed. */
  busyAfterReplies: false,
  /** `query()` throws synchronously (a bad option, a missing binary). */
  throwOnQuery: false,
  options: undefined as Record<string, unknown> | undefined,
  order: [] as string[],
  deleted: [] as string[],
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  deleteSession: async (id: string) => {
    sdk.deleted.push(id);
  },
  query: ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<unknown>;
    options: Record<string, unknown> & { abortController: AbortController };
  }): FakeQuery => {
    sdk.options = options;
    if (sdk.throwOnQuery) throw new Error("spawn failed");
    const killed = () =>
      new Promise<never>((_, reject) => {
        const sig = options.abortController.signal;
        if (sig.aborted) reject(new Error("aborted"));
        sig.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const it = (async function* () {
      for await (const msg of prompt) {
        sdk.order.push("sent");
        sdk.sent.push(msg);
        break;
      }
      if (sdk.busy) {
        // The subprocess dies with the abort; the stream throws.
        await new Promise<never>((_, reject) => {
          const sig = options.abortController.signal;
          if (sig.aborted) reject(new Error("aborted"));
          sig.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      for (const reply of sdk.replies) yield reply;
      if (sdk.busyAfterReplies) await killed();
    })();
    return Object.assign(it, {
      supportedCommands: () =>
        sdk.hang
          ? new Promise<never>(() => undefined)
          : Promise.resolve(sdk.commands.map((name) => ({ name }))),
    }) as FakeQuery;
  },
}));
vi.mock("../backend/claude-sdk/state.js", () => ({ getConfig: () => ({}) }));
vi.mock("../backend/claude-sdk/options.js", () => ({
  getActiveFrontends: () => ["telegram"],
  prepareChatSystemPrompt: () => ({ text: "sys" }),
  buildSdkOptions: (
    _chatId: string,
    abortController: AbortController,
    model?: string,
  ) => ({
    options: {
      abortController,
      ...(model ? { model } : {}),
      ...(sdk.resume ? { resume: sdk.resume } : {}),
    },
    activeModel: model ?? "m",
  }),
}));
const waitForMcpServersReady = vi.fn(async (_q: unknown, _names: string[]) => {
  sdk.order.push("mcp-ready");
});
vi.mock("../backend/claude-sdk/mcp-ready.js", () => ({
  waitForMcpServersReady: (q: unknown, names: string[]) =>
    waitForMcpServersReady(q, names),
}));
const logWarn = vi.fn();
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logWarn: (...a: unknown[]) => logWarn(...a),
}));
const recordCompactBoundary = vi.fn();
vi.mock("../backend/runtime/cache/cache-metrics.js", () => ({
  recordCompactBoundary: (...a: unknown[]) => recordCompactBoundary(...a),
}));

const { compactChatSession, discardCompactedSession, foldCompactMessage } =
  await import("../backend/claude-sdk/session/compact.js");

const boundary = (pre: number, post?: number): SDKMessage =>
  ({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: pre,
      ...(post !== undefined ? { post_tokens: post } : {}),
    },
    uuid: "u",
    session_id: "sess-1",
  }) as unknown as SDKMessage;

const result = (over: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "sess-1",
    total_cost_usd: 1.25,
    usage: {
      input_tokens: 10,
      output_tokens: 1_200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 650_000,
    },
    ...over,
  }) as unknown as SDKMessage;

beforeEach(() => {
  sdk.commands = ["compact", "context"];
  sdk.replies = [];
  sdk.sent = [];
  sdk.resume = "sess-1";
  sdk.hang = false;
  sdk.busy = false;
  sdk.busyAfterReplies = false;
  sdk.throwOnQuery = false;
  sdk.options = undefined;
  sdk.order = [];
  sdk.deleted = [];
  recordCompactBoundary.mockClear();
  waitForMcpServersReady.mockClear();
  logWarn.mockClear();
});

const forked = (m: SDKMessage) =>
  ({ ...(m as object), session_id: "fork-9" }) as unknown as SDKMessage;

describe("compactChatSession", () => {
  it("sends /compact on the resumed session and reports the boundary", async () => {
    sdk.replies = [boundary(650_000, 9_000), result()];

    const out = await compactChatSession("c1", { modelId: "opus" });

    expect(sdk.sent).toEqual([
      expect.objectContaining({
        type: "user",
        message: { role: "user", content: "/compact" },
      }),
    ]);
    expect(out).toEqual({
      status: "compacted",
      preTokens: 650_000,
      postTokens: 9_000,
      sessionId: "sess-1",
      usage: {
        inputTokens: 10,
        outputTokens: 1_200,
        cacheRead: 0,
        cacheWrite: 650_000,
        costUsd: 1.25,
      },
    });
    expect(recordCompactBoundary).toHaveBeenCalledWith("c1", {
      trigger: "manual",
      pre_tokens: 650_000,
      post_tokens: 9_000,
    });
  });

  it("answers unsupported — and sends nothing — when the CLI has no /compact", async () => {
    sdk.commands = ["context"];
    const onRequestSent = vi.fn();
    expect(await compactChatSession("c1", { onRequestSent })).toMatchObject({
      status: "unsupported",
    });
    expect(sdk.sent).toEqual([]);
    expect(onRequestSent).not.toHaveBeenCalled();
  });

  it("marks the end of the pre-request phase once /compact is sent", async () => {
    sdk.busy = true;
    sdk.replies = [boundary(650_000, 9_000), result()];
    const caller = new AbortController();
    const onRequestSent = vi.fn();
    const pass = compactChatSession("c1", {
      signal: caller.signal,
      onRequestSent,
    });
    await vi.waitFor(() => expect(sdk.sent).toHaveLength(1));
    expect(onRequestSent).toHaveBeenCalledTimes(1);
    caller.abort();
    expect(await pass).toEqual({ status: "aborted" });

    // Aborted in the pre-request phase: never marked.
    const early = new AbortController();
    early.abort();
    const never = vi.fn();
    await compactChatSession("c1", {
      signal: early.signal,
      onRequestSent: never,
    });
    expect(never).not.toHaveBeenCalled();
  });

  it("skips a chat with no session to resume", async () => {
    sdk.resume = undefined;
    expect(await compactChatSession("c1")).toMatchObject({
      status: "skipped",
    });
  });

  it("fails (session untouched) when no boundary comes back", async () => {
    sdk.replies = [
      {
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "failed",
        compact_error: "prompt too long",
      } as unknown as SDKMessage,
      result(),
    ];
    expect(await compactChatSession("c1")).toEqual({
      status: "failed",
      error: "prompt too long",
    });
    expect(recordCompactBoundary).not.toHaveBeenCalled();
  });

  it("times out a CLI that never answers", async () => {
    sdk.hang = true;
    expect(await compactChatSession("c1", { timeoutMs: 20 })).toEqual({
      status: "failed",
      error: "timed out after 20ms",
    });
    expect(sdk.sent).toEqual([]);
  });

  it("waits for the frontend's MCP server before sending, on the given model", async () => {
    sdk.replies = [boundary(650_000, 9_000), result()];
    await compactChatSession("c1", { modelId: "opus-x" });
    expect(waitForMcpServersReady).toHaveBeenCalledWith(expect.anything(), [
      "telegram-tools",
    ]);
    expect(sdk.order).toEqual(["mcp-ready", "sent"]);
    expect(sdk.options).toMatchObject({ model: "opus-x", resume: "sess-1" });
    expect(sdk.options?.forkSession).toBeUndefined();
  });

  it("warns on a cache miss (write > 5 % of pre_tokens), not on a warm read", async () => {
    sdk.replies = [boundary(650_000, 9_000), result()];
    await compactChatSession("c1");
    expect(logWarn).toHaveBeenCalledWith(
      "agent",
      expect.stringContaining("missed the cache"),
    );

    logWarn.mockClear();
    sdk.replies = [
      boundary(650_000, 9_000),
      result({
        usage: {
          input_tokens: 10,
          output_tokens: 1_200,
          cache_read_input_tokens: 648_000,
          cache_creation_input_tokens: 2_000,
        },
      }),
    ];
    const out = await compactChatSession("c1");
    expect(out).toMatchObject({
      status: "compacted",
      usage: { cacheRead: 648_000, cacheWrite: 2_000 },
    });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("forks the session for a precompute and reports the fork's id", async () => {
    sdk.replies = [forked(boundary(650_000, 9_000)), forked(result())];
    const out = await compactChatSession("c1", { fork: true });
    expect(sdk.options).toMatchObject({ resume: "sess-1", forkSession: true });
    expect(out).toMatchObject({ status: "compacted", sessionId: "fork-9" });
  });

  it("drops the id when the CLI did not honour the fork (compacted in place)", async () => {
    sdk.replies = [boundary(650_000, 9_000), result()];
    const out = await compactChatSession("c1", { fork: true });
    expect(out).toMatchObject({ status: "compacted" });
    expect((out as { sessionId?: string }).sessionId).toBeUndefined();
  });

  it("aborts before the boundary: kills the pass and leaves the session untouched", async () => {
    sdk.busy = true;
    sdk.replies = [boundary(650_000, 9_000), result()];
    const caller = new AbortController();
    const onBoundary = vi.fn();
    const pass = compactChatSession("c1", {
      signal: caller.signal,
      onBoundary,
    });
    await vi.waitFor(() => expect(sdk.sent).toHaveLength(1));
    caller.abort();
    expect(await pass).toEqual({ status: "aborted" });
    expect(onBoundary).not.toHaveBeenCalled();
    expect(recordCompactBoundary).not.toHaveBeenCalled();
    const killed = sdk.options!.abortController as AbortController;
    expect(killed.signal.aborted).toBe(true);
  });

  it("answers aborted without spawning when the signal is already aborted", async () => {
    const caller = new AbortController();
    caller.abort();
    expect(await compactChatSession("c1", { signal: caller.signal })).toEqual({
      status: "aborted",
    });
    expect(sdk.options).toBeUndefined();
  });

  it("aborts a fork even after its boundary, and deletes the fork", async () => {
    sdk.busyAfterReplies = true; // the CLI is still closing the turn
    sdk.replies = [forked(boundary(650_000, 9_000))];
    const caller = new AbortController();
    const out = await compactChatSession("c1", {
      fork: true,
      signal: caller.signal,
      onBoundary: () => caller.abort(),
    });
    expect(out).toEqual({ status: "aborted" });
    expect(sdk.deleted).toEqual(["fork-9"]);
  });

  it("keeps an unhonoured fork's in-place landing when aborted after the boundary", async () => {
    sdk.busyAfterReplies = true;
    sdk.replies = [boundary(650_000, 9_000)]; // session_id is the source's
    const caller = new AbortController();
    const out = await compactChatSession("c1", {
      fork: true,
      signal: caller.signal,
      onBoundary: () => caller.abort(),
    });
    expect(out).toMatchObject({ status: "compacted", postTokens: 9_000 });
    expect(sdk.deleted).toEqual([]);
  });

  it("deletes the fork when a fork pass fails or times out", async () => {
    sdk.replies = [
      forked({
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "failed",
        compact_error: "prompt too long",
      } as unknown as SDKMessage),
      forked(result()),
    ];
    expect(await compactChatSession("c1", { fork: true })).toMatchObject({
      status: "failed",
    });
    expect(sdk.deleted).toEqual(["fork-9"]);

    sdk.deleted = [];
    sdk.busyAfterReplies = true;
    sdk.replies = [
      forked({ type: "system", subtype: "init" } as unknown as SDKMessage),
    ];
    expect(
      await compactChatSession("c1", { fork: true, timeoutMs: 20 }),
    ).toEqual({ status: "failed", error: "timed out after 20ms" });
    expect(sdk.deleted).toEqual(["fork-9"]);
  });

  it("never deletes the source session when a non-fork pass fails", async () => {
    sdk.replies = [
      result({ is_error: true, subtype: "error_during_execution" }),
    ];
    expect(await compactChatSession("c1")).toMatchObject({ status: "failed" });
    expect(await compactChatSession("c1", { fork: true })).toMatchObject({
      status: "failed",
    });
    expect(sdk.deleted).toEqual([]);
  });

  it("fails cleanly when query() throws synchronously: timer and listener released", async () => {
    vi.useFakeTimers();
    try {
      sdk.throwOnQuery = true;
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      const out = await compactChatSession("c1", { signal: caller.signal });
      expect(out).toEqual({ status: "failed", error: "spawn failed" });
      expect(vi.getTimerCount()).toBe(0);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an abort once the boundary is in, and reports the landing", async () => {
    sdk.replies = [boundary(650_000, 9_000), result()];
    const caller = new AbortController();
    const out = await compactChatSession("c1", {
      signal: caller.signal,
      onBoundary: () => caller.abort(),
    });
    expect(out).toMatchObject({ status: "compacted", postTokens: 9_000 });
  });
});

describe("discardCompactedSession", () => {
  it("deletes the fork on the default account through the SDK", async () => {
    await discardCompactedSession("fork-9");
    expect(sdk.deleted).toEqual(["fork-9"]);
  });

  it("deletes an extra account's fork from its own CLAUDE_CONFIG_DIR", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "compact-acct-"));
    try {
      const project = join(configDir, "projects", "-home-u-ws");
      mkdirSync(join(project, "fork-10", "subagents"), { recursive: true });
      writeFileSync(join(project, "fork-10.jsonl"), "{}\n");
      writeFileSync(join(project, "sess-1.jsonl"), "{}\n");
      const account = { backendId: "claude-2", configDir } as never;

      await discardCompactedSession("fork-10", account);
      expect(existsSync(join(project, "fork-10.jsonl"))).toBe(false);
      expect(existsSync(join(project, "fork-10"))).toBe(false);
      expect(existsSync(join(project, "sess-1.jsonl"))).toBe(true);
      expect(sdk.deleted).toEqual([]); // not the daemon's own config dir

      // A path is never a session id.
      await discardCompactedSession("../sess-1", account);
      expect(existsSync(join(project, "sess-1.jsonl"))).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("foldCompactMessage", () => {
  it("keeps post_tokens optional", () => {
    const state = {};
    expect(foldCompactMessage(state, boundary(100_000))).toBe("continue");
    expect(state).toMatchObject({ boundary: { pre: 100_000 } });
    expect(
      (state as { boundary: { post?: number } }).boundary.post,
    ).toBeUndefined();
  });

  it("ends on result and flags an error result with no boundary", () => {
    const state: { error?: string } = {};
    expect(
      foldCompactMessage(
        state,
        result({
          is_error: true,
          subtype: "error_during_execution",
          errors: ["x"],
        }),
      ),
    ).toBe("done");
    expect(state.error).toBe("x");
  });
});
