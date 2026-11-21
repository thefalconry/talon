/**
 * Kimi one-shot runner — heartbeat, dream, cron and sub-agents.
 *
 * Each run is a fresh `kimi -p` process that exits when the turn does.
 * A failed run (non-zero exit, spawn error, auth failure) throws, the
 * way the agy and codex one-shots do: callers record a returned run as a
 * success, so a swallowed failure would read as "done" in cron, the
 * heartbeat and the task table.
 */

import { spawn } from "node:child_process";
import type { OneShotAgentParams, OneShotUsage } from "../../core/types.js";
import { log, logWarn } from "../../util/log.js";
import { appendBackendSuffix } from "../runtime/index.js";
import { emitAssistantText } from "../runtime/one-shot-hooks.js";
import { abortLogLine } from "../../core/agents/abort-reason.js";
import {
  KIMI_SYSTEM_PROMPT_SUFFIX,
  KIMI_BASE_ARGS,
  KIMI_RUN_LABEL_ENV,
} from "./constants.js";
import { kimiBinary, getState } from "./state.js";
import { getDefaultModelId } from "./models.js";
import { isKimiAuthFailure, kimiAuthError } from "./auth.js";
import { parseKimiLine, type KimiEvent, describeKimiTool } from "./events.js";
import { kimiPromptTooLarge, readKimiSessionUsage } from "./process/child.js";

const ts = (): string => new Date().toISOString().slice(11, 19);

interface SpawnOutcome {
  response: string;
  sessionId?: string;
  stderr: string;
  code: number | null;
}

/**
 * A Kimi one-shot that failed: non-zero exit, spawn error or a prompt
 * kimi cannot take. Thrown so callers record the run as failed, not ok.
 */
export class KimiOneShotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "KimiOneShotError";
  }
}

function buildOneShotArgs(params: {
  prompt: string;
  model: string;
  workspace: string;
}): string[] {
  return [
    ...KIMI_BASE_ARGS,
    "-p",
    params.prompt,
    "-m",
    params.model,
    "--add-dir",
    params.workspace,
  ];
}

/** Spawn `kimi -p`, stream its NDJSON into the log, resolve on exit. */
function runKimiOnce(inputs: {
  binary: string;
  args: string[];
  cwd: string;
  contextLabel: string;
  abortController: AbortController;
  appendLog: (text: string) => Promise<void>;
}): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve, reject) => {
    const proc = spawn(inputs.binary, inputs.args, {
      cwd: inputs.cwd,
      env: { ...process.env, [KIMI_RUN_LABEL_ENV]: inputs.contextLabel },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outcome: SpawnOutcome = { response: "", stderr: "", code: null };
    let buffer = "";
    // Log writes are chained so sections stay in order, and every write's
    // failure is caught: a rejected appendLog must not escape as an
    // unhandled rejection.
    let queue: Promise<void> = Promise.resolve();

    const onAbort = () => proc.kill("SIGTERM");
    inputs.abortController.signal.addEventListener("abort", onAbort, {
      once: true,
    });

    const handleLine = (line: string): void => {
      const event = parseKimiLine(line);
      if (!event) return;
      if (
        event.role === "meta" &&
        event.type === "session.resume_hint" &&
        event.session_id
      ) {
        outcome.sessionId = event.session_id;
      }
      if (event.role === "assistant" && event.content) {
        outcome.response += event.content;
      }
      queue = queue
        .then(() => logOneShotEvent(inputs.appendLog, event))
        .catch(() => {});
    };

    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
        nl = buffer.indexOf("\n");
      }
    });
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => {
      outcome.stderr = (outcome.stderr + chunk).slice(-4000);
    });
    proc.on("error", (err) => {
      inputs.abortController.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    proc.on("close", (code) => {
      inputs.abortController.signal.removeEventListener("abort", onAbort);
      if (buffer.trim()) handleLine(buffer);
      buffer = "";
      outcome.code = code;
      queue.then(() => resolve(outcome)).catch(() => resolve(outcome));
    });
  });
}

export async function runOneShotAgent(
  params: OneShotAgentParams,
): Promise<OneShotUsage | void> {
  const {
    prompt,
    systemPrompt,
    model,
    workspace,
    contextLabel,
    abortController,
    appendLog,
    onAssistantText,
  } = params;

  const finalSystemPrompt = appendBackendSuffix(
    systemPrompt,
    KIMI_SYSTEM_PROMPT_SUFFIX,
  );
  const activeModel = model || getDefaultModelId();
  log("agent", `[${contextLabel}] kimi one-shot model: ${activeModel}`);

  try {
    if (abortController.signal.aborted) {
      throw new Error("Aborted before prompt was sent");
    }

    const fullPrompt = `${finalSystemPrompt}\n\n---\n\n${prompt}`;
    const tooLarge = kimiPromptTooLarge(fullPrompt);
    if (tooLarge) throw tooLarge;

    const outcome = await runKimiOnce({
      binary: kimiBinary(getState().config?.kimiBinary),
      args: buildOneShotArgs({
        prompt: fullPrompt,
        model: activeModel,
        workspace,
      }),
      cwd: workspace,
      contextLabel,
      abortController,
      appendLog,
    });

    if (abortController.signal.aborted) {
      await appendLog(
        `\n### [${ts()}] Aborted\n${abortLogLine(abortController.signal)}\n`,
      );
      return;
    }

    if (outcome.code !== 0) {
      const reason = isKimiAuthFailure(outcome.stderr)
        ? kimiAuthError().message
        : outcome.stderr.trim() || `kimi exited ${outcome.code ?? "n/a"}`;
      logWarn("agent", `kimi one-shot produced error: ${reason}`);
      await appendLog(`\n### [${ts()}] Error\n${reason}\n`);
      throw new KimiOneShotError(reason);
    }

    if (outcome.response.trim()) {
      emitAssistantText(onAssistantText, outcome.response);
      await appendLog(`\n## [${ts()}] Assistant\n${outcome.response}\n`);
    }

    if (outcome.sessionId) {
      const usage = await readKimiSessionUsage(outcome.sessionId);
      if (usage) return usage;
    }
    return undefined;
  } catch (err) {
    // The non-zero-exit branch already logged its own failure.
    if (err instanceof KimiOneShotError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (abortController.signal.aborted || /abort/i.test(msg)) {
      await appendLog(
        `\n### [${ts()}] Aborted\n${abortLogLine(abortController.signal)}\n`,
      );
      return;
    }
    logWarn("agent", `kimi one-shot run failed: ${msg}`);
    await appendLog(`\n### [${ts()}] Error\n${msg}\n`);
    throw new KimiOneShotError(msg, { cause: err });
  }
}

async function logOneShotEvent(
  appendLog: (text: string) => Promise<void>,
  event: KimiEvent,
): Promise<void> {
  if (event.role === "assistant" && event.tool_calls) {
    for (const call of event.tool_calls) {
      const shape = describeKimiTool(call);
      await appendLog(
        `\n**Tool:** \`${shape.name}\`\n` +
          "```json\n" +
          `${JSON.stringify(shape.input, null, 2).slice(0, 2000)}\n` +
          "```\n",
      );
    }
  } else if (event.role === "tool") {
    await appendLog(
      `\n**Tool Output:**\n` +
        "```\n" +
        `${event.content.slice(0, 2000)}\n` +
        "```\n",
    );
  }
}
