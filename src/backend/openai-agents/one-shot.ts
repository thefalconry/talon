/**
 * OpenAI Agents one-shot runner — heartbeat, dream, cron query jobs and
 * sub-agents.
 *
 * Reuses the chat path's pieces (the built-in tool set, the hub-backed
 * MCP bundle, the SDK's `Agent` + streaming `run()`), with three
 * differences that make it an *isolated* run:
 *
 *   - **No session.** Each run starts from a blank conversation; nothing
 *     is read from or written to the per-chat `TalonSession` map.
 *   - **Its own MCP bundle**, keyed by the run's `contextLabel` and closed
 *     in a `finally`. The label (`agent:<id>`, `heartbeat`) is what the
 *     MCP hub binds the tool session to, so a sub-agent's
 *     `report_result` / `check_inbox` / `message_parent` calls reach the
 *     gateway as that agent. It stays out of the per-chat pool because
 *     concurrent runs can share a label (every isolated cron job runs as
 *     `heartbeat`).
 *   - **Its own client**, aimed at the same endpoint as the chat path but
 *     with a far longer per-request timeout: a local llama.cpp server can
 *     sit on a long prompt for over a minute before the first token. The
 *     run as a whole is bounded by the caller's timeout and abort signal.
 *
 * The final assistant text is reported through `onAssistantText` (the
 * sub-agent runner's fallback result when the model never calls
 * `report_result`); tool calls, tool output and reasoning go to the run
 * log only. A failed run throws so cron, heartbeat and the task table
 * record it as failed rather than ok.
 */

import { Agent, OpenAIProvider, Runner } from "@openai/agents";
import type { OneShotAgentParams, OneShotUsage } from "../../core/types.js";
import { log, logWarn } from "../../util/log.js";
import { appendBackendSuffix } from "../runtime/index.js";
import { emitAssistantText } from "../runtime/one-shot-hooks.js";
import { abortLogLine } from "../../core/agents/abort-reason.js";
import {
  OPENAI_AGENTS_AGENT_NAME,
  OPENAI_AGENTS_DEFAULT_MODEL,
  OPENAI_AGENTS_MAX_TURNS,
  OPENAI_AGENTS_ONE_SHOT_REQUEST_TIMEOUT_MS,
  OPENAI_AGENTS_ONE_SHOT_SUFFIX,
} from "./constants.js";
import { getState } from "./state.js";
import {
  createOpenAIClient,
  getActiveFrontends,
  getOpenAIApiKey,
  getOpenAIBaseUrl,
} from "./init.js";
import { openUnpooledBundle, type OpenAIAgentsMcpBundle } from "./mcp-pool.js";
import {
  OPENAI_AGENTS_BUILTIN_TOOLS,
  type BuiltinRunContext,
} from "./builtins.js";

const ts = (): string => new Date().toISOString().slice(11, 19);

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** Cap on how much of one tool payload lands in the run log. */
const LOG_PAYLOAD_CHARS = 2000;

/**
 * An OpenAI Agents one-shot that failed upstream (model error, max turns,
 * MCP setup). Thrown so callers record the run as failed rather than ok.
 */
export class OpenAIAgentsOneShotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpenAIAgentsOneShotError";
  }
}

/**
 * The runner an isolated run drives: one whose model provider owns a
 * client with the one-shot request timeout, on the endpoint the chat
 * path resolved. With no key and no custom endpoint configured there is
 * nothing to redirect, so the SDK default (which the chat path also uses
 * in that case) is kept.
 */
function buildOneShotRunner(): Runner {
  const apiKey = getOpenAIApiKey();
  const baseURL = getOpenAIBaseUrl();
  if (!apiKey && !baseURL) return new Runner();
  const client = createOpenAIClient({
    apiKey,
    baseURL,
    timeoutMs: OPENAI_AGENTS_ONE_SHOT_REQUEST_TIMEOUT_MS,
  });
  const provider = new OpenAIProvider({
    openAIClient: client,
    useResponses: getState().apiMode === "responses",
  });
  return new Runner({ modelProvider: provider });
}

/** Open the run's own MCP bundle, bound to its context label. */
async function openRunBundle(
  contextLabel: string,
): Promise<OpenAIAgentsMcpBundle> {
  const state = getState();
  const config = state.config;
  if (!config) throw new Error("OpenAI Agents backend not initialized");
  return openUnpooledBundle({
    chatId: contextLabel,
    bridgeUrl: `http://127.0.0.1:${state.gatewayPortFn()}`,
    frontends: getActiveFrontends(),
    braveApiKey: config.braveApiKey,
    toolExclusions: config,
  });
}

type RunUsage = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokensDetails?: { cachedTokens?: number };
};

/** Aggregated usage off a run's state (see the chat handler's twin). */
function readRunUsage(runState: unknown): OneShotUsage | undefined {
  const u = (runState as { _context?: { usage?: RunUsage } } | undefined)
    ?._context?.usage;
  if (!u) return undefined;
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheRead: u.inputTokensDetails?.cachedTokens ?? 0,
    cacheWrite: 0, // Neither OpenAI API reports cache writes.
  };
}

type RawItem = Record<string, unknown>;

function rawItemOf(item: unknown): RawItem | undefined {
  if (!item || typeof item !== "object") return undefined;
  const raw = (item as { rawItem?: unknown }).rawItem;
  return raw && typeof raw === "object" ? (raw as RawItem) : undefined;
}

/** Text parts of a content array, joined (`output_text`, `reasoning_text`, …). */
function joinTextParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  let text = "";
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const t = (part as { text?: unknown }).text;
    if (typeof t === "string") text += t;
  }
  return text;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The assistant text of a `message_output_created` item. */
