/**
 * Sub-agents across a restart — `suspendAgents` on the way out,
 * `resumeSuspendedAgents` on the way in.
 *
 * Both halves run in one process here: the registry is reset between them
 * (what a new daemon starts with) while the SQLite rows carry over, which is
 * exactly the hand-over a /restart or /update performs. Same backend harness
 * as agents-runner.test.ts — a fake background runner in the real pool.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Backend,
  BackgroundRunner,
  ModelCatalog,
} from "../core/agent-runtime/capabilities.js";
import { composeBackend } from "../core/agent-runtime/capabilities.js";
import {
  clearBackends,
  registerBackend,
} from "../core/agent-runtime/backend-registry.js";
import type {
  ExecuteParams,
  ExecuteResult,
  OneShotAgentParams,
} from "../core/types.js";
import type { TalonConfig } from "../core/config/index.js";
import {
  cleanupBackendPool,
  initBackendPool,
  resetBackendPoolForTest,
} from "../core/engine/backend-controller/index.js";
import {
  agentRegistry,
  deliverToAgent,
  initAgents,
  killAgent,
  resumeSuspendedAgents,
  spawnAgent,
  suspendAgents,
  type AgentParent,
} from "../core/agents/index.js";
import {
  MAX_RESUMES,
  RESUME_MIN_TIMEOUT_MS,
  RESUME_WINDOW_MS,
} from "../core/agents/runner.js";
import {
  claimSuspendedAgents,
  saveSuspendedAgents,
  type SuspendedAgent,
} from "../storage/suspended-agents.js";

vi.mock("../core/engine/backend-router/index.js", () => ({
  chooseBackend: vi.fn(),
  recordBackendRunUsage: vi.fn(),
  recordBackendRunFailure: vi.fn(),
  recordBackendRunSuccess: vi.fn(),
  taskClassForEffort: () => undefined,
}));

const CHAT: AgentParent = { kind: "chat", chatId: "42", numericChatId: 42 };
const STUB_CONFIG = { backend: "claude" } as unknown as TalonConfig;
const STUB_CTX = { getBridgePort: () => 0, frontendName: "terminal" as const };

type OneShot = BackgroundRunner["runOneShotAgent"];

function catalog(known = "sonnet"): ModelCatalog {
  return {
    resolveModelInfo: async (query: string) =>
      query === known
        ? {
            kind: "exact" as const,
            storedValue: known,
            model: { id: known, name: known } as never,
          }
        : { kind: "missing" as const },
    getDefaultModelId: () => known,
    getRawModelInfo: async () => undefined,
  };
}

async function withBackend(run: OneShot): Promise<void> {
  const backend: Backend = composeBackend({
    id: "codex",
    label: "codex",
    background: { runOneShotAgent: run },
    models: catalog(),
  });
  registerBackend({
    id: "claude",
    label: "claude",
    async init() {
      return { backend: composeBackend({ id: "claude", label: "claude" }) };
    },
  });
  registerBackend({
    id: "codex",
    label: "codex",
    async init() {
      return { backend };
    },
  });
  await initBackendPool(STUB_CONFIG, STUB_CTX);
}

/** A run that works until it is aborted — a long agent mid-flight. */
const untilAborted: OneShot = (params) =>
  new Promise<void>((_resolve, reject) => {
    const stop = (): void => reject(new Error("aborted"));
    if (params.abortController.signal.aborted) stop();
    params.abortController.signal.addEventListener("abort", stop);
  });

const execute = vi.fn(
  async (_params: ExecuteParams): Promise<ExecuteResult> => ({
    text: "",
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    bridgeMessageCount: 0,
  }),
);

async function spawnRunning(overrides: Record<string, unknown> = {}) {
  const outcome = await spawnAgent({
    brief: "refactor the widget",
    label: "widget",
    parent: CHAT,
    backendId: "codex",
    timeoutMs: 10 * 60_000,
    ...overrides,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  await vi.waitFor(() =>
    expect(agentRegistry.get(outcome.agentId)?.state).toBe("running"),
  );
  return outcome.agentId;
}

/** What a fresh daemon starts with: an empty registry, the same database. */
async function successor(run: OneShot, caps?: { maxConcurrent: number }) {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
  agentRegistry.resetForTest();
  execute.mockClear();
  initAgents({ execute, ...(caps ? { caps } : {}) });
  await withBackend(run);
}

function suspendedRow(overrides: Partial<SuspendedAgent> = {}): SuspendedAgent {
  return {
    id: "agt_row",
    label: "row",
    brief: "do the thing",
    parent: CHAT,
    backendId: "codex",
    model: "sonnet",
    timeoutMs: 10 * 60_000,
    elapsedMs: 60_000,
    preflight: false,
    depth: 0,
    suspendedAt: Date.now(),
    resumes: 0,
    inbox: [],
    ...overrides,
  };
}

beforeEach(async () => {
  claimSuspendedAgents(); // the worker's database outlives each test
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
  agentRegistry.resetForTest();
  execute.mockClear();
  initAgents({ execute });
});

afterEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
  agentRegistry.resetForTest();
  claimSuspendedAgents();
});

