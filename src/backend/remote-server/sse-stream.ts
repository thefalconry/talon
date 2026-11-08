/**
 * Typed access to the remote-server SSE event iterator.
 *
 * Both `@kilocode/sdk/v2` and `@opencode-ai/sdk/v2` expose
 * `client.global.event()` which (per the upstream wire format) returns
 * a `ServerSentEventsResult` whose `stream` field is an async iterable
 * of typed events. The SDK's published types under-promise this shape —
 * the call signature returns a wider type than the value it produces,
 * so the narrowing lives here once, behind a runtime guard.
 */

import { faultText } from "../../core/engine/fault-text.js";
import { logDebug, logWarn } from "../../util/log.js";

/**
 * Minimal client surface — what both `KiloClient` and `OpencodeClient`
 * expose for SSE subscription. The structural shape avoids depending on
 * either SDK directly from this module.
 */
export interface SseSubscribableClient {
  global: {
    event(): Promise<unknown>;
  };
}

/**
 * Subscribe to the remote agent's SSE event stream.
 *
 * Returns the event iterator on success, or `undefined` when the
 * subscription call rejected (network blip, server not ready, etc.) or
 * when the response shape doesn't expose an iterable stream. Callers
 * should treat `undefined` as "no events to read; carry on with the
 * sync prompt response as source of truth."
 *
 * The warning is logged here so callers don't all need to duplicate the
 * `errMsg(err)` formatting.
 */
export async function subscribeSseStream(
  client: SseSubscribableClient,
  chatId: string,
): Promise<AsyncIterable<unknown> | undefined> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const stream = narrowSseResult(await client.global.event());
      if (stream) return stream;
      lastError = new Error("response did not contain an async event stream");
    } catch (err) {
      lastError = err;
    }
    if (attempt < 3) {
      logDebug(
        "agent",
        `sse.subscribe.retry chat=${chatId} attempt=${attempt} delay_ms=${150 * attempt} error="${faultText(lastError)}"`,
      );
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
  logWarn(
    "agent",
    `[${chatId}] SSE subscribe failed after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  return undefined;
}

/**
 * Pull the iterable `stream` field out of a `global.event()` response.
 * Exported for tests; production code should call `subscribeSseStream`.
 */
function narrowSseResult(result: unknown): AsyncIterable<unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const stream = (result as { stream?: unknown }).stream;
  if (!stream || typeof stream !== "object") return undefined;
  // `Symbol.asyncIterator` is the only reliable runtime predicate for
  // an async iterable. Some SDK shapes also expose `[Symbol.iterator]`
  // but the for-await-of loop in callers requires the async variant.
  if (
    typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] !==
    "function"
  ) {
    return undefined;
  }
  return stream as AsyncIterable<unknown>;
}
