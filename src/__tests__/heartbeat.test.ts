/**
 * Tests for src/core/background/heartbeat.ts
 *
 * Covers: initHeartbeat, startHeartbeatTimer (double-start guard),
 * forceHeartbeat (concurrency guard), state persistence semantics
 * (success vs failure paths), and awaitCurrentRun.
 *
 * The heartbeat module no longer talks to an SDK directly — it routes
 * through `backend.background?.runOneShotAgent`. We supply a fake backend with mockable
 * runOneShotAgent + evictOrphanSubprocesses methods. The SDK-specific
 * subprocess-eviction logic (formerly in heartbeat.ts) lives in
 * src/backend/claude-sdk/one-shot.ts and is covered by its own test file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OneShotAgentParams } from "../core/types.js";
import type { Backend } from "../core/agent-runtime/capabilities.js";
import { stubBackend } from "./helpers/stub-backend.js";

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// Hoisted with the mock factories below: vi.mock is hoisted above every
// import, so a plain `const` here is in its temporal dead zone whenever
// node:fs is first evaluated through a transitive import (util/watchdog)
// rather than this file's own imports.
const {
  existsSyncMock,
  readFileSyncMock,
  mkdirSyncMock,
  appendFileMock,
  mkdirAsyncMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(() => false),
  readFileSyncMock: vi.fn(() => "null"),
  mkdirSyncMock: vi.fn(),
  appendFileMock: vi.fn(async () => {}),
  mkdirAsyncMock: vi.fn(async () => undefined),
}));

// Package-owned system templates (prompts/system/*.md) are real files
// shipped with the code — buildHeartbeatSystemPrompt renders
// heartbeat-agent.md through them. Let those reads hit the real fs;
// everything else (state files, the user's seeded heartbeat.md) stays
// mocked.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    existsSync: existsSyncMock,
    readFileSync: (path: unknown, ...args: unknown[]) =>
      /[/\\]prompts[/\\]system[/\\]/.test(String(path))
        ? (real.readFileSync as (...a: unknown[]) => unknown)(path, ...args)
        : (readFileSyncMock as (...a: unknown[]) => unknown)(path, ...args),
    mkdirSync: mkdirSyncMock,
  };
});

vi.mock("node:fs/promises", () => ({
  appendFile: appendFileMock,
  mkdir: mkdirAsyncMock,
}));

// Heartbeat state now rides the kv store (storage/kv.js) instead of a
// JSON file. Mock the seam with an in-memory map so a test can both
// seed prior state AND observe the running→idle write sequence — the
// real kv keeps only the latest value, so it can't show the pair.
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

const HEARTBEAT_STATE_KEY = "heartbeat.state";
/** Persisted-state payloads written under the heartbeat key, in order. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stateWrites(): any[] {
  return kvSetMock.mock.calls
    .filter((c) => c[0] === HEARTBEAT_STATE_KEY)
    .map((c) => c[1]);
}
/** Seed a prior persisted state verbatim (no normalization). */
function seedState(value: unknown): void {
  kvStore.set(HEARTBEAT_STATE_KEY, value);
}
/** Wipe persisted state and clear the recorded write log. */
function clearState(): void {
  kvStore.delete(HEARTBEAT_STATE_KEY);
  kvSetMock.mockClear();
}

// Fake backend the heartbeat module dispatches to. Tests override
// `runOneShotAgentMock` per-case to simulate clean runs, hangs, errors, etc.
const runOneShotAgentMock = vi.fn<(p: OneShotAgentParams) => Promise<void>>(
  async () => {},
);
const evictOrphanSubprocessesMock = vi.fn(async (_label: string) => ({
  found: 0,
  termed: 0,
  killed: 0,
}));

function makeMockBackend(): Backend {
  return stubBackend({
    query: vi.fn(),
    runOneShotAgent: (p) => runOneShotAgentMock(p),
    evictOrphanSubprocesses: (label: string) =>
      evictOrphanSubprocessesMock(label),
  });
}

