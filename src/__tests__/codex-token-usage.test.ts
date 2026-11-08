/**
 * Codex per-call token-usage reader tests.
 *
 * `token-usage.ts` parses the Codex CLI rollout JSONL to recover the
 * **last API call's** prompt size — the only honest "current context
 * fill" signal Codex exposes. The SDK's `turn.completed.usage` is
 * cumulative across all API calls in a turn (2M+ tokens on multi-call
 * agentic flows), so the rollout is the only place this number lives.
 *
 * Tests cover the happy path (real rollout shape lifted from a real
 * Codex run), graceful degradation when:
 *
 *   - sessions/ dir doesn't exist yet (first run)
 *   - thread_id doesn't match any rollout (stale resume id, archived)
 *   - rollout exists but contains no `token_count` events (turn died
 *     before the first API call returned)
 *   - rollout contains malformed JSON lines (mid-write crash recovery)
 *   - rollout has a `token_count` event but `last_token_usage` is
 *     malformed / missing input_tokens
 *
 * All non-happy paths must return `null` — the handler treats a null
 * result as "context unknown" rather than fabricating a number.
 *
 * `CODEX_HOME` env var is overridden per-test so nothing touches the
 * real `~/.codex/sessions/` tree.
 */

import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyRateLimits,
  extractSnapshotFromTokenCountPayload,
  readLastRolloutSnapshot,
  readLastTokenCount,
} from "../backend/codex/token-usage.js";

let originalCodexHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalCodexHome = process.env.CODEX_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "talon-codex-token-"));
  process.env.CODEX_HOME = tempHome;
});

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

/**
 * Write a rollout file under `$CODEX_HOME/sessions/YYYY/MM/DD/` ending
 * in `-<threadId>.jsonl`. Returns the absolute path written.
 */
function writeRollout(opts: {
  year: string;
  month: string;
  day: string;
  threadId: string;
  events: unknown[];
}): string {
  const dir = join(tempHome, "sessions", opts.year, opts.month, opts.day);
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `rollout-${opts.year}-${opts.month}-${opts.day}T00-00-00-${opts.threadId}.jsonl`,
  );
  const body = opts.events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(file, body);
  return file;
}

/** Minimal valid `token_count` event matching what Codex CLI emits. */
function tokenCountEvent(opts: {
  lastInput: number;
  lastCached?: number;
  contextWindow?: number;
}) {
  return {
    timestamp: "2026-05-21T00:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: opts.lastInput,
          cached_input_tokens: opts.lastCached ?? 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: opts.lastInput,
        },
        last_token_usage: {
          input_tokens: opts.lastInput,
          cached_input_tokens: opts.lastCached ?? 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: opts.lastInput,
        },
        model_context_window: opts.contextWindow,
      },
    },
  };
}

