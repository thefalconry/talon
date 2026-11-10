/**
 * Codex one-shot agent runner — used by heartbeat & dream.
 *
 * The heartbeat/dream modules own timing, locking, and the run log
 * file. This module owns everything Codex-specific:
 *
 *   - Ensuring the per-context Codex instance is built (with the
 *     contextLabel's MCP servers wired in).
 *   - Starting an ephemeral thread (heartbeat / dream don't resume —
 *     each run is fresh).
 *   - Streaming `runStreamed` events into the run log.
 *   - Honouring the heartbeat module's abort controller so timeouts
 *     stop the model promptly.
 *
 * Codex spawns the `codex` CLI as a subprocess per `runStreamed` call.
 * The SDK's AbortSignal cuts the subprocess cleanly when the abort
 * fires — no orphan process handling needed.
 */

import type { OneShotAgentParams, OneShotUsage } from "../../core/types.js";
import { log, logWarn } from "../../util/log.js";
import { appendBackendSuffix } from "../runtime/index.js";
import { emitAssistantText, emitSessionId } from "../runtime/one-shot-hooks.js";
import { ensureCodex, getCodexAuthInfo } from "./init.js";
import {
  CODEX_SYSTEM_PROMPT_SUFFIX,
  CODEX_THREAD_PERMISSIONS,
} from "./constants.js";
import { isChatGptModelMismatchError } from "./auth.js";
import {
  chatGptFallbackFor,
  getCodexChatGptDefaultModel,
  isCodexOAuthIncompat,
} from "./models.js";
import { markOAuthIncompat } from "./oauth-incompat.js";
import { toCodexReasoningEffort } from "./effort.js";
import { abortLogLine } from "../../core/agents/abort-reason.js";

/**
 * Resolve the effective model for a one-shot run, applying the same
 * OAuth-aware pre-emptive swap the interactive handler uses.
 *
 * Heartbeats and dream calls pass `params.model` straight through from
 * `config.heartbeatModel ?? config.model`. If that's an OAuth-incompat
 * id (curated `apiKeyOnly: true` or runtime-learned) AND the active
 * Codex credential is ChatGPT OAuth, swap to the resolved ChatGPT default
 * (`getCodexChatGptDefaultModel`) to avoid the
 * silent exit-1 failure mode that hit a group chat on 2026-05-20 23:13Z.
 *
 * Returns the resolved model id, whether a swap occurred, and an
 * optional reason string for the run log.
 */
function resolveOneShotModel(requested: string): {
  model: string;
  swapped: boolean;
  reason?: string;
} {
  const authInfo = getCodexAuthInfo();
  if (authInfo?.mode !== "chatgpt") return { model: requested, swapped: false };
  if (!isCodexOAuthIncompat(requested)) {
    return { model: requested, swapped: false };
  }

  const fallback =
    chatGptFallbackFor(requested) ?? getCodexChatGptDefaultModel();
  if (fallback === requested) return { model: requested, swapped: false };

  return {
    model: fallback,
    swapped: true,
    reason:
      `OAuth-incompat ${requested} → ${fallback} ` +
      `(curated apiKeyOnly or runtime-learned; set TALON_CODEX_KEY for ` +
      `api-key billing to use api-key-only models)`,
  };
}