// The plan-aware router + the pool handle it borrows a routed backend from.
// These tests assert what the heartbeat ASKS for and that it hands the
// instance back; the ranking itself is backend-router.test.ts's job.
const { chooseBackendMock, resolveRoutedModelMock, acquireMock, releaseMock } =
  vi.hoisted(() => ({
    chooseBackendMock: vi.fn(async (request: { chatBackendId: string }) => ({
      backendId: request.chatBackendId,
      reason: "no candidates",
      routed: false,
    })),
    resolveRoutedModelMock: vi.fn(async () => "routed-model"),
    acquireMock: vi.fn(),
    releaseMock: vi.fn(async () => {}),
  }));

vi.mock("../core/engine/backend-router/index.js", () => ({
  chooseBackend: chooseBackendMock,
  resolveRoutedModel: resolveRoutedModelMock,
  recordBackendRunUsage: vi.fn(),
  recordBackendRunFailure: vi.fn(),
  recordBackendRunSuccess: vi.fn(),
}));

vi.mock(
  "../core/engine/backend-controller/index.js",
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import("../core/engine/backend-controller/index.js")
      >();
    return { ...real, acquireBackendInstance: acquireMock };
  },
);

vi.mock("../util/paths.js", () => ({
  files: {
    heartbeatState: "/fake/.talon/workspace/memory/heartbeat_state.json",
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
    prompts: "/fake/.talon/prompts",
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────────

const {
  initHeartbeat,
  startHeartbeatTimer,
  stopHeartbeatTimer,
  forceHeartbeat,
  getHeartbeatStatus,
  awaitCurrentRun,
  buildHeartbeatSystemPrompt,
} = await import("../core/background/heartbeat/index.js");

describe("initHeartbeat", () => {
  it("accepts a config object without throwing", () => {
    expect(() => initHeartbeat({ model: "claude-sonnet-4-6" })).not.toThrow();
  });

  it("accepts all optional config fields", () => {
    expect(() =>
      initHeartbeat({
        model: "claude-sonnet-4-6",
        heartbeatModel: "claude-haiku-4-5",
        heartbeatEffort: "high",
        workspace: "/tmp/test-workspace",
        getBackend: () => makeMockBackend(),
        frontends: ["telegram"],
      }),
    ).not.toThrow();
  });
});

describe("startHeartbeatTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initHeartbeat({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
    });
  });

  afterEach(() => {
    stopHeartbeatTimer();
    vi.useRealTimers();
  });

  it("guards against double-start during startup delay", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    startHeartbeatTimer(60);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    // Calling again during the 5-minute startup delay should be a no-op
    startHeartbeatTimer(60);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it("guards against double-start after interval is set", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    startHeartbeatTimer(60);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    // Advance past startup delay to create the interval timer
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    // Now try to start again — should be a no-op (interval count stays at 1)
    startHeartbeatTimer(60);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
  });
});

describe("startHeartbeatTimer — due-driven cadence (Gleam scheduler core)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initHeartbeat({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
    });
    readFileSyncMock.mockReset();
    runOneShotAgentMock.mockReset();
    runOneShotAgentMock.mockImplementation(async () => {});
    clearState();
  });

  afterEach(() => {
    stopHeartbeatTimer();
    vi.useRealTimers();
  });

  /** Persisted state whose last_run is always `agoMs` before "now". */
  function mockState(agoMs: number): void {
    seedState({
      last_run: Date.now() - agoMs,
      status: "idle",
      run_count: 3,
    });
    existsSyncMock.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSyncMock.mockImplementation(((filePath: string) => {
      const p = String(filePath).replace(/\\/g, "/");
      if (p.endsWith("/heartbeat.md")) return "heartbeat prompt";
      return "null";
    }) as any);
  }

  it("skips the startup run when the persisted cadence is not yet due", async () => {
    mockState(10 * 60 * 1000); // ran 10min ago, interval 60min
    startHeartbeatTimer(60);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100); // startup delay
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000); // a few due checks
    expect(runOneShotAgentMock).not.toHaveBeenCalled();
  });

  it("collapses several missed fire times into one catch-up run", async () => {
    mockState(3 * 60 * 60 * 1000); // 3 missed hourly fires (downtime/suspend)
    startHeartbeatTimer(60);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);
  });

  it("fires after the startup delay on a fresh install (no state)", async () => {
    existsSyncMock.mockReturnValue(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSyncMock.mockImplementation(((filePath: string) => {
      const p = String(filePath).replace(/\\/g, "/");
      if (p.endsWith("/heartbeat.md")) return "heartbeat prompt";
      return "null";
    }) as any);
    startHeartbeatTimer(60);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);
  });
});

