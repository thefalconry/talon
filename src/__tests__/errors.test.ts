import { describe, it, expect } from "vitest";
import { TalonError, classify, friendlyMessage } from "../core/errors.js";

describe("classify", () => {
  it("classifies rate limit errors", () => {
    const err = classify(new Error("429 Too Many Requests"));
    expect(err.reason).toBe("rate_limit");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
  });

  it("extracts retry-after from rate limit", () => {
    const err = classify(new Error("rate limit, retry after 30 seconds"));
    expect(err.reason).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(30000);
  });

  it("classifies overloaded errors", () => {
    const err = classify(new Error("503 Service Unavailable"));
    expect(err.reason).toBe("overloaded");
    expect(err.retryable).toBe(true);
  });

  it("classifies generic 5xx as overloaded", () => {
    const err = classify(new Error("502 Bad Gateway"));
    expect(err.reason).toBe("overloaded");
    expect(err.retryable).toBe(true);
  });

  it("classifies network errors", () => {
    expect(classify(new Error("ECONNREFUSED")).reason).toBe("network");
    expect(classify(new Error("fetch failed")).reason).toBe("network");
    expect(classify(new Error("ETIMEDOUT")).reason).toBe("network");
    expect(classify(new Error("ENOTFOUND")).reason).toBe("network");
  });

  // Transient transport failures that used to fall through to
  // `unknown`/non-retryable, so `withRetry`, the backend retry ladder,
  // and the frontend send queues all gave up on a blip instead of
  // retrying. Every entry here is a real Node/undici/proxy message.
  describe("transient transport failures are retryable", () => {
    const transient = [
      "socket hang up",
      "other side closed",
      "Premature close",
      "getaddrinfo EAI_AGAIN api.anthropic.com",
      "write EPIPE",
      "The operation was aborted due to timeout",
      "Request timed out.",
      "Headers Timeout Error",
      "UND_ERR_CONNECT_TIMEOUT",
      "Client network socket disconnected before secure TLS connection was established",
      "upstream connect error or disconnect/reset before headers",
      "Internal Server Error",
      "Bad Gateway",
      "Gateway Timeout",
    ];
    for (const message of transient) {
      it(`retries: ${message}`, () => {
        const err = classify(new Error(message));
        expect(err.retryable).toBe(true);
      });
    }
  });

  // undici reports the real fault on the cause chain and leaves the
  // top-level message contentless ("fetch failed", "terminated"), so
  // message-only matching misses it entirely.
  it("finds a transport code nested on the cause chain", () => {
    const err = classify(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("terminated"), {
          code: "UND_ERR_SOCKET",
        }),
      }),
    );
    expect(err.reason).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("walks more than one level of cause nesting", () => {
    const err = classify(
      new TypeError("opaque", {
        cause: new Error("wrapper", {
          cause: Object.assign(new Error("inner"), { code: "ECONNRESET" }),
        }),
      }),
    );
    expect(err.retryable).toBe(true);
  });

  it("treats TimeoutError by name as a retryable deadline", () => {
    const err = new Error("no useful text");
    err.name = "TimeoutError";
    expect(classify(err).retryable).toBe(true);
  });

  // The counterpart to the timeout rule, and the reason bare "abort" is
  // NOT in the transient set: an interrupt is the user saying stop.
  // Retrying it would restart the work they just cancelled.
  it("keeps a user interrupt non-retryable", () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    expect(classify(err).retryable).toBe(false);
    expect(classify(new Error("MessageAborted")).retryable).toBe(false);
    expect(classify(new Error("aborted")).retryable).toBe(false);
  });

  // A DNS name that does not resolve is a config error; retrying just
  // burns the ladder. EAI_AGAIN (temporary resolver failure) does retry.
  it("does not treat a permanently unresolvable host as retryable via code", () => {
    const err = classify(
      Object.assign(new Error("getaddrinfo ENOTFOUND nope.invalid"), {
        code: "ENOTFOUND",
      }),
    );
    // Still `network` via the long-standing message rule, but the code
    // set deliberately excludes ENOTFOUND.
    expect(err.reason).toBe("network");
  });

  it("leaves programmer-error guards as non-retryable unknown", () => {
    for (const message of [
      "Dispatcher not initialized",
      'Unknown backend "gpt5" — known: claude',
      'Backend role "chat" not bound',
      "Heartbeat already running",
    ]) {
      const err = classify(new Error(message));
      expect(err.reason).toBe("unknown");
      expect(err.retryable).toBe(false);
    }
  });

  it("classifies session expired errors", () => {
    const err = classify(new Error("session expired"));
    expect(err.reason).toBe("session_expired");
    expect(err.retryable).toBe(false);
  });

  it("classifies context length errors", () => {
    const err = classify(new Error("context length exceeded"));
    expect(err.reason).toBe("context_length");
    expect(err.retryable).toBe(false);
  });

  it("classifies auth errors", () => {
    const err = classify(new Error("401 Unauthorized"));
    expect(err.reason).toBe("auth");
    expect(err.retryable).toBe(false);
  });

  it("classifies auth errors without status code — covers L128 ?? 401 fallback", () => {
    // "authentication failed" has no numeric status → status=undefined → status ?? 401 = 401
    const err = classify(new Error("authentication failed"));
    expect(err.reason).toBe("auth");
    expect(err.status).toBe(401);
  });

  it("classifies 400 as bad_request", () => {
    const err = classify(new Error("400 Bad Request"));
    expect(err.reason).toBe("bad_request");
    expect(err.retryable).toBe(false);
  });

  it("classifies 403 as forbidden", () => {
    const err = classify(new Error("403 Forbidden"));
    expect(err.reason).toBe("forbidden");
    expect(err.retryable).toBe(false);
  });

  it("returns unknown for unrecognized errors", () => {
    const err = classify(new Error("something weird"));
    expect(err.reason).toBe("unknown");
    expect(err.retryable).toBe(false);
  });

  it("passes through TalonError unchanged", () => {
    const original = new TalonError("test", {
      reason: "rate_limit",
      retryable: true,
    });
    expect(classify(original)).toBe(original);
  });

  it("handles string errors", () => {
    const err = classify("rate limit hit");
    expect(err.reason).toBe("rate_limit");
  });

  it("handles non-Error objects", () => {
    const err = classify(42);
    expect(err.reason).toBe("unknown");
  });

  it("covers inner catch when String(err) throws — non-stringifiable object (L62)", () => {
    const bad = {
      toString() {
        throw new Error("no string");
      },
      [Symbol.toPrimitive]() {
        throw new Error("no primitive");
      },
    };
    const err = classify(bad);
    expect(err.reason).toBe("unknown");
    expect(err.message).toBe("[non-stringifiable error]");
  });

  // Additional classify coverage for network variants
  it("classifies ECONNRESET as network", () => {
    expect(classify(new Error("ECONNRESET")).reason).toBe("network");
  });

  it("classifies ECONNABORTED as network", () => {
    expect(classify(new Error("ECONNABORTED")).reason).toBe("network");
  });

  it("classifies 'connection reset' as network", () => {
    expect(classify(new Error("connection reset by peer")).reason).toBe(
      "network",
    );
  });

  it("classifies Claude's 'No conversation found' as session_expired", () => {
    expect(
      classify(
        new Error(
          "No conversation found with session ID: 0f3c6a9e-1111-2222-3333-444455556666",
        ),
      ).reason,
    ).toBe("session_expired");
  });

  it("classifies 'invalid.*resume' as session_expired", () => {
    expect(
      classify(new Error("invalid session, resume not possible")).reason,
    ).toBe("session_expired");
  });

  it("classifies 'too long' as context_length", () => {
    expect(classify(new Error("message is too long")).reason).toBe(
      "context_length",
    );
  });

  it("classifies 'token limit' as context_length", () => {
    expect(classify(new Error("token limit exceeded")).reason).toBe(
      "context_length",
    );
  });

  it("classifies 'api_key' as auth", () => {
    expect(classify(new Error("invalid api_key provided")).reason).toBe("auth");
  });

  it("preserves original error as cause", () => {
    const original = new Error("503 overloaded");
    const err = classify(original);
    expect(err.cause).toBe(original);
  });

  it("classifies 500 as retryable server error", () => {
    const err = classify(new Error("500 Internal Server Error"));
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(500);
  });

  it("classifies 504 as retryable", () => {
    const err = classify(new Error("504 Gateway Timeout"));
    expect(err.retryable).toBe(true);
  });

  it("classifies ENOTFOUND as network error", () => {
    const err = classify(new Error("ENOTFOUND"));
    expect(err.reason).toBe("network");
    expect(err.retryable).toBe(true);
  });

  // Mutant killers: rate.?limit regex — .? allows optional char between rate and limit
  it("matches 'rate limit' with space (rate.?limit regex)", () => {
    const err = classify(new Error("rate limit exceeded"));
    expect(err.reason).toBe("rate_limit");
  });

  it("matches 'ratelimit' without space (rate.?limit regex)", () => {
    const err = classify(new Error("ratelimit exceeded"));
    expect(err.reason).toBe("rate_limit");
  });

  // Mutant killers: retry.?after regex — .? allows optional char between retry and after
  it("extracts retry-after with no separator (retryafter60)", () => {
    const err = classify(new Error("ratelimit retryafter60"));
    expect(err.reason).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(60_000);
  });

  it("extracts retry-after with hyphen separator (retry-after: 60)", () => {
    const err = classify(new Error("rate limit hit, retry-after: 60"));
    expect(err.reason).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(60_000);
  });

  // Mutant killers: status ?? 429 — default status when no status code in message
  it("defaults to status 429 when rate limit message has no status code", () => {
    const err = classify(new Error("rate limit exceeded, please slow down"));
    expect(err.reason).toBe("rate_limit");
    expect(err.status).toBe(429);
  });

  it("uses extracted status instead of 429 default when status present", () => {
    // The status regex now only matches 4xx/5xx error codes — 2xx/3xx values
    // appearing in error messages (e.g. "took 200ms", "position 301") are
    // ignored to avoid spurious status stamps. Use a 4xx code that does not
    // trigger another classifier branch to verify extraction still works.
    const err = classify(new Error("rate limit hit, error 418 teapot"));
    expect(err.reason).toBe("rate_limit");
    expect(err.status).toBe(418);
  });

  it("ignores 2xx/3xx numbers in error messages (status regex narrowed to 4xx/5xx)", () => {
    // Regression for the spurious-status bug: numbers like "200ms" or
    // "position 301" used to be extracted as TalonError.status, polluting
    // diagnostic logs. The classifier should fall back to the rate_limit
    // default (429) instead of stamping the unrelated number.
    const err = classify(new Error("rate limit hit, took 200ms"));
    expect(err.reason).toBe("rate_limit");
    expect(err.status).toBe(429);
  });

  // Mutant killers: overloaded/503/capacity branch
  it("classifies 'overloaded' keyword as overloaded", () => {
    const err = classify(new Error("API is overloaded"));
    expect(err.reason).toBe("overloaded");
    expect(err.retryable).toBe(true);
  });

  it("classifies 'capacity' keyword as overloaded", () => {
    const err = classify(new Error("at capacity, try again later"));
    expect(err.reason).toBe("overloaded");
    expect(err.retryable).toBe(true);
  });

  // Mutant killers: status ?? 503 for overloaded branch
  it("defaults to status 503 when overloaded message has no status code", () => {
    const err = classify(new Error("server is overloaded please wait"));
    expect(err.reason).toBe("overloaded");
    expect(err.status).toBe(503);
  });

  it("uses extracted status instead of 503 default for overloaded", () => {
    // "503" is in the message so status would be 503 anyway — use a message with overloaded keyword + different status
    const err = classify(new Error("overloaded, returned 502"));
    expect(err.reason).toBe("overloaded");
    expect(err.status).toBe(502);
  });

  // Mutant killers: context.*length regex — .* allows any chars between context and length
  it("matches 'context length exceeded' (space between context and length)", () => {
    const err = classify(new Error("context length exceeded"));
    expect(err.reason).toBe("context_length");
  });

  it("matches 'context_length_exceeded' (underscore between context and length)", () => {
    const err = classify(new Error("context_length_exceeded"));
    expect(err.reason).toBe("context_length");
  });

  // Claude subscription usage limits — the SDK surfaces these as user-facing
  // text (rateLimitMessages.ts upstream), not as a 429-marked error.
  it("classifies Claude Code limit messages as usage_limit (not retryable)", () => {
    for (const msg of [
      "You've hit your weekly limit · resets Jul 10, 9am",
      "You’ve hit your Opus limit · resets 3am", // curly apostrophe variant
      "You've hit your session limit",
      "You're out of extra usage · resets Jul 12, 1pm",
      "Claude AI usage limit reached|1751234567",
    ]) {
      const err = classify(new Error(msg));
      expect(err.reason, msg).toBe("usage_limit");
      expect(err.retryable, msg).toBe(false);
    }
  });

  it("does not confuse usage limits with generic rate limits", () => {
    expect(classify(new Error("429 Too Many Requests")).reason).toBe(
      "rate_limit",
    );
    expect(classify(new Error("You've hit your weekly limit")).reason).toBe(
      "usage_limit",
    );
  });
});

