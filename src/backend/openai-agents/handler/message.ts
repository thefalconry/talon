/**
 * OpenAI Agents backend message handler.
 *
 * Drives a single-agent run on top of `@openai/agents`'s `run()` in streaming
 * mode. OpenAI-Agents-specific bits: building the `Agent` with the per-chat
 * MCP bundle, iterating the `StreamedRunResult` (see `events.ts`), and
 * `.cancel()` on terminator. The post-stream phases — accounting, the
 * trailing-prose flow-violation retry, the result — are the shared ones in
 * `backend/runtime/turn/turn-phases.ts`.
 */

import { Agent, run } from "@openai/agents";
import type {
  QueryParams,
  QueryResult,
} from "../../runtime/turn/handler-types.js";
import { getSession, incrementTurns } from "../../../storage/sessions.js";
import { getChatSettings } from "../../../storage/chat-settings.js";
import { log, logError, logWarn } from "../../../util/log.js";
import { traceMessage } from "../../../util/trace.js";

import {
  createStreamState,
  recordTokens,
  finalizeResponseText,
  formatUserPrompt,
  prepareSystemPrompt,
  routeDelivery,
  buildFirstTurnReminder,
  buildFlowViolationReminder,
  applyRetryDecision,
  registerTurnInterrupt,
  accountTurn,
  accountFailedTurn,
  nameSessionFromFirstMessage,
  enforceTrailingProse,
  finishCallbackTurn,
  type StreamState,
} from "../../runtime/index.js";

import {
  buildOpenAiAgentsSuffix,
  OPENAI_AGENTS_DEFAULT_MODEL,
  OPENAI_AGENTS_MAX_TURNS,
  OPENAI_AGENTS_AGENT_NAME,
} from "../constants.js";
import { getState, getOrCreateSession } from "../state.js";
import { getActiveFrontends } from "../init.js";
import { frontendsForChat } from "../../runtime/frontends.js";
import { getOrCreateBundle } from "../mcp-pool.js";
import { OPENAI_AGENTS_BUILTIN_TOOLS } from "../builtins.js";
import { activeAborts } from "./state.js";
import { handleRunItem } from "./events.js";

// ── Local utility ───────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** The expected close on `end_turn` / a user interrupt: abort after the terminator. */
const isTerminatorAbort = (state: StreamState, err: unknown): boolean =>
  state.turnTerminated &&
  (errMsg(err) === "AbortError" || /abort/i.test(errMsg(err)));

type McpBundle = Awaited<ReturnType<typeof getOrCreateBundle>>;

type RunUsage = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokensDetails?: { cachedTokens?: number };
};

/**
 * Read the aggregated usage off a run's state. `_context` is named with
 * an underscore in the SDK type but is structurally public; the SDK
 * updates it as each model call in the agentic loop completes, so this
 * is valid both mid-stream (live stats) and after `stream.completed`.
 */
function readRunUsage(runState: unknown): RunUsage | undefined {
  return (runState as { _context?: { usage?: RunUsage } })._context?.usage;
}

function recordRunUsage(state: StreamState, usage: RunUsage): void {
  recordTokens(state, {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheRead: usage.inputTokensDetails?.cachedTokens ?? 0,
    cacheWrite: 0, // OpenAI Responses API doesn't report cache writes.
  });
}

// ── Setup ───────────────────────────────────────────────────────────────────

/**
 * First-turn nudge — turn 0 is where flow violations cluster, and one
 * line in the user message costs nothing on later turns and never
 * touches the cached prefix.
 */
function buildTurnPrompt(
  params: QueryParams,
  frontend: string | undefined,
  previousTurns: number,
  isRetry: boolean,
): string {
  let prompt = formatUserPrompt({
    text: params.text,
    senderName: params.senderName ?? "user",
    senderHandle: params.senderHandle,
    isGroup: params.isGroup,
    messageId: params.messageId,
    retrievedMemory: params.retrievedMemory,
  });
  if (frontend && previousTurns === 0 && !isRetry) {
    prompt += `\n\n${buildFirstTurnReminder(frontend)}`;
  }
  return prompt;
}

