/**
 * Session warm-up — cold-start optimization.
 *
 * Spawns a throwaway SDK subprocess in streaming input mode, calls
 * getContextUsage() to populate contextWindow and baseline contextTokens,
 * then tears it down. Fire-and-forget — does not block the caller.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { getSession } from "../../storage/sessions.js";
import { log, logWarn } from "../../util/log.js";
import { getConfig } from "./state.js";
import { buildSdkOptions } from "./options.js";
import { prepareSystemPrompt } from "../runtime/index.js";
import {
  DEFAULT_CLAUDE_ACCOUNT,
  type ClaudeRunAccount,
} from "./accounts/account.js";

export async function warmSession(
  chatId: string,
  account: ClaudeRunAccount = DEFAULT_CLAUDE_ACCOUNT,
): Promise<void> {
  // Guard against being called before initAgent()
  try {
    getConfig();
  } catch {
    return;
  }

  const abort = new AbortController();
  try {
    // Snapshot the prompt under this chat's fresh session epoch. The
    // first real turn finds the same snapshot (same epoch) and sends a
    // byte-identical prompt — so the warm-up's cache write is actually
    // reused instead of being invalidated by a re-timestamped rebuild.
    const session = getSession(chatId);
    const prepared = prepareSystemPrompt({
      config: getConfig(),
      previousTurns: session.turns,
      chatId,
      sessionEpoch: session.createdAt,
    });
    const { options } = buildSdkOptions(
      chatId,
      undefined,
      undefined,
      prepared,
      account,
    );

    // Streaming input mode: pass an async iterable that never yields a user message
    const neverYield = async function* (): AsyncGenerator<never> {
      await new Promise<never>((_, reject) => {
        abort.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
      // Unreachable — the promise above only ever rejects. The yield* both
      // satisfies require-yield and documents that this stream produces
      // nothing by design (streaming-input mode with no user message).
      yield* [] as never[];
    };

    const q = query({
      prompt: neverYield(),
      options: { ...options, abortController: abort },
    });

    // Drain the stream in the background so the SDK's internal message loop
    // doesn't stall — control responses are processed in readMessages() which
    // needs the inputStream consumer to not back-pressure.
    const drainPromise = (async () => {
      try {
        for await (const _ of q) {
          // discard SDK messages; we only care about the control response
        }
      } catch {
        // expected: abort causes the stream to end with an error
      }
    })();

    // Race getContextUsage against a timeout so /reset doesn't hang
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("warm-up timed out")),
        15_000,
      );
    });
    let ctx: Awaited<ReturnType<typeof q.getContextUsage>>;
    try {
      ctx = await Promise.race([q.getContextUsage(), timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    if (ctx.maxTokens > 0) session.usage.contextWindow = ctx.maxTokens;
    if (ctx.totalTokens > 0) session.usage.contextTokens = ctx.totalTokens;
    log(
      "agent",
      `[${chatId}] warm-up: context ${ctx.totalTokens}/${ctx.maxTokens} (${ctx.percentage.toFixed(1)}%) model=${ctx.model}`,
    );

    abort.abort();
    await drainPromise;
  } catch (err) {
    abort.abort();
    // Non-fatal — /status will just show 0 until first real message
    logWarn(
      "agent",
      `[${chatId}] warm-up failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}