describe("forceHeartbeat", () => {
  beforeEach(() => {
    initHeartbeat({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
    });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSyncMock.mockImplementation(((filePath: string) => {
      const p = String(filePath).replace(/\\/g, "/");
      if (p.endsWith("/heartbeat.md"))
        return "heartbeat prompt {{workspace}} {{logsDir}} {{lastRunIso}} {{memoryFile}} {{instructionsFile}} {{runCount}} {{intervalMinutes}}";
      return "null";
    }) as any);
    clearState();
    runOneShotAgentMock.mockReset();
    runOneShotAgentMock.mockImplementation(async () => {});
    evictOrphanSubprocessesMock.mockClear();
  });

  it("writes heartbeat state twice (running then idle) on success", async () => {
    await forceHeartbeat();

    const writes = stateWrites();
    expect(writes).toHaveLength(2);
    expect(writes[0].status).toBe("running");
    expect(writes[1].status).toBe("idle");
  });

  it("increments run_count only on success", async () => {
    await forceHeartbeat();

    const writes = stateWrites();
    const finalState = writes[writes.length - 1];
    expect(finalState.run_count).toBe(1);
    expect(finalState.status).toBe("idle");
  });

  it("calls backend.background?.runOneShotAgent with contextLabel='heartbeat'", async () => {
    await forceHeartbeat();

    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);
    const params = runOneShotAgentMock.mock.calls[0][0];
    expect(params.contextLabel).toBe("heartbeat");
    expect(params.model).toBe("claude-sonnet-4-6");
    expect(typeof params.appendLog).toBe("function");
    // No heartbeatEffort configured → the model keeps its own default.
    expect(params.reasoningEffort).toBeUndefined();
  });

  it("passes heartbeatEffort through when the model advertises it", async () => {
    initHeartbeat({
      model: "claude-sonnet-4-6",
      heartbeatEffort: "high",
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

    await forceHeartbeat();
    expect(runOneShotAgentMock.mock.calls[0][0].reasoningEffort).toBe("high");
  });

  it("drops heartbeatEffort the model does not advertise (run still happens)", async () => {
    initHeartbeat({
      model: "claude-sonnet-4-6",
      heartbeatEffort: "xhigh", // Codex-only ceiling
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

    await forceHeartbeat();
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);
    expect(
      runOneShotAgentMock.mock.calls[0][0].reasoningEffort,
    ).toBeUndefined();
  });

  it("preserves previous last_run on failure", async () => {
    const previousLastRun = Date.now() - 3600_000;
    seedState({ last_run: previousLastRun, status: "idle", run_count: 5 });

    // Make backend throw
    runOneShotAgentMock.mockImplementationOnce(async () => {
      throw new Error("Agent exploded");
    });

    await expect(forceHeartbeat()).rejects.toThrow("Agent exploded");

    // The last write should preserve previous last_run and run_count
    const writes = stateWrites();
    const finalState = writes[writes.length - 1];
    expect(finalState.last_run).toBe(previousLastRun);
    expect(finalState.run_count).toBe(5);
    expect(finalState.status).toBe("idle");
  });

  it("sets last_started even on failure", async () => {
    runOneShotAgentMock.mockImplementationOnce(async () => {
      throw new Error("Boom");
    });

    await expect(forceHeartbeat()).rejects.toThrow("Boom");

    const writes = stateWrites();
    const finalState = writes[writes.length - 1];
    expect(finalState.last_started).toBeGreaterThan(0);
  });

  it("rejects concurrent runs (concurrency guard)", async () => {
    const firstRun = forceHeartbeat().catch(() => {});

    // The running flag should now be true
    await expect(forceHeartbeat()).rejects.toThrow("Heartbeat already running");
    await firstRun;
  });

  it("resolves successfully when backend returns without error", async () => {
    await expect(forceHeartbeat()).resolves.toBeUndefined();
  });

  it("passes an AbortController to backend.background?.runOneShotAgent", async () => {
    await forceHeartbeat();

    const params = runOneShotAgentMock.mock.calls[0][0];
    const ac = params.abortController;
    expect(ac).toBeInstanceOf(AbortController);
    expect(ac.signal.aborted).toBe(false);
  });
});

describe("getHeartbeatStatus", () => {
  beforeEach(() => {
    clearState();
  });

  it("returns null when no state is persisted", () => {
    expect(getHeartbeatStatus()).toBeNull();
  });

  it("returns parsed state when present", () => {
    seedState({ last_run: Date.now(), status: "idle", run_count: 3 });
    const result = getHeartbeatStatus();
    expect(result?.run_count).toBe(3);
    expect(result?.status).toBe("idle");
  });

  it("returns null for a corrupt (non-object) value", () => {
    seedState("{ invalid json ");
    expect(getHeartbeatStatus()).toBeNull();
  });

  it("returns null when last_run is not a number", () => {
    seedState({ last_run: "not-a-number", status: "idle", run_count: 0 });
    expect(getHeartbeatStatus()).toBeNull();
  });

  it("returns null when run_count is not a number", () => {
    seedState({ last_run: Date.now(), status: "idle", run_count: "five" });
    expect(getHeartbeatStatus()).toBeNull();
  });

  it("returns null when status is invalid", () => {
    seedState({ last_run: Date.now(), status: "broken", run_count: 1 });
    expect(getHeartbeatStatus()).toBeNull();
  });

  it("returns null when last_run is non-finite", () => {
    // Infinity is typeof number but not finite — normalize must reject it.
    seedState({ last_run: Infinity, status: "idle", run_count: 0 });
    expect(getHeartbeatStatus()).toBeNull();
  });
});

describe("buildHeartbeatSystemPrompt", () => {
  // Frontend list now comes from initHeartbeat config (passed from bootstrap)
  // instead of being read from the claude-sdk module — heartbeat is
  // backend-agnostic.

  it("returns base prompt without outbound section when no frontends are configured", () => {
    initHeartbeat({ model: "claude-sonnet-4-6", frontends: [] });
    const prompt = buildHeartbeatSystemPrompt();
    expect(prompt).toContain("background heartbeat agent");
    expect(prompt).not.toContain("OUTBOUND MESSAGING");
    expect(prompt).not.toContain("telegram-tools");
  });

  it("returns base prompt without outbound section when frontends omitted", () => {
    initHeartbeat({ model: "claude-sonnet-4-6" });
    const prompt = buildHeartbeatSystemPrompt();
    expect(prompt).toContain("background heartbeat agent");
    expect(prompt).not.toContain("OUTBOUND MESSAGING");
  });

  it("references telegram-tools when telegram is the only frontend", () => {
    initHeartbeat({ model: "claude-sonnet-4-6", frontends: ["telegram"] });
    const prompt = buildHeartbeatSystemPrompt();
    expect(prompt).toContain("OUTBOUND MESSAGING");
    expect(prompt).toContain("`telegram-tools`");
    expect(prompt).not.toContain("`teams-tools`");
  });

  it("references teams-tools when teams is the only frontend", () => {
    initHeartbeat({ model: "claude-sonnet-4-6", frontends: ["teams"] });
    const prompt = buildHeartbeatSystemPrompt();
    expect(prompt).toContain("OUTBOUND MESSAGING");
    expect(prompt).toContain("`teams-tools`");
    expect(prompt).not.toContain("`telegram-tools`");
  });

  it("lists ALL active frontends when multiple are configured", () => {
    initHeartbeat({
      model: "claude-sonnet-4-6",
      frontends: ["telegram", "teams"],
    });
    const prompt = buildHeartbeatSystemPrompt();
    expect(prompt).toContain("OUTBOUND MESSAGING");
    expect(prompt).toContain("`telegram-tools`");
    expect(prompt).toContain("`teams-tools`");
  });

  it("uses the first frontend in the example send() call", () => {
    initHeartbeat({
      model: "claude-sonnet-4-6",
      frontends: ["teams", "telegram"],
    });
    const prompt = buildHeartbeatSystemPrompt();
    expect(prompt).toMatch(/from `teams-tools`/);
  });

  it("does not mention chat-id parameter when there are no frontends", () => {
    initHeartbeat({ model: "claude-sonnet-4-6", frontends: [] });
    const prompt = buildHeartbeatSystemPrompt();
    expect(prompt).not.toContain("chat_id");
  });

  it("teaches the cross-frontend send_via tool in the outbound block", () => {
    initHeartbeat({ model: "claude-sonnet-4-6", frontends: ["telegram"] });
    const prompt = buildHeartbeatSystemPrompt();
    expect(prompt).toContain("send_via(frontend=");
    // The target forms are the point: WhatsApp is reachable by phone number
    // even when only telegram-tools is mounted.
    expect(prompt).toContain("WhatsApp");
    expect(prompt).toContain("phone number");
  });
});

describe("awaitCurrentRun", () => {
  beforeEach(() => {
    initHeartbeat({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
    });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSyncMock.mockImplementation(((filePath: string) => {
      const p = String(filePath).replace(/\\/g, "/");
      if (p.endsWith("/heartbeat.md"))
        return "heartbeat prompt {{workspace}} {{logsDir}} {{lastRunIso}} {{memoryFile}} {{instructionsFile}} {{runCount}} {{intervalMinutes}}";
      return "null";
    }) as any);
    clearState();
    runOneShotAgentMock.mockReset();
    runOneShotAgentMock.mockImplementation(async () => {});
  });

  it("resolves immediately when no run is in progress", async () => {
    await expect(awaitCurrentRun()).resolves.toBeUndefined();
  });

  it("waits for in-flight run to complete", async () => {
    let resolveAgent!: () => void;
    const agentPromise = new Promise<void>((r) => {
      resolveAgent = r;
    });

    runOneShotAgentMock.mockImplementationOnce(async () => {
      await agentPromise;
    });

    const runPromise = forceHeartbeat().catch(() => {});

    // awaitCurrentRun should not resolve until the agent finishes
    let awaited = false;
    const awaitPromise = awaitCurrentRun().then(() => {
      awaited = true;
    });

    // Give microtasks a chance to run
    await new Promise((r) => setTimeout(r, 10));
    expect(awaited).toBe(false);

    // Now resolve the agent
    resolveAgent();
    await awaitPromise;
    await runPromise;
    expect(awaited).toBe(true);
  });
});

// ── Eviction tests ────────────────────────────────────────────────────────
//
// These cover the fix for the wedged-heartbeat bug: when the backend hangs
// and ignores AbortController.abort(), the heartbeat must still release its
// lock so the next interval can fire (prior behaviour: deadlocked for 17+
// hours on 2026-05-10).
//
// The /proc-walking subprocess sweep itself lives in
// src/backend/claude-sdk/one-shot.ts (it's Claude-SDK-specific) and has its
// own test file. Here we only verify the heartbeat module's coordination:
// abort on timeout, release the lock on grace exit, delegate orphan cleanup
// to the backend.

describe("heartbeat eviction (timeout + abort + delegation)", () => {
  // Uses the file-level hoisted mocks and the top-level module import,
  // exactly like every other suite in this file. The suite previously
  // re-mocked node:fs / paths / write-file-atomic via vi.resetModules()
  // + vi.doMock() and a fresh dynamic import — needed only because the
  // heartbeat timeout env vars were read at module load. That pattern
  // raced vitest's module registry (the fresh import intermittently saw
  // the REAL fs or a stale mock instance) and made this suite flaky.
  // heartbeat.ts now reads TALON_HEARTBEAT_TIMEOUT_MS / _ABORT_GRACE_MS
  // per run, so no re-import is needed.
  const evictionRunOneShotMock = runOneShotAgentMock;
  const evictionEvictMock = evictOrphanSubprocessesMock;
  const evictionMod = { forceHeartbeat, initHeartbeat };

  beforeEach(() => {
    process.env.TALON_HEARTBEAT_TIMEOUT_MS = "50";
    process.env.TALON_HEARTBEAT_ABORT_GRACE_MS = "50";

    existsSyncMock.mockImplementation(() => false);
    readFileSyncMock.mockImplementation(((filePath: string) => {
      const p = String(filePath).replace(/\\/g, "/");
      if (p.endsWith("/heartbeat.md"))
        return "heartbeat prompt {{workspace}} {{logsDir}} {{lastRunIso}} {{memoryFile}} {{instructionsFile}} {{runCount}} {{intervalMinutes}}";
      return "null";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    clearState();
    evictionRunOneShotMock.mockReset();
    evictionEvictMock.mockReset();
    evictionEvictMock.mockImplementation(async () => ({
      found: 0,
      termed: 0,
      killed: 0,
    }));
    evictionMod.initHeartbeat({
      model: "claude-sonnet-4-6",
      getBackend: () =>
        stubBackend({
          query: vi.fn(),
          runOneShotAgent: evictionRunOneShotMock,
          evictOrphanSubprocesses: evictionEvictMock,
        }),
    });
  });

  afterEach(() => {
    delete process.env.TALON_HEARTBEAT_TIMEOUT_MS;
    delete process.env.TALON_HEARTBEAT_ABORT_GRACE_MS;
  });

  it("calls AbortController.abort() when the agent hangs past the timeout", async () => {
    let capturedSignal: AbortSignal | undefined;
    evictionRunOneShotMock.mockImplementationOnce(
      async (params: OneShotAgentParams) => {
        capturedSignal = params.abortController.signal;
        // Hang until aborted, then throw.
        await new Promise<void>((resolve) => {
          capturedSignal!.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("aborted");
      },
    );

    await expect(evictionMod.forceHeartbeat()).rejects.toThrow(
      "Heartbeat agent timed out",
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("releases the running lock even when the backend ignores abort", async () => {
    // Pathological backend: never settles even after abort is signalled.
    // This is the exact prod failure mode from 2026-05-10.
    evictionRunOneShotMock.mockImplementationOnce(
      () =>
        new Promise<void>(() => {
          /* unresolved */
        }),
    );

    await expect(evictionMod.forceHeartbeat()).rejects.toThrow(
      "Heartbeat agent timed out",
    );

    // The critical property: a second heartbeat must NOT be rejected with
    // "Heartbeat already running" — the lock must have been released.
    evictionRunOneShotMock.mockImplementationOnce(async () => {});
    await expect(evictionMod.forceHeartbeat()).resolves.toBeUndefined();
  }, 5000);

  it("delegates orphan cleanup to backend.evictOrphanSubprocesses on grace exit", async () => {
    evictionRunOneShotMock.mockImplementationOnce(
      () =>
        new Promise<void>(() => {
          /* never settles */
        }),
    );

    await expect(evictionMod.forceHeartbeat()).rejects.toThrow(
      "Heartbeat agent timed out",
    );

    // Give the fire-and-forget eviction a tick to run.
    await new Promise((r) => setTimeout(r, 30));

    expect(evictionEvictMock).toHaveBeenCalledWith("heartbeat");
  });

  it("does not crash when backend has no evictOrphanSubprocesses", async () => {
    // Re-init with a backend that doesn't implement eviction (e.g. Kilo).
    evictionMod.initHeartbeat({
      model: "claude-sonnet-4-6",
      getBackend: () =>
        stubBackend({
          query: vi.fn(),
          runOneShotAgent: () =>
            new Promise<void>(() => {
              /* never settles */
            }),
        }),
    });

    await expect(evictionMod.forceHeartbeat()).rejects.toThrow(
      "Heartbeat agent timed out",
    );
    // Lock should still be released — verify by running another heartbeat.
    evictionMod.initHeartbeat({
      model: "claude-sonnet-4-6",
      getBackend: () =>
        stubBackend({
          query: vi.fn(),
          runOneShotAgent: async () => {},
        }),
    });
    await expect(evictionMod.forceHeartbeat()).resolves.toBeUndefined();
  }, 5000);

  it("advances last_run and run_count on timeout so next heartbeat sees a fresh window", async () => {
    // Prior behaviour: a timed-out heartbeat preserved last_run and run_count,
    // so every retry re-triggered against the same window — the agent kept
    // making the same decision (e.g. diving into the same investigation) and
    // timing out again. Bumping state on timeout means the next heartbeat sees
    // a fresh `lastRunIso` and an incremented run number.
    evictionRunOneShotMock.mockImplementationOnce(
      () =>
        new Promise<void>(() => {
          /* never settles */
        }),
    );

    const before = Date.now();
    await expect(evictionMod.forceHeartbeat()).rejects.toThrow(
      "Heartbeat agent timed out",
    );

    // Find the final state write (status: "idle" — the one written in the
    // catch path; the initial "running" write happens before the timeout).
    const idleWrites = stateWrites().filter(
      (s: { status: string }) => s.status === "idle",
    );
    expect(idleWrites.length).toBeGreaterThan(0);
    const finalState = idleWrites[idleWrites.length - 1];

    expect(finalState.run_count).toBe(1); // bumped from 0
    expect(finalState.last_run).toBeGreaterThanOrEqual(before);
    expect(finalState.status).toBe("idle");
  }, 5000);
});

// ── Failure backoff ────────────────────────────────────────────────────────
//
// A failed run does not advance last_run, so the every-minute due check used
// to re-fire the same failing heartbeat 60×/hour (observed live: a
// session-limit night logged hundreds of identical failures a minute apart).

// Pure-helper coverage (parseSessionLimitResetMs, failureBackoffUntil,
// FailureBackoff) lives in failure-backoff.test.ts — the module is shared
// with dream. Here: the heartbeat scheduler's behavioral integration.

const { hb } = await import("../core/background/heartbeat/state.js");

describe("heartbeat failure backoff (behavioral)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initHeartbeat({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
    });
    readFileSyncMock.mockReset();
    runOneShotAgentMock.mockReset();
    clearState();
    hb.failureBackoff.succeed();
  });

  afterEach(() => {
    stopHeartbeatTimer();
    hb.failureBackoff.succeed();
    vi.useRealTimers();
  });

  function mockOverdueState(): void {
    seedState({
      last_run: Date.now() - 2 * 60 * 60 * 1000, // 2h ago, interval 60min
      status: "idle",
      run_count: 3,
    });
    existsSyncMock.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSyncMock.mockImplementation(((filePath: string) => {
      const p = String(filePath).replace(/\\/g, "/");
      if (p.endsWith("/heartbeat.md")) return "heartbeat prompt";
      return "null";
    }) as any);
  }

  it("stops re-firing every due check after a failure, then retries after the backoff", async () => {
    mockOverdueState();
    runOneShotAgentMock.mockRejectedValue(new Error("backend exploded"));

    startHeartbeatTimer(60);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100); // startup delay
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);

    // The old behaviour retried on EVERY minute due check (4 more calls here).
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);

    // First failure backs off 5min — the next due check after it retries.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(2);

    // Second failure doubles the window (10min): still quiet 8 minutes in.
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(2);
  });

  it("waits out a session-limit error until its stated reset time", async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 0, 0));
    mockOverdueState();
    runOneShotAgentMock.mockRejectedValue(
      new Error(
        "Claude Code returned an error result: You've hit your session limit · resets 12:30am (UTC)",
      ),
    );

    startHeartbeatTimer(60);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100); // fails at ~00:05
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);

    // Backed off until 00:32 (reset + buffer): quiet for the next 25 minutes…
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000); // ~00:30
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);

    // …and retries once the stated reset has passed.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000); // ~00:33
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(2);
  });

  it("does not re-run every due check when a successful run's state write is lost", async () => {
    mockOverdueState();
    runOneShotAgentMock.mockResolvedValue(undefined);
    // kvSet logs and swallows a failed write (full disk): the run completes
    // but last_run never reaches the store.
    const persist = kvSetMock.getMockImplementation();
    kvSetMock.mockImplementation(() => {});
    try {
      startHeartbeatTimer(60);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100); // startup delay
      expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);

      // The old behaviour re-ran the whole agent on every minute due check.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);
    } finally {
      kvSetMock.mockImplementation(persist!);
    }
  });

  it("clears the backoff after a successful run", async () => {
    mockOverdueState();
    runOneShotAgentMock.mockRejectedValueOnce(new Error("blip"));
    runOneShotAgentMock.mockResolvedValue(undefined);

    startHeartbeatTimer(60);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100); // fail #1
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000); // retry succeeds
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(2);
    expect(hb.failureBackoff.failures).toBe(0);
    expect(hb.failureBackoff.active()).toBe(false);
  });
});