describe("readLastTokenCount", () => {
  it("returns null when sessions/ directory doesn't exist", async () => {
    const result = await readLastTokenCount("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when no rollout matches the thread_id", async () => {
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "019e4b4b-a545-70a2-a23f-15529f3a0083",
      events: [tokenCountEvent({ lastInput: 100, contextWindow: 200000 })],
    });
    const result = await readLastTokenCount("019e4b4b-different-thread-id");
    expect(result).toBeNull();
  });

  it("reads last_token_usage.input_tokens as contextTokens", async () => {
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "thread-1",
      events: [tokenCountEvent({ lastInput: 98088, contextWindow: 258400 })],
    });
    const result = await readLastTokenCount("thread-1");
    expect(result).toEqual({ contextTokens: 98088, contextWindow: 258400 });
  });

  it("returns the LAST token_count event (per-call view, not cumulative)", async () => {
    // Mirrors the real multi-call session shape: each token_count event's
    // last_token_usage represents that call's prompt size. The reader must
    // return the LATEST one — that's the current context fill at end-of-turn.
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "thread-multi",
      events: [
        tokenCountEvent({ lastInput: 99881, contextWindow: 272000 }),
        tokenCountEvent({ lastInput: 109771, contextWindow: 272000 }),
        tokenCountEvent({ lastInput: 152598, contextWindow: 272000 }),
      ],
    });
    const result = await readLastTokenCount("thread-multi");
    expect(result?.contextTokens).toBe(152598);
    expect(result?.contextWindow).toBe(272000);
  });

  it("walks newest date directories first", async () => {
    // Same thread_id, two different days. The newer one's value should win.
    writeRollout({
      year: "2026",
      month: "05",
      day: "20",
      threadId: "thread-walked",
      events: [tokenCountEvent({ lastInput: 50000, contextWindow: 272000 })],
    });
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "thread-walked",
      events: [tokenCountEvent({ lastInput: 95000, contextWindow: 272000 })],
    });
    const result = await readLastTokenCount("thread-walked");
    expect(result?.contextTokens).toBe(95000);
  });

  it("returns contextWindow undefined when not present in the event", async () => {
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "thread-no-window",
      events: [tokenCountEvent({ lastInput: 100 })],
    });
    const result = await readLastTokenCount("thread-no-window");
    expect(result?.contextTokens).toBe(100);
    expect(result?.contextWindow).toBeUndefined();
  });

  it("skips malformed JSON lines and continues scanning backwards", async () => {
    const dir = join(tempHome, "sessions", "2026", "05", "21");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-2026-05-21T00-00-00-malformed.jsonl");
    // Trailing garbage on the last line (mid-write crash). The reader
    // must skip it and return the previous valid token_count event.
    const goodEvent = JSON.stringify(
      tokenCountEvent({ lastInput: 7777, contextWindow: 272000 }),
    );
    writeFileSync(
      file,
      [goodEvent, "{not valid json", '{"partial":'].join("\n"),
    );
    const result = await readLastTokenCount("malformed");
    expect(result?.contextTokens).toBe(7777);
  });

  it("returns null when rollout has no token_count events", async () => {
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "thread-no-tc",
      events: [
        {
          timestamp: "...",
          type: "response_item",
          payload: { type: "message" },
        },
        {
          timestamp: "...",
          type: "event_msg",
          payload: { type: "turn_started" },
        },
      ],
    });
    const result = await readLastTokenCount("thread-no-tc");
    expect(result).toBeNull();
  });

  it("skips token_count events with missing last_token_usage", async () => {
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "thread-missing-last",
      events: [
        // Valid event first…
        tokenCountEvent({ lastInput: 4242, contextWindow: 272000 }),
        // …then a malformed token_count later in the file (missing
        // last_token_usage). The reader walks BACKWARDS, so it sees the
        // bad one first, skips it, and finds the good one.
        {
          timestamp: "...",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { total_token_usage: { input_tokens: 9999 } },
          },
        },
      ],
    });
    const result = await readLastTokenCount("thread-missing-last");
    expect(result?.contextTokens).toBe(4242);
  });

  it("ignores empty lines in the JSONL file", async () => {
    const dir = join(tempHome, "sessions", "2026", "05", "21");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-2026-05-21T00-00-00-blank.jsonl");
    const goodEvent = JSON.stringify(
      tokenCountEvent({ lastInput: 1234, contextWindow: 100000 }),
    );
    // Trailing newlines + blank lines mid-file.
    writeFileSync(file, ["", goodEvent, "", "", ""].join("\n"));
    const result = await readLastTokenCount("blank");
    expect(result?.contextTokens).toBe(1234);
  });

  it("non-numeric or non-finite input_tokens are skipped", async () => {
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "thread-bad-input",
      events: [
        tokenCountEvent({ lastInput: 5555, contextWindow: 272000 }),
        {
          timestamp: "...",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: "not-a-number" },
              model_context_window: 272000,
            },
          },
        },
      ],
    });
    const result = await readLastTokenCount("thread-bad-input");
    // Reader skips the bad one (walking backwards) and falls back to the
    // earlier valid event.
    expect(result?.contextTokens).toBe(5555);
  });
});

// ── Rate-limits snapshot + classifier ───────────────────────────────────────
//
// These tests cover the new usage-exhausted detection layer added on top
// of the existing per-call usage reader. The same rollout JSONL carries
// rate_limits info on every `token_count` event; we read it to distinguish
// "silent exit because oauth-incompat" from "silent exit because account
// has no credits" — the 2026-05-21 case Ada flagged where a free
// ChatGPT OAuth account ran out of quota and surfaced as a silent exit-1.

/**
 * Exhausted-shape `token_count` payload — exactly the shape Codex CLI
 * wrote to Ada's rollout when his free OAuth ran out of credits.
 *
 *   info: null               — turn died before any API call returned usage
 *   rate_limits.credits.has_credits: false
 *   rate_limits.credits.balance: "0"
 *   rate_limits.limit_id: "premium"
 *   rate_limits.plan_type: null
 */
