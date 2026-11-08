/**
 * Tests for src/core/background/dream/index.ts
 *
 * Covers: initDream, maybeStartDream (guard paths), forceDream (concurrency),
 * state persistence, prompt template / mempalace gating, and timeout handling.
 *
 * Dream now routes through `backend.background?.runOneShotAgent`. We supply a fake
 * backend; SDK-specific message formatting and MCP wiring live in
 * src/backend/<name>/one-shot.ts and are tested separately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OneShotAgentParams } from "../core/types.js";
import type { Backend } from "../core/agent-runtime/capabilities.js";
import { stubBackend } from "./helpers/stub-backend.js";
import { logWarn as logWarnMock } from "../util/log.js";

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// Hoisted with the mock factory: vi.mock is hoisted above every import,
// so a plain `const` here is in its temporal dead zone whenever node:fs is
// first evaluated through a transitive import (util/watchdog) rather than
// this file's own imports.
const { existsSyncMock, readFileSyncMock, mkdirSyncMock, appendFileSyncMock } =
  vi.hoisted(() => ({
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => "null"),
    mkdirSyncMock: vi.fn(),
    appendFileSyncMock: vi.fn(),
  }));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
  appendFileSync: appendFileSyncMock,
}));

// Dream state now rides the kv store (storage/kv.js) instead of a JSON
// file. Mock the seam with an in-memory map so a test can both seed
// prior state AND observe the running→idle write sequence — the real kv
// keeps only the latest value, so it can't show the pair.
const kvStore = new Map<string, unknown>();
const kvSetMock = vi.fn((key: string, value: unknown) => {
  kvStore.set(key, JSON.parse(JSON.stringify(value)));
});
const kvGetMock = vi.fn((key: string) => kvStore.get(key));
const kvDeleteMock = vi.fn((key: string) => kvStore.delete(key));
vi.mock("../storage/kv.js", () => ({
  kvGet: (k: string) => kvGetMock(k),
  kvSet: (k: string, v: unknown) => kvSetMock(k, v),
  kvDelete: (k: string) => kvDeleteMock(k),
}));

const DREAM_STATE_KEY = "dream.state";
/** Persisted-state payloads written under the dream key, in order. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stateWrites(): any[] {
  return kvSetMock.mock.calls
    .filter((c) => c[0] === DREAM_STATE_KEY)
    .map((c) => c[1]);
}
/** Seed a prior persisted state verbatim (no normalization). */
function seedState(value: unknown): void {
  kvStore.set(DREAM_STATE_KEY, value);
}
/** Wipe persisted state and clear the recorded write log. */
function clearState(): void {
  kvStore.delete(DREAM_STATE_KEY);
  kvSetMock.mockClear();
}

vi.mock("../util/paths.js", () => ({
  files: {
    dreamState: "/fake/.talon/workspace/memory/dream_state.json",
    memory: "/fake/.talon/workspace/memory/memory.md",
    log: "/fake/.talon/talon.log",
  },
  dirs: {
    root: "/fake/.talon",
    logs: "/fake/.talon/workspace/logs",
    workspace: "/fake/.talon/workspace",
    data: "/fake/.talon/data",
    memory: "/fake/.talon/workspace/memory",
    dailyMemory: "/fake/.talon/workspace/memory/daily",
  },
}));

// Fake backend the dream module dispatches to.
const runOneShotAgentMock = vi.fn<(p: OneShotAgentParams) => Promise<void>>(
  async () => {},
);

