import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffMs,
  DEFAULT_BACKOFF_MS,
  getPlanUsage,
  resetPlanUsageCacheForTest,
} from "../backend/claude-sdk/usage/plan-usage.js";

const BODY = {
  limits: [{ kind: "session", percent: 37, resets_at: "2026-10-10T16:00:00Z" }],
};

function account(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-acct-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "test-token", subscriptionType: "max" },
    }),
  );
  return dir;
}

function reply(status: number, body: unknown = {}, headers = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("claude plan usage under rate limiting", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetPlanUsageCacheForTest();
    delete process.env.ANTHROPIC_API_KEY;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the last reading through a 429 and stops asking until the backoff ends", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-10T12:00:00Z") });
    const dir = account();
    fetchMock.mockResolvedValueOnce(reply(200, BODY));
    expect((await getPlanUsage(dir))?.windows[0]?.percent).toBe(37);

    vi.setSystemTime(Date.now() + 61_000); // past the 60s cache
    fetchMock.mockResolvedValueOnce(reply(429, {}, { "retry-after": "120" }));
    expect((await getPlanUsage(dir))?.windows[0]?.percent).toBe(37);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 61_000); // still inside the 120s backoff
    expect((await getPlanUsage(dir))?.windows[0]?.percent).toBe(37);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 60_000); // backoff over
    fetchMock.mockResolvedValueOnce(
      reply(200, { limits: [{ kind: "session", percent: 50 }] }),
    );
    expect((await getPlanUsage(dir))?.windows[0]?.percent).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("restores the last good reading from disk after a restart", async () => {
    const dir = account();
    fetchMock.mockResolvedValueOnce(reply(200, BODY));
    await getPlanUsage(dir);
    await new Promise((r) => setTimeout(r, 50)); // let the snapshot write land

    resetPlanUsageCacheForTest(); // simulated restart: memory gone
    fetchMock.mockResolvedValueOnce(reply(429));
    const usage = await getPlanUsage(dir);
    expect(usage?.windows[0]?.percent).toBe(37);
    expect(usage?.plan).toBe("max");
  });

  it("does not mix accounts", async () => {
    const a = account();
    const b = account();
    fetchMock.mockResolvedValueOnce(reply(200, BODY));
    await getPlanUsage(a);
    fetchMock.mockResolvedValueOnce(reply(429));
    expect(await getPlanUsage(b)).toBeUndefined();
  });
});

describe("backoffMs", () => {
  it("honours Retry-After seconds and dates, capped, with a default", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(backoffMs("90", now)).toBe(90_000);
    expect(backoffMs("Sat, 10 Oct 2026 12:02:00 GMT", now)).toBe(120_000);
    expect(backoffMs("86400", now)).toBe(30 * 60_000);
    expect(backoffMs(null, now)).toBe(DEFAULT_BACKOFF_MS);
    expect(backoffMs("garbage", now)).toBe(DEFAULT_BACKOFF_MS);
  });
});