export async function runOneShotAgent(
  params: OneShotAgentParams,
): Promise<OneShotUsage | void> {
  const {
    prompt,
    systemPrompt,
    model: requestedModel,
    reasoningEffort,
    contextLabel,
    abortController,
    appendLog,
    onAssistantText,
    resumeSessionId,
    onSessionId,
  } = params;

  const codex = ensureCodex(contextLabel);

  const finalSystemPrompt = appendBackendSuffix(
    systemPrompt,
    CODEX_SYSTEM_PROMPT_SUFFIX,
  );

  // Codex SDK doesn't expose `system` on runStreamed — the system
  // prompt gets prepended to the user prompt for a one-shot, since
  // there's no thread continuity to worry about.
  // A resumed thread already carries the system prompt from its first turn.
  const inputText = resumeSessionId
    ? prompt
    : `${finalSystemPrompt}\n\n---\n\n${prompt}`;

  const resolved = resolveOneShotModel(requestedModel);
  const activeModel = resolved.model;
  if (resolved.swapped) {
    logWarn(
      "agent",
      `[${contextLabel}] Codex one-shot model swap: ${resolved.reason}`,
    );
    const ts = new Date().toISOString().slice(11, 19);
    await appendLog(`\n### [${ts}] Model swap\n${resolved.reason}\n`);
  }
  log("agent", `[${contextLabel}] Codex one-shot model: ${activeModel}`);

  // Availability was already checked by the caller against the model
  // catalog (core/background/effort.ts); all that's left is Codex's own
  // vocabulary, which can't express `off` / `max`.
  const modelReasoningEffort = toCodexReasoningEffort(reasoningEffort);
  if (reasoningEffort && !modelReasoningEffort) {
    logWarn(
      "agent",
      `[${contextLabel}] Codex one-shot: effort "${reasoningEffort}" has no ` +
        `Codex equivalent — using the model default`,
    );
  } else if (modelReasoningEffort) {
    log(
      "agent",
      `[${contextLabel}] Codex one-shot effort: ${modelReasoningEffort}`,
    );
  }

  const thread = openThread(
    codex,
    {
      model: activeModel,
      skipGitRepoCheck: true,
      ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
      ...CODEX_THREAD_PERMISSIONS,
    },
    params,
  );

  // The real reason a run failed lives in the stream, not in whatever the
  // SDK throws afterwards: a model the account can't use yields
  // `turn.failed` ("404 … The model `gpt-5.5` does not exist …") and the
  // SDK then throws only "Codex Exec exited with code 1: Reading prompt
  // from stdin...". Capture both so the failure the caller records is the
  // one that explains it.
  const failure = new StreamFailure();

  try {
    if (abortController.signal.aborted) {
      throw new Error("Aborted before prompt was sent");
    }

    const { events } = await thread.runStreamed(inputText, {
      signal: abortController.signal,
    });

    // `turn.completed.usage` is cumulative across the run — the last one
    // seen is the settlement figure the task table records.
    let usage: OneShotUsage | undefined;
    for await (const event of events) {
      if (abortController.signal.aborted) break;
      reportThreadStarted(event, onSessionId);
      await appendCodexEvent(appendLog, event, onAssistantText);
      failure.observe(event);
      usage = turnUsage(event) ?? usage;
    }
    // A stream that ends cleanly after `turn.failed` is still a failed run
    // — returning here is how 26/26 Codex cron runs were stored as "ok".
    if (!abortController.signal.aborted && failure.message) {
      throw new CodexOneShotError(failure.message);
    }
    return usage;
  } catch (err) {
    const thrown = err instanceof Error ? err.message : String(err);
    if (
      !(err instanceof CodexOneShotError) &&
      (abortController.signal.aborted || /abort/i.test(thrown))
    ) {
      const ts = new Date().toISOString().slice(11, 19);
      await appendLog(
        `\n### [${ts}] Aborted\n${abortLogLine(abortController.signal)}\n`,
      );
      return;
    }
    const msg = failure.describe(thrown);
    await learnFromMismatch(activeModel, msg, contextLabel);
    logWarn("agent", `Codex one-shot run failed: ${msg}`);
    const ts = new Date().toISOString().slice(11, 19);
    await appendLog(`\n### [${ts}] Error\n${msg}\n`);
    throw err instanceof CodexOneShotError
      ? err
      : new CodexOneShotError(msg, { cause: err });
  }
}

type CodexClient = ReturnType<typeof ensureCodex>;
type CodexThreadOptions = Parameters<CodexClient["startThread"]>[0];

/**
 * Start the run's thread — or, for a sub-agent interrupted by a daemon
 * restart, continue its own thread and re-report the handle.
 */
function openThread(
  codex: CodexClient,
  options: CodexThreadOptions,
  params: Pick<
    OneShotAgentParams,
    "resumeSessionId" | "onSessionId" | "contextLabel"
  >,
): ReturnType<CodexClient["startThread"]> {
  const { resumeSessionId, onSessionId, contextLabel } = params;
  if (!resumeSessionId) return codex.startThread(options);
  log(
    "agent",
    `[${contextLabel}] Codex one-shot resuming thread ${resumeSessionId}`,
  );
  const thread = codex.resumeThread(resumeSessionId, options);
  emitSessionId(onSessionId, resumeSessionId);
  return thread;
}

/** Report the thread id from `thread.started` so a restart can resume it. */
function reportThreadStarted(
  event: { type: string },
  onSessionId: OneShotAgentParams["onSessionId"],
): void {
  if (event.type !== "thread.started") return;
  const threadId = (event as { thread_id?: unknown }).thread_id;
  if (typeof threadId === "string") emitSessionId(onSessionId, threadId);
}

/** The cumulative usage a `turn.completed` event carries, if any. */
function turnUsage(event: { type: string }): OneShotUsage | undefined {
  if (event.type !== "turn.completed") return undefined;
  const u = (event as { usage?: Record<string, number> }).usage;
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheRead: u.cached_input_tokens ?? 0,
    cacheWrite: 0, // Codex doesn't report cache writes
  };
}

