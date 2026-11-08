/**
 * One-shot run hooks — the shared, throw-proof call site for
 * `OneShotAgentParams.onAssistantText`.
 *
 * Every backend's isolated runner (`BackgroundRunner.runOneShotAgent`) already
 * renders the model's assistant text into the run log as markdown. The hook is
 * the same text as data, so a caller (the sub-agent runner) can take a run's
 * result without parsing the log back apart. It lives here rather than in each
 * backend so all four report it identically: same "final answer only" meaning,
 * same empty-string skip, same swallow-and-log on a throwing callback.
 *
 * Contract:
 *   - Final assistant text only. Reasoning/thinking blocks and tool-call
 *     payloads are log-only; they never reach the hook.
 *   - Synchronous. The runner does not await the consumer, so a hook that
 *     wants to do async work owns its own queueing.
 *   - Never throws into the run. A consumer bug must not abort a heartbeat.
 */

import type { OneShotAgentParams } from "../../core/types.js";
import { logWarn } from "../../util/log.js";

/**
 * Report one assistant text segment to the run's optional consumer.
 *
 * No-ops when there is no hook (the heartbeat/dream/cron path) or when the
 * text is empty — the backends guard their log appends the same way, so the
 * hook sees exactly the segments the log does.
 */
export function emitAssistantText(
  onAssistantText: OneShotAgentParams["onAssistantText"],
  text: string,
): void {
  if (!onAssistantText || !text) return;
  try {
    onAssistantText(text);
  } catch (err) {
    logWarn(
      "agent",
      `one-shot onAssistantText hook threw (ignored): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Report the run's conversation handle (Claude SDK session id, Codex thread
 * id) to the run's optional consumer — the sub-agent runner persists it so a
 * daemon restart can resume the conversation. Same contract as
 * `emitAssistantText`: synchronous, no-op without a hook or an id, and a
 * throwing consumer is logged, never propagated into the run.
 */
export function emitSessionId(
  onSessionId: OneShotAgentParams["onSessionId"],
  sessionId: string | undefined,
): void {
  if (!onSessionId || !sessionId) return;
  try {
    onSessionId(sessionId);
  } catch (err) {
    logWarn(
      "agent",
      `one-shot onSessionId hook threw (ignored): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
