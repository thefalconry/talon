/**
 * The run breaker and the "backend is not working" signals the router
 * applies on top of headroom: an auth failure reported by telemetry, an
 * auth failure on a run, and repeated failures — plus the cool-off,
 * half-open re-trip and reset on success.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { TalonConfig } from "../core/config/index.js";

const listAvailableBackends = vi.hoisted(() => vi.fn());
const getPooledBackend = vi.hoisted(() => vi.fn());
const getPoolConfig = vi.hoisted(() => vi.fn());
vi.mock("../core/engine/backend-controller/index.js", () => ({
  listAvailableBackends,
  getPooledBackend,
  getPoolConfig,
}));

const {
  isAuthFailureMessage,
  openBreaker,
  recordBackendRunFailure,
  recordBackendRunSuccess,
  resetBackendBreakersForTest,
  BREAKER_BASE_COOLOFF_MS,
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_MAX_COOLOFF_MS,
} = await import("../core/engine/backend-router/breaker.js");
const { formatHeadroom, getBackendHeadroom, resetHeadroomCacheForTest } =
  await import("../core/engine/backend-router/headroom.js");
const { chooseBackend } =
  await import("../core/engine/backend-router/router.js");

function planned(percent: number, authFailure?: string) {
  return {
    background: {},
    usage: {
      getPlanUsage: async () => ({
        fetchedAt: Date.now(),
        windows: [{ label: "5h", percent }],
      }),
      ...(authFailure ? { getAuthFailure: () => authFailure } : {}),
    },
  };
}

function pool(entries: Record<string, unknown>): void {
  listAvailableBackends.mockReturnValue(
    Object.keys(entries).map((id) => ({ id, label: id })),
  );
  getPooledBackend.mockImplementation((id: string) => entries[id] ?? null);
}

const config = {} as TalonConfig;

beforeEach(() => {
  listAvailableBackends.mockReset();
  getPooledBackend.mockReset();
  getPoolConfig.mockReset();
  getPoolConfig.mockReturnValue(null);
  resetHeadroomCacheForTest();
  resetBackendBreakersForTest();
});

describe("isAuthFailureMessage", () => {
  it("recognises the credential failures backends report", () => {
    for (const msg of [
      "unexpected status 401 Unauthorized",
      "Your Codex login has expired — run `codex login`",
      "authentication required",
      "Failed to refresh token: refresh_token_reused",
      "Invalid API key provided",
    ]) {
      expect(isAuthFailureMessage(msg)).toBe(true);
    }
  });

  it("does not treat model or transport errors as auth", () => {
    for (const msg of [
      "unexpected status 404 Not Found: The model `gpt-5.5` does not exist",
      "rate limit hit, try later",
      "fetch failed — network unreachable",
    ]) {
      expect(isAuthFailureMessage(msg)).toBe(false);
    }
  });
});

describe("breaker", () => {
  const t0 = 1_000_000;

  it("opens at once on an auth failure", () => {
    recordBackendRunFailure("codex", new Error("401 Unauthorized"), t0);
    const open = openBreaker("codex", t0 + 1);
    expect(open?.reason).toMatch(/auth failure/);
    expect(open?.until).toBe(t0 + BREAKER_BASE_COOLOFF_MS);
  });

  it("opens after N consecutive ordinary failures, not before", () => {
    const err = new Error("404 model does not exist");
    for (let i = 1; i < BREAKER_FAILURE_THRESHOLD; i++) {
      recordBackendRunFailure("codex", err, t0 + i);
      expect(openBreaker("codex", t0 + i)).toBeUndefined();
    }
    recordBackendRunFailure("codex", err, t0 + 10);
    expect(openBreaker("codex", t0 + 11)?.reason).toMatch(
      /consecutive failures/,
    );
  });

  it("a success in between resets the count", () => {
    const err = new Error("boom");
    for (let i = 1; i < BREAKER_FAILURE_THRESHOLD; i++) {
      recordBackendRunFailure("codex", err, t0 + i);
    }
    recordBackendRunSuccess("codex");
    recordBackendRunFailure("codex", err, t0 + 10);
    expect(openBreaker("codex", t0 + 11)).toBeUndefined();
  });

  it("ignores caller aborts", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD + 2; i++) {
      recordBackendRunFailure("codex", abort, t0 + i);
    }
    expect(openBreaker("codex", t0 + 10)).toBeUndefined();
  });

  it("half-opens after the cool-off and re-trips with a doubled cool-off", () => {
    recordBackendRunFailure("codex", new Error("401"), t0);
    const reopen = t0 + BREAKER_BASE_COOLOFF_MS;
    expect(openBreaker("codex", reopen)).toBeUndefined();
    // The half-open probe fails: one failure is enough now.
    recordBackendRunFailure("codex", new Error("still broken"), reopen);
    expect(openBreaker("codex", reopen + 1)?.until).toBe(
      reopen + 2 * BREAKER_BASE_COOLOFF_MS,
    );
  });

  it("caps the cool-off", () => {
    let now = t0;
    for (let i = 0; i < 20; i++) {
      recordBackendRunFailure("codex", new Error("401"), now);
      const open = openBreaker("codex", now);
      expect(open).toBeDefined();
      expect((open?.until ?? 0) - now).toBeLessThanOrEqual(
        BREAKER_MAX_COOLOFF_MS,
      );
      now = open?.until ?? now;
    }
  });

  it("does not stretch an open cool-off with more failures", () => {
    recordBackendRunFailure("codex", new Error("401"), t0);
    recordBackendRunFailure("codex", new Error("401"), t0 + 60_000);
    expect(openBreaker("codex", t0 + 60_001)?.until).toBe(
      t0 + BREAKER_BASE_COOLOFF_MS,
    );
  });
});

describe("headroom overlay", () => {
  it("zeroes a backend whose telemetry reports a rejected login", async () => {
    pool({ codex: planned(5, "Codex login expired — run `codex login`") });
    const entry = await getBackendHeadroom("codex", "Codex", config);
    expect(entry.headroom).toBe(0);
    expect(entry.limiting?.percent).toBe(100);
    expect(entry.unavailable).toMatch(/login expired/);
    expect(formatHeadroom(entry)).toMatch(/^0% — unavailable/);
  });

  it("zeroes a backend with an open breaker, and restores it on success", async () => {
    pool({ codex: planned(5) });
    recordBackendRunFailure("codex", new Error("401 Unauthorized"));
    const blocked = await getBackendHeadroom("codex", "Codex", config);
    expect(blocked.headroom).toBe(0);
    expect(blocked.unavailable).toMatch(/breaker open/);

    // The breaker is applied per read, not cached with the plan reading.
    recordBackendRunSuccess("codex");
    const restored = await getBackendHeadroom("codex", "Codex", config);
    expect(restored.headroom).toBeCloseTo(0.95, 5);
    expect(restored.unavailable).toBeUndefined();
  });
});

describe("routing around a broken backend", () => {
  it("does not prefer an unmeasured backend over a measured one with room", async () => {
    pool({ claude: planned(60), codex: { background: {} } });
    const decision = await chooseBackend({
      purpose: "cron",
      chatBackendId: "claude",
      config,
    });
    expect(decision.backendId).toBe("claude");
  });

  it("still uses an unmeasured backend when it is the only one", async () => {
    pool({ codex: { background: {} } });
    const decision = await chooseBackend({
      purpose: "cron",
      chatBackendId: "codex",
      config,
    });
    expect(decision.backendId).toBe("codex");
  });

  it("routes away from a backend whose runs keep failing", async () => {
    pool({ claude: planned(70), codex: planned(5) });
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      recordBackendRunFailure("codex", new Error("404 model does not exist"));
    }
    const decision = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "codex",
      config,
    });
    expect(decision.backendId).toBe("claude");
  });

  it("routes away from a backend with an expired login", async () => {
    pool({
      claude: planned(70),
      codex: planned(0, "Codex login expired (usage endpoint returned 401)"),
    });
    const decision = await chooseBackend({
      purpose: "heartbeat",
      chatBackendId: "codex",
      config,
    });
    expect(decision.backendId).toBe("claude");
  });
});