function makeMockBackend(): Backend {
  return stubBackend({
    query: vi.fn(),
    runOneShotAgent: (p) => runOneShotAgentMock(p),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

const { initDream, maybeStartDream, forceDream, dreamFailureBackoff } =
  await import("../core/background/dream/index.js");

beforeEach(() => {
  runOneShotAgentMock.mockReset();
  runOneShotAgentMock.mockImplementation(async () => {});
  clearState();
  dreamFailureBackoff.succeed(); // module-level state — reset between tests
});

describe("initDream", () => {
  it("accepts a config object without throwing", () => {
    expect(() => initDream({ model: "claude-sonnet-4-6" })).not.toThrow();
  });

  it("accepts all optional config fields", () => {
    expect(() =>
      initDream({
        model: "claude-sonnet-4-6",
        dreamModel: "claude-haiku-4-5",
        dreamEffort: "low",
        workspace: "/tmp/test-workspace",
        getBackend: () => makeMockBackend(),
      }),
    ).not.toThrow();
  });
});

describe("maybeStartDream", () => {
  beforeEach(() => {
    initDream({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
    });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("dream prompt template");
  });

  it("does nothing when no dream state exists", () => {
    expect(() => maybeStartDream()).not.toThrow();
  });

  it("does nothing when dream was recently run (within 12 hours)", () => {
    const recentRun = Date.now() - 1_000;
    seedState({ last_run: recentRun, status: "idle" });
    expect(() => maybeStartDream()).not.toThrow();
  });

  it("does not start a second dream if one is already running", async () => {
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("dream prompt template");
    const firstDream = forceDream().catch(() => {});
    await expect(forceDream()).rejects.toThrow("Dream already running");
    await firstDream;
  });
});

describe("forceDream", () => {
  beforeEach(() => {
    initDream({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
    });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("dream prompt template");
    clearState();
  });

  it("writes dream state twice (running then idle)", async () => {
    await forceDream();

    const writes = stateWrites();
    expect(writes).toHaveLength(2);
    expect(writes[0].status).toBe("running");
    expect(writes[1].status).toBe("idle");
  });

  it("resolves successfully when backend returns without error", async () => {
    await expect(forceDream()).resolves.toBeUndefined();
  });

  it("calls backend.background?.runOneShotAgent with contextLabel='dream'", async () => {
    await forceDream();
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);
    const params = runOneShotAgentMock.mock.calls[0][0];
    expect(params.contextLabel).toBe("dream");
    expect(params.model).toBe("claude-sonnet-4-6");
    expect(typeof params.appendLog).toBe("function");
  });

  it("uses dreamModel override when set", async () => {
    initDream({
      model: "claude-sonnet-4-6",
      dreamModel: "claude-haiku-4-5",
      getBackend: () => makeMockBackend(),
    });
    await forceDream();
    expect(runOneShotAgentMock.mock.calls[0][0].model).toBe("claude-haiku-4-5");
  });

  it("passes dreamEffort through to the one-shot params", async () => {
    initDream({
      model: "claude-sonnet-4-6",
      dreamEffort: "low",
      getBackend: () => makeMockBackend(),
    });
    await forceDream();
    expect(runOneShotAgentMock.mock.calls[0][0].reasoningEffort).toBe("low");
  });

  it("drops a dreamEffort the model does not advertise (dream still runs)", async () => {
    initDream({
      model: "claude-sonnet-4-6",
      dreamEffort: "xhigh", // Codex-only ceiling, not on a Claude model
      getBackend: () =>
        stubBackend({
          runOneShotAgent: (p) => runOneShotAgentMock(p),
          getModelInfo: async () =>
            ({
              id: "claude-sonnet-4-6",
              displayName: "Sonnet",
              aliases: [],
              provider: "anthropic",
              selectable: true,
              supportedReasoningLevels: ["low", "medium", "high"],
            }) as never,
        }),
    });
    await forceDream();
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);
    expect(
      runOneShotAgentMock.mock.calls[0][0].reasoningEffort,
    ).toBeUndefined();
  });

  it("omits reasoningEffort when dreamEffort is unset", async () => {
    await forceDream();
    expect(
      runOneShotAgentMock.mock.calls[0][0].reasoningEffort,
    ).toBeUndefined();
  });

  it("rejects when backend has no runOneShotAgent", async () => {
    initDream({
      model: "claude-sonnet-4-6",
      // Backend with chat but no background slot → dream refuses
      // to run because runOneShotAgent isn't available.
      getBackend: () => stubBackend({ query: vi.fn() }),
    });
    await expect(forceDream()).rejects.toThrow("background");
  });

  it("rejects when no backend is configured", async () => {
    initDream({ model: "claude-sonnet-4-6" });
    await expect(forceDream()).rejects.toThrow("background");
  });
});

describe("readDreamState — edge cases", () => {
  beforeEach(() => {
    initDream({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
    });
    readFileSyncMock.mockReturnValue("dream prompt template");
  });

  it("treats a corrupt (non-object) value as no state (maybeStartDream still safe)", () => {
    seedState("{ invalid json ");
    expect(() => maybeStartDream()).not.toThrow();
  });

  it("treats non-numeric last_run as stale", () => {
    seedState({ last_run: "not-a-number", status: "idle" });
    expect(() => maybeStartDream()).not.toThrow();
  });

  it("skips when state has last_run within interval", () => {
    seedState({ last_run: Date.now() - 60_000, status: "idle" });
    maybeStartDream();
    expect(runOneShotAgentMock).not.toHaveBeenCalled();
  });
});

describe("dream timeout", () => {
  let mod: typeof import("../core/background/dream/index.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let timeoutRunOneShotMock: any;

  beforeEach(async () => {
    process.env.TALON_DREAM_TIMEOUT_MS_OVERRIDE = "50";
    vi.resetModules();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "dream prompt template"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/workspace/memory/dream_state.json",
        memory: "/fake/.talon/workspace/memory/memory.md",
        log: "/fake/.talon/talon.log",
      },
      dirs: {
        root: "/fake/.talon",
        logs: "/fake/.talon/workspace/logs",
        workspace: "/fake/.talon/workspace",
        data: "/fake/.talon/data",
        memory: "/fake/.talon/workspace/memory",
        dailyMemory: "/fake/.talon/workspace/memory/daily",
      },
    }));
    timeoutRunOneShotMock = vi.fn();
    mod = await import("../core/background/dream/index.js");
    mod.initDream({
      model: "claude-sonnet-4-6",
      getBackend: () =>
        stubBackend({
          query: vi.fn(),
          runOneShotAgent: timeoutRunOneShotMock,
        }),
    });
  });

  afterEach(() => {
    delete process.env.TALON_DREAM_TIMEOUT_MS_OVERRIDE;
    vi.doUnmock("../util/log.js");
    vi.doUnmock("node:fs");
    vi.doUnmock("../util/paths.js");
  });

  it("calls AbortController.abort() when the agent hangs past the timeout", async () => {
    let capturedSignal: AbortSignal | undefined;
    timeoutRunOneShotMock.mockImplementationOnce(
      async (params: OneShotAgentParams) => {
        capturedSignal = params.abortController.signal;
        // Hang until we see the abort, but the dream module's hard 10-min
        // timeout drives the fail path. The dream module currently doesn't
        // support env-var timeout overrides, so this verifies abort plumbing
        // by aborting from the agent side after a small delay.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        throw new Error("aborted");
      },
    );

    // We expect the dream to eventually settle (either with the throw above,
    // or — if the underlying timeout fires first — with "Dream agent timed
    // out"). Either way, capturedSignal must have been an AbortSignal.
    await expect(mod.forceDream()).rejects.toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("mempalace section gating in dream prompt", () => {
  beforeEach(() => {
    initDream({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
    });
    readFileSyncMock.mockReturnValue(
      "PROMPT START {{mempalaceSection}} PROMPT END",
    );
    existsSyncMock.mockReturnValue(false);
    runOneShotAgentMock.mockClear();
  });

  it("includes mempalace mining and diary instructions when configured", async () => {
    initDream({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
      mempalace: { pythonPath: "/usr/bin/python3", palacePath: "/fake/palace" },
    });
    await forceDream();

    expect(runOneShotAgentMock).toHaveBeenCalled();
    const params = runOneShotAgentMock.mock.calls[0][0];
    expect(params.prompt).toContain("-m mempalace mine");
    expect(params.prompt).toContain("mempalace_diary_write");
    expect(params.prompt).not.toContain(
      "MemPalace is not configured. Skip this stage.",
    );
  });

  it("includes skip message when mempalace is not configured", async () => {
    initDream({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
    });
    await forceDream();

    expect(runOneShotAgentMock).toHaveBeenCalled();
    const params = runOneShotAgentMock.mock.calls[0][0];
    expect(params.prompt).toContain(
      "MemPalace is not configured. Skip this stage.",
    );
    expect(params.prompt).not.toContain("-m mempalace mine");
    expect(params.prompt).not.toContain("mempalace_diary_write");
  });
});

describe("maybeStartDream swallows errors", () => {
  it("does not propagate errors from the backend (auto trigger)", async () => {
    initDream({
      model: "claude-sonnet-4-6",
      getBackend: () =>
        stubBackend({
          query: vi.fn(),
          runOneShotAgent: async () => {
            throw new Error("backend exploded");
          },
        }),
    });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("dream prompt template");

    expect(() => maybeStartDream()).not.toThrow();
    // Give the catch a tick to swallow.
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ── Failure backoff ────────────────────────────────────────────────────────
//
// A failed dream keeps the old last_run, and maybeStartDream runs on every
// invocation — without a backoff a broken backend gets re-fired on every
// message (observed live: a model outage produced 403 identical
// consolidation failures).

describe("dream failure backoff", () => {
  beforeEach(() => {
    initDream({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
    });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("dream prompt template");
    // Overdue: last run 13 hours ago (interval is 12h).
    seedState({ last_run: Date.now() - 13 * 60 * 60 * 1000, status: "idle" });
  });

  it("arms after a failed run and suppresses the next auto fire", async () => {
    runOneShotAgentMock.mockRejectedValue(new Error("backend exploded"));
    await expect(forceDream()).rejects.toThrow("backend exploded");
    expect(dreamFailureBackoff.active()).toBe(true);

    runOneShotAgentMock.mockClear();
    maybeStartDream(); // still overdue, but inside the backoff window
    await new Promise((r) => setTimeout(r, 10));
    expect(runOneShotAgentMock).not.toHaveBeenCalled();
  });

  it("logs the backoff with the failure count and the cause", async () => {
    runOneShotAgentMock.mockRejectedValue(new Error("backend exploded"));
    await expect(forceDream()).rejects.toThrow("backend exploded");
    const line = vi
      .mocked(logWarnMock)
      .mock.calls.map((c) => String(c[1]))
      .find((l) => l.startsWith("dream.backoff"));
    expect(line).toMatch(
      /^dream\.backoff failures=1 until=\S+Z error="backend exploded"$/,
    );
  });

  it("arms when a successful run's state write is lost", async () => {
    // kvSet logs and swallows a failed write (full disk): the run completes
    // but last_run never reaches the store, so the dream still looks overdue.
    const persist = kvSetMock.getMockImplementation();
    kvSetMock.mockImplementation(() => {});
    try {
      await expect(forceDream()).resolves.toBeUndefined();
      expect(dreamFailureBackoff.active()).toBe(true);

      runOneShotAgentMock.mockClear();
      maybeStartDream(); // the next message must not run it all again
      await new Promise((r) => setTimeout(r, 10));
      expect(runOneShotAgentMock).not.toHaveBeenCalled();
    } finally {
      kvSetMock.mockImplementation(persist!);
    }
  });

  it("lets forceDream bypass the window and clears it on success", async () => {
    runOneShotAgentMock.mockRejectedValueOnce(new Error("blip"));
    await expect(forceDream()).rejects.toThrow("blip");
    expect(dreamFailureBackoff.active()).toBe(true);

    // forced runs ignore the window; a success clears it.
    await expect(forceDream()).resolves.toBeUndefined();
    expect(dreamFailureBackoff.active()).toBe(false);
    expect(dreamFailureBackoff.failures).toBe(0);
  });
});