/**
 * Record a model as OAuth-incompat when a one-shot failed on it with an
 * explicit server mismatch, so the next run pre-emptively swaps.
 */
async function learnFromMismatch(
  activeModel: string,
  msg: string,
  contextLabel: string,
): Promise<void> {
  // Learn only from EXPLICIT mismatches in one-shot context.
  // Silent-exit failures are ambiguous (transient outage vs real
  // model-incompat) and persisting them would over-poison the
  // learning store with the result that one bad heartbeat
  // permanently downgrades the model. Explicit mismatches (the 400
  // "not supported … ChatGPT account" and the 404 "model … does not
  // exist") carry the unambiguous server message so they're safe to
  // mark.
  //
  // Unlike the interactive handler, heartbeat/dream can't recurse for
  // a retry (would mess with the timing contract and lock
  // semantics), so the failure is surfaced to the caller — the task
  // settles as failed — and the next scheduled run takes a fresh
  // swing on the learned fallback.
  const authInfo = getCodexAuthInfo();
  const fallback = getCodexChatGptDefaultModel();
  if (
    authInfo?.mode !== "chatgpt" ||
    activeModel === fallback ||
    !isChatGptModelMismatchError(msg)
  ) {
    return;
  }
  const recorded = await markOAuthIncompat(activeModel);
  if (recorded) {
    logWarn(
      "agent",
      `[${contextLabel}] Codex one-shot: recorded ${activeModel} as ` +
        `OAuth-incompat (explicit mismatch) — next ${contextLabel} run ` +
        `will pre-emptively swap to ${fallback}`,
    );
  }
}

/**
 * A Codex one-shot that failed upstream. The message is the most specific
 * reason the stream carried (the `turn.failed` text when there was one),
 * so task tables, cron run records and the backend router see the cause
 * rather than the SDK's generic exit wrapper.
 */
class CodexOneShotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodexOneShotError";
  }
}

/**
 * Codex emits `error` events for transient retries it handles itself
 * ("Reconnecting... 2/5 (…)", "Falling back from WebSockets to HTTPS
 * transport. …"). Those are progress, not failure — only the terminal
 * `turn.failed` / final `error` count.
 */
const TRANSIENT_ERROR_RE = /^\s*(reconnecting\.\.\.|falling back from)/i;

/** Tracks the terminal failure reported on a Codex event stream. */
class StreamFailure {
  private turnFailed: string | undefined;
  private lastError: string | undefined;

  observe(event: { type: string } & Record<string, unknown>): void {
    if (event.type === "turn.failed") {
      const err = (event as { error?: { message?: unknown } }).error;
      const text =
        typeof err?.message === "string" && err.message.trim()
          ? err.message.trim()
          : "turn failed (no message)";
      this.turnFailed = text;
      return;
    }
    if (event.type === "error" && typeof event.message === "string") {
      const text = event.message.trim();
      if (text && !TRANSIENT_ERROR_RE.test(text)) this.lastError = text;
    }
  }

  /** The failure the stream reported, or undefined when it reported none. */
  get message(): string | undefined {
    return this.turnFailed ?? this.lastError;
  }

  /**
   * Combine the stream's failure with whatever the SDK threw, most
   * specific first, without repeating the same text twice.
   */
  describe(thrown: string): string {
    const streamed = this.message;
    if (!streamed) return thrown;
    if (!thrown || thrown === streamed || streamed.includes(thrown)) {
      return streamed;
    }
    return `${streamed} (${thrown.trim()})`;
  }
}

/**
 * Append one Codex `ThreadEvent` to the run log. We surface:
 *
 *   - `thread.started` — record the thread id for diagnostic purposes.
 *   - `turn.started` / `turn.completed` — markers around the model's work.
 *   - `item.completed` — the meat: agent messages, tool calls, reasoning,
 *     command execution, file changes, web searches, todo lists, errors.
 *   - `turn.failed` / `error` — surface upstream failures into the log.
 *
 * `item.started` / `item.updated` are skipped to keep the log readable —
 * the completed snapshot of each item is sufficient.
 */