/**
 * Acquire the per-chat MCP bundle. Persistent across turns — built on
 * first use, kept until the backend's cleanup releases the pool.
 */
async function acquireMcpBundle(
  chatId: string,
  frontends: readonly string[],
): Promise<McpBundle> {
  const state = getState();
  const config = state.config;
  if (!config) throw new Error("OpenAI Agents backend not initialized");
  try {
    return await getOrCreateBundle({
      chatId,
      bridgeUrl: `http://127.0.0.1:${state.gatewayPortFn()}`,
      frontends,
      braveApiKey: config.braveApiKey,
      toolExclusions: config,
    });
  } catch (err) {
    logError(
      "agent",
      `[${chatId}] OpenAI Agents: MCP setup failed: ${errMsg(err)}`,
    );
    throw err;
  }
}

/**
 * Diagnostic — enumerate every tool the model will see this turn.
 * Critical for tracking down "model never calls end_turn": if it
 * isn't in this list, the problem is MCP registration, not the model.
 */
async function logRegisteredTools(
  chatId: string,
  mcpBundle: McpBundle,
): Promise<void> {
  try {
    const builtinNames = OPENAI_AGENTS_BUILTIN_TOOLS.map((t) => t.name);
    const mcpToolLists = await Promise.all(
      mcpBundle.servers.map((s) =>
        s
          .listTools()
          .then((ts: Array<{ name?: string }>) => ts.map((t) => t.name ?? "?"))
          .catch(() => [] as string[]),
      ),
    );
    const mcpNames = mcpToolLists.flat();
    log(
      "agent",
      `[${chatId}] tools registered: builtins=[${builtinNames.join(", ")}] mcp=[${mcpNames.join(", ")}]`,
    );
  } catch {
    /* best-effort diagnostic */
  }
}

// ── Stream loop ─────────────────────────────────────────────────────────────