describe("friendlyMessage", () => {
  it("returns rate limit message with retry time", () => {
    const err = new TalonError("x", {
      reason: "rate_limit",
      retryAfterMs: 30000,
    });
    expect(friendlyMessage(err)).toContain("30 seconds");
  });

  it("returns overloaded message", () => {
    expect(friendlyMessage(new Error("503"))).toContain("busy");
  });

  it("returns network error message", () => {
    expect(friendlyMessage(new Error("ECONNREFUSED"))).toContain("Connection");
  });

  it("returns context length message with /reset", () => {
    const msg = friendlyMessage(new Error("context length exceeded"));
    expect(msg).toContain("/reset");
  });

  it("passes through session expired messages as-is", () => {
    const msg = "Session expired. Send your message again.";
    const err = new TalonError(msg, { reason: "session_expired" });
    expect(friendlyMessage(err)).toBe(msg);
  });

  it("classifies raw errors before generating message", () => {
    expect(friendlyMessage(new Error("some random failure"))).toContain(
      "Something went wrong",
    );
  });

  it("returns generic rate limit message when retryAfterMs is absent", () => {
    const err = new TalonError("x", { reason: "rate_limit", retryable: true });
    // No retryAfterMs → falls through to FRIENDLY_MESSAGES["rate_limit"]
    expect(friendlyMessage(err)).toContain("Rate limited");
    expect(friendlyMessage(err)).not.toContain("seconds");
  });

  it("returns auth message", () => {
    expect(friendlyMessage(new Error("401 Unauthorized"))).toContain("API key");
  });

  it("returns bad_request message", () => {
    expect(friendlyMessage(new Error("400 Bad Request"))).toContain(
      "Something went wrong",
    );
  });

  it("returns forbidden message", () => {
    expect(friendlyMessage(new Error("403 Forbidden"))).toContain("Permission");
  });

  it("returns telegram_api message", () => {
    const err = new TalonError("Telegram failed", { reason: "telegram_api" });
    expect(friendlyMessage(err)).toContain("Telegram API");
  });

  it("passes usage-limit messages through verbatim", () => {
    const msg = "You've hit your weekly limit · resets Jul 10, 9am";
    expect(friendlyMessage(new Error(msg))).toBe(msg);
  });

  it("falls back to the usage_limit template when the message is empty", () => {
    const err = new TalonError("", { reason: "usage_limit" });
    expect(friendlyMessage(err)).toContain("Usage limit reached");
  });

  it("appends the underlying detail for unknown errors", () => {
    const msg = friendlyMessage(new Error("spawn ENOENT /usr/bin/rg"));
    expect(msg).toContain("Something went wrong");
    expect(msg).toContain("spawn ENOENT /usr/bin/rg");
  });

  it("appends the underlying detail for auth errors", () => {
    const msg = friendlyMessage(new Error("401 invalid x-api-key header"));
    expect(msg).toContain("API key");
    expect(msg).toContain("invalid x-api-key");
  });

  it("clips long details and collapses whitespace", () => {
    const long = `boom ${"x".repeat(500)}\n\nnext   line`;
    const msg = friendlyMessage(new Error(long));
    expect(msg.length).toBeLessThan(400);
    expect(msg).not.toContain("\n\nnext");
  });

  it("keeps transient reasons terse (no detail appended)", () => {
    expect(friendlyMessage(new Error("ECONNREFUSED 1.2.3.4"))).not.toContain(
      "1.2.3.4",
    );
  });
});

describe("TalonError", () => {
  it("is an instanceof Error", () => {
    const err = new TalonError("test", { reason: "unknown" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TalonError);
  });

  it("has correct name", () => {
    const err = new TalonError("test", { reason: "rate_limit" });
    expect(err.name).toBe("TalonError");
  });

  it("defaults retryable to false", () => {
    const err = new TalonError("test", { reason: "unknown" });
    expect(err.retryable).toBe(false);
  });

  it("preserves cause", () => {
    const cause = new Error("original");
    const err = new TalonError("wrapped", { reason: "unknown", cause });
    expect(err.cause).toBe(cause);
  });
});