function exhaustedPayload() {
  return {
    type: "token_count",
    info: null,
    rate_limits: {
      limit_id: "premium",
      limit_name: null,
      primary: null,
      secondary: null,
      credits: {
        has_credits: false,
        unlimited: false,
        balance: "0",
      },
      plan_type: null,
      rate_limit_reached_type: null,
    },
  };
}

/**
 * Healthy-shape `token_count` payload — codex tier on plan_type "plus",
 * populated primary/secondary windows. This is what every successful
 * call writes.
 */
function healthyPayload(lastInput = 100, used = 3) {
  return {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: lastInput },
      last_token_usage: { input_tokens: lastInput },
      model_context_window: 272000,
    },
    rate_limits: {
      limit_id: "codex",
      limit_name: null,
      primary: { used_percent: used, window_minutes: 300, resets_at: 0 },
      secondary: { used_percent: 18, window_minutes: 10080, resets_at: 0 },
      credits: null,
      plan_type: "plus",
      rate_limit_reached_type: null,
    },
  };
}

describe("extractSnapshotFromTokenCountPayload", () => {
  it("extracts both usage and rate_limits from a healthy payload", () => {
    const snap = extractSnapshotFromTokenCountPayload(healthyPayload(98088));
    expect(snap.usage).toEqual({ contextTokens: 98088, contextWindow: 272000 });
    expect(snap.rateLimits).toMatchObject({
      limitId: "codex",
      planType: "plus",
      primaryUsedPercent: 3,
      secondaryUsedPercent: 18,
    });
    expect(snap.rateLimits?.hasCredits).toBeUndefined();
  });

  it("extracts rate_limits with no usage when info is null (exhausted shape)", () => {
    const snap = extractSnapshotFromTokenCountPayload(exhaustedPayload());
    expect(snap.usage).toBeUndefined();
    expect(snap.rateLimits).toMatchObject({
      limitId: "premium",
      hasCredits: false,
      creditsBalance: "0",
    });
    expect(snap.rateLimits?.planType).toBeUndefined();
  });

  it("returns empty snapshot when the payload has neither info nor rate_limits", () => {
    const snap = extractSnapshotFromTokenCountPayload({ type: "token_count" });
    expect(snap.usage).toBeUndefined();
    expect(snap.rateLimits).toBeUndefined();
    expect(snap.totals).toBeUndefined();
  });

  it("extracts cumulative totals from total_token_usage", () => {
    const snap = extractSnapshotFromTokenCountPayload({
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 5_714_742,
          cached_input_tokens: 5_414_656,
          output_tokens: 16_467,
        },
        last_token_usage: { input_tokens: 143_372 },
        model_context_window: 258_400,
      },
    });
    expect(snap.totals).toEqual({
      inputTokens: 5_714_742,
      cachedInputTokens: 5_414_656,
      outputTokens: 16_467,
    });
  });

  it("coerces missing cached/output fields in total_token_usage to 0", () => {
    const snap = extractSnapshotFromTokenCountPayload({
      type: "token_count",
      info: { total_token_usage: { input_tokens: 1000 } },
    });
    expect(snap.totals).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });

  it("omits totals when total_token_usage.input_tokens is non-numeric", () => {
    const snap = extractSnapshotFromTokenCountPayload({
      type: "token_count",
      info: { total_token_usage: { input_tokens: "nope" } },
    });
    expect(snap.totals).toBeUndefined();
  });
});

