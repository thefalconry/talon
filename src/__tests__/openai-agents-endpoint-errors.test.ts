/**
 * Endpoint-error normalisation for OpenAI-compatible servers that answer a
 * rejected request with HTTP 200 and a bare `{"error": …}` body.
 */

import { describe, it, expect } from "vitest";
import {
  bareErrorOf,
  errorBodyFetch,
  isContextLengthError,
  isNonRetryableEndpointError,
  normalizeErrorBody,
} from "../backend/openai-agents/guards/endpoint-errors.js";

const CONTEXT_ERROR = {
  error: {
    code: 400,
    message:
      "request (154551 tokens) exceeds the available context size (32768 tokens)",
    type: "exceed_context_size_error",
  },
};

/** A response whose body arrives in the given chunks. */
function chunked(
  parts: string[],
  init: ResponseInit = { status: 200 },
): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  return new Response(body, init);
}

describe("openai-agents / endpoint errors: bareErrorOf", () => {
  it("finds a bare error object", () => {
    expect(bareErrorOf(JSON.stringify(CONTEXT_ERROR))).toMatchObject({
      code: 400,
    });
    expect(bareErrorOf('{"error":"nope"}')).toEqual({ message: "nope" });
  });

  it("ignores real payloads, null errors and non-JSON", () => {
    // A Responses-API object carries `error: null` next to `output`.
    expect(bareErrorOf('{"id":"r","error":null,"output":[]}')).toBeNull();
    expect(
      bareErrorOf('{"error":{"message":"x"},"choices":[{"index":0}]}'),
    ).toBeNull();
    expect(bareErrorOf('{"error":null}')).toBeNull();
    expect(bareErrorOf("data: {}")).toBeNull();
  });
});

describe("openai-agents / endpoint errors: normalizeErrorBody", () => {
  it("turns a 200 event-stream bare error into the HTTP error it stands for", async () => {
    const res = await normalizeErrorBody(
      chunked(
        [
          "  ",
          JSON.stringify(CONTEXT_ERROR).slice(0, 20),
          JSON.stringify(CONTEXT_ERROR).slice(20),
        ],
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual(CONTEXT_ERROR);
  });

  it("uses 400 when the error has no HTTP status, and keeps 5xx/429 codes", async () => {
    const plain = await normalizeErrorBody(
      chunked(['{"error":{"message":"bad"}}']),
    );
    expect(plain.status).toBe(400);
    const busy = await normalizeErrorBody(
      chunked(['{"error":{"code":503,"message":"loading model"}}']),
    );
    expect(busy.status).toBe(503);
  });

  it("passes an SSE stream through byte-for-byte", async () => {
    const parts = [
      'data: {"a":1}\n\n',
      'data: {"b":2}\n\n',
      "data: [DONE]\n\n",
    ];
    const res = await normalizeErrorBody(
      chunked(parts, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(parts.join(""));
  });

  it("passes a normal JSON completion through", async () => {
    const body =
      '{"id":"c","choices":[{"index":0,"message":{"content":"hi"}}]}';
    const res = await normalizeErrorBody(chunked([body]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });

  it("leaves non-2xx responses alone", async () => {
    const res = new Response("{}", { status: 401 });
    expect(await normalizeErrorBody(res)).toBe(res);
  });

  it("errorBodyFetch applies it to whatever fetch it wraps", async () => {
    const f = errorBodyFetch(async () =>
      chunked([JSON.stringify(CONTEXT_ERROR)]),
    );
    const res = await f("http://x/v1/chat/completions");
    expect(res.status).toBe(400);
  });
});

describe("openai-agents / endpoint errors: classification", () => {
  it("treats 4xx other than 408/409/429 as non-retryable", () => {
    expect(isNonRetryableEndpointError({ status: 400 })).toBe(true);
    expect(isNonRetryableEndpointError({ status: 413 })).toBe(true);
    expect(isNonRetryableEndpointError({ status: 429 })).toBe(false);
    expect(isNonRetryableEndpointError({ status: 500 })).toBe(false);
    expect(isNonRetryableEndpointError(new Error("x"))).toBe(false);
  });

  it("recognises context-length messages", () => {
    expect(isContextLengthError(CONTEXT_ERROR.error.message)).toBe(true);
    expect(
      isContextLengthError(
        "This model's maximum context length is 8192 tokens",
      ),
    ).toBe(true);
    expect(isContextLengthError("invalid api key")).toBe(false);
  });
});
