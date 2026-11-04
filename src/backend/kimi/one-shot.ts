/**
 * Kimi one-shot runner — heartbeat, dream, cron and sub-agents.
 */

import { spawn } from "node:child_process";
import type { OneShotAgentParams, OneShotUsage } from "../../core/types.js";
import { log, logWarn } from "../../util/log.js";
import { appendBackendSuffix } from "../runtime/index.js";
import { emitAssistantText } from "../runtime/one-shot-hooks.js";
import { KIMI_SYSTEM_PROMPT_SUFFIX, KIMI_BASE_ARGS } from "./constants.js";
import { kimiBinary, getState } from "./state.js";
import { getDefaultModelId } from "./models.js";
import { isKimiAuthFailure, kimiAuthError } from "./auth.js";
import {
  parseKimiLine,
  type KimiEvent,
  type KimiToolEvent,
  describeKimiTool,
} from "./events.js";
import { readKimiSessionUsage } from "./process/child.js";

const ts = (): string => new Date().toISOString().slice(11, 19);

interface SpawnOutcome {
  response: string;
  sessionId?: string;
  stderr: string;
  code: number | null;
}

export function buildOneShotArgs(params: {
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

    const binary = kimiBinary(getState().config?.kimiBinary);
    const args = buildOneShotArgs({
      prompt: `${finalSystemPrompt}\n\n---\n\n${prompt}`,
      model: activeModel,
      workspace,
    });

    const proc = spawn(binary, args, {
      cwd: workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const outcome: SpawnOutcome = {
      response: "",
      stderr: "",
      code: null,
    };

    const onAbort = () => proc.kill("SIGTERM");
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    let buffer = "";
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const event = parseKimiLine(line);
        if (event) {
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
          void logOneShotEvent(appendLog, event);
        }
        nl = buffer.indexOf("\n");
      }
    });

    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => {
      outcome.stderr = (outcome.stderr + chunk).slice(-4000);
    });

    await new Promise<void>((resolve, reject) => {
      proc.on("error", (err) => {
        abortController.signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      proc.on("close", (code) => {
        abortController.signal.removeEventListener("abort", onAbort);
        outcome.code = code;
        resolve();
      });
    });

    if (abortController.signal.aborted) {
      await appendLog(`\n### [${ts()}] Aborted\nRun aborted by timeout.\n`);
      return;
    }

    if (outcome.code !== 0) {
      const reason = isKimiAuthFailure(outcome.stderr)
        ? kimiAuthError().message
        : outcome.stderr.trim() || `kimi exited ${outcome.code ?? "n/a"}`;
      logWarn("agent", `kimi one-shot produced error: ${reason}`);
      await appendLog(`\n### [${ts()}] Error\n${reason}\n`);
      return;
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
    const msg = err instanceof Error ? err.message : String(err);
    if (abortController.signal.aborted || /abort/i.test(msg)) {
      await appendLog(`\n### [${ts()}] Aborted\nRun aborted by timeout.\n`);
      return;
    }
    logWarn("agent", `kimi one-shot run failed: ${msg}`);
    await appendLog(`\n### [${ts()}] Error\n${msg}\n`);
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
        `${(event as KimiToolEvent).content.slice(0, 2000)}\n` +
        "```\n",
    );
  }
}