async function appendCodexEvent(
  appendLog: (text: string) => Promise<void>,
  event: { type: string } & Record<string, unknown>,
  onAssistantText?: OneShotAgentParams["onAssistantText"],
): Promise<void> {
  const ts = new Date().toISOString().slice(11, 19);

  switch (event.type) {
    case "thread.started": {
      const id =
        typeof event.thread_id === "string" ? event.thread_id : "(unknown)";
      await appendLog(`\n### [${ts}] Thread started\n\`${id}\`\n`);
      return;
    }
    case "turn.started":
      await appendLog(`\n### [${ts}] Turn started\n`);
      return;
    case "turn.completed": {
      const usage = (event as { usage?: Record<string, number> }).usage;
      if (usage) {
        await appendLog(
          `\n### [${ts}] Turn completed\ninput=${usage.input_tokens ?? 0} ` +
            `cached=${usage.cached_input_tokens ?? 0} ` +
            `output=${usage.output_tokens ?? 0} ` +
            `reasoning=${usage.reasoning_output_tokens ?? 0}\n`,
        );
      } else {
        await appendLog(`\n### [${ts}] Turn completed\n`);
      }
      return;
    }
    case "turn.failed": {
      const err = (event as { error?: { message?: string } }).error;
      await appendLog(
        `\n### [${ts}] Turn FAILED\n${err?.message ?? "(no message)"}\n`,
      );
      return;
    }
    case "error": {
      const msg =
        typeof event.message === "string" ? event.message : "(no message)";
      await appendLog(`\n### [${ts}] ERROR\n${msg}\n`);
      return;
    }
    case "item.completed": {
      const item = (event as unknown as { item?: Record<string, unknown> })
        .item;
      if (item) await appendCodexItem(appendLog, item, ts, onAssistantText);
      return;
    }
    default:
      return;
  }
}

/**
 * Append one `ThreadItem` to the run log, and report the model's final
 * answers to the run's optional `onAssistantText` consumer.
 *
 * Only `agent_message` items are reported: `reasoning` items are the model's
 * thinking and the rest are tool/command/diff payloads, none of which is the
 * run's answer.
 */
async function appendCodexItem(
  appendLog: (text: string) => Promise<void>,
  item: Record<string, unknown>,
  ts: string,
  onAssistantText?: OneShotAgentParams["onAssistantText"],
): Promise<void> {
  const type = typeof item.type === "string" ? item.type : "unknown";

  if (type === "agent_message") {
    const text = typeof item.text === "string" ? item.text : "";
    if (text) {
      emitAssistantText(onAssistantText, text);
      await appendLog(`\n## [${ts}] Assistant\n${text}\n`);
    }
    return;
  }

  if (type === "reasoning") {
    const text = typeof item.text === "string" ? item.text : "";
    if (text) await appendLog(`\n### [${ts}] Reasoning\n${text}\n`);
    return;
  }

  if (type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "(unknown)";
    const tool = typeof item.tool === "string" ? item.tool : "(unknown)";
    const input = item.arguments ?? null;
    await appendLog(
      `\n**MCP tool call:** \`${server}.${tool}\`\n\`\`\`json\n${JSON.stringify(
        input,
        null,
        2,
      ).slice(0, 2000)}\n\`\`\`\n`,
    );
    return;
  }

  if (type === "command_execution") {
    const cmd = typeof item.command === "string" ? item.command : "(unknown)";
    const status = typeof item.status === "string" ? item.status : "(unknown)";
    const exitCode = item.exit_code;
    const exitTail = typeof exitCode === "number" ? ` exit=${exitCode}` : "";
    await appendLog(`\n**Command:** \`${cmd}\` (${status}${exitTail})\n`);
    return;
  }

  if (type === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const status = typeof item.status === "string" ? item.status : "(unknown)";
    const list = changes
      .map((c) => {
        const change = c as { kind?: string; path?: string };
        return `  - ${change.kind ?? "?"} ${change.path ?? "?"}`;
      })
      .join("\n");
    await appendLog(`\n**File changes:** (${status})\n${list}\n`);
    return;
  }

  if (type === "web_search") {
    const query = typeof item.query === "string" ? item.query : "(unknown)";
    await appendLog(`\n**Web search:** \`${query}\`\n`);
    return;
  }

  if (type === "todo_list") {
    const items = Array.isArray(item.items) ? item.items : [];
    const list = items
      .map((todo) => {
        const t = todo as { text?: string; completed?: boolean };
        return `  - [${t.completed ? "x" : " "}] ${t.text ?? "?"}`;
      })
      .join("\n");
    await appendLog(`\n**Todo list:**\n${list}\n`);
    return;
  }

  if (type === "error") {
    const msg =
      typeof item.message === "string" ? item.message : "(no message)";
    await appendLog(`\n### [${ts}] Error item\n${msg}\n`);
    return;
  }

  // Fallback: dump unknown item types.
  const truncated = JSON.stringify(item, null, 2).slice(0, 2000);
  await appendLog(
    `\n### [${ts}] Item (${type})\n\`\`\`json\n${truncated}\n\`\`\`\n`,
  );
}