function messageText(item: unknown): string {
  const raw = rawItemOf(item);
  if (!raw) return "";
  return joinTextParts(raw.content);
}

/**
 * Render one run-item stream event into the run log, reporting final
 * assistant text to the run's hook. Unknown event names are skipped.
 */
async function logRunItem(
  event: { name: string; item: unknown },
  inputs: Pick<OneShotAgentParams, "appendLog" | "onAssistantText">,
): Promise<void> {
  const { appendLog } = inputs;
  switch (event.name) {
    case "message_output_created": {
      const text = messageText(event.item);
      if (!text.trim()) return;
      emitAssistantText(inputs.onAssistantText, text);
      await appendLog(`\n## [${ts()}] Assistant\n${text}\n`);
      return;
    }
    case "reasoning_item_created": {
      const raw = rawItemOf(event.item);
      const text = raw
        ? joinTextParts(raw.rawContent) || joinTextParts(raw.content)
        : "";
      if (text.trim()) await appendLog(`\n### [${ts()}] Reasoning\n${text}\n`);
      return;
    }
    case "tool_called": {
      const raw = rawItemOf(event.item);
      const name = typeof raw?.name === "string" ? raw.name : "(unknown)";
      const args = stringify(raw?.arguments ?? {});
      await appendLog(
        `\n**Tool call:** \`${name}\`\n\`\`\`json\n${args.slice(0, LOG_PAYLOAD_CHARS)}\n\`\`\`\n`,
      );
      return;
    }
    case "tool_output": {
      const output = (event.item as { output?: unknown } | undefined)?.output;
      const text = stringify(output ?? "");
      await appendLog(
        `\n**Tool output:**\n\`\`\`\n${text.slice(0, LOG_PAYLOAD_CHARS)}\n\`\`\`\n`,
      );
      return;
    }
    default:
      return;
  }
}

/** Drive the streamed run to completion, logging as it goes. */
async function driveRun(inputs: {
  runner: Runner;
  agent: Agent<BuiltinRunContext>;
  prompt: string;
  context: BuiltinRunContext;
  params: OneShotAgentParams;
}): Promise<OneShotUsage | undefined> {
  const { runner, agent, prompt, context, params } = inputs;
  const { abortController } = params;
  const stream = await runner.run(agent, prompt, {
    stream: true,
    maxTurns: OPENAI_AGENTS_MAX_TURNS,
    signal: abortController.signal,
    context,
  });
  for await (const event of stream) {
    if (abortController.signal.aborted) break;
    if (event.type === "run_item_stream_event") {
      await logRunItem(event, params);
    }
  }
  if (abortController.signal.aborted) {
    await stream.completed.catch(() => {});
    return readRunUsage(stream.state);
  }
  await stream.completed;
  if (stream.error) throw stream.error;
  return readRunUsage(stream.state);
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
    env,
  } = params;

  const config = getState().config;
  if (!config) throw new Error("OpenAI Agents backend not initialized");
  const activeModel = model || config.model || OPENAI_AGENTS_DEFAULT_MODEL;
  log(
    "agent",
    `[${contextLabel}] OpenAI Agents one-shot model: ${activeModel}`,
  );
  if (params.reasoningEffort) {
    // The chat path has no per-turn reasoning knob on this backend either;
    // the endpoint's model default applies.
    logWarn(
      "agent",
      `[${contextLabel}] OpenAI Agents one-shot: effort ` +
        `"${params.reasoningEffort}" is not applied — using the model default`,
    );
  }

  let bundle: OpenAIAgentsMcpBundle | undefined;
  try {
    if (abortController.signal.aborted) {
      throw new Error("Aborted before prompt was sent");
    }
    bundle = await openRunBundle(contextLabel);
    if (bundle.failed.length > 0) {
      await appendLog(
        `\n### [${ts()}] MCP servers that failed to connect\n` +
          bundle.failed.map((f) => `- ${f.name}: ${f.error}`).join("\n") +
          "\n",
      );
    }
    const agent = new Agent<BuiltinRunContext>({
      name: OPENAI_AGENTS_AGENT_NAME,
      instructions: appendBackendSuffix(
        systemPrompt,
        OPENAI_AGENTS_ONE_SHOT_SUFFIX,
      ),
      model: activeModel,
      tools: [...OPENAI_AGENTS_BUILTIN_TOOLS],
      mcpServers: bundle.servers,
      mcpConfig: { includeServerInToolNames: true },
    });
    const usage = await driveRun({
      runner: buildOneShotRunner(),
      agent,
      prompt,
      context: { cwd: workspace, ...(env ? { env } : {}) },
      params,
    });
    if (abortController.signal.aborted) {
      await appendLog(
        `\n### [${ts()}] Aborted\n${abortLogLine(abortController.signal)}\n`,
      );
      return;
    }
    if (usage) {
      await appendLog(
        `\n### [${ts()}] Run completed\ninput=${usage.inputTokens} ` +
          `cached=${usage.cacheRead} output=${usage.outputTokens}\n`,
      );
    }
    return usage;
  } catch (err) {
    const msg = errMsg(err);
    if (abortController.signal.aborted || /abort/i.test(msg)) {
      await appendLog(
        `\n### [${ts()}] Aborted\n${abortLogLine(abortController.signal)}\n`,
      );
      return;
    }
    logWarn("agent", `OpenAI Agents one-shot run failed: ${msg}`);
    await appendLog(`\n### [${ts()}] Error\n${msg}\n`);
    throw new OpenAIAgentsOneShotError(msg, { cause: err });
  } finally {
    await bundle?.close();
  }
}
