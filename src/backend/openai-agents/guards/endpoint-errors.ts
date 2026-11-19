/**
 * Endpoint error handling for OpenAI-compatible servers that don't report
 * errors the OpenAI way.
 *
 * Some local routers in front of llama.cpp answer a rejected request with
 * HTTP 200 and a bare JSON error as the body — even for a streamed request
 * (`content-type: text/event-stream`, body `{"error":{"code":400,…}}`, no
 * SSE framing). The openai client finds no SSE events in that body, the
 * Agents SDK sees an empty model turn and asks again, and the run loops
 * until "Max turns exceeded" without ever surfacing the endpoint's reason
 * (e.g. "request (154551 tokens) exceeds the available context size").
 *
 * {@link errorBodyFetch} wraps the client's fetch: a 2xx response whose
 * body is `{"error": {...}}` becomes a response with the error's status
 * (`error.code` when it is an HTTP status, else 400), so the openai client
 * throws its usual `APIError` with the endpoint's message on the first
 * attempt. Everything else — SSE streams, normal JSON — passes through
 * untouched (a stream is re-assembled from the bytes peeked at).
 */

/** Cap on how much of a non-SSE 2xx body is buffered to inspect it. */
const MAX_INSPECT_BYTES = 4 * 1024 * 1024;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** The error object of a bare `{"error": {...}}` body, or null. */
export function bareErrorOf(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  // A real completion/response carries its payload; a Responses-API
  // object has `error: null` alongside `output`.
  if ("choices" in obj || "output" in obj) return null;
  const err = obj.error;
  if (!err) return null;
  if (typeof err === "string") return { message: err };
  if (typeof err === "object" && !Array.isArray(err)) {
    return err as Record<string, unknown>;
  }
  return null;
}

/** The HTTP status a bare error body stands for. */
function statusOf(err: Record<string, unknown>): number {
  for (const key of ["code", "status"]) {
    const v = Number(err[key]);
    if (Number.isInteger(v) && v >= 400 && v <= 599) return v;
  }
  return 400;
}

/** Re-emit `head` chunks, then the rest of `reader`. */
function rejoin(
  head: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of head) controller.enqueue(c);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Turn a 2xx bare-error response into a failing one; pass anything else
 * through with its body intact.
 */
export async function normalizeErrorBody(res: Response): Promise<Response> {
  if (!res.ok || !res.body) return res;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let text = "";
  let bytes = 0;
  let done = false;
  // Peek until the first non-whitespace character.
  while (!text.trimStart()) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    chunks.push(r.value);
    bytes += r.value.byteLength;
    text += decoder.decode(r.value, { stream: true });
  }
  const init = {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  };
  // SSE (`data:`, `event:`, `:`) or anything that isn't a JSON object.
  if (!text.trimStart().startsWith("{")) {
    return new Response(done ? concat(chunks) : rejoin(chunks, reader), init);
  }
  // A JSON object: read it whole (bounded) and look for a bare error.
  while (!done && bytes <= MAX_INSPECT_BYTES) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    chunks.push(r.value);
    bytes += r.value.byteLength;
    text += decoder.decode(r.value, { stream: true });
  }
  if (!done) return new Response(rejoin(chunks, reader), init);
  text += decoder.decode();
  const err = bareErrorOf(text);
  if (!err) return new Response(concat(chunks), init);
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify({ error: err }), {
    status: statusOf(err),
    statusText: "Endpoint error",
    headers,
  });
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * A fetch for the openai client that surfaces 2xx bare-error bodies as
 * HTTP errors. Resolves `globalThis.fetch` per call, so a fetch installed
 * after the client was built (tests, instrumentation) is honoured.
 */
export function errorBodyFetch(base?: FetchLike): FetchLike {
  return async (input, init) => {
    const res = await (base ?? (globalThis.fetch as FetchLike))(input, init);
    return normalizeErrorBody(res);
  };
}

/**
 * Whether an error from the model call is a client error the endpoint
 * will repeat verbatim if asked again (a 4xx other than 408/409/429):
 * context overflow, bad request, auth, unknown model.
 */
export function isNonRetryableEndpointError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409 &&
    status !== 429
  );
}

/** Whether an endpoint error message reads as a context-length overflow. */
export function isContextLengthError(message: string): boolean {
  return /context (size|length|window)|maximum context|too many tokens|exceeds the available context|context_length_exceeded|exceed_context_size/i.test(
    message,
  );
}
