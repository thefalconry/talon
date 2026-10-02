/**
 * The router never moves work between Claude accounts.
 *
 * Extra Claude accounts exist so the operator can *choose* which
 * subscription runs what. Using a second subscription automatically to get
 * round the first one's rate limits is exactly what this feature must not
 * do, so the guarantee is structural (account group + explicit-only, see
 * backend-registry.ts) and pinned here: with `claude` out of headroom and
 * `claude-2` idle, unpinned work defaulting to `claude` stays on `claude`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TalonConfig } from "../core/config/index.js";

const listAvailableBackends = vi.hoisted(() => vi.fn());
const getPooledBackend = vi.hoisted(() => vi.fn());
const getPoolConfig = vi.hoisted(() => vi.fn());
vi.mock("../core/engine/backend-controller/index.js", () => ({
  listAvailableBackends,
  getPooledBackend,
  getPoolConfig,
}));

const { chooseBackend } =
  await import("../core/engine/backend-router/router.js");
const { resetHeadroomCacheForTest } =
  await import("../core/engine/backend-router/headroom.js");
const { clearBackends, registerBackend } =
  await import("../core/agent-runtime/backend-registry.js");

/** A pooled backend that reports one plan window at `percent` used. */
function planned(percent: number) {
  return {
    background: {},
    usage: {
      getPlanUsage: async () => ({
        fetchedAt: Date.now(),
        windows: [{ label: "5h", percent }],
      }),
    },
  };
}

function pool(entries: Record<string, unknown>): void {
  listAvailableBackends.mockReturnValue(
    Object.keys(entries).map((id) => ({ id, label: id })),
  );
  getPooledBackend.mockImplementation((id: string) => entries[id] ?? null);
}

/** Register the factories the way claude-sdk/factory.ts tags them. */
function registerFactories(): void {
  const init = async () => {
    throw new Error("not booted in this test");
  };
  registerBackend({
    id: "claude",
    label: "Anthropic",
    accountGroup: "claude",
    init,
  });
  registerBackend({
    id: "claude-2",
    label: "Claude (account 2)",
    accountGroup: "claude",
    explicitOnly: true,
    init,
  });
  registerBackend({ id: "codex", label: "Codex", init });
}

const config = {} as TalonConfig;

beforeEach(() => {
  clearBackends();
  registerFactories();
  listAvailableBackends.mockReset();
  getPooledBackend.mockReset();
  getPoolConfig.mockReset();
  getPoolConfig.mockReturnValue(null);
  resetHeadroomCacheForTest();
});

describe("no failover between Claude accounts", () => {
  for (const purpose of ["subagent", "cron", "heartbeat"] as const) {
    it(`${purpose}: a spent claude never routes to an idle claude-2`, async () => {
      pool({ claude: planned(99), "claude-2": planned(1) });
      const decision = await chooseBackend({
        purpose,
        chatBackendId: "claude",
        config,
      });
      expect(decision.backendId).toBe("claude");
    });
  }

  it("a spent claude may route to another provider, never to claude-2", async () => {
    pool({ claude: planned(99), "claude-2": planned(0), codex: planned(50) });
    const decision = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "claude",
      config,
    });
    expect(decision.backendId).toBe("codex");
  });

  it("the reasoning veto can't pull claude-2 in either", async () => {
    pool({ claude: planned(99), "claude-2": planned(0), codex: planned(50) });
    const decision = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "codex",
      config,
      hints: { taskClass: "reasoning" },
    });
    expect(decision.backendId).not.toBe("claude-2");
  });

  it("work from another provider never shops between Claude accounts", async () => {
    pool({ codex: planned(99), claude: planned(95), "claude-2": planned(0) });
    const decision = await chooseBackend({
      purpose: "cron",
      chatBackendId: "codex",
      config,
    });
    expect(decision.backendId).not.toBe("claude-2");
  });

  it("a spent claude-2 never routes back to claude", async () => {
    pool({ claude: planned(0), "claude-2": planned(99) });
    const decision = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "claude-2",
      config,
    });
    expect(decision.backendId).toBe("claude-2");
  });

  it("an explicit choice of claude-2 is honoured", async () => {
    pool({ claude: planned(99), "claude-2": planned(1) });
    const decision = await chooseBackend({
      purpose: "subagent",
      requestedBackendId: "claude-2",
      chatBackendId: "claude",
      config,
    });
    expect(decision).toMatchObject({ backendId: "claude-2", reason: "pinned" });
  });
});
