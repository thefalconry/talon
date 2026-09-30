/**
 * Antigravity one-shot runner — heartbeat, dream, cron and sub-agents.
 *
 * Unlike the chat path (one warm child per chat, many turns) an
 * isolated run gets a FRESH `agy -p` process that exits when the turn
 * does. The output format is still `stream-json` so tool steps reach
 * the run log while the run is happening, which is what claude-sdk and
 * codex both do — a heartbeat that only logged its final answer would
 * be undebuggable.
 *
 * Its MCP entries live under their own `__talon__oneshot-<label>__`
 * scope so a heartbeat's servers never collide with a chat's, and are
 * removed in a `finally` whatever the run did.
 */

import { spawn } from "node:child_process";
import type { OneShotAgentParams, OneShotUsage } from "../../core/types.js";
import { log, logWarn } from "../../util/log.js";
import { appendBackendSuffix } from "../runtime/index.js";
import { emitAssistantText } from "../runtime/one-shot-hooks.js";
import { AGY_SYSTEM_PROMPT_SUFFIX } from "./constants.js";
import { agyBinary, getState } from "./state.js";
import { agyScopeSlug } from "./mcp/config.js";
import { registerMcpForChat, unregisterMcpScope } from "./mcp/register.js";
import { toAgyEffort } from "./effort.js";
import { getDefaultModelId } from "./models.js";
import { isAgyAuthFailure, agyAuthError } from "./auth.js";
import {
  agyUsageToTokens,
  describeAgyTool,
  parseAgyLine,
  type AgyEvent,
  type AgyResult,
  type AgyStepUpdate,
} from "./events.js";

const ts = (): string => new Date().toISOString().slice(11, 19);

/** MCP scope for one isolated run — never a chat's. */
export function oneShotScope(contextLabel: string): string {
  return `oneshot-${agyScopeSlug(contextLabel)}`;
}

interface SpawnOutcome {
  result: AgyResult | undefined;
  stderr: string;
  code: number | null;
}

/** Everything the child loop needs, so the spawn helper stays small. */
interface RunInputs {
  binary: string;
  args: string[];
  cwd: string;
  prompt: string;
  abortController: AbortController;
  appendLog: (text: string) => Promise<void>;
  onAssistantText?: OneShotAgentParams["onAssistantText"];
}

/** Render one stream event into the run log (and the assistant hook). */
async function logEvent(
  inputs: Pick<RunInputs, "appendLog" | "onAssistantText">,
  event: AgyEvent,
): Promise<void> {
  const { appendLog } = inputs;
  if (event.event === "init") {
    await appendLog(
      `\n### [${ts()}] Conversation started\n\`${event.conversation_id ?? "(unknown)"}\`\n`,
    );
    return;
  }
  if (event.event === "result") {
    await logResult(appendLog, event.result);
    return;
  }
  const step = event.step_update;
  if (step) await logStep(inputs, step);
}

async function logStep(
  inputs: Pick<RunInputs, "appendLog" | "onAssistantText">,
  step: AgyStepUpdate,
): Promise<void> {
  if (step.step_type === "tool" && step.state !== "ACTIVE") {
    const shape = describeAgyTool(step);
    const where = shape.server ? `${shape.server}.${shape.name}` : shape.name;
    const failed = step.state === "ERROR" || Boolean(step.tool_info?.error);
    const detail = step.tool_info?.error?.message;
    await inputs.appendLog(
      `\n**Tool:** \`${where}\`${failed ? " (FAILED)" : ""}\n` +
        "```json\n" +
        `${JSON.stringify(shape.input, null, 2).slice(0, 2000)}\n` +
        "```\n" +
        (detail ? `${detail}\n` : ""),
    );
    return;
  }
  if (step.step_type === "agent_response" && step.state === "DONE") {
    const usage = step.usage;
    if (usage) {
      await inputs.appendLog(
        `\n_step: input=${usage.input_tokens ?? 0} output=${usage.output_tokens ?? 0} ` +
          `thinking=${usage.thinking_tokens ?? 0} cached=${usage.cache_read_tokens ?? 0}_\n`,
      );
    }
  }
}

async function logResult(
  appendLog: (text: string) => Promise<void>,
  result: AgyResult | undefined,
): Promise<void> {
  if (!result) return;
  if (result.status && result.status !== "SUCCESS") {
    await appendLog(
      `\n### [${ts()}] Turn ${result.status}\n${result.error ?? "(no message)"}\n`,
    );
    return;
  }
  const u = result.usage;
  await appendLog(
    `\n### [${ts()}] Turn completed\ninput=${u?.input_tokens ?? 0} ` +
      `output=${u?.output_tokens ?? 0} thinking=${u?.thinking_tokens ?? 0} ` +
      `cached=${u?.cache_read_tokens ?? 0}\n`,
  );
}

