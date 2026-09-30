/**
 * Sub-agents survive a daemon restart.
 *
 * Every spawn is mirrored to the `agents` table; a shutdown parks live runs
 * (the row stays `running`, the parent is not told anything); the next boot's
 * `resumeAgentsAfterRestart` brings each one back under its original id —
 * continuing its backend session where the backend can, re-briefing it with
 * its previous run log where it cannot.
 *
 * A "restart" here is: park + abort (shutdownAgents), wipe the in-memory
 * registry and backend pool, re-register the backends, resume from the DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackgroundRunner,
  ModelCatalog,
} from "../core/agent-runtime/capabilities.js";
import { composeBackend } from "../core/agent-runtime/capabilities.js";
import {
  clearBackends,
  registerBackend,
} from "../core/agent-runtime/backend-registry.js";
import type { ExecuteParams, ExecuteResult } from "../core/types.js";
import type { TalonConfig } from "../core/config/index.js";
import {
  cleanupBackendPool,
  initBackendPool,
  resetBackendPoolForTest,
} from "../core/engine/backend-controller/index.js";
import {
  agentRegistry,
  initAgents,
  resumeAgentsAfterRestart,
  shutdownAgents,
  spawnAgent,
  type AgentParent,
} from "../core/agents/index.js";
import { MAX_AGENT_RESUMES } from "../core/agents/runner.js";
import { abortKind } from "../core/agents/abort-reason.js";
import * as agentsRepo from "../storage/agents/repo.js";

vi.mock("../core/engine/backend-router/index.js", () => ({
  chooseBackend: vi.fn(async (request: { chatBackendId: string }) => ({
    backendId: request.chatBackendId,
    reason: "no candidates",
    routed: false,
  })),
  recordBackendRunUsage: vi.fn(),
  recordBackendRunFailure: vi.fn(),
  recordBackendRunSuccess: vi.fn(),
  taskClassForEffort: () => undefined,
}));

type OneShot = BackgroundRunner["runOneShotAgent"];

const CHAT: AgentParent = { kind: "chat", chatId: "42", numericChatId: 42 };
const STUB_CONFIG = { backend: "claude" } as unknown as TalonConfig;
const STUB_CTX = { getBridgePort: () => 0, frontendName: "terminal" as const };

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

/** (Re)boot the pool with a background-capable "codex" backend. */
async function boot(run: OneShot, supportsResume: boolean): Promise<void> {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
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
      return {
        backend: composeBackend({
          id: "codex",
          label: "codex",
          background: {
            runOneShotAgent: run,
            ...(supportsResume ? { supportsResume: true } : {}),
          },
          models: catalog(),
        }),
      };
    },
  });
  await initBackendPool(STUB_CONFIG, STUB_CTX);
}

/** A run that reports a session id, then blocks until aborted. */
function blockingRun(sessionId?: string) {
  return vi.fn<OneShot>(async (p) => {
    if (sessionId) p.onSessionId?.(sessionId);
    await new Promise<void>((resolve) => {
      if (p.abortController.signal.aborted) return resolve();
      p.abortController.signal.addEventListener("abort", () => resolve());
    });
    throw new Error("aborted");
  });
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
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

/** Spawn an agent, let it start, then "restart the daemon" under it. */
async function spawnAndRestart(
  sessionId?: string,
  opts: { preflight?: boolean } = {},
): Promise<string> {
  await boot(blockingRun(sessionId), true);
  const outcome = await spawnAgent({
    brief: "port the widget to the new API",
    label: "porter",
    parent: CHAT,
    backendId: "codex",
    timeoutMs: 60 * 60 * 1000,
    ...(opts.preflight ? { preflight: true } : {}),
  });
  if (!outcome.ok) throw new Error(outcome.error);
  const id = outcome.agentId;
  if (sessionId) {
    await until(() => agentsRepo.get(id)?.sessionId === sessionId);
  } else {
    await until(() => agentsRepo.get(id)?.state === "running");
  }
  shutdownAgents();
  await until(() => !agentRegistry.isLive(id));
  agentRegistry.resetForTest();
  return id;
}

beforeEach(() => {
  agentsRepo.removeAll();
  agentRegistry.resetForTest();
  execute.mockClear();
  initAgents({ execute });
});

afterEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
  agentRegistry.resetForTest();
  agentsRepo.removeAll();
});