// ── plan-aware routing ──────────────────────────────────────────────────────

describe("heartbeat backend routing", () => {
  /** A second backend the router can send the run to. */
  const routedRun = vi.fn(
    async (_params: OneShotAgentParams): Promise<void> => {},
  );

  beforeEach(() => {
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(((filePath: string) =>
      String(filePath).replace(/\\/g, "/").endsWith("/heartbeat.md")
        ? "heartbeat prompt"
        : "null") as never);
    clearState();
    runOneShotAgentMock.mockReset();
    runOneShotAgentMock.mockImplementation(async () => {});
    routedRun.mockClear();
    chooseBackendMock.mockClear();
    resolveRoutedModelMock.mockClear();
    resolveRoutedModelMock.mockResolvedValue("routed-model");
    releaseMock.mockClear();
    acquireMock.mockReset();
    acquireMock.mockResolvedValue({
      backend: stubBackend({ runOneShotAgent: routedRun }),
      release: releaseMock,
    });
  });

  it("routes an unpinned heartbeat and releases the borrowed instance", async () => {
    initHeartbeat({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
      getBackendId: () => "claude",
    });
    chooseBackendMock.mockResolvedValue({
      backendId: "agy",
      reason: "most headroom 92%",
      routed: true,
    });

    await forceHeartbeat();

    expect(chooseBackendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "heartbeat",
        chatBackendId: "claude",
      }),
    );
    expect(routedRun).toHaveBeenCalledTimes(1);
    expect(runOneShotAgentMock).not.toHaveBeenCalled();
    // The routed run takes the target backend's own default model.
    expect(routedRun.mock.calls[0]?.[0]?.model).toBe("routed-model");
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("passes heartbeatBackend and heartbeatModel through as pins", async () => {
    initHeartbeat({
      model: "claude-sonnet-4-6",
      heartbeatModel: "claude-haiku-4-5",
      getBackend: () => makeMockBackend(),
      getBackendId: () => "claude",
      pinnedBackendId: "codex",
    });
    chooseBackendMock.mockResolvedValue({
      backendId: "codex",
      reason: "pinned",
      routed: false,
    });

    await forceHeartbeat();

    expect(chooseBackendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBackendId: "codex",
        requestedModel: "claude-haiku-4-5",
      }),
    );
    // Not routed → the role backend runs it, exactly as before.
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);
    expect(acquireMock).not.toHaveBeenCalled();
  });

  it("stays on the role backend when the routed one names no model", async () => {
    initHeartbeat({
      model: "claude-sonnet-4-6",
      getBackend: () => makeMockBackend(),
      getBackendId: () => "claude",
    });
    chooseBackendMock.mockResolvedValue({
      backendId: "agy",
      reason: "most headroom 92%",
      routed: true,
    });
    resolveRoutedModelMock.mockResolvedValue(null as never);

    await forceHeartbeat();

    expect(acquireMock).not.toHaveBeenCalled();
    expect(runOneShotAgentMock).toHaveBeenCalledTimes(1);
  });
});
