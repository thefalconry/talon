/**
 * Empty-run guard — a run that says nothing and does nothing is a failure
 * that feeds the backend circuit breaker, and an explicit backend pin is
 * refused while that breaker is open.
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
import type { Backend } from "../core/agent-runtime/capabilities.js";
import { composeBackend } from "../core/agent-runtime/capabilities.js";
import {
  clearBackends,
  registerBackend,
} from "../core/agent-runtime/backend-registry.js";
import type { TalonConfig } from "../core/config/index.js";
import {
  cleanupBackendPool,
  initBackendPool,
  resetBackendPoolForTest,
} from "../core/engine/backend-controller/index.js";
import {
  agentRegistry,
  initAgents,
  spawnAgent,
  type AgentParent,
} from "../core/agents/index.js";
import {
  BREAKER_FAILURE_THRESHOLD,
  openBreaker,
  recordBackendRunFailure,
  resetBackendBreakersForTest,
} from "../core/engine/backend-router/breaker.js";

// Real breaker, stubbed router: only the pick itself is faked.
vi.mock("../core/engine/backend-router/index.js", async (orig) => ({
  ...(await orig<typeof import("../core/engine/backend-router/index.js")>()),
  chooseBackend: async (request: { chatBackendId: string }) => ({
    backendId: request.chatBackendId,
    reason: "no candidates",
    routed: false,
  }),
}));

const CHAT: AgentParent = { kind: "chat", chatId: "42", numericChatId: 42 };
const STUB_CONFIG = { backend: "claude" } as unknown as TalonConfig;
const STUB_CTX = { getBridgePort: () => 0, frontendName: "terminal" as const };

type OneShot = NonNullable<Backend["background"]>["runOneShotAgent"];

async function withBackend(run: OneShot): Promise<void> {
  const factory = (id: string, backend: Backend) => ({
    id,
    label: id,
    async init() {
      return { backend };
    },
  });
  registerBackend(
    factory("claude", composeBackend({ id: "claude", label: "claude" })),
  );
  registerBackend(
    factory(
      "codex",
      composeBackend({
        id: "codex",
        label: "codex",
        background: { runOneShotAgent: run },
        models: {
          resolveModelInfo: async () => ({ kind: "missing" as const }),
          getDefaultModelId: () => "m",
          getRawModelInfo: async () => undefined,
        },
      }),
    ),
  );
  await initBackendPool(STUB_CONFIG, STUB_CTX);
}

function spawn(overrides: Record<string, unknown> = {}) {
  return spawnAgent({
    brief: "do the thing",
    label: "probe",
    parent: CHAT,
    backendId: "codex",
    ...overrides,
  });
}

async function runToSettle(overrides: Record<string, unknown> = {}) {
  const outcome = await spawn(overrides);
  if (!outcome.ok) throw new Error(outcome.error);
  return agentRegistry.waitForSettle(outcome.agentId, 8_000);
}

beforeEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
  agentRegistry.resetForTest();
  resetBackendBreakersForTest();
  initAgents({ execute: vi.fn() as never });
});

afterEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
  agentRegistry.resetForTest();
  resetBackendBreakersForTest();
});

describe("empty-run guard", () => {
  it("settles an instant run with no text and no tool calls as failed and feeds the breaker", async () => {
    await withBackend(async () => {});
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      expect(openBreaker("codex")).toBeUndefined();
      const record = await runToSettle();
      expect(record?.state).toBe("failed");
      expect(record?.error).toBe(
        "empty run: the agent produced no output and made no tool calls",
      );
    }
    // Each empty run counted as a failure: the streak reached the threshold.
    expect(openBreaker("codex")).toBeDefined();
  });

  it("still settles done when the run produced text but made no tool calls", async () => {
    await withBackend(async (params) => {
      params.onAssistantText?.("here is the answer");
    });
    const record = await runToSettle();
    expect(record?.state).toBe("done");
    expect(record?.result).toEqual({ summary: "here is the answer" });
  });

  it("does not flag a silent run that made tool calls", async () => {
    await withBackend(async (params) => {
      await params.appendLog?.(
        '**Tool call:** `Bash`\n```json\n{"command":"ls"}\n```\n',
      );
    });
    const record = await runToSettle();
    expect(record?.error ?? "").not.toContain("empty run");
    expect(openBreaker("codex")).toBeUndefined();
  });
});

describe("explicit backend with an open breaker", () => {
  it("refuses the spawn, names the backend and suggests omitting backend=", async () => {
    await withBackend(async (params) => {
      params.onAssistantText?.("ok");
    });
    recordBackendRunFailure("codex", new Error("401 unauthorized"));
    expect(openBreaker("codex")).toBeDefined();
    const outcome = await spawn();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('"codex"');
    expect(outcome.error).toMatch(/\d+m/);
    expect(outcome.error).toContain("Omit backend=");
    expect(agentRegistry.list?.().length ?? 0).toBe(0);
  });
});
