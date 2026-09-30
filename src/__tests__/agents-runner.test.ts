/**
 * The sub-agent runner — backend/model resolution, settlement precedence,
 * the four terminal states, backend release, and the task/bus trail.
 *
 * The backend is a fake `BackgroundRunner` registered in the real pool, the
 * same harness `job-oneshot.test.ts` uses, so acquisition and release are
 * exercised for real rather than mocked away.
 *
 * Not covered here: orphan eviction after a timeout. That is
 * `runIsolatedAgent`'s discipline (tested in `job-oneshot.test.ts`); asserting
 * it through the runner would mean waiting out the 30s abort grace.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type {
  Backend,
  BackgroundRunner,
  ModelCatalog,
} from "../core/agent-runtime/capabilities.js";
import { composeBackend } from "../core/agent-runtime/capabilities.js";
import {
  clearBackends,
  registerBackend,
  type BackendFactory,
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
  agentContextLabel,
  agentRegistry,
  initAgents,
  killAgent,
  spawnAgent,
  type AgentParent,
} from "../core/agents/index.js";
import { taskTable } from "../core/tasks/index.js";
import { bus } from "../core/bus/index.js";

// The plan-aware router, stubbed. These tests assert what the runner ASKS
// it and what it does with the answer; how it decides is
// backend-router.test.ts's job.
const chooseBackend = vi.hoisted(() =>
  vi.fn(async (request: { chatBackendId: string }) => ({
    backendId: request.chatBackendId,
    reason: "no candidates",
    routed: false,
  })),
);
vi.mock("../core/engine/backend-router/index.js", () => ({
  chooseBackend,
  recordBackendRunUsage: vi.fn(),
  recordBackendRunFailure: vi.fn(),
  recordBackendRunSuccess: vi.fn(),
  taskClassForEffort: (effort?: string) =>
    effort === "high" || effort === "xhigh" ? "reasoning" : undefined,
}));

const CHAT: AgentParent = { kind: "chat", chatId: "42", numericChatId: 42 };
const STUB_CONFIG = { backend: "claude" } as unknown as TalonConfig;
const STUB_CTX = { getBridgePort: () => 0, frontendName: "terminal" as const };

/** A catalog that knows exactly one model id and defaults to it. */
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

function backendFactory(
  id: string,
  backend: Backend,
  cleanup?: () => void,
): BackendFactory {
  return {
    id,
    label: id,
    async init() {
      return { backend, cleanup };
    },
  };
}

type OneShot = BackgroundRunner["runOneShotAgent"];

/**
 * Pool with a capability-less "claude" as the chat's backend and a
 * background-capable "codex" that is only ever acquired transiently — so a
 * leaked holder shows up immediately as a missing `cleanup` call.
 */
async function withBackend(
  run: OneShot,
  extras: { cleanup?: () => void; models?: ModelCatalog } = {},
): Promise<void> {
  registerBackend(
    backendFactory("claude", composeBackend({ id: "claude", label: "claude" })),
  );
  registerBackend(
    backendFactory(
      "codex",
      composeBackend({
        id: "codex",
        label: "codex",
        background: { runOneShotAgent: run },
        models: extras.models ?? catalog(),
      }),
      extras.cleanup,
    ),
  );
  await initBackendPool(STUB_CONFIG, STUB_CTX);
}

/** Spawn on the transient background backend. */
function spawn(overrides: Record<string, unknown> = {}) {
  return spawnAgent({
    brief: "investigate the thing",
    label: "probe",
    parent: CHAT,
    backendId: "codex",
    ...overrides,
  });
}

/** Wait for an agent's own settlement (the runner settles asynchronously). */
function settled(agentId: string) {
  return agentRegistry.waitForSettle(agentId, 8_000);
}

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

beforeEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
  agentRegistry.resetForTest();
  execute.mockClear();
  chooseBackend.mockClear();
  chooseBackend.mockImplementation(
    async (request: { chatBackendId: string }) => ({
      backendId: request.chatBackendId,
      reason: "no candidates",
      routed: false,
    }),
  );
  initAgents({ execute });
});

afterEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
  agentRegistry.resetForTest();
});

