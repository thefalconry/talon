/**
 * The headroom model — the signal the plan-aware router ranks backends on.
 *
 * Covers the two sources (a backend's own plan windows, and Talon's local
 * token ledger against a configured budget), the rolling windows, the 60s
 * cache and its stale-on-failure behaviour, and the ledger's persistence
 * round-trip.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TalonConfig } from "../core/config/index.js";

const listAvailableBackends = vi.hoisted(() => vi.fn());
const getPooledBackend = vi.hoisted(() => vi.fn());
vi.mock("../core/engine/backend-controller/index.js", () => ({
  listAvailableBackends,
  getPooledBackend,
  getPoolConfig: () => null,
}));

const {
  collectBackendHeadroom,
  getBackendHeadroom,
  headroomFromLedger,
  headroomFromPlan,
  limitingWindowOf,
  resetHeadroomCacheForTest,
  HEADROOM_CACHE_MS,
} = await import("../core/engine/backend-router/headroom.js");
const {
  flushBackendLedger,
  ledgerUsage,
  loadBackendLedger,
  recordBackendUsage,
  resetBackendLedgerForTest,
  tokensInWindow,
  LEDGER_SHORT_WINDOW_MS,
} = await import("../core/engine/backend-router/ledger.js");

const HOUR = 60 * 60_000;

function withBudgets(budgets: TalonConfig["backendBudgets"]): TalonConfig {
  return { backendBudgets: budgets } as TalonConfig;
}

let tempDir: string;

beforeEach(() => {
  listAvailableBackends.mockReset();
  getPooledBackend.mockReset();
  getPooledBackend.mockReturnValue(null);
  resetHeadroomCacheForTest();
  tempDir = mkdtempSync(join(tmpdir(), "talon-ledger-"));
  resetBackendLedgerForTest(join(tempDir, "backend-ledger.json"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tempDir, { recursive: true, force: true });
  resetBackendLedgerForTest();
});

describe("headroom from a plan", () => {
  it("is 1 minus the tightest window", () => {
    const entry = headroomFromPlan("claude", "Anthropic", {
      fetchedAt: 1000,
      windows: [
        { label: "5h", percent: 20 },
        { label: "7d", percent: 73, resetsAt: "2026-09-27T00:00:00Z" },
      ],
    });
    expect(entry?.headroom).toBeCloseTo(0.27, 5);
    expect(entry?.source).toBe("plan");
    expect(entry?.limiting).toMatchObject({ label: "7d", percent: 73 });
    expect(entry?.fetchedAt).toBe(1000);
  });

  it("has nothing to say when the plan reports no windows", () => {
    expect(limitingWindowOf({ fetchedAt: 1, windows: [] })).toBeUndefined();
    expect(
      headroomFromPlan("claude", "Anthropic", { fetchedAt: 1, windows: [] }),
    ).toBeUndefined();
  });
});

describe("headroom from the local ledger", () => {
  it("measures the tighter of the two configured windows", () => {
    const now = Date.now();
    recordBackendUsage("agy", 400_000, now - 1000);
    const config = withBudgets({
      agy: { tokensPer5h: 1_000_000, tokensPerDay: 10_000_000 },
    });
    const entry = headroomFromLedger("agy", "Antigravity", config, now);
    // 40% of the 5h budget, 4% of the day budget → the 5h window limits.
    expect(entry?.source).toBe("ledger");
    expect(entry?.limiting?.label).toContain("5h");
    expect(entry?.headroom).toBeCloseTo(0.6, 5);
  });

  it("is absent when the backend has no configured budget", () => {
    recordBackendUsage("agy", 999_999);
    expect(
      headroomFromLedger("agy", "Antigravity", withBudgets({})),
    ).toBeUndefined();
  });

  it("rolls the 5h window forward as time passes", () => {
    const t0 = Date.parse("2026-09-20T00:00:00Z");
    recordBackendUsage("agy", 100, t0);
    recordBackendUsage("agy", 50, t0 + HOUR);

    expect(tokensInWindow("agy", LEDGER_SHORT_WINDOW_MS, t0 + HOUR)).toBe(150);
    // 5h01m after the first record, only the second is still inside.
    expect(
      tokensInWindow("agy", LEDGER_SHORT_WINDOW_MS, t0 + 5 * HOUR + 60_000),
    ).toBe(50);
    // ...and 6h after the second, the window is empty again.
    expect(tokensInWindow("agy", LEDGER_SHORT_WINDOW_MS, t0 + 7 * HOUR)).toBe(
      0,
    );
  });

  it("prunes entries out of the 24h window entirely", () => {
    const t0 = Date.parse("2026-09-20T00:00:00Z");
    recordBackendUsage("agy", 500, t0);
    // A later record prunes anything past retention at write time.
    recordBackendUsage("agy", 7, t0 + 25 * HOUR);
    const used = ledgerUsage("agy", t0 + 25 * HOUR);
    expect(used.tokensDay).toBe(7);
    expect(used.tokens5h).toBe(7);
  });
});

describe("ledger persistence", () => {
  it("round-trips through the data file", async () => {
    const now = Date.now();
    recordBackendUsage("agy", 1234, now);
    await flushBackendLedger();

    // A fresh process: same file, empty memory.
    resetBackendLedgerForTest(join(tempDir, "backend-ledger.json"));
    expect(tokensInWindow("agy", LEDGER_SHORT_WINDOW_MS, now)).toBe(0);
    await loadBackendLedger();
    expect(tokensInWindow("agy", LEDGER_SHORT_WINDOW_MS, now)).toBe(1234);
  });

  it("starts empty when the file is missing or corrupt", async () => {
    resetBackendLedgerForTest(join(tempDir, "does-not-exist.json"));
    await loadBackendLedger();
    expect(tokensInWindow("agy", LEDGER_SHORT_WINDOW_MS)).toBe(0);
  });
});

describe("getBackendHeadroom", () => {
  function planBackend(percent: number, calls: { n: number }) {
    return {
      background: {},
      usage: {
        getPlanUsage: async () => {
          calls.n++;
          return {
            plan: "max",
            fetchedAt: Date.now(),
            windows: [{ label: "5h", percent }],
          };
        },
      },
    };
  }

  it("caches a reading for 60s and refreshes after", async () => {
    const calls = { n: 0 };
    getPooledBackend.mockReturnValue(planBackend(40, calls));
    const t0 = Date.now();

    const first = await getBackendHeadroom("claude", "Anthropic", undefined, {
      now: t0,
    });
    expect(first.headroom).toBeCloseTo(0.6, 5);
    expect(calls.n).toBe(1);

    await getBackendHeadroom("claude", "Anthropic", undefined, {
      now: t0 + HEADROOM_CACHE_MS - 1,
    });
    expect(calls.n).toBe(1);

    await getBackendHeadroom("claude", "Anthropic", undefined, {
      now: t0 + HEADROOM_CACHE_MS + 1,
    });
    expect(calls.n).toBe(2);
  });

  it("keeps the last value and flags it stale when a read fails", async () => {
    let fail = false;
    getPooledBackend.mockReturnValue({
      background: {},
      usage: {
        getPlanUsage: async () => {
          if (fail) throw new Error("no credentials");
          return {
            fetchedAt: 500,
            windows: [{ label: "5h", percent: 10 }],
          };
        },
      },
    });
    const t0 = Date.now();
    const good = await getBackendHeadroom("claude", "Anthropic", undefined, {
      now: t0,
    });
    expect(good.headroom).toBeCloseTo(0.9, 5);
    expect(good.stale).toBeUndefined();

    fail = true;
    const stale = await getBackendHeadroom("claude", "Anthropic", undefined, {
      now: t0 + HEADROOM_CACHE_MS + 1,
    });
    expect(stale.stale).toBe(true);
    expect(stale.headroom).toBeCloseTo(0.9, 5);
  });

  it("reports source 'none' for a backend with neither plan nor budget", async () => {
    getPooledBackend.mockReturnValue({ background: {} });
    const entry = await getBackendHeadroom("kilo", "Kilo", undefined);
    expect(entry.source).toBe("none");
    // Unmeasured is not "empty": it must never be preferred on no evidence.
    expect(entry.headroom).toBe(0);
    expect(entry.limiting).toBeUndefined();
  });

  it("collects one entry per exposed backend, plan and ledger mixed", async () => {
    const now = Date.now();
    listAvailableBackends.mockReturnValue([
      { id: "claude", label: "Anthropic" },
      { id: "agy", label: "Antigravity" },
    ]);
    getPooledBackend.mockImplementation((id: string) =>
      id === "claude"
        ? {
            background: {},
            usage: {
              getPlanUsage: async () => ({
                fetchedAt: now,
                windows: [{ label: "5h", percent: 50 }],
              }),
            },
          }
        : { background: {} },
    );
    recordBackendUsage("agy", 250_000, now);

    const entries = await collectBackendHeadroom(
      withBudgets({ agy: { tokensPer5h: 1_000_000 } }),
      { now },
    );
    expect(entries.map((e) => [e.id, e.source])).toEqual([
      ["claude", "plan"],
      ["agy", "ledger"],
    ]);
    expect(entries[1]?.headroom).toBeCloseTo(0.75, 5);
  });

  it("prefers agy's own /usage windows and falls back to its budget when they are missing", async () => {
    const now = Date.now();
    let plan:
      | { fetchedAt: number; windows: { label: string; percent: number }[] }
      | undefined = {
      fetchedAt: now,
      windows: [
        { label: "Gemini · 7d", percent: 40 },
        { label: "Gemini · 5h", percent: 0 },
      ],
    };
    getPooledBackend.mockReturnValue({
      background: {},
      usage: { getPlanUsage: async () => plan },
    });
    recordBackendUsage("agy", 250_000, now);
    const config = withBudgets({ agy: { tokensPer5h: 1_000_000 } });

    const fromPlan = await getBackendHeadroom("agy", "Antigravity", config, {
      now,
    });
    expect(fromPlan.source).toBe("plan");
    expect(fromPlan.limiting?.label).toBe("Gemini · 7d");
    expect(fromPlan.headroom).toBeCloseTo(0.6, 5);

    plan = undefined;
    const fromLedger = await getBackendHeadroom("agy", "Antigravity", config, {
      now,
      force: true,
    });
    expect(fromLedger.source).toBe("ledger");
    expect(fromLedger.headroom).toBeCloseTo(0.75, 5);
  });
});