/** Spawn `agy -p`, stream its NDJSON into the log, resolve on exit. */
function runAgyOnce(inputs: RunInputs): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve, reject) => {
    const proc = spawn(inputs.binary, inputs.args, {
      cwd: inputs.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outcome: SpawnOutcome = { result: undefined, stderr: "", code: null };
    let buffer = "";
    let queue: Promise<void> = Promise.resolve();

    const onAbort = () => proc.kill("SIGTERM");
    inputs.abortController.signal.addEventListener("abort", onAbort, {
      once: true,
    });

    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const event = parseAgyLine(line);
        if (event) {
          if (event.event === "result") outcome.result = event.result;
          queue = queue.then(() => logEvent(inputs, event)).catch(() => {});
        }
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
      outcome.code = code;
      queue.then(() => resolve(outcome)).catch(() => resolve(outcome));
    });
  });
}

/** Build the argv for a one-shot `agy -p` run. */
export function buildOneShotArgs(params: {
  prompt: string;
  model: string;
  effort?: string;
  workspace: string;
}): string[] {
  const args = [
    "-p",
    params.prompt,
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--print-timeout",
    "0s",
    "--model",
    params.model,
    "--add-dir",
    params.workspace,
  ];
  if (params.effort) args.push("--effort", params.effort);
  return args;
}

export async function runOneShotAgent(
  params: OneShotAgentParams,
): Promise<OneShotUsage | void> {
  const {
    prompt,
    systemPrompt,
    model,
    reasoningEffort,
    workspace,
    contextLabel,
    abortController,
    appendLog,
    onAssistantText,
  } = params;

  const scope = oneShotScope(contextLabel);
  registerMcpForChat(contextLabel, { scope });

  // No system-prompt flag; a one-shot has no history to inherit one
  // from, so it is prepended to the prompt verbatim.
  const finalSystemPrompt = appendBackendSuffix(
    systemPrompt,
    AGY_SYSTEM_PROMPT_SUFFIX,
  );
  const effort = toAgyEffort(reasoningEffort);
  if (reasoningEffort && !effort) {
    logWarn(
      "agent",
      `[${contextLabel}] agy one-shot: effort "${reasoningEffort}" has no ` +
        `agy equivalent — using the model default`,
    );
  }
  const activeModel = model || getDefaultModelId();
  log("agent", `[${contextLabel}] agy one-shot model: ${activeModel}`);

  try {
    if (abortController.signal.aborted) {
      throw new Error("Aborted before prompt was sent");
    }
    const outcome = await runAgyOnce({
      binary: agyBinary(getState().config?.agyBinary),
      args: buildOneShotArgs({
        prompt: `${finalSystemPrompt}\n\n---\n\n${prompt}`,
        model: activeModel,
        ...(effort ? { effort } : {}),
        workspace,
      }),
      cwd: workspace,
      prompt,
      abortController,
      appendLog,
      ...(onAssistantText ? { onAssistantText } : {}),
    });
    return await settleOneShot({
      outcome,
      contextLabel,
      appendLog,
      ...(onAssistantText ? { onAssistantText } : {}),
      aborted: abortController.signal.aborted,
    });
  } catch (err) {
    // settleOneShot already logged its own failure — just pass it on.
    if (err instanceof AgyOneShotError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (abortController.signal.aborted || /abort/i.test(msg)) {
      await appendLog(`\n### [${ts()}] Aborted\nRun aborted by timeout.\n`);
      return;
    }
    logWarn("agent", `agy one-shot run failed: ${msg}`);
    await appendLog(`\n### [${ts()}] Error\n${msg}\n`);
    // Surface it: a swallowed failure is recorded as a successful run by
    // cron, heartbeat and the task table.
    throw new AgyOneShotError(msg, { cause: err });
  } finally {
    unregisterMcpScope(scope);
  }
}

/**
 * An agy one-shot that failed: no result, a non-SUCCESS turn, or a spawn
 * error. Thrown so callers record the run as failed rather than ok.
 */
class AgyOneShotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgyOneShotError";
  }
}

/** Report the run's answer + usage, or its failure, to the log. */
async function settleOneShot(inputs: {
  outcome: SpawnOutcome;
  contextLabel: string;
  appendLog: (text: string) => Promise<void>;
  onAssistantText?: OneShotAgentParams["onAssistantText"];
  aborted: boolean;
}): Promise<OneShotUsage | void> {
  const { outcome, appendLog } = inputs;
  if (inputs.aborted) {
    await appendLog(`\n### [${ts()}] Aborted\nRun aborted by timeout.\n`);
    return;
  }
  if (!outcome.result) {
    const reason = isAgyAuthFailure(outcome.stderr)
      ? agyAuthError().message
      : outcome.stderr.trim() || `agy exited ${outcome.code ?? "n/a"}`;
    logWarn("agent", `agy one-shot produced no result: ${reason}`);
    await appendLog(`\n### [${ts()}] Error\n${reason}\n`);
    throw new AgyOneShotError(reason);
  }
  if (outcome.result.status && outcome.result.status !== "SUCCESS") {
    // logResult already wrote the "Turn <status>" section.
    const reason =
      outcome.result.error?.trim() || `agy turn ${outcome.result.status}`;
    logWarn("agent", `agy one-shot turn ${outcome.result.status}: ${reason}`);
    throw new AgyOneShotError(reason);
  }
  const response = outcome.result.response ?? "";
  if (response.trim()) {
    emitAssistantText(inputs.onAssistantText, response);
    await appendLog(`\n## [${ts()}] Assistant\n${response}\n`);
  }
  return agyUsageToTokens(outcome.result.usage);
}
