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
import { emitAssistantText } from "../runtime/one-shot-hooks.js";
import { ensureCodex, getCodexAuthInfo } from "./init.js";
import {
  CODEX_SYSTEM_PROMPT_SUFFIX,
  CODEX_CHATGPT_DEFAULT_MODEL,
  CODEX_THREAD_PERMISSIONS,
} from "./constants.js";
import { isChatGptModelMismatchError } from "./auth.js";
import { chatGptFallbackFor, isCodexOAuthIncompat } from "./models.js";
import { markOAuthIncompat } from "./oauth-incompat.js";
import { toCodexReasoningEffort } from "./effort.js";
import { abortLogLine } from "../../util/abort-reason.js";

/**
 * Resolve the effective model for a one-shot run, applying the same
 * OAuth-aware pre-emptive swap the interactive handler uses.
 *
 * Heartbeats and dream calls pass `params.model` straight through from
 * `config.heartbeatModel ?? config.model`. If that's an OAuth-incompat
 * id (curated `apiKeyOnly: true` or runtime-learned) AND the active
 * Codex credential is ChatGPT OAuth, swap to `gpt-5.5` to avoid the
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

  const fallback = chatGptFallbackFor(requested) ?? CODEX_CHATGPT_DEFAULT_MODEL;
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
  } = params;

  const codex = ensureCodex(contextLabel);

  const finalSystemPrompt = appendBackendSuffix(
    systemPrompt,
    CODEX_SYSTEM_PROMPT_SUFFIX,
  );

  // Codex SDK doesn't expose `system` on runStreamed — the system
  // prompt gets prepended to the user prompt for a one-shot, since
  // there's no thread continuity to worry about.
  const inputText = `${finalSystemPrompt}\n\n---\n\n${prompt}`;

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

  const thread = codex.startThread({
    model: activeModel,
    skipGitRepoCheck: true,
    ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    ...CODEX_THREAD_PERMISSIONS,
  });

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
      await appendCodexEvent(appendLog, event, onAssistantText);
      if (event.type === "turn.completed") {
        const u = (event as { usage?: Record<string, number> }).usage;
        if (u) {
          usage = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheRead: u.cached_input_tokens ?? 0,
            cacheWrite: 0, // Codex doesn't report cache writes
          };
        }
      }
    }
    return usage;
  } catch (err) {
    if (
      abortController.signal.aborted ||
      /abort/i.test(err instanceof Error ? err.message : String(err))
    ) {
      const ts = new Date().toISOString().slice(11, 19);
      await appendLog(
        `\n### [${ts}] Aborted\n${abortLogLine(abortController.signal)}\n`,
      );
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);

    // Learn only from EXPLICIT mismatches in one-shot context.
    // Silent-exit failures are ambiguous (transient outage vs real
    // model-incompat) and persisting them would over-poison the
    // learning store with the result that one bad heartbeat
    // permanently downgrades the model. Explicit mismatches carry the
    // unambiguous server message so they're safe to mark.
    //
    // Unlike the interactive handler, heartbeat/dream can't recurse for
    // a retry (would mess with the timing contract and lock
    // semantics), so silent-exit failures here simply surface to the
    // run log; the next scheduled run takes a fresh swing.
    const authInfo = getCodexAuthInfo();
    if (
      authInfo?.mode === "chatgpt" &&
      activeModel !== CODEX_CHATGPT_DEFAULT_MODEL &&
      isChatGptModelMismatchError(msg)
    ) {
      const recorded = await markOAuthIncompat(activeModel);
      if (recorded) {
        logWarn(
          "agent",
          `[${contextLabel}] Codex one-shot: recorded ${activeModel} as ` +
            `OAuth-incompat (explicit mismatch) — next ${contextLabel} run ` +
            `will pre-emptively swap to ${CODEX_CHATGPT_DEFAULT_MODEL}`,
        );
      }
    }

    logWarn("agent", `Codex one-shot run failed: ${msg}`);
    const ts = new Date().toISOString().slice(11, 19);
    await appendLog(`\n### [${ts}] Error\n${msg}\n`);
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