describe("suspendAgents", () => {
  it("persists running agents, aborts them silently, and refuses new spawns", async () => {
    await withBackend(untilAborted);
    const id = await spawnRunning();
    expect(deliverToAgent("42", id, "also fix the tests")).toBe(true);

    expect(suspendAgents()).toBe(1);
    const record = await agentRegistry.waitForSettle(id, 8_000);
    expect(record?.state).toBe("killed");
    // Handed to the successor: the parent is not woken with a kill report.
    await new Promise((r) => setTimeout(r, 20));
    expect(execute).not.toHaveBeenCalled();

    const refused = await spawnAgent({
      brief: "x",
      label: "late",
      parent: CHAT,
      backendId: "codex",
    });
    expect(refused).toMatchObject({ ok: false });

    const [row, ...rest] = claimSuspendedAgents();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      id,
      label: "widget",
      brief: "refactor the widget",
      parent: CHAT,
      backendId: "codex",
      model: "sonnet",
      timeoutMs: 10 * 60_000,
      resumes: 0,
      inbox: [expect.objectContaining({ text: "also fix the tests" })],
    });
  });

  it("does not persist an agent someone already asked to kill", async () => {
    await withBackend(untilAborted);
    const id = await spawnRunning();
    expect(killAgent(id)).toBe(true);
    expect(suspendAgents()).toBe(0);
    expect(claimSuspendedAgents()).toEqual([]);
  });
});

describe("resumeSuspendedAgents", () => {
  it("relaunches under the same id with the resume note and restored inbox", async () => {
    await withBackend(untilAborted);
    const id = await spawnRunning();
    deliverToAgent("42", id, "also fix the tests");
    suspendAgents();
    await agentRegistry.waitForSettle(id, 8_000);

    const prompts: OneShotAgentParams[] = [];
    await successor(async (params) => {
      prompts.push(params);
      return undefined;
    });
    expect(await resumeSuspendedAgents()).toBe(1);
    expect(agentRegistry.get(id)).not.toBeNull();
    expect(agentRegistry.drain(id)).toEqual([
      expect.objectContaining({ text: "also fix the tests" }),
    ]);

    const record = await agentRegistry.waitForSettle(id, 8_000);
    expect(record?.state).toBe("failed"); // this fake run says nothing
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.prompt).toContain("RESUMED AFTER RESTART");
    expect(prompts[0]?.prompt).toContain(`${id}.md`);
    expect(prompts[0]?.prompt).toContain("refactor the widget");
    // Its parent hears about it from the new daemon, under the old id.
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0]?.[0].prompt).toContain(id);

    // Claimed once: a second boot finds nothing to resume.
    expect(await resumeSuspendedAgents()).toBe(0);
  });

  it("carries the resume count and remaining budget into the next suspension", async () => {
    const now = Date.now();
    saveSuspendedAgents([
      suspendedRow({
        timeoutMs: 10 * 60_000,
        elapsedMs: 9.9 * 60_000,
        resumes: 1,
      }),
    ]);
    await successor(untilAborted);
    expect(await resumeSuspendedAgents(now)).toBe(1);
    await vi.waitFor(() =>
      expect(agentRegistry.get("agt_row")?.state).toBe("running"),
    );
    suspendAgents();
    await agentRegistry.waitForSettle("agt_row", 8_000);
    const [row] = claimSuspendedAgents();
    // Nearly out of time, so it got the floor — and that is its cap now.
    expect(row).toMatchObject({ resumes: 2, timeoutMs: RESUME_MIN_TIMEOUT_MS });
  });

  it("resumes parents before children, re-linking the tree", async () => {
    saveSuspendedAgents([
      suspendedRow({
        id: "agt_child",
        depth: 1,
        parent: { kind: "agent", agentId: "agt_parent" },
      }),
      suspendedRow({ id: "agt_parent" }),
    ]);
    const prompts = new Map<string, string>();
    await successor((params) => {
      prompts.set(params.contextLabel ?? "", params.prompt);
      return untilAborted(params);
    });
    expect(await resumeSuspendedAgents()).toBe(2);
    expect(agentRegistry.get("agt_parent")?.children).toEqual(["agt_child"]);
    await vi.waitFor(() => expect(prompts.size).toBe(2));
    expect(prompts.get("agent:agt_parent")).toContain("agt_child");
    suspendAgents();
  });

  it("gives up — killed, parent told — past the resume cap or window", async () => {
    const now = Date.now();
    saveSuspendedAgents([
      suspendedRow({ id: "agt_loop", resumes: MAX_RESUMES }),
      suspendedRow({
        id: "agt_stale",
        suspendedAt: now - RESUME_WINDOW_MS - 1,
      }),
    ]);
    const run = vi.fn<OneShot>(async () => {});
    await successor(run);
    expect(await resumeSuspendedAgents(now)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(agentRegistry.get("agt_loop")?.state).toBe("killed");
    expect(agentRegistry.get("agt_stale")?.error).toMatch(/down for/);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("respects the concurrency cap", async () => {
    saveSuspendedAgents([
      suspendedRow({ id: "agt_a" }),
      suspendedRow({ id: "agt_b" }),
    ]);
    await successor(untilAborted, { maxConcurrent: 1 });
    expect(await resumeSuspendedAgents()).toBe(1);
    expect(agentRegistry.isLive("agt_a")).toBe(true);
    expect(agentRegistry.get("agt_b")).toMatchObject({
      state: "killed",
      error: expect.stringMatching(/concurrency cap/),
    });
    suspendAgents();
  });
});
