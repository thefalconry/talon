/**
 * Spending a banked Claude limit reset. Every network call is mocked: the
 * real claim endpoint spends a one-off reset, so these tests must never
 * reach it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimBankedReset,
  getBankedResetOffer,
  isValidGrantId,
  isValidRequestId,
  newResetRequestId,
  parseClaimResponse,
  parseResetStatus,
  pickGrant,
} from "../backend/claude-sdk/usage/banked-reset.js";
import { getPlanUsage } from "../backend/claude-sdk/usage/plan-usage.js";

const ORG = "11111111-2222-3333-4444-555555555555";
const NOW = Date.parse("2026-09-24T00:00:00Z");

const grant = (over: Record<string, unknown> = {}) => ({
  id: "opus55-launch",
  label: "Launch reset",
  resets_total: 1,
  resets_left: 1,
  starts_at: "2026-09-22T16:00:00+00:00",
  ends_at: "2026-10-22T16:00:00+00:00",
  clears: ["five_hour", "seven_day"],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  percent_used: { five_hour: 9, seven_day: 82 },
  ...over,
});

const usageBody = (cedar: Record<string, unknown>) => ({
  limits: [{ kind: "session", percent: 9 }],
  cedar_ember: { eligible: true, at_limit: false, ...cedar },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Route = (init?: RequestInit) => Response | Promise<Response>;

function mockFetch(routes: { usage?: Route; profile?: Route; claim?: Route }) {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/oauth/usage") && routes.usage)
      return routes.usage(init);
    if (u.endsWith("/api/oauth/profile") && routes.profile)
      return routes.profile(init);
    if (
      u.endsWith(`/api/organizations/${ORG}/reset_rate_limits`) &&
      routes.claim
    )
      return routes.claim(init);
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const profile: Route = () => json({ organization: { uuid: ORG } });

let dir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "talon-reset-"));
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "tok", subscriptionType: "max" },
    }),
  );
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("id validation", () => {
  it("accepts the CLI's grant id shape and nothing else", () => {
    expect(isValidGrantId("opus55-launch-promax-20260921")).toBe(true);
    expect(isValidGrantId("a_b-1")).toBe(true);
    expect(isValidGrantId("")).toBe(false);
    expect(isValidGrantId("Upper")).toBe(false);
    expect(isValidGrantId("has space")).toBe(false);
    expect(isValidGrantId("../x")).toBe(false);
    expect(isValidGrantId("a".repeat(41))).toBe(false);
  });

  it("accepts request ids of 1-64 url-safe characters", () => {
    expect(isValidRequestId(newResetRequestId())).toBe(true);
    expect(isValidRequestId("Abc_123-x")).toBe(true);
    expect(isValidRequestId("")).toBe(false);
    expect(isValidRequestId("a".repeat(65))).toBe(false);
    expect(isValidRequestId("x/y")).toBe(false);
  });

  it("refuses to send a claim with a malformed id", async () => {
    const f = mockFetch({});
    expect((await claimBankedReset("Bad Id", "req")).result).toBe("error");
    expect((await claimBankedReset("ok", "bad/req")).result).toBe("error");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("grant selection", () => {
  it("prefers next_grant_id when it is usable", () => {
    const status = parseResetStatus(
      usageBody({
        grants: [
          grant({ id: "soon", ends_at: "2026-09-30T00:00:00Z" }),
          grant({ id: "later" }),
        ],
        next_grant_id: "later",
      }),
    )!;
    expect(pickGrant(status, NOW)?.id).toBe("later");
  });

  it("falls back to the soonest-expiring usable grant", () => {
    const status = parseResetStatus(
      usageBody({
        grants: [
          grant({ id: "later" }),
          grant({
            id: "paused",
            paused: true,
            ends_at: "2026-09-25T00:00:00Z",
          }),
          grant({ id: "expired", ends_at: "2026-09-01T00:00:00Z" }),
          grant({
            id: "empty",
            resets_left: 0,
            ends_at: "2026-09-25T00:00:00Z",
          }),
          grant({
            id: "notnow",
            usable_now: false,
            ends_at: "2026-09-25T00:00:00Z",
          }),
          grant({ id: "soon", ends_at: "2026-09-30T00:00:00Z" }),
          grant({ id: "forever", ends_at: null }),
        ],
        next_grant_id: "paused",
      }),
    )!;
    expect(pickGrant(status, NOW)?.id).toBe("soon");
  });

  it("returns nothing when no grant is usable or the program is off", () => {
    expect(
      pickGrant(
        parseResetStatus(usageBody({ grants: [grant({ paused: true })] }))!,
        NOW,
      ),
    ).toBeUndefined();
    expect(
      parseResetStatus({ cedar_ember: { eligible: false } }),
    ).toBeUndefined();
    expect(parseResetStatus({})).toBeUndefined();
  });

  it("drops grants whose id the CLI would refuse", () => {
    const status = parseResetStatus(
      usageBody({ grants: [grant({ id: "BAD ID" })] }),
    )!;
    expect(status.grants).toEqual([]);
  });

  it("builds an offer from the usage endpoint", async () => {
    mockFetch({
      usage: () =>
        json(
          usageBody({
            grants: [grant(), grant({ id: "second", resets_left: 2 })],
            next_grant_id: "opus55-launch",
            cooldown_until: "2026-09-24T01:00:00Z",
          }),
        ),
    });
    const offer = await getBankedResetOffer(NOW);
    expect(offer).toEqual({
      grant: {
        id: "opus55-launch",
        label: "Launch reset",
        resetsLeft: 1,
        endsAt: "2026-10-22T16:00:00+00:00",
        clears: ["five_hour", "seven_day"],
        percentUsed: { five_hour: 9, seven_day: 82 },
        useRequiresLimit: false,
      },
      atLimit: false,
      cooldownUntil: "2026-09-24T01:00:00Z",
      totalResetsLeft: 3,
    });
  });

  it("offers nothing on an API-key session", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const f = mockFetch({});
    expect(await getBankedResetOffer(NOW)).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("claimBankedReset", () => {
  it("POSTs the CLI's body to the org's reset route", async () => {
    let sent: RequestInit | undefined;
    mockFetch({
      profile,
      claim: (init) => {
        sent = init;
        return json({
          result: "reset",
          resets_left: 0,
          cleared: ["five_hour"],
        });
      },
    });
    const claim = await claimBankedReset("opus55-launch", "req123");
    expect(claim).toEqual({
      result: "reset",
      resetsLeft: 0,
      cleared: ["five_hour"],
    });
    expect(sent?.method).toBe("POST");
    expect(JSON.parse(String(sent?.body))).toEqual({
      program: "cedar_ember",
      grant_id: "opus55-launch",
      request_id: "req123",
    });
    const headers = sent?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it.each([
    "reset",
    "already_used",
    "not_limited",
    "cooldown",
    "ineligible",
    "unavailable",
  ])("passes the server result %s through", async (result) => {
    mockFetch({ profile, claim: () => json({ result }) });
    expect((await claimBankedReset("g", "r")).result).toBe(result);
  });

  it("reads an unknown result as unavailable", async () => {
    mockFetch({ profile, claim: () => json({ result: "something_new" }) });
    expect((await claimBankedReset("g", "r")).result).toBe("unavailable");
    expect(parseClaimResponse(null).result).toBe("unavailable");
  });

  it("maps HTTP failures", async () => {
    mockFetch({ profile, claim: () => json({}, 429) });
    expect((await claimBankedReset("g", "r")).result).toBe("rate_limited");
    mockFetch({ profile, claim: () => json({}, 403) });
    expect((await claimBankedReset("g", "r")).result).toBe("auth_error");
    mockFetch({ profile, claim: () => json({}, 500) });
    expect((await claimBankedReset("g", "r")).result).toBe("error");
    mockFetch({
      profile,
      claim: () => {
        throw new Error("network down");
      },
    });
    expect((await claimBankedReset("g", "r")).result).toBe("error");
  });

  it("is an auth error without an organization or credentials", async () => {
    mockFetch({ profile: () => json({ organization: null }) });
    expect((await claimBankedReset("g", "r")).result).toBe("auth_error");
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const f = mockFetch({});
    expect((await claimBankedReset("g", "r")).result).toBe("auth_error");
    expect(f).not.toHaveBeenCalled();
  });

  it("keeps the reason, cooldown and weekly reset", () => {
    expect(
      parseClaimResponse({
        result: "cooldown",
        reason: "cooldown",
        cooldown_until: "2026-09-24T02:00:00Z",
        weekly_resets_at: "2026-09-26T20:00:00Z",
        resets_left: -1,
      }),
    ).toEqual({
      result: "cooldown",
      reason: "cooldown",
      cleared: [],
      cooldownUntil: "2026-09-24T02:00:00Z",
      weeklyResetsAt: "2026-09-26T20:00:00Z",
    });
  });

  it("invalidates the cached plan usage after a reset", async () => {
    const f = mockFetch({
      usage: () => json(usageBody({ grants: [grant()] })),
      profile,
      claim: () => json({ result: "reset" }),
    });
    const usageCalls = () =>
      f.mock.calls.filter(([u]) => String(u).includes("/api/oauth/usage"))
        .length;
    await getPlanUsage();
    await getPlanUsage();
    expect(usageCalls()).toBe(1); // cached
    await claimBankedReset("opus55-launch", "req");
    await getPlanUsage();
    expect(usageCalls()).toBe(2);
  });
});