describe("classifyRateLimits", () => {
  it("classifies has_credits: false as exhausted", () => {
    const snap = extractSnapshotFromTokenCountPayload(exhaustedPayload());
    expect(classifyRateLimits(snap.rateLimits)).toBe("exhausted");
  });

  it("classifies rate_limit_reached_type populated as exhausted", () => {
    const snap = extractSnapshotFromTokenCountPayload({
      type: "token_count",
      rate_limits: { rate_limit_reached_type: "primary" },
    });
    expect(classifyRateLimits(snap.rateLimits)).toBe("exhausted");
  });

  it("classifies has_credits: true as healthy", () => {
    const snap = extractSnapshotFromTokenCountPayload({
      type: "token_count",
      rate_limits: { credits: { has_credits: true, balance: "100" } },
    });
    expect(classifyRateLimits(snap.rateLimits)).toBe("healthy");
  });

  it("classifies non-100% primary usage as healthy", () => {
    const snap = extractSnapshotFromTokenCountPayload(healthyPayload());
    expect(classifyRateLimits(snap.rateLimits)).toBe("healthy");
  });

  it("classifies undefined rate_limits as unknown", () => {
    expect(classifyRateLimits(undefined)).toBe("unknown");
  });

  it("classifies all-null rate_limits as unknown (defensive)", () => {
    const snap = extractSnapshotFromTokenCountPayload({
      type: "token_count",
      rate_limits: {},
    });
    expect(classifyRateLimits(snap.rateLimits)).toBe("unknown");
  });
});

describe("readLastRolloutSnapshot", () => {
  it("returns the most recent token_count snapshot — exhausted shape", async () => {
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "thread-exhausted",
      events: [
        {
          timestamp: "...",
          type: "event_msg",
          payload: exhaustedPayload(),
        },
      ],
    });
    const snap = await readLastRolloutSnapshot("thread-exhausted");
    expect(snap?.usage).toBeUndefined();
    expect(classifyRateLimits(snap?.rateLimits)).toBe("exhausted");
    expect(snap?.rateLimits?.limitId).toBe("premium");
    expect(snap?.numApiCalls).toBe(1);
  });

  it("does not count healthy info:null preflight token_count events as API calls", async () => {
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "thread-preflight",
      events: [
        {
          timestamp: "1",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: null,
            rate_limits: {
              limit_id: "codex",
              primary: { used_percent: 3 },
              credits: null,
              plan_type: "plus",
              rate_limit_reached_type: null,
            },
          },
        },
        { timestamp: "2", type: "event_msg", payload: healthyPayload(50_000) },
      ],
    });
    const snap = await readLastRolloutSnapshot("thread-preflight");
    expect(classifyRateLimits(snap?.rateLimits)).toBe("healthy");
    expect(snap?.numApiCalls).toBe(1);
  });

  it("returns the LAST event when a turn went healthy → exhausted", async () => {
    // Real shape: a turn might start healthy and only exhaust on a later
    // call. Reverse-scan must return the latest verdict, not an earlier
    // one.
    writeRollout({
      year: "2026",
      month: "05",
      day: "21",
      threadId: "thread-mixed",
      events: [
        { timestamp: "1", type: "event_msg", payload: healthyPayload(50_000) },
        { timestamp: "2", type: "event_msg", payload: exhaustedPayload() },
      ],
    });
    const snap = await readLastRolloutSnapshot("thread-mixed");
    expect(classifyRateLimits(snap?.rateLimits)).toBe("exhausted");
    expect(snap?.numApiCalls).toBe(2);
  });

  it("returns null when no rollout matches the thread_id", async () => {
    const result = await readLastRolloutSnapshot("nonexistent-thread");
    expect(result).toBeNull();
  });

  it("returns the LATEST cumulative totals from the rollout", async () => {
    writeRollout({
      year: "2026",
      month: "06",
      day: "12",
      threadId: "thread-totals",
      events: [
        tokenCountEvent({ lastInput: 21_252, lastCached: 2_432 }),
        tokenCountEvent({ lastInput: 45_152, lastCached: 23_296 }),
      ],
    });
    const snap = await readLastRolloutSnapshot("thread-totals");
    expect(snap?.totals).toEqual({
      inputTokens: 45_152,
      cachedInputTokens: 23_296,
      outputTokens: 0,
    });
  });

  it("backfills totals from an earlier event when the newest token_count has info:null", async () => {
    // Exhausted/preflight events write `info: null` — totals must come
    // from the most recent event that actually carried them, otherwise
    // the per-turn usage fallback in handler.ts would silently skip.
    writeRollout({
      year: "2026",
      month: "06",
      day: "12",
      threadId: "thread-totals-backfill",
      events: [
        { timestamp: "1", type: "event_msg", payload: healthyPayload(50_000) },
        { timestamp: "2", type: "event_msg", payload: exhaustedPayload() },
      ],
    });
    const snap = await readLastRolloutSnapshot("thread-totals-backfill");
    expect(snap?.totals).toEqual({
      inputTokens: 50_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });
});
