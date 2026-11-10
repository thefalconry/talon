/**
 * The prompt-cache overlay (storage/prompt-cache.ts) idle compaction is
 * anchored on: TTL observed from the cache write, inherited across reads.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPromptCache,
  getPromptCache,
  notePromptCacheRateLimit,
  notePromptCacheRequest,
} from "../storage/sessions.js";

beforeEach(() => clearPromptCache("c1"));

describe("prompt-cache observation", () => {
  it("reads 1 h from a write of only ephemeral_1h tokens", () => {
    notePromptCacheRequest("c1", {
      at: 10,
      cacheWrite: 1_000,
      cacheWrite1h: 1_000,
      cacheWrite5m: 0,
    });
    expect(getPromptCache("c1")).toEqual({
      lastRequestAt: 10,
      cached: true,
      ttlMs: 3_600_000,
    });
  });

  it("reads 5 min when any 5-minute tokens were written (they expire first)", () => {
    notePromptCacheRequest("c1", {
      at: 10,
      cacheWrite: 1_000,
      cacheWrite1h: 900,
      cacheWrite5m: 100,
    });
    expect(getPromptCache("c1")?.ttlMs).toBe(300_000);
    notePromptCacheRequest("c1", {
      at: 20,
      cacheWrite: 1_000,
      cacheWrite1h: 1_000,
    });
    expect(getPromptCache("c1")?.ttlMs).toBe(3_600_000);
    notePromptCacheRequest("c1", {
      at: 30,
      cacheWrite: 1_000,
      cacheWrite5m: 1_000,
    });
    expect(getPromptCache("c1")?.ttlMs).toBe(300_000);
  });

  it("inherits the TTL on a request that wrote nothing", () => {
    notePromptCacheRequest("c1", {
      at: 10,
      cacheWrite: 1_000,
      cacheWrite1h: 1_000,
      modelId: "opus-x",
    });
    notePromptCacheRequest("c1", { at: 20, cacheRead: 1_000, cacheWrite: 0 });
    expect(getPromptCache("c1")).toEqual({
      lastRequestAt: 20,
      cached: true,
      ttlMs: 3_600_000,
    });
  });

  it("forgets the TTL on a write with no ephemeral breakdown (Claude Code's rule)", () => {
    notePromptCacheRequest("c1", {
      at: 10,
      cacheWrite: 1_000,
      cacheWrite1h: 1_000,
    });
    notePromptCacheRequest("c1", { at: 20, cacheWrite: 500 });
    expect(getPromptCache("c1")).toEqual({ lastRequestAt: 20, cached: true });
    notePromptCacheRequest("c1", {
      at: 30,
      cacheWrite: 500,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
    });
    expect(getPromptCache("c1")?.ttlMs).toBeUndefined();
    // A later read inherits nothing to arm on.
    notePromptCacheRequest("c1", { at: 40, cacheRead: 1_000 });
    expect(getPromptCache("c1")?.ttlMs).toBeUndefined();
  });

  it("is unknown until a write is seen, and uncached when nothing was read or written", () => {
    notePromptCacheRequest("c1", { at: 10, cacheRead: 0, cacheWrite: 0 });
    expect(getPromptCache("c1")).toEqual({ lastRequestAt: 10, cached: false });
  });

  it("keeps the rate-limit status seen before the first request", () => {
    notePromptCacheRateLimit("c1", "allowed_warning");
    expect(getPromptCache("c1")).toBeUndefined();
    notePromptCacheRequest("c1", { at: 10 });
    expect(getPromptCache("c1")?.rateLimitStatus).toBe("allowed_warning");
    clearPromptCache("c1");
    notePromptCacheRequest("c1", { at: 11 });
    expect(getPromptCache("c1")?.rateLimitStatus).toBeUndefined();
  });
});