describe("spawnAgent routing", () => {
  it("never asks the router when the caller pinned a backend", async () => {
    await withBackend(vi.fn<OneShot>(async () => {}));
    const outcome = await spawn();
    expect(outcome).toMatchObject({ ok: true, backendId: "codex" });
    expect(chooseBackend).not.toHaveBeenCalled();
    if (outcome.ok) expect(outcome.routing).toBeUndefined();
  });

  it("routes an unpinned spawn from the parent's backend", async () => {
    const run = vi.fn<OneShot>(async () => {});
    await withBackend(run);
    chooseBackend.mockResolvedValue({
      backendId: "codex",
      reason: "most headroom 92%",
      routed: true,
    });

    const outcome = await spawn({ backendId: undefined });
    expect(chooseBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "subagent",
        // The chat role's backend — what the agent would have inherited.
        chatBackendId: "claude",
      }),
    );
    expect(outcome).toMatchObject({ ok: true, backendId: "codex" });
    if (!outcome.ok) return;
    expect(outcome.routing).toBe("most headroom 92%");
    await settled(outcome.agentId);
    expect(run).toHaveBeenCalledOnce();
  });

  it("derives the task class from effort alone", async () => {
    await withBackend(vi.fn<OneShot>(async () => {}));
    chooseBackend.mockResolvedValue({
      backendId: "codex",
      reason: "most headroom 50%",
      routed: true,
    });

    const outcome = await spawn({
      backendId: undefined,
      reasoningEffort: "xhigh",
    });
    expect(chooseBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        hints: { taskClass: "reasoning", effort: "xhigh" },
      }),
    );
    if (outcome.ok) await settled(outcome.agentId);
  });

  it("passes a model through as a pin rather than a preference", async () => {
    await withBackend(vi.fn<OneShot>(async () => {}));
    chooseBackend.mockResolvedValue({
      backendId: "codex",
      reason: "pinned",
      routed: false,
    });

    const outcome = await spawn({ backendId: undefined, model: "sonnet" });
    expect(chooseBackend).toHaveBeenCalledWith(
      expect.objectContaining({ requestedModel: "sonnet" }),
    );
    // reason "pinned" is not a routing decision, so nothing is surfaced.
    if (outcome.ok) {
      expect(outcome.routing).toBeUndefined();
      await settled(outcome.agentId);
    }
  });
});

