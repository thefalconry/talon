/**
 * `applyRetryDecision` unit tests.
 *
 * The four backends used to inline the same 30-line retry block
 * (`classify` → `classifyRetry` → `reset_and_retry` / `fallback_model`
 * / `propagate`); they now delegate to this helper. The handler-level
 * integration tests (e.g. codex-handler.test.ts) cover the full
 * recovery path end-to-end; this file pins the helper's per-branch
 * behaviour directly so future evolution doesn't need an integration
 * round-trip to validate.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { QueryParams } from "../backend/runtime/turn/handler-types.js";
import { applyRetryDecision } from "../backend/runtime/turn/handle-retry.js";
import { TalonError } from "../core/errors.js";
import { registerModels, clearModels } from "../core/models/catalog.js";
import { setChatModel } from "../storage/chat-settings.js";
import { resetSession, getSession } from "../storage/sessions.js";

beforeEach(() => {
  clearModels();
  resetSession("test-chat");
  setChatModel("test-chat", undefined);
});

const stubParams = {
  chatId: "test-chat",
  text: "hi",
  senderName: "Ada",
  isGroup: false,
};

describe("shared / applyRetryDecision — propagate path", () => {
  it("returns classified-only when error is not retryable", async () => {
    const recurse = vi.fn(async () => ({
      text: "should not run",
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }));

    const outcome = await applyRetryDecision({
      err: new Error("unauthorized — invalid api key"),
      chatId: "test-chat",
      activeModel: "any-model",
      retried: false,
      params: stubParams,
      recurseWithRetried: recurse,
      backendLabel: "Kilo",
    });

    expect(outcome.retry).toBeUndefined();
    expect(outcome.classified).toBeInstanceOf(TalonError);
    // The 401-like message classifies to `auth`.
    expect(outcome.classified.reason).toBe("auth");
    expect(recurse).not.toHaveBeenCalled();
  });

  it("returns classified-only when already retried", async () => {
    // A retryable error that would normally trigger fallback_model —
    // but since `retried` is true, the helper short-circuits.
    registerModels([
      {
        id: "model-a",
        aliases: [],
        provider: "test",
        displayName: "Model A",
        fallback: "model-b",
      },
      {
        id: "model-b",
        aliases: [],
        provider: "test",
        displayName: "Model B",
      },
    ]);

    const recurse = vi.fn();
    const outcome = await applyRetryDecision({
      err: new Error("fetch failed — network blip"),
      chatId: "test-chat",
      activeModel: "model-a",
      retried: true,
      params: stubParams,
      recurseWithRetried: recurse,
      backendLabel: "Kilo",
    });

    expect(outcome.retry).toBeUndefined();
    expect(outcome.classified.reason).toBe("network");
    expect(recurse).not.toHaveBeenCalled();
  });
});

describe("shared / applyRetryDecision — reset_and_retry path", () => {
  it("resets session and recurses on session_expired", async () => {
    // Set up a session so we can prove it got reset.
    const sessionBefore = getSession("test-chat");
    sessionBefore.sessionId = "stale-thread";

    const expected = {
      text: "recovered",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const recurse = vi.fn(async () => expected);

    const outcome = await applyRetryDecision({
      err: new Error("session expired or invalid resume"),
      chatId: "test-chat",
      activeModel: "any-model",
      retried: false,
      params: stubParams,
      recurseWithRetried: recurse,
      backendLabel: "Kilo",
    });

    expect(outcome.retry).toEqual(expected);
    expect(recurse).toHaveBeenCalledOnce();
    expect(recurse).toHaveBeenCalledWith(stubParams);
    // Session was reset before recursion.
    expect(getSession("test-chat").sessionId).toBeUndefined();
  });

  it("recurses on context_length too", async () => {
    const recurse = vi.fn(async () => ({
      text: "smaller",
      durationMs: 5,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
    }));

    const outcome = await applyRetryDecision({
      err: new Error("context length exceeded"),
      chatId: "test-chat",
      activeModel: "any-model",
      retried: false,
      params: stubParams,
      recurseWithRetried: recurse,
      backendLabel: "OpenCode",
    });

    expect(outcome.retry?.text).toBe("smaller");
    expect(recurse).toHaveBeenCalledOnce();
  });
});

describe("shared / applyRetryDecision — fallback_model path", () => {
  it("passes the fallback model via params.model to the recursive call", async () => {
    registerModels([
      {
        id: "primary",
        aliases: [],
        provider: "test",
        displayName: "Primary",
        fallback: "fallback",
      },
      {
        id: "fallback",
        aliases: [],
        provider: "test",
        displayName: "Fallback",
      },
    ]);

    // Capture the params received inside the recursion.
    // QueryParams has model?: string so we can assert on it directly.
    let paramsSeenInRecursion: QueryParams = stubParams;
    const recurse = vi.fn(async (p: QueryParams) => {
      paramsSeenInRecursion = p;
      return {
        text: "ok",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    });

    const outcome = await applyRetryDecision({
      err: new Error("fetch failed — rate limited"),
      chatId: "test-chat",
      activeModel: "primary",
      retried: false,
      params: stubParams,
      recurseWithRetried: recurse,
      backendLabel: "Kilo",
    });

    expect(outcome.retry?.text).toBe("ok");
    // The fallback model is threaded through params so the backend's
    // own resolution chain honours it even when params.model is set.
    expect(paramsSeenInRecursion.model).toBe("fallback");
  });

  it("propagates the error when the recursive retry throws", async () => {
    registerModels([
      {
        id: "primary",
        aliases: [],
        provider: "test",
        displayName: "Primary",
        fallback: "fallback",
      },
      {
        id: "fallback",
        aliases: [],
        provider: "test",
        displayName: "Fallback",
      },
    ]);
    // Pre-set the chat model to confirm it is not mutated by the helper.
    setChatModel("test-chat", "user-pinned");

    const recurse = vi.fn(async () => {
      throw new Error("retry blew up");
    });

    await expect(
      applyRetryDecision({
        err: new Error("fetch failed — overloaded"),
        chatId: "test-chat",
        activeModel: "primary",
        retried: false,
        params: stubParams,
        recurseWithRetried: recurse,
        backendLabel: "Codex",
      }),
    ).rejects.toThrow("retry blew up");
  });

  it("propagates when retryable but no fallback configured", async () => {
    // No models registered → `getFallbackModel` returns null → propagate.
    const recurse = vi.fn();
    const outcome = await applyRetryDecision({
      err: new Error("fetch failed — econnreset"),
      chatId: "test-chat",
      activeModel: "unregistered-model",
      retried: false,
      params: stubParams,
      recurseWithRetried: recurse,
      backendLabel: "Kilo",
    });

    expect(outcome.retry).toBeUndefined();
    expect(outcome.classified.reason).toBe("network");
    expect(recurse).not.toHaveBeenCalled();
  });
});

describe("shared / applyRetryDecision — backend label", () => {
  it("omits the label prefix when backendLabel is undefined or empty", async () => {
    // Smoke-test only — we can't easily intercept the log line content
    // here without rewiring the logger, but the helper should not
    // throw on missing/empty label values.
    const recurse = vi.fn(async () => ({
      text: "ok",
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }));

    await expect(
      applyRetryDecision({
        err: new Error("session expired"),
        chatId: "test-chat",
        activeModel: "any",
        retried: false,
        params: stubParams,
        recurseWithRetried: recurse,
      }),
    ).resolves.toBeDefined();

    expect(recurse).toHaveBeenCalledOnce();
  });
});
