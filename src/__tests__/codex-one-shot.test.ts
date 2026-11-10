/**
 * Codex one-shot agent runner tests.
 *
 * Exercises the event-translation layer that turns Codex's
 * `runStreamed` `ThreadEvent` stream into run-log lines used by
 * heartbeat + dream. The full path (spawning `codex` CLI) isn't
 * exercisable without the binary on PATH, but the per-event/per-item
 * formatting logic is pure and we can hand-build representative
 * events.
 *
 * We don't import `runOneShotAgent` directly because it depends on
 * `ensureCodex` which spawns the CLI. Instead this file imports the
 * source for the test surface area via a thin helper export.
 */

import { describe, it, expect, vi } from "vitest";
import type { ReasoningEffortLevel } from "../core/types.js";
import { CODEX_CHATGPT_DEFAULT_MODEL } from "../backend/codex/constants.js";

vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
}));

vi.mock("@openai/codex-sdk", () => {
  // Light mock — `runOneShotAgent` only needs `startThread` and a
  // working `runStreamed` AsyncGenerator.
  class MockThread {
    async runStreamed(_input: string, options?: { signal?: AbortSignal }) {
      const events = (async function* () {
        yield { type: "thread.started", thread_id: "thr_test" };
        yield { type: "turn.started" };
        yield {
          type: "item.completed",
          item: {
            id: "i1",
            type: "agent_message",
            text: "Hello from Codex.",
          },
        };
        yield {
          type: "item.completed",
          item: {
            id: "i2",
            type: "mcp_tool_call",
            server: "telegram-tools",
            tool: "send",
            arguments: { type: "text", text: "ok" },
            status: "completed",
          },
        };
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cached_input_tokens: 10,
            reasoning_output_tokens: 5,
          },
        };
      })();
      void options;
      return { events };
    }
  }
  return {
    Codex: class {
      // The init module accesses `__talonChatId` as a stash slot.
      // Allow arbitrary property writes via `as any` in init.ts.
      startThread() {
        return new MockThread();
      }
      resumeThread() {
        return new MockThread();
      }
    },
  };
});

// Now import after the mocks are wired
const { runOneShotAgent } = await import("../backend/codex/one-shot.js");
const { initCodexAgent } = await import("../backend/codex/init.js");

describe("codex / runOneShotAgent — event → log translation", () => {
  it("appends thread-started, turn lifecycle, agent message, and tool call", async () => {
    initCodexAgent(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "terminal",
        openaiApiKey: "test-key",
      } as never,
      () => 19876,
      "terminal",
    );

    const lines: string[] = [];
    const appendLog = async (text: string) => {
      lines.push(text);
    };
    const abortController = new AbortController();

    await runOneShotAgent({
      prompt: "Hello",
      systemPrompt: "You are an assistant.",
      workspace: "/tmp",
      model: "gpt-5-codex",
      contextLabel: "heartbeat",
      abortController,
      appendLog,
    });

    const log = lines.join("");
    expect(log).toContain("Thread started");
    expect(log).toContain("thr_test");
    expect(log).toContain("Turn started");
    expect(log).toContain("Turn completed");
    expect(log).toContain("input=100");
    expect(log).toContain("output=50");
    expect(log).toContain("Assistant");
    expect(log).toContain("Hello from Codex.");
    expect(log).toContain("MCP tool call");
    expect(log).toContain("telegram-tools.send");
  });

  it("stops appending once the abort signal fires", async () => {
    initCodexAgent(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "terminal",
        openaiApiKey: "test-key",
      } as never,
      () => 19876,
      "terminal",
    );

    const lines: string[] = [];
    const appendLog = async (text: string) => {
      lines.push(text);
    };
    const abortController = new AbortController();
    // Fire abort immediately
    abortController.abort();

    await runOneShotAgent({
      prompt: "Hello",
      systemPrompt: "You are an assistant.",
      workspace: "/tmp",
      model: "gpt-5-codex",
      contextLabel: "heartbeat",
      abortController,
      appendLog,
    });

    const log = lines.join("");
    expect(log).toContain("Aborted");
  });
});

// ── Coverage for the long tail of item types one-shot.ts handles ───────────

