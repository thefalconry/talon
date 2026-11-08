/**
 * Unit tests for the bridge — the HTTP caller MCP servers use to dispatch
 * actions to the gateway.
 *
 * Covers:
 *   - default chatId from createBridge() becomes `_chatId` in the body
 *   - explicit `chat_id` in params promotes to `_chatId` AND stays in body
 *   - explicit `chat_id` overrides the default
 *   - non-OK HTTP responses throw a structured error
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Long-haul actions (>300s budgets) use undici's own fetch in production
// (the built-in fetch's dispatcher can't wait that long, and brand-checks
// foreign Agents). In tests, route undici's fetch through the same global
// fetch stub so every bridge call is observable via vi.stubGlobal below.
vi.mock("undici", () => ({
  Agent: class MockAgent {},
  fetch: (...args: unknown[]) =>
    (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { createBridge } from "../core/tools/bridge.js";
import { logWarn } from "../util/log.js";

describe("createBridge", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("sends action + params + default _chatId from createBridge", async () => {
    const bridge = createBridge("http://test/", "123");
    await bridge("send_message", { text: "hello" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test//action");
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toMatchObject({
      action: "send_message",
      text: "hello",
      _chatId: "123",
    });
    // No explicit chat_id — `chat_id` should NOT be in body.
    expect(body.chat_id).toBeUndefined();
  });

  it("explicit chat_id in params promotes to _chatId AND stays in body", async () => {
    // The bridge keeps `chat_id` in the body as the explicit-routing
    // signal the gateway uses to skip its active-context check. The
    // promoted `_chatId` carries the routing target.
    const bridge = createBridge("http://test/", ""); // empty default chat
    await bridge("send_message", {
      text: "hi from heartbeat",
      chat_id: 424242420,
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body).toMatchObject({
      action: "send_message",
      text: "hi from heartbeat",
      chat_id: 424242420, // stays in body — explicit-routing signal
      _chatId: "424242420", // promoted as the routing key
    });
  });

  it("explicit chat_id overrides createBridge's default chatId", async () => {
    const bridge = createBridge("http://test/", "111");
    await bridge("send_message", { text: "go to other chat", chat_id: 222 });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body._chatId).toBe("222");
  });

  it("string chat_id (Teams-style ID) is preserved exactly", async () => {
    const bridge = createBridge("http://test/", "");
    await bridge("send_message", {
      text: "to teams",
      chat_id: "teams_chat_19:abc...",
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body._chatId).toBe("teams_chat_19:abc...");
    expect(body.chat_id).toBe("teams_chat_19:abc...");
  });

  it("non-OK HTTP response throws structured error", async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "boom",
    }));

    const bridge = createBridge("http://test/", "123");
    await expect(bridge("send_message", { text: "hi" })).rejects.toThrow(
      /Bridge error \(500\): boom/,
    );
  });

  it("timeout abort throws a message naming the action and the budget", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    fetchMock.mockImplementationOnce(async () => {
      throw timeoutErr;
    });

    const bridge = createBridge("http://test/", "123");
    await expect(bridge("device_pull_file", { path: "/x" })).rejects.toThrow(
      /"device_pull_file" did not complete within 3600s/,
    );
  });

  it("an early AbortError is not reported as a timeout", async () => {
    // A socket drop / cancelled request surfaces as AbortError long before
    // the budget runs out; it must not be labelled "did not complete within".
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "AbortError";
    (abortErr as Error & { cause?: unknown }).cause = new Error(
      "other side closed",
    );
    fetchMock.mockImplementationOnce(async () => {
      throw abortErr;
    });

    const bridge = createBridge("http://test/", "123");
    const err = await bridge("device_pull_file", { path: "/x" }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).not.toMatch(/did not complete within/);
    expect(msg).toMatch(/"device_pull_file" was aborted after \d+s \(\d+ms;/);
    expect(msg).toContain("before its 3600s budget");
    expect(msg).toContain("other side closed");
    expect(vi.mocked(logWarn)).toHaveBeenCalledWith(
      "bridge",
      expect.stringMatching(
        /"device_pull_file" aborted after \d+ms \(budget 3600000ms\).*other side closed/,
      ),
    );
  });

  it("an AbortError once the budget has elapsed is still a timeout", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(async () => {
        vi.advanceTimersByTime(120_001);
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      });
      const bridge = createBridge("http://test/", "123");
      await expect(bridge("send_message", { text: "x" })).rejects.toThrow(
        /"send_message" did not complete within 120s/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("network failure throws a message naming the action", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:19876");
    });

    const bridge = createBridge("http://test/", "123");
    await expect(bridge("native_read", { path: "/x" })).rejects.toThrow(
      /"native_read" could not reach the Talon gateway.*ECONNREFUSED/,
    );
  });

  it("call with no params works (default chatId, no body extras)", async () => {
    const bridge = createBridge("http://test/", "456");
    await bridge("list_active_markets", {});

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body).toEqual({ action: "list_active_markets", _chatId: "456" });
  });

  // ── Edge cases for chat_id values ────────────────────────────────────────

  it("negative numeric chat_id (Telegram group ID) is preserved as negative", async () => {
    // Telegram supergroup IDs are negative (e.g., -1009876543210). The bridge
    // must not coerce sign — String(-1009876543210) keeps the minus prefix.
    const bridge = createBridge("http://test/", "");
    await bridge("send_message", {
      text: "to group",
      chat_id: -1009876543210,
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body._chatId).toBe("-1009876543210");
    expect(body.chat_id).toBe(-1009876543210);
  });

  it("chat_id=0 is promoted (gateway decides what to do)", async () => {
    // The bridge doesn't validate chat_id — it just routes. Whether 0 is a
    // valid chat ID is the gateway/handler's call (gateway rejects it via
    // its `if (!chatId)` falsy guard, but the bridge correctly forwards).
    const bridge = createBridge("http://test/", "");
    await bridge("send_message", { text: "zero", chat_id: 0 });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body._chatId).toBe("0");
    expect(body.chat_id).toBe(0);
  });

  it("chat_id=null is forwarded as-is (schema validates upstream)", async () => {
    // chat_id is `optional()` in the messaging.ts schema, so a null value
    // shouldn't reach here in practice. If it does, String(null) = "null"
    // — gateway will reject (no matching context), but the bridge doesn't
    // crash.
    const bridge = createBridge("http://test/", "fallback");
    await bridge("send_message", { text: "null id", chat_id: null });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    // null gets stringified to "null"; the explicit-routing path triggers
    // because chat_id IS in the body (typeof !== "undefined"), even though
    // its value is null.
    expect(body._chatId).toBe("null");
    expect(body.chat_id).toBeNull();
  });

  it("heartbeat sentinel default ('heartbeat') is overridden by explicit chat_id", async () => {
    // The heartbeat-tier MCP server is spawned with TALON_CHAT_ID="heartbeat".
    // When the model calls send() with an explicit chat_id, the bridge MUST
    // overwrite the sentinel — otherwise the gateway would route to the
    // sentinel string and fail.
    const bridge = createBridge("http://test/", "heartbeat");
    await bridge("send_message", {
      text: "outbound from heartbeat",
      chat_id: 424242420,
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body._chatId).toBe("424242420");
    // Critically NOT "heartbeat" — would be a routing-bypass bug.
    expect(body._chatId).not.toBe("heartbeat");
  });

  it("heartbeat sentinel default is forwarded as _chatId when no explicit chat_id", async () => {
    // When heartbeat-tier MCP server makes a call WITHOUT chat_id (a bug or
    // a model mistake), the gateway must see _chatId="heartbeat" so its
    // explicit-routing guard (rawChatId !== "heartbeat") kicks in and falls
    // through to the rejection path. The bridge's job is just to forward.
    const bridge = createBridge("http://test/", "heartbeat");
    await bridge("send_message", { text: "no chat_id" });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body._chatId).toBe("heartbeat");
    expect(body.chat_id).toBeUndefined();
  });

  it("string chat_id with leading zeros preserved exactly (no number coercion)", async () => {
    // Edge case: user passes chat_id="000123" as a string. The bridge does
    // String(chat_id) which is identity for strings, so "000123" stays.
    const bridge = createBridge("http://test/", "");
    await bridge("send_message", { text: "leading zeros", chat_id: "000123" });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body._chatId).toBe("000123");
  });
});

describe("textResult", () => {
  it("marks ok:false gateway results as tool errors", async () => {
    const { textResult } = await import("../core/tools/bridge.js");
    const fail = textResult({ ok: false, text: "device offline" });
    expect(fail.isError).toBe(true);
    const failText = fail.content[0];
    expect(failText.type).toBe("text");
    if (failText.type === "text") expect(failText.text).toBe("device offline");

    const good = textResult({ ok: true, text: "done" });
    expect(good.isError).toBeUndefined();

    // Results without an ok field (raw payloads) are never marked as errors.
    const raw = textResult({ text: "plain" });
    expect(raw.isError).toBeUndefined();
  });

  it("surfaces an image result as an MCP image content block", async () => {
    const { textResult } = await import("../core/tools/bridge.js");
    const res = textResult({
      ok: true,
      text: "/tmp/pic.jpg [local] — image (image/jpeg, 3 bytes)",
      image: { data: "AAEC", mimeType: "image/jpeg" },
    });
    expect(res.isError).toBeUndefined();
    // Text note first, then the viewable image block.
    expect(res.content).toHaveLength(2);
    expect(res.content[0].type).toBe("text");
    const img = res.content[1];
    expect(img.type).toBe("image");
    if (img.type === "image") {
      expect(img.data).toBe("AAEC");
      expect(img.mimeType).toBe("image/jpeg");
    }
  });

  it("ignores a malformed image field (no bogus block)", async () => {
    const { textResult } = await import("../core/tools/bridge.js");
    const res = textResult({
      ok: true,
      text: "plain",
      image: { data: 123, mimeType: "image/png" },
    });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
  });
});