describe("sub-agent persistence", () => {
  it("persists the spawn with its brief, parent, backend and timeout", async () => {
    await boot(blockingRun(), true);
    const outcome = await spawnAgent({
      brief: "the brief",
      label: "lbl",
      parent: CHAT,
      backendId: "codex",
      timeoutMs: 120_000,
    });
    if (!outcome.ok) throw new Error(outcome.error);
    await until(() => agentsRepo.get(outcome.agentId)?.state === "running");
    const row = agentsRepo.get(outcome.agentId)!;
    expect(row).toMatchObject({
      brief: "the brief",
      label: "lbl",
      parentKind: "chat",
      parentId: "42",
      parentNumericChatId: 42,
      backendId: "codex",
      model: "sonnet",
      timeoutMs: 120_000,
    });
    shutdownAgents();
    await until(() => !agentRegistry.isLive(outcome.agentId));
  });

  it("a shutdown parks the agent instead of killing it", async () => {
    const id = await spawnAndRestart("sess-1");
    const row = agentsRepo.get(id)!;
    expect(row.state).toBe("running");
    expect(row.interruptedAt).toBeTypeOf("number");
    expect(row.sessionId).toBe("sess-1");
    // The parent is not woken with a death notice.
    expect(execute).not.toHaveBeenCalled();
  });

  it("a shutdown abort does not read as a kill", async () => {
    const run = blockingRun("sess-1");
    await boot(run, true);
    const outcome = await spawnAgent({
      brief: "port the widget to the new API",
      label: "porter",
      parent: CHAT,
      backendId: "codex",
    });
    if (!outcome.ok) throw new Error(outcome.error);
    await until(() => agentsRepo.get(outcome.agentId)?.sessionId === "sess-1");
    const signal = run.mock.calls[0]![0].abortController.signal;
    shutdownAgents();
    await until(() => !agentRegistry.isLive(outcome.agentId));
    expect(signal.aborted).toBe(true);
    expect(abortKind(signal)).not.toBe("killed");
  });

  it("resumes the backend session on boot and delivers the report", async () => {
    const id = await spawnAndRestart("sess-1");

    const resumed = vi.fn<OneShot>(async (p) => {
      p.onAssistantText?.("finished after the restart");
    });
    await boot(resumed, true);
    expect(await resumeAgentsAfterRestart()).toBe(1);
    const settled = await agentRegistry.waitForSettle(id, 5_000);

    expect(resumed).toHaveBeenCalledOnce();
    const params = resumed.mock.calls[0]![0];
    expect(params.resumeSessionId).toBe("sess-1");
    expect(params.contextLabel).toBe(`agent:${id}`);
    expect(params.prompt).toContain("interrupted by a daemon restart");
    expect(settled).toMatchObject({
      id,
      state: "done",
      result: { summary: "finished after the restart" },
    });
    await until(() => execute.mock.calls.length > 0);
    expect(execute.mock.calls[0]![0].prompt).toContain(id);
    expect(agentsRepo.get(id)).toMatchObject({ state: "done", resumeCount: 1 });
  });

  it("re-briefs with the previous brief when the backend cannot resume", async () => {
    const id = await spawnAndRestart("sess-1");

    const rerun = vi.fn<OneShot>(async (p) => {
      p.onAssistantText?.("done again");
    });
    await boot(rerun, false);
    await resumeAgentsAfterRestart();
    await agentRegistry.waitForSettle(id, 5_000);

    const params = rerun.mock.calls[0]![0];
    expect(params.resumeSessionId).toBeUndefined();
    expect(params.prompt).toContain("port the widget to the new API");
    expect(params.prompt).toContain("RESUMED AFTER A DAEMON RESTART");
  });

  it("keeps the pre-flight lane when it re-briefs a resumed agent", async () => {
    const id = await spawnAndRestart("sess-1", { preflight: true });
    expect(agentsRepo.get(id)?.preflight).toBe(true);

    const rerun = vi.fn<OneShot>(async (p) => {
      p.onAssistantText?.("done again");
    });
    await boot(rerun, false);
    await resumeAgentsAfterRestart();
    await agentRegistry.waitForSettle(id, 5_000);

    const params = rerun.mock.calls[0]![0];
    expect(params.prompt).toContain("RESUMED AFTER A DAEMON RESTART");
    expect(params.prompt).toContain("npm run preflight");
  });

  it("does not add the pre-flight lane to a re-brief that never had it", async () => {
    const id = await spawnAndRestart("sess-1");
    expect(agentsRepo.get(id)?.preflight).toBeUndefined();

    const rerun = vi.fn<OneShot>(async (p) => {
      p.onAssistantText?.("done again");
    });
    await boot(rerun, false);
    await resumeAgentsAfterRestart();
    await agentRegistry.waitForSettle(id, 5_000);

    expect(rerun.mock.calls[0]![0].prompt).not.toContain("npm run preflight");
  });

  it("keeps undrained inbox messages across the restart", async () => {
    await boot(blockingRun("s"), true);
    const outcome = await spawnAgent({
      brief: "b",
      label: "inbox",
      parent: CHAT,
      backendId: "codex",
    });
    if (!outcome.ok) throw new Error(outcome.error);
    const id = outcome.agentId;
    await until(() => agentsRepo.get(id)?.sessionId === "s");
    agentRegistry.push(id, { from: "42", text: "also do X", at: 1 });
    shutdownAgents();
    await until(() => !agentRegistry.isLive(id));
    agentRegistry.resetForTest();

    let drained: string[] = [];
    await boot(
      vi.fn<OneShot>(async (p) => {
        drained = agentRegistry.drain(id).map((m) => m.text);
        // Stay running until the test's shutdown aborts it.
        await new Promise<void>((resolve) =>
          p.abortController.signal.addEventListener("abort", () => resolve()),
        );
      }),
      true,
    );
    await resumeAgentsAfterRestart();
    await until(() => drained.length > 0);
    expect(drained).toEqual(["also do X"]);
    shutdownAgents();
    await until(() => !agentRegistry.isLive(id));
  });

  it("delivers a report that landed before the restart without rerunning", async () => {
    await boot(
      vi.fn<OneShot>(async (p) => {
        await new Promise<void>((resolve) =>
          p.abortController.signal.addEventListener("abort", () => resolve()),
        );
        throw new Error("aborted");
      }),
      true,
    );
    const outcome = await spawnAgent({
      brief: "b",
      label: "reported",
      parent: CHAT,
      backendId: "codex",
    });
    if (!outcome.ok) throw new Error(outcome.error);
    const id = outcome.agentId;
    await until(() => agentsRepo.get(id)?.state === "running");
    agentRegistry.report(id, { summary: "all done" });
    shutdownAgents();
    await until(() => !agentRegistry.isLive(id));
    agentRegistry.resetForTest();

    const rerun = vi.fn<OneShot>(async () => {});
    await boot(rerun, true);
    await resumeAgentsAfterRestart();
    await until(() => agentsRepo.get(id)?.state === "done");
    expect(rerun).not.toHaveBeenCalled();
    await until(() => execute.mock.calls.length > 0);
    expect(execute.mock.calls[0]![0].prompt).toContain("all done");
  });

  it("gives up after too many restarts and tells the parent", async () => {
    const id = await spawnAndRestart("sess-1");
    const row = agentsRepo.get(id)!;
    agentsRepo.upsert({ ...row, resumeCount: MAX_AGENT_RESUMES });

    const rerun = vi.fn<OneShot>(async () => {});
    await boot(rerun, true);
    await resumeAgentsAfterRestart();
    await until(() => agentsRepo.get(id)?.state === "failed");
    expect(rerun).not.toHaveBeenCalled();
    await until(() => execute.mock.calls.length > 0);
    expect(execute.mock.calls[0]![0].prompt).toContain("daemon restarts");
  });

  it("a normal settlement is persisted as terminal and not resumed", async () => {
    await boot(
      vi.fn<OneShot>(async (p) => {
        p.onAssistantText?.("ok");
      }),
      true,
    );
    const outcome = await spawnAgent({
      brief: "b",
      label: "quick",
      parent: CHAT,
      backendId: "codex",
    });
    if (!outcome.ok) throw new Error(outcome.error);
    await agentRegistry.waitForSettle(outcome.agentId, 5_000);
    expect(agentsRepo.get(outcome.agentId)?.state).toBe("done");
    agentRegistry.resetForTest();
    expect(await resumeAgentsAfterRestart()).toBe(0);
  });
});