async function driveAgentRun(inputs: {
  chatId: string;
  prompt: string;
  systemPrompt: string;
  activeModel: string;
  mcpBundle: McpBundle;
  abortController: AbortController;
  state: StreamState;
  onToolUse: QueryParams["onToolUse"];
}): Promise<void> {
  const { chatId, mcpBundle, abortController, state } = inputs;
  await logRegisteredTools(chatId, mcpBundle);

  // Build the agent. `tools` carries the filesystem + shell built-ins
  // for parity with the Claude SDK backend; `mcpServers` carries the
  // Talon frontend + plugin MCP servers. Single agent, no handoffs.
  // `mcpConfig.includeServerInToolNames` namespaces MCP tools as
  // `mcp_<serverName>__<toolName>` so colliding names across plugins
  // both stay available. Built-in tools stay unprefixed.
  const agent = new Agent({
    name: OPENAI_AGENTS_AGENT_NAME,
    instructions: inputs.systemPrompt,
    model: inputs.activeModel,
    tools: [...OPENAI_AGENTS_BUILTIN_TOOLS],
    mcpServers: mcpBundle.servers,
    mcpConfig: { includeServerInToolNames: true },
  });

  // Per-chat MemorySession so the SDK preserves the full multi-turn
  // record (model outputs, tool calls + results, reasoning items).
  // Without this, every turn starts blind to prior context.
  const stream = await run(agent, inputs.prompt, {
    stream: true,
    maxTurns: OPENAI_AGENTS_MAX_TURNS,
    signal: abortController.signal,
    session: getOrCreateSession(chatId),
  });

  // The Agents SDK aggregates usage on the run context as each model
  // call completes — sample it (throttled) so the live-turn overlay
  // tracks the agentic loop instead of jumping from 0 to final.
  let lastLiveUsagePushAt = 0;
  const pushRunUsageLive = (): void => {
    const now = Date.now();
    if (now - lastLiveUsagePushAt < 1000) return;
    lastLiveUsagePushAt = now;
    const u = readRunUsage(stream.state);
    if (u) recordRunUsage(state, u);
  };

  const seenToolCallIds = new Set<string>();
  for await (const event of stream) {
    if (abortController.signal.aborted && !state.turnTerminated) break;

    if (event.type === "run_item_stream_event") {
      handleRunItem(event, {
        state,
        seenToolCallIds,
        onToolUse: inputs.onToolUse,
        chatId,
      });
      pushRunUsageLive();
    }
    // `raw_model_stream_event` and `agent_updated_stream_event`
    // events are intentionally not surfaced — token-by-token streaming
    // would expose private chain-of-thought; the final-message event
    // is enough.

    // Terminator-driven abort. The SDK emits TWO events for each tool
    // call: `tool_called` (RPC about to run) and `tool_output` (RPC
    // completed; message reached the frontend). We must NOT abort on
    // `tool_called` — that cancels the in-flight RPC and the message
    // never ships. Aborting on `tool_output` after we've flagged the
    // turn terminated means delivery happened AND we skip the SDK's
    // wrap-up round-trip (otherwise 5–10s of lingering typing).
    if (
      state.turnTerminated &&
      event.type === "run_item_stream_event" &&
      (event as { name?: string }).name === "tool_output" &&
      !abortController.signal.aborted
    ) {
      log(
        "agent",
        `[${chatId}] terminator tool result received — aborting wrap-up`,
      );
      try {
        abortController.abort();
      } catch (err) {
        logWarn("agent", `[${chatId}] abort failed: ${errMsg(err)}`);
      }
    }
  }

  // Await the final completion so usage + final state are populated.
  // Safe to call even when we aborted via the terminator (resolves to
  // the partial state).
  await stream.completed.catch(() => {
    /* swallow — aborted-by-terminator path */
  });

  // Token usage from the underlying RunResult. The SDK aggregates
  // `usage` across all turns in the loop.
  const usage = readRunUsage(stream.state);
  if (usage) recordRunUsage(state, usage);
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
  _flowRetries = 0,
): Promise<QueryResult> {
  const state = getState();
  const config = state.config;
  if (!config) {
    throw new Error("OpenAI Agents backend not initialized");
  }

  const { chatId, text, senderName, isGroup, onTextBlock } = params;
  const t0 = Date.now();
  const session = getSession(chatId);
  const previousTurns = session.turns;
  const isRetry = _retried || _flowRetries > 0;

  // Resolve the active model — chat-settings → config → default.
  const chatSettings = getChatSettings(chatId);
  const activeModel =
    params.model ??
    chatSettings.model ??
    config.model ??
    OPENAI_AGENTS_DEFAULT_MODEL;
  log("agent", `[${chatId}] OpenAI Agents model resolved: ${activeModel}`);

  // The chat's OWNING messaging frontend (falling back to the primary
  // for cross-surface chats) drives the delivery-contract suffix and
  // the frontend-aware flow-violation/first-turn text — tool names
  // differ per frontend. Empty in terminal mode (no delivery tools —
  // contract enforcement is skipped below anyway).
  const frontends = getActiveFrontends();
  const frontend: string | undefined = frontendsForChat(chatId, frontends)[0];

  // Per-session frozen prompt + Agents-specific delivery suffix.
  const { text: systemPrompt } = prepareSystemPrompt({
    config,
    previousTurns,
    backendSuffix: buildOpenAiAgentsSuffix(frontend ?? "telegram"),
    chatId,
    sessionEpoch: session.createdAt,
  });
  const prompt = buildTurnPrompt(params, frontend, previousTurns, isRetry);

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  const mcpBundle = await acquireMcpBundle(chatId, frontends);

  // Bind the stream state to the chat so token mutators mirror counts
  // into the live-turn overlay — /status updates while the turn runs.
  const streamState = createStreamState(chatId);
  const abortController = new AbortController();
  activeAborts.set(chatId, abortController);
  // A user interrupt is a synthetic turn terminator: marking the flag
  // before aborting routes the close through the same clean path a
  // model-fired end_turn takes (abort swallowed, no retry, no flow
  // violation), settling with the partial text and real usage.
  const unregisterInterrupt = registerTurnInterrupt(chatId, () => {
    streamState.turnTerminated = true;
    abortController.abort();
  });

  const setupMs = Date.now() - t0;
  let turnMs = 0;

  try {
    const turnStart = Date.now();
    await driveAgentRun({
      chatId,
      prompt,
      systemPrompt,
      activeModel,
      mcpBundle,
      abortController,
      state: streamState,
      onToolUse: params.onToolUse,
    });
    turnMs = Date.now() - turnStart;
  } catch (err) {
    // Swallow the terminator abort — the turn completed via a delivery tool.
    if (!isTerminatorAbort(streamState, err)) {
      // MCP bundle is retained across a retry — its servers are
      // stateless wrt the model conversation. See `mcp-pool.ts`.
      const outcome = await applyRetryDecision({
        err,
        chatId,
        activeModel,
        retried: _retried,
        params,
        recurseWithRetried: (p) => handleMessage(p, true),
        backendLabel: "OpenAI Agents",
      });
      if (outcome.retry) return outcome.retry;

      // Terminal failure — account for whatever the turn consumed before
      // dying (the retry above did its own accounting).
      accountFailedTurn({
        backend: "openai-agents",
        chatId,
        state: streamState,
        durationMs: Date.now() - t0,
        model: activeModel,
      });
      logError(
        "agent",
        `[${chatId}] OpenAI Agents error: ${outcome.classified.message}`,
      );
      throw outcome.classified;
    }
  } finally {
    unregisterInterrupt();
    if (activeAborts.get(chatId) === abortController) {
      activeAborts.delete(chatId);
    }
    // MCP bundle is NOT closed here — it persists across turns via the
    // pool in `mcp-pool.ts` and is released at backend cleanup.
  }

  // ── Post-loop accounting ──────────────────────────────────────────────────

  const responseText = finalizeResponseText(streamState);
  const durationMs = Date.now() - t0;
  accountTurn({
    chatId,
    backend: "openai-agents",
    state: streamState,
    durationMs,
    model: activeModel,
  });

  // Replies MUST go through `end_turn` (canonical) or `send` (mid-turn).
  // Only enforced when delivery tools are registered (non-empty
  // mcpBundle.servers). `incrementTurns` is deferred until AFTER the
  // check so the retry path doesn't double-count.
  const violation =
    mcpBundle.servers.length > 0
      ? enforceTrailingProse({
          chatId,
          state: streamState,
          flowRetries: _flowRetries,
          ...(frontend
            ? { reminder: buildFlowViolationReminder(frontend) }
            : {}),
        })
      : undefined;
  if (violation?.violated && violation.shouldRetry) {
    // Recursive call owns the `incrementTurns` for this user message.
    return handleMessage(
      { ...params, text: violation.reminder },
      _retried,
      _flowRetries + 1,
    );
  }

  // Reached the non-retry path — this turn counts as one user-visible turn.
  incrementTurns(chatId);
  nameSessionFromFirstMessage({ chatId, text, previousTurns, isRetry });

  // ── Delivery — strict tool-only ──────────────────────────────────────────
  // Replies must reach the user via a delivery tool. Trailing prose is
  // private scratchpad and is NEVER shipped as a fallback. routeDelivery is
  // only invoked when there's something to ship (delivered-via-tools text or
  // a synthetic upstream error).
  const hasDeliverable =
    streamState.deliveredTextNorms.length > 0 || !!streamState.syntheticError;
  const delivery = hasDeliverable
    ? await routeDelivery({
        backendLabel: "OpenAI Agents",
        chatId,
        state: streamState,
        responseText: "",
        onTextBlock,
      })
    : { route: "silent" as const, chars: 0 };

  return finishCallbackTurn({
    chatId,
    state: streamState,
    responseText,
    durationMs,
    setupMs,
    turnMs,
    delivery,
  });
}