describe("codex / runOneShotAgent — extended item-type coverage", () => {
  /**
   * Drive runOneShotAgent against a custom event stream by re-mocking
   * the SDK for each test. Each test re-imports init + runOneShotAgent
   * after re-applying the mock to get a fresh Codex instance.
   */
  /** What the last {@link runWith} rejected with, if anything. */
  let lastRunError: unknown;

  async function runWith(
    events: AsyncGenerator<Record<string, unknown>>,
  ): Promise<string[]> {
    vi.resetModules();
    vi.doMock("../core/plugin/index.js", () => ({
      getPluginMcpServers: vi.fn(() => ({})),
    }));
    vi.doMock("@openai/codex-sdk", () => {
      class MockThread {
        async runStreamed(_input: string, options?: { signal?: AbortSignal }) {
          void options;
          return { events };
        }
      }
      return {
        Codex: class {
          startThread() {
            return new MockThread();
          }
          resumeThread() {
            return new MockThread();
          }
        },
      };
    });

    const initMod = await import("../backend/codex/init.js");
    const runMod = await import("../backend/codex/one-shot.js");

    initMod.initCodexAgent(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "terminal",
        openaiApiKey: "test-key",
      } as never,
      () => 19876,
      "terminal",
    );

    const lines: string[] = [];
    lastRunError = undefined;
    await runMod
      .runOneShotAgent({
        prompt: "Hello",
        systemPrompt: "You are an assistant.",
        workspace: "/tmp",
        model: "gpt-5-codex",
        contextLabel: "heartbeat",
        abortController: new AbortController(),
        appendLog: async (text: string) => {
          lines.push(text);
        },
      })
      .catch((err: unknown) => {
        lastRunError = err;
      });
    return lines;
  }

  it("renders reasoning items as their own log section", async () => {
    const events = (async function* () {
      yield { type: "turn.started" };
      yield {
        type: "item.completed",
        item: { id: "i1", type: "reasoning", text: "deliberating quietly" },
      };
      yield { type: "turn.completed" };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Reasoning");
    expect(log).toContain("deliberating quietly");
  });

  it("renders command_execution items with status + exit code", async () => {
    const events = (async function* () {
      yield {
        type: "item.completed",
        item: {
          id: "i1",
          type: "command_execution",
          command: "ls -la",
          status: "completed",
          exit_code: 0,
        },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Command:");
    expect(log).toContain("ls -la");
    expect(log).toContain("completed");
    expect(log).toContain("exit=0");
  });

  it("renders file_change items with a per-file list", async () => {
    const events = (async function* () {
      yield {
        type: "item.completed",
        item: {
          id: "i1",
          type: "file_change",
          status: "completed",
          changes: [
            { kind: "create", path: "a.txt" },
            { kind: "edit", path: "b.txt" },
          ],
        },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("File changes:");
    expect(log).toContain("create a.txt");
    expect(log).toContain("edit b.txt");
  });

  it("renders web_search items with the query", async () => {
    const events = (async function* () {
      yield {
        type: "item.completed",
        item: {
          id: "i1",
          type: "web_search",
          query: "talon agent harness",
        },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Web search:");
    expect(log).toContain("talon agent harness");
  });

  it("renders todo_list items with checkbox state", async () => {
    const events = (async function* () {
      yield {
        type: "item.completed",
        item: {
          id: "i1",
          type: "todo_list",
          items: [
            { text: "first task", completed: true },
            { text: "second task", completed: false },
          ],
        },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Todo list:");
    expect(log).toContain("[x] first task");
    expect(log).toContain("[ ] second task");
  });

  it("surfaces turn.failed events with the upstream error message", async () => {
    const events = (async function* () {
      yield { type: "turn.started" };
      yield {
        type: "turn.failed",
        error: { message: "rate limit hit, try later" },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Turn FAILED");
    expect(log).toContain("rate limit hit, try later");
    // A stream that ends after turn.failed is a failed run, not a success:
    // the caller (cron, heartbeat, task table) must see it reject.
    expect(lastRunError).toBeInstanceOf(Error);
    expect((lastRunError as Error).name).toBe("CodexOneShotError");
    expect((lastRunError as Error).message).toBe("rate limit hit, try later");
  });

  it("rejects with the model-not-found 404 when the account lost the model", async () => {
    const notFound =
      "unexpected status 404 Not Found: The model `gpt-5.5` does not exist " +
      "or you do not have access to it.";
    const events = (async function* () {
      yield { type: "turn.started" };
      yield { type: "error", message: "Reconnecting... 1/5 (stream closed)" };
      yield { type: "error", message: notFound };
      yield { type: "turn.failed", error: { message: notFound } };
    })();
    await runWith(events);
    expect((lastRunError as Error).message).toBe(notFound);
  });

  it("ignores transient reconnect errors when the turn completes", async () => {
    const events = (async function* () {
      yield { type: "turn.started" };
      yield { type: "error", message: "Reconnecting... 1/5 (stream closed)" };
      yield {
        type: "error",
        message: "Falling back from WebSockets to HTTPS transport. x",
      };
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      };
    })();
    await runWith(events);
    expect(lastRunError).toBeUndefined();
  });

  it("surfaces stream-level error events", async () => {
    const events = (async function* () {
      yield { type: "error", message: "connection reset" };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("ERROR");
    expect(log).toContain("connection reset");
    expect((lastRunError as Error).message).toBe("connection reset");
  });

  it("renders unknown item types via the fallback JSON dump", async () => {
    const events = (async function* () {
      yield {
        type: "item.completed",
        item: {
          id: "i1",
          type: "future_capability",
          payload: { foo: "bar" },
        },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Item (future_capability)");
    expect(log).toContain("future_capability");
    expect(log).toContain("foo");
  });
});

// ── OAuth-aware model resolution (heartbeat / dream parity with handler) ──
//
// These tests assert that one-shot runs on a ChatGPT-OAuth credential
// receive the same pre-emptive model swap the interactive handler
// applies. Without this, a heartbeat configured with `heartbeatModel:
// gpt-5-codex` (or any cache-discovered learned-incompat id) would
// fail silently with the 2026-05-20 23:13Z bug shape, but in
// a context where there's no chat to deliver an error to.

import { afterEach, beforeEach } from "vitest";

// ── Reasoning effort → Codex thread option ────────────────────────────────

describe("codex / runOneShotAgent — reasoning effort", () => {
  /**
   * Run a one-shot with `reasoningEffort` and return the options the
   * runner handed to `startThread`.
   *
   * Availability ("does this model offer that level?") is the caller's job
   * (core/background/effort.ts) — the runner's only remaining decision is
   * whether Codex can express the level at all, which is what these assert.
   */
  async function threadOptionsFor(
    reasoningEffort?: ReasoningEffortLevel,
  ): Promise<Record<string, unknown>> {
    vi.resetModules();
    const captured: Record<string, unknown>[] = [];
    vi.doMock("../core/plugin/index.js", () => ({
      getPluginMcpServers: vi.fn(() => ({})),
    }));
    vi.doMock("@openai/codex-sdk", () => {
      class MockThread {
        async runStreamed() {
          const events = (async function* () {
            yield { type: "turn.completed" };
          })();
          return { events };
        }
      }
      return {
        Codex: class {
          startThread(options: Record<string, unknown>) {
            captured.push(options);
            return new MockThread();
          }
          resumeThread() {
            return new MockThread();
          }
        },
      };
    });

    const initMod = await import("../backend/codex/init.js");
    const runMod = await import("../backend/codex/one-shot.js");
    initMod.initCodexAgent(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "terminal",
        openaiApiKey: "test-key",
      } as never,
      () => 19876,
      "terminal",
    );

    await runMod.runOneShotAgent({
      prompt: "Hello",
      systemPrompt: "test",
      workspace: "/tmp",
      model: "gpt-5-codex",
      ...(reasoningEffort ? { reasoningEffort } : {}),
      contextLabel: "heartbeat",
      abortController: new AbortController(),
      appendLog: async () => {},
    });

    expect(captured).toHaveLength(1);
    return captured[0];
  }

  it("passes a Codex-expressible level as modelReasoningEffort", async () => {
    expect(await threadOptionsFor("high")).toMatchObject({
      modelReasoningEffort: "high",
    });
  });

  it("passes xhigh through (Codex's own ceiling)", async () => {
    expect(await threadOptionsFor("xhigh")).toMatchObject({
      modelReasoningEffort: "xhigh",
    });
  });

  it("omits the option entirely when no effort is requested", async () => {
    expect(await threadOptionsFor()).not.toHaveProperty("modelReasoningEffort");
  });

  it.each(["off", "max"] as const)(
    "omits the option for %s, which Codex cannot express",
    async (level) => {
      expect(await threadOptionsFor(level)).not.toHaveProperty(
        "modelReasoningEffort",
      );
    },
  );
});

describe("codex / runOneShotAgent — OAuth-aware model swap", () => {
  let fakeHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origApiKey: string | undefined;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "talon-codex-oneshot-"));
    fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".codex", "auth.json"),
      '{"auth_mode":"chatgpt"}',
    );
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    origApiKey = process.env.OPENAI_API_KEY;
    // Set BOTH HOME and USERPROFILE so `os.homedir()` resolves to
    // fakeHome on POSIX AND Windows (Node uses USERPROFILE on win32
    // and falls back to HOMEDRIVE+HOMEPATH if USERPROFILE is unset,
    // which would leak into the real user profile).
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    delete process.env.OPENAI_API_KEY;
    const oauthIncompat = await import("../backend/codex/oauth-incompat.js");
    oauthIncompat.resetOAuthIncompatForTests();
    // The store now persists in the shared per-worker kv table (not a
    // per-fakeHome file), so a learned model outlives resetModules.
    // Clear the row so each test starts from an empty set.
    const kv = await import("../storage/kv.js");
    kv.kvDelete("codex.oauth-incompat");
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    if (origUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = origUserProfile;
    }
    if (origApiKey !== undefined) {
      process.env.OPENAI_API_KEY = origApiKey;
    }
    // Also reset the in-memory oauth-incompat store so a learned
    // model from one test doesn't bleed into the next via the
    // module-level singleton (vi.resetModules() is called per test
    // inside runWithMockedSdk, but explicit reset is cheap insurance).
    const oauthIncompat = await import("../backend/codex/oauth-incompat.js");
    oauthIncompat.resetOAuthIncompatForTests();
    try {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /**
   * Drive `runOneShotAgent` with a fresh SDK mock and capture both the
   * appendLog output AND the `model` value the mocked thread saw.
   */
  async function runWithMockedSdk(
    requestedModel: string,
    events: AsyncGenerator<Record<string, unknown>>,
  ): Promise<{ log: string; observedModel: string | undefined }> {
    vi.resetModules();
    const observedThreadOptions: Array<Record<string, unknown>> = [];
    vi.doMock("../core/plugin/index.js", () => ({
      getPluginMcpServers: vi.fn(() => ({})),
    }));
    vi.doMock("@openai/codex-sdk", () => {
      class MockThread {
        async runStreamed(_input: string, opts?: { signal?: AbortSignal }) {
          void opts;
          return { events };
        }
      }
      return {
        Codex: class {
          startThread(opts: Record<string, unknown>) {
            observedThreadOptions.push(opts);
            return new MockThread();
          }
          resumeThread() {
            return new MockThread();
          }
        },
      };
    });

    const initMod = await import("../backend/codex/init.js");
    const runMod = await import("../backend/codex/one-shot.js");

    initMod.initCodexAgent(
      {
        model: requestedModel,
        workspace: "/tmp",
        systemPrompt: "Test system prompt.",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    const lines: string[] = [];
    const appendLog = async (text: string) => {
      lines.push(text);
    };
    const abortController = new AbortController();
    await runMod.runOneShotAgent({
      prompt: "Hello",
      systemPrompt: "You are a heartbeat agent.",
      workspace: "/tmp",
      model: requestedModel,
      contextLabel: "heartbeat",
      abortController,
      appendLog,
    });

    return {
      log: lines.join(""),
      observedModel: observedThreadOptions[0]?.model as string | undefined,
    };
  }

  it("swaps gpt-5-codex → the ChatGPT default on OAuth and logs the swap", async () => {
    const events = (async function* () {
      yield { type: "turn.started" };
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      };
    })();

    const { log, observedModel } = await runWithMockedSdk(
      "gpt-5-codex",
      events,
    );
    expect(observedModel).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
    expect(log).toContain("Model swap");
    expect(log).toContain("gpt-5-codex");
    expect(log).toContain(CODEX_CHATGPT_DEFAULT_MODEL);
  });

  it("swaps a runtime-learned OAuth-incompat model on OAuth", async () => {
    // The vi.resetModules() inside runWithMockedSdk would invalidate
    // any pre-marked oauth-incompat state, so we inline the run and
    // mark the model AFTER reset against the same module instance
    // resolveOneShotModel will consult.
    vi.resetModules();
    const observedThreadOptions: Array<Record<string, unknown>> = [];
    vi.doMock("../core/plugin/index.js", () => ({
      getPluginMcpServers: vi.fn(() => ({})),
    }));
    vi.doMock("@openai/codex-sdk", () => {
      class MockThread {
        async runStreamed() {
          const events = (async function* () {
            yield { type: "turn.started" };
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cached_input_tokens: 0,
                reasoning_output_tokens: 0,
              },
            };
          })();
          return { events };
        }
      }
      return {
        Codex: class {
          startThread(opts: Record<string, unknown>) {
            observedThreadOptions.push(opts);
            return new MockThread();
          }
          resumeThread() {
            return new MockThread();
          }
        },
      };
    });

    const initMod = await import("../backend/codex/init.js");
    const runMod = await import("../backend/codex/one-shot.js");
    const oauthIncompat = await import("../backend/codex/oauth-incompat.js");

    initMod.initCodexAgent(
      {
        model: "gpt-5.4-mini",
        workspace: "/tmp",
        systemPrompt: "Test system prompt.",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    // initCodexAgent has now (fire-and-forget) loaded the store
    // under the auth file's fingerprint. Re-await the same loader
    // so we know the in-memory state is settled before marking,
    // then mark the model and run.
    await oauthIncompat.loadOAuthIncompatStore(
      "chatgpt:file:~/.codex/auth.json",
    );
    await oauthIncompat.markOAuthIncompat("gpt-5.4-mini");

    const lines: string[] = [];
    const abortController = new AbortController();
    await runMod.runOneShotAgent({
      prompt: "Hello",
      systemPrompt: "test",
      workspace: "/tmp",
      model: "gpt-5.4-mini",
      contextLabel: "heartbeat",
      abortController,
      appendLog: async (t: string) => {
        lines.push(t);
      },
    });

    const log = lines.join("");
    expect(observedThreadOptions[0]?.model).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
    expect(log).toContain("Model swap");
    expect(log).toContain("gpt-5.4-mini");
  });

  it("does NOT swap when the requested model is already the ChatGPT default", async () => {
    const events = (async function* () {
      yield { type: "turn.started" };
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      };
    })();

    const { observedModel, log } = await runWithMockedSdk(
      CODEX_CHATGPT_DEFAULT_MODEL,
      events,
    );
    expect(observedModel).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
    expect(log).not.toContain("Model swap");
  });

  it("does NOT persist silent-exit failures (ambiguous signal), only explicit", async () => {
    // Heartbeat/dream can't recurse for an in-place retry. Silent
    // exit-1 could be a transient outage OR a real incompat — we
    // can't tell. Persisting on ambiguous failures would over-poison
    // the store (a one-off blip permanently downgrades heartbeats).
    // The run is logged as an error but no learning happens. The
    // EXPLICIT mismatch path (server returns the canonical text) IS
    // persisted in a separate path because that signal is definitive.
    vi.resetModules();
    vi.doMock("../core/plugin/index.js", () => ({
      getPluginMcpServers: vi.fn(() => ({})),
    }));
    vi.doMock("@openai/codex-sdk", () => {
      class MockThread {
        async runStreamed() {
          throw new Error(
            "Codex Exec exited with code 1: Reading prompt from stdin...\n",
          );
        }
      }
      return {
        Codex: class {
          startThread() {
            return new MockThread();
          }
          resumeThread() {
            return new MockThread();
          }
        },
      };
    });
    const initMod = await import("../backend/codex/init.js");
    const runMod = await import("../backend/codex/one-shot.js");
    const oauthIncompat = await import("../backend/codex/oauth-incompat.js");

    initMod.initCodexAgent(
      {
        model: "gpt-5.4-mini",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    const lines: string[] = [];
    const abortController = new AbortController();
    await expect(
      runMod.runOneShotAgent({
        prompt: "Hello",
        systemPrompt: "test",
        workspace: "/tmp",
        model: "gpt-5.4-mini",
        contextLabel: "heartbeat",
        abortController,
        appendLog: async (t: string) => {
          lines.push(t);
        },
      }),
    ).rejects.toThrow(/Reading prompt from stdin/);

    const log = lines.join("");
    expect(log).toContain("Error");
    expect(log).toContain("Reading prompt from stdin");
    // Silent-exit is NOT persisted — ambiguous signal.
    expect(oauthIncompat.isKnownOAuthIncompat("gpt-5.4-mini")).toBe(false);
  });

  it("DOES persist on EXPLICIT mismatch even in one-shot context", async () => {
    // Heartbeat/dream can't recurse for an in-place retry, but
    // explicit mismatch is unambiguous server signal — persist it so
    // the next scheduled run pre-empts to the ChatGPT default.
    vi.resetModules();
    vi.doMock("../core/plugin/index.js", () => ({
      getPluginMcpServers: vi.fn(() => ({})),
    }));
    vi.doMock("@openai/codex-sdk", () => {
      class MockThread {
        async runStreamed() {
          throw new Error(
            `400 Bad Request: The "gpt-future-model" model is not ` +
              `supported when using Codex with a ChatGPT account.`,
          );
        }
      }
      return {
        Codex: class {
          startThread() {
            return new MockThread();
          }
          resumeThread() {
            return new MockThread();
          }
        },
      };
    });
    const initMod = await import("../backend/codex/init.js");
    const runMod = await import("../backend/codex/one-shot.js");
    const oauthIncompat = await import("../backend/codex/oauth-incompat.js");

    initMod.initCodexAgent(
      {
        model: "gpt-future-model",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    const lines: string[] = [];
    await expect(
      runMod.runOneShotAgent({
        prompt: "Hello",
        systemPrompt: "test",
        workspace: "/tmp",
        model: "gpt-future-model",
        contextLabel: "heartbeat",
        abortController: new AbortController(),
        appendLog: async (t: string) => {
          lines.push(t);
        },
      }),
    ).rejects.toThrow(/not supported when using Codex/);

    expect(oauthIncompat.isKnownOAuthIncompat("gpt-future-model")).toBe(true);
  });
});

// ── The assistant-text hook ─────────────────────────────────────────────────

describe("codex / runOneShotAgent — onAssistantText", () => {
  /**
   * Same fresh-SDK-mock drive as the item-type coverage above, plus the
   * optional hook under test.
   */
  async function runWithHook(
    events: AsyncGenerator<Record<string, unknown>>,
    onAssistantText?: (text: string) => void,
  ): Promise<string[]> {
    vi.resetModules();
    vi.doMock("../core/plugin/index.js", () => ({
      getPluginMcpServers: vi.fn(() => ({})),
    }));
    vi.doMock("@openai/codex-sdk", () => {
      class MockThread {
        async runStreamed(_input: string, options?: { signal?: AbortSignal }) {
          void options;
          return { events };
        }
      }
      return {
        Codex: class {
          startThread() {
            return new MockThread();
          }
          resumeThread() {
            return new MockThread();
          }
        },
      };
    });

    const initMod = await import("../backend/codex/init.js");
    const runMod = await import("../backend/codex/one-shot.js");

    initMod.initCodexAgent(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "terminal",
        openaiApiKey: "test-key",
      } as never,
      () => 19876,
      "terminal",
    );

    const lines: string[] = [];
    await runMod.runOneShotAgent({
      prompt: "Hello",
      systemPrompt: "You are an assistant.",
      workspace: "/tmp",
      model: "gpt-5-codex",
      contextLabel: "heartbeat",
      abortController: new AbortController(),
      appendLog: async (text: string) => {
        lines.push(text);
      },
      ...(onAssistantText ? { onAssistantText } : {}),
    });
    return lines;
  }

  function mixedStream(): AsyncGenerator<Record<string, unknown>> {
    return (async function* () {
      yield { type: "turn.started" };
      yield {
        type: "item.completed",
        item: { id: "i1", type: "reasoning", text: "deliberating quietly" },
      };
      yield {
        type: "item.completed",
        item: { id: "i2", type: "agent_message", text: "the answer" },
      };
      yield {
        type: "item.completed",
        item: {
          id: "i3",
          type: "mcp_tool_call",
          server: "telegram-tools",
          tool: "send",
          arguments: { text: "ok" },
        },
      };
      yield { type: "turn.completed" };
    })();
  }

  it("reports agent_message items and not reasoning or tool items", async () => {
    const seen: string[] = [];
    const lines = await runWithHook(mixedStream(), (text) => seen.push(text));

    expect(seen).toEqual(["the answer"]);
    // Reasoning and tool calls stay log-only.
    expect(lines.join("")).toContain("deliberating quietly");
    expect(lines.join("")).toContain("MCP tool call");
  });

  it("swallows a throwing hook and still writes the run log", async () => {
    const lines = await runWithHook(mixedStream(), () => {
      throw new Error("consumer blew up");
    });

    expect(lines.join("")).toContain("the answer");
    expect(lines.join("")).toContain("Turn completed");
  });
});
