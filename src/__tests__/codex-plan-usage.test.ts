import {
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { parseCodexUsage } from "../backend/codex/plan-usage.js";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logWarn,
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

/** The shape the ChatGPT backend returns for a plan install. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 26,
        limit_window_seconds: 604800,
        reset_at: 1786225824,
      },
      secondary_window: null,
    },
    ...over,
  };
}

describe("parseCodexUsage", () => {
  it("labels a window by its length and converts the reset to ISO", () => {
    const usage = parseCodexUsage(body());
    expect(usage?.plan).toBe("plus");
    expect(usage?.windows).toEqual([
      {
        label: "7d",
        percent: 26,
        resetsAt: new Date(1786225824 * 1000).toISOString(),
      },
    ]);
  });

  it("keeps both windows when the plan still has a shorter one", () => {
    const usage = parseCodexUsage(
      body({
        rate_limit: {
          primary_window: {
            used_percent: 26,
            limit_window_seconds: 604800,
            reset_at: 1786225824,
          },
          secondary_window: {
            used_percent: 4,
            limit_window_seconds: 18000,
            reset_at: 1786000000,
          },
        },
      }),
    );
    expect(usage?.windows.map((w) => w.label)).toEqual(["7d", "5h"]);
  });

  it("drops a window the plan no longer has", () => {
    // The 5-hour window was retired; a null secondary is normal, not a gap.
    const usage = parseCodexUsage(body());
    expect(usage?.windows).toHaveLength(1);
  });

  it("clamps and rounds the percentage", () => {
    const usage = parseCodexUsage(
      body({
        rate_limit: {
          primary_window: {
            used_percent: 99.6,
            limit_window_seconds: 604800,
          },
        },
      }),
    );
    expect(usage?.windows[0]?.percent).toBe(100);
    expect(usage?.windows[0]?.resetsAt).toBeUndefined();
  });

  it("returns undefined when there is no plan to report", () => {
    expect(parseCodexUsage(null)).toBeUndefined();
    expect(parseCodexUsage({})).toBeUndefined();
    expect(parseCodexUsage({ rate_limit: {} })).toBeUndefined();
    expect(
      parseCodexUsage({ rate_limit: { primary_window: {} } }),
    ).toBeUndefined();
  });
});

describe("getPlanUsage \u2014 401 latch", () => {
  let codexHome: string;
  let originalCodexHome: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;
  let getPlanUsage: () => Promise<unknown>;

  const authFile = () => join(codexHome, "auth.json");

  beforeEach(async () => {
    originalCodexHome = process.env.CODEX_HOME;
    codexHome = mkdtempSync(join(tmpdir(), "talon-codex-plan-usage-"));
    process.env.CODEX_HOME = codexHome;
    writeFileSync(
      authFile(),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "stale-token", account_id: "acc_1" },
      }),
    );
    fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    logWarn.mockClear();
    // Fresh module per test: the latch and the usage cache are singletons.
    vi.resetModules();
    ({ getPlanUsage } = await import("../backend/codex/plan-usage.js"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  it("warns once and stops calling the endpoint until auth.json changes", async () => {
    expect(await getPlanUsage()).toBeUndefined();
    expect(await getPlanUsage()).toBeUndefined();
    expect(await getPlanUsage()).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]?.[1]).toContain("codex login");
  });

  it("re-arms when `codex login` rewrites auth.json", async () => {
    await getPlanUsage();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A fresh login writes a new file; bump the mtime past the old one so
    // the change is visible even on coarse filesystem timestamps.
    const next = new Date(statSync(authFile()).mtimeMs + 5_000);
    writeFileSync(
      authFile(),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "fresh-token", account_id: "acc_1" },
      }),
    );
    utimesSync(authFile(), next, next);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body()), { status: 200 }),
    );

    const usage = (await getPlanUsage()) as { plan?: string } | undefined;
    expect(usage?.plan).toBe("plus");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers?.Authorization).toBe(
      "Bearer fresh-token",
    );
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("warns again for a second 401 after the file changed", async () => {
    await getPlanUsage();
    const next = new Date(statSync(authFile()).mtimeMs + 5_000);
    utimesSync(authFile(), next, next);

    await getPlanUsage();
    await getPlanUsage();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logWarn).toHaveBeenCalledTimes(2);
  });

  it("reports the rejected login to the router until auth.json changes", async () => {
    const mod = await import("../backend/codex/plan-usage.js");
    expect(mod.getAuthFailure()).toBeUndefined();
    await mod.getPlanUsage();
    expect(mod.getAuthFailure()).toMatch(/codex login/);

    const next = new Date(statSync(authFile()).mtimeMs + 5_000);
    utimesSync(authFile(), next, next);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body()), { status: 200 }),
    );
    await mod.getPlanUsage();
    expect(mod.getAuthFailure()).toBeUndefined();
  });

  it("does not latch other failures", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    await getPlanUsage();
    await getPlanUsage();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logWarn).toHaveBeenCalledTimes(2);
  });
});