describe("spawnAgent resolution", () => {
  it("runs on the chosen backend's default model with an agent context label", async () => {
    const run = vi.fn<OneShot>(async () => {});
    await withBackend(run);

    const outcome = await spawn();
    expect(outcome).toMatchObject({
      ok: true,
      backendId: "codex",
      model: "sonnet",
    });
    if (!outcome.ok) return;
    await settled(outcome.agentId);

    const params = run.mock.calls[0]?.[0] as OneShotAgentParams;
    expect(params.model).toBe("sonnet");
    expect(params.contextLabel).toBe(agentContextLabel(outcome.agentId));
    expect(params.prompt).toContain("investigate the thing");
    expect(params.systemPrompt).toContain(outcome.agentId);
    expect(params.systemPrompt).toContain("report_result");
  });

  it("inherits the parent chat's backend when none is given", async () => {
    const run = vi.fn<OneShot>(async () => {});
    registerBackend(
      backendFactory(
        "claude",
        composeBackend({
          id: "claude",
          label: "claude",
          background: { runOneShotAgent: run },
          models: catalog("opus"),
        }),
      ),
    );
    await initBackendPool(STUB_CONFIG, STUB_CTX);

    const outcome = await spawnAgent({
      brief: "b",
      label: "l",
      parent: CHAT,
    });
    expect(outcome).toMatchObject({
      ok: true,
      backendId: "claude",
      model: "opus",
    });
  });

  it("rejects an explicit model the backend does not offer, leaving no record", async () => {
    await withBackend(async () => {});
    const outcome = await spawn({ model: "not-a-model" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("not selectable");
    expect(agentRegistry.list()).toEqual([]);
  });

  it("refuses a backend with no background capability, leaving no record", async () => {
    await withBackend(async () => {});
    const outcome = await spawn({ backendId: "claude" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("cannot host a sub-agent");
    expect(agentRegistry.list()).toEqual([]);
  });

  it("releases the transient backend instance once the run settles", async () => {
    const cleanup = vi.fn();
    await withBackend(async () => {}, { cleanup });
    const outcome = await spawn();
    if (!outcome.ok) return;
    await settled(outcome.agentId);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("releases the transient backend instance even when the run throws", async () => {
    const cleanup = vi.fn();
    await withBackend(
      async () => {
        throw new Error("boom");
      },
      { cleanup },
    );
    const outcome = await spawn();
    if (!outcome.ok) return;
    await settled(outcome.agentId);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("spawnAgent settlement", () => {
  it("settles done with the reported result, recording usage", async () => {
    await withBackend(async (params) => {
      const id = params.contextLabel.slice("agent:".length);
      agentRegistry.report(id, { summary: "found it", details: "evidence" });
      return { inputTokens: 10, outputTokens: 2, cacheRead: 0, cacheWrite: 0 };
    });
    const outcome = await spawn();
    if (!outcome.ok) return;
    const record = await settled(outcome.agentId);
    expect(record?.state).toBe("done");
    expect(record?.result).toEqual({
      summary: "found it",
      details: "evidence",
    });
    expect(record?.usage?.inputTokens).toBe(10);
  });

  it("falls back to the last assistant text when nothing was reported", async () => {
    await withBackend(async (params) => {
      params.onAssistantText?.("first pass");
      params.onAssistantText?.("  final answer  ");
    });
    const outcome = await spawn();
    if (!outcome.ok) return;
    const record = await settled(outcome.agentId);
    expect(record?.state).toBe("done");
    expect(record?.result).toEqual({ summary: "final answer" });
  });

  it("fails when there was neither a report nor any text", async () => {
    await withBackend(async () => {});
    const outcome = await spawn();
    if (!outcome.ok) return;
    const record = await settled(outcome.agentId);
    expect(record?.state).toBe("failed");
    expect(record?.result).toBeNull();
    expect(record?.error).toContain("without calling report_result");
  });

  it("settles failed when the run throws", async () => {
    await withBackend(async () => {
      throw new Error("backend exploded");
    });
    const outcome = await spawn();
    if (!outcome.ok) return;
    const record = await settled(outcome.agentId);
    expect(record?.state).toBe("failed");
    expect(record?.error).toContain("backend exploded");
  });

  it("settles timed_out after aborting the run", async () => {
    let aborted = false;
    await withBackend(
      (params) =>
        new Promise<void>((_resolve, reject) => {
          params.abortController.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted by timeout"));
          });
        }),
    );
    const outcome = await spawn({ timeoutMs: 40 });
    if (!outcome.ok) return;
    const record = await settled(outcome.agentId);
    expect(record?.state).toBe("timed_out");
    expect(record?.error).toMatch(/timed out/);
    expect(aborted).toBe(true);
  });

  it("settles killed when killAgent aborts the run, and the task agrees", async () => {
    await withBackend(
      (params) =>
        new Promise<void>((_resolve, reject) => {
          const stop = (): void => reject(new Error("aborted"));
          if (params.abortController.signal.aborted) stop();
          params.abortController.signal.addEventListener("abort", stop);
        }),
    );
    const outcome = await spawn();
    if (!outcome.ok) return;
    // Let the run register its task before killing it.
    await vi.waitFor(() =>
      expect(agentRegistry.get(outcome.agentId)?.taskId).toBeDefined(),
    );
    expect(killAgent(outcome.agentId)).toBe(true);
    const record = await settled(outcome.agentId);
    expect(record?.state).toBe("killed");

    const task = taskTable.list().find((entry) => entry.id === record?.taskId);
    expect(task).toMatchObject({
      kind: "agent",
      state: "killed",
      label: "probe",
    });
  });

  it("kills a settled agent's still-running children", async () => {
    let childId: string | undefined;
    await withBackend(async (params) => {
      const parentId = params.contextLabel.slice("agent:".length);
      if (childId) return;
      const child = agentRegistry.register(
        {
          label: "child",
          brief: "b",
          parent: { kind: "agent", agentId: parentId },
          backendId: "codex",
        },
        { maxConcurrent: 10, maxDepth: 2, defaultTimeoutMs: 1000 },
      );
      if (child.ok) {
        childId = child.record.id;
        agentRegistry.start(childId, {
          model: "sonnet",
          abort: new AbortController(),
        });
      }
      params.onAssistantText?.("done");
    });
    const outcome = await spawn();
    if (!outcome.ok) return;
    await settled(outcome.agentId);
    expect(childId).toBeDefined();
    // Reaping happens after the settlement the test awaited on.
    await vi.waitFor(() =>
      expect(agentRegistry.killRequested(childId as string)).toBe(true),
    );
  });
});

describe("spawnAgent observability", () => {
  it("publishes spawned before settled and wakes the parent chat", async () => {
    const seen: string[] = [];
    const off = bus.subscribeAll((event) => {
      if (event.type.startsWith("agent.")) seen.push(event.type);
    });
    await withBackend(async (params) => {
      params.onAssistantText?.("done");
    });
    const outcome = await spawn();
    if (!outcome.ok) {
      off();
      return;
    }
    await settled(outcome.agentId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    off();

    expect(seen[0]).toBe("agent.spawned");
    expect(seen).toContain("agent.settled");
    expect(seen).toContain("agent.message");
    const wake = execute.mock.calls[0]?.[0];
    expect(wake?.chatId).toBe("42");
    expect(wake?.source).toBe("agent");
    expect(wake?.senderName).toBe("Agent");
    expect(wake?.prompt).toContain("AGENT FINISHED");
    expect(wake?.prompt).toContain(outcome.agentId);
    expect(wake?.prompt).toContain("probe");
  });
});
