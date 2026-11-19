/**
 * Antigravity main message handler.
 *
 * Drives one turn on the chat's long-lived `agy` child (see
 * `../process.ts`) and folds the result back through the shared
 * post-stream phases in `backend/runtime/turn/turn-phases.ts`.
 *
 * The agy-specific bits are:
 *
 *   - MCP entries are written to agy's shared config file BEFORE the
 *     child spawns; the CLI reads them once at startup.
 *   - No system-prompt flag: the assembled prompt rides in as a fenced
 *     block on the first turn only (codex does the same).
 *   - A turn in a stream-json process cannot be cancelled in-flight,
 *     so the terminator kills the child; the next turn respawns it
 *     with `--conversation <id>` and the conversation continues.
 *   - `result.usage` is cumulative over the session, so a turn's real
 *     cost is the delta against the previous result.
 */

import type {
  QueryParams,
  QueryResult,
} from "../../runtime/turn/handler-types.js";
import { getSession, incrementTurns } from "../../../storage/sessions.js";
import { getChatSettings } from "../../../storage/chat-settings.js";
import type { DeliveryDecision } from "../../runtime/turn/delivery.js";
import { log, logError, logWarn } from "../../../util/log.js";
import { traceMessage } from "../../../util/trace.js";
import { incrementCounter } from "../../../storage/metrics.js";
import { dirs } from "../../../util/paths.js";

import {
  createStreamState,
  finalizeResponseText,
  formatUserPrompt,
  prepareSystemPrompt,
  routeDelivery,
  buildDeliveryFailureReminder,
  TextBlockDeliveryError,
  applyRetryDecision,
  registerTurnInterrupt,
  recordTokens,
  accountTurn,
  accountFailedTurn,
  nameSessionFromFirstMessage,
  finishCallbackTurn,
  type StreamState,
} from "../../runtime/index.js";
import {
  frontendsForChat,
  nonTerminalFrontends,
} from "../../runtime/frontends.js";

import { agySystemPromptSuffix } from "../constants.js";
import { getState, agyBinary, type AgySessionUsage } from "../state.js";
import { registerMcpForChat } from "../mcp/register.js";
import {
  applyAgyStep,
  createAgyEventContext,
  agyUsageToTokens,
  agyUsageDelta,
  type AgyEventContext,
  type AgyResult,
  type AgyStepUpdate,
} from "../events.js";
import type { AgyEffort } from "../effort.js";
import { selectAgyRun } from "../effort.js";
import { catalogForSelection, getDefaultModelId } from "../models.js";
import {
  ensureChild,
  killChild,
  AgyTurnAborted,
  type AgyChild,
  type AgySpawnSpec,
} from "../process/child.js";
import { agyAuthError, isAgyAuthFailure } from "../auth.js";

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * The expected close on `end_turn` / a user interrupt. Killing the
 * child IS how a turn is stopped here, so the resulting rejection is
 * a clean completion, not an error to retry.
 */
function isTerminatorAbort(state: StreamState, err: unknown): boolean {
  return (
    state.turnTerminated &&
    (err instanceof AgyTurnAborted || /abort/i.test(errMsg(err)))
  );
}

// ── Model + effort ──────────────────────────────────────────────────────────

interface ResolvedRun {
  model: string;
  effort: AgyEffort | undefined;
}

/**
 * Resolve the model and effort for this turn. The precedence lives in
 * `effort.ts`; [selectAgyRun] is shared with the warm-up and
 * one-shot paths so all three spawn the same, CLI-valid pair.
 */
async function resolveRun(
  chatId: string,
  requestedModel: string | undefined,
  requestedEffort: ReturnType<typeof getChatSettings>["effort"],
): Promise<ResolvedRun> {
  const { model, effort, dropped } = selectAgyRun(
    requestedModel ?? getDefaultModelId(),
    requestedEffort,
    requestedEffort ? await catalogForSelection() : [],
  );
  log(
    "agent",
    `[${chatId}] agy model resolved: ${model}${effort ? ` (effort=${effort})` : ""}` +
      (dropped
        ? ` (effort "${dropped}" not offered — using model default)`
        : ""),
  );
  return { model, effort };
}

// ── Turn plumbing ───────────────────────────────────────────────────────────

/**
 * Feed one step to the shared state, then enforce the terminator:
 * once a delivery tool has shipped the reply there is nothing left to
 * generate, and the only way to stop an agy turn is to kill the child.
 */
function makeStepHandler(
  ctx: AgyEventContext,
  chatId: string,
  child: AgyChild,
): (step: AgyStepUpdate) => void {
  return (step) => {
    applyAgyStep(step, ctx);
    if (!ctx.state.turnTerminated || !child.alive) return;
    log("agent", `[${chatId}] terminator fired — killing agy child`);
    killChild(chatId, "terminator");
  };
}

/** Record the turn's usage, delta'd off the session's cumulative counters. */
function settleUsage(
  chatId: string,
  state: StreamState,
  result: AgyResult,
  model: string,
): void {
  const cumulative = agyUsageToTokens(result.usage);
  const store = getState().lastUsage;
  const previous = store.get(chatId);
  const turn = agyUsageDelta(previous, cumulative);
  recordTokens(state, turn);
  const snapshot: AgySessionUsage = { ...cumulative, contextModelId: model };
  // Keyed under BOTH ids on purpose: `/status` looks the snapshot up by
  // the stored session id (agy's conversation id), while `resetChat`
  // and the tests reach for it by chat id.
  store.set(chatId, snapshot);
  if (result.conversation_id) store.set(result.conversation_id, snapshot);
  // `input_tokens` on the terminal result is the conversation's
  // accumulated prompt, which is the best context-fill estimate agy
  // gives us — there is no rollout file to read a real one from.
  state.contextTokens = turn.inputTokens;
}

/** Surface a non-SUCCESS result as a synthetic error on the state. */
function applyResultStatus(state: StreamState, result: AgyResult): boolean {
  if (!result.status || result.status === "SUCCESS") return false;
  state.syntheticError =
    result.error ?? `Antigravity turn ended with status ${result.status}`;
  return true;
}

// ── Failure ladder ──────────────────────────────────────────────────────────

async function recoverAgyFailure(inputs: {
  err: unknown;
  params: QueryParams;
  retried: boolean;
  model: string;
  state: StreamState;
  toolCalls: number;
  t0: number;
  stderr: string;
}): Promise<QueryResult> {
  const { err, params, retried, model, state } = inputs;
  const { chatId } = params;

  // An unauthenticated CLI is the one failure a user can actually fix,
  // and it only ever shows up on stderr. Swap it for a directed error
  // before the generic ladder classifies it as an opaque exit.
  const surfaced = isAgyAuthFailure(`${inputs.stderr} ${errMsg(err)}`)
    ? agyAuthError(err)
    : err;

  const decision = await applyRetryDecision({
    err: surfaced,
    chatId,
    activeModel: model,
    retried,
    params,
    recurseWithRetried: (p) => handleMessage(p, true),
    backendLabel: "Antigravity",
    resetNoun: "session",
  });
  if (decision.retry) return decision.retry;

  accountFailedTurn({
    backend: "agy",
    chatId,
    state,
    durationMs: Date.now() - inputs.t0,
    model,
    toolCalls: inputs.toolCalls,
  });
  logError("agent", `[${chatId}] agy error: ${decision.classified.message}`);
  throw decision.classified;
}

/** The prompt text handed to the child for this turn. */
function buildTurnInput(inputs: {
  params: QueryParams;
  config: NonNullable<ReturnType<typeof getState>["config"]>;
  session: ReturnType<typeof getSession>;
  previousTurns: number;
}): string {
  const { params, config, session, previousTurns } = inputs;
  const override = getState().systemPromptOverride;
  const { text: systemPrompt } = prepareSystemPrompt({
    config: override ? { ...config, systemPrompt: override } : config,
    previousTurns,
    backendSuffix: agySystemPromptSuffix(
      frontendsForChat(
        params.chatId,
        nonTerminalFrontends(config.frontend),
      )[0] ?? "telegram",
    ),
    chatId: params.chatId,
    sessionEpoch: session.createdAt,
  });
  const prompt = formatUserPrompt({
    text: params.text,
    senderName: params.senderName ?? "user",
    senderHandle: params.senderHandle,
    isGroup: params.isGroup,
    messageId: params.messageId,
    retrievedMemory: params.retrievedMemory,
  });
  // No `--system` flag exists: prepend the assembled prompt on the
  // first turn only; a resumed conversation already carries it.
  return previousTurns === 0 ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
}

/** Spawn shape for this chat's child, including the resume id. */
function spawnSpecFor(inputs: {
  config: NonNullable<ReturnType<typeof getState>["config"]>;
  chatId: string;
  model: string;
  effort: AgyEffort | undefined;
  session: ReturnType<typeof getSession>;
}): AgySpawnSpec {
  const workspace = inputs.config.workspace || dirs.workspace;
  return {
    binary: agyBinary(inputs.config.agyBinary),
    cwd: workspace,
    model: inputs.model,
    effort: inputs.effort,
    addDirs: [workspace],
    ...(inputs.session.sessionId
      ? { conversationId: inputs.session.sessionId }
      : {}),
  };
}

/**
 * Route the turn's text through the shared delivery decision tree,
 * converting a failed text-block delivery into the one-shot
 * re-prompt every backend does.
 */
async function deliverTurn(
  params: QueryParams,
  state: StreamState,
  responseText: string,
  retried: boolean,
): Promise<{ decision: DeliveryDecision } | { retry: QueryResult }> {
  try {
    return {
      decision: await routeDelivery({
        backendLabel: "Antigravity",
        chatId: params.chatId,
        state,
        responseText,
        onTextBlock: params.onTextBlock,
        metricNamespace: "agy",
        propagateDeliveryFailure: true,
      }),
    };
  } catch (err) {
    if (!(err instanceof TextBlockDeliveryError) || retried) throw err;
    incrementCounter("delivery.text_block_retry");
    logWarn(
      "agent",
      `[${params.chatId}] ${err.message}; re-prompting Antigravity with delivery failure`,
    );
    return {
      retry: await handleMessage(
        { ...params, text: buildDeliveryFailureReminder(err) },
        true,
      ),
    };
  }
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  const config = getState().config;
  if (!config) throw new Error("Antigravity agent not initialized");

  const { chatId, text, senderName, isGroup } = params;
  const t0 = Date.now();
  const session = getSession(chatId);
  const previousTurns = session.turns;
  const chatSettings = getChatSettings(chatId);

  const { model, effort } = await resolveRun(
    chatId,
    params.model ?? chatSettings.model ?? config.model,
    chatSettings.effort,
  );

  const inputText = buildTurnInput({ params, config, session, previousTurns });

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  // MCP entries must exist on disk before the child spawns — agy reads
  // its server list once, at process start.
  registerMcpForChat(chatId);
  const child = ensureChild(
    chatId,
    spawnSpecFor({ config, chatId, model, effort, session }),
  );

  const streamState = createStreamState(chatId);
  const ctx = createAgyEventContext(streamState, chatId, {
    onStreamDelta: params.onStreamDelta,
    onToolUse: params.onToolUse,
    onToolStart: params.onToolStart,
    onToolEnd: params.onToolEnd,
  });
  // A user interrupt is a synthetic terminator: flagging first routes
  // the kill through the same clean close a model-fired end_turn takes.
  const unregisterInterrupt = registerTurnInterrupt(chatId, () => {
    streamState.turnTerminated = true;
    killChild(chatId, "interrupt");
  });

  const setupMs = Date.now() - t0;
  let turnMs = 0;
  let result: AgyResult | undefined;

  try {
    const turnStart = Date.now();
    result = await child.runTurn(inputText, {
      onStep: makeStepHandler(ctx, chatId, child),
    });
    turnMs = Date.now() - turnStart;
  } catch (err) {
    if (!isTerminatorAbort(streamState, err)) {
      return await recoverAgyFailure({
        err,
        params,
        retried: _retried,
        model,
        state: streamState,
        toolCalls: ctx.toolMetrics.count,
        t0,
        stderr: child.stderrSnapshot,
      });
    }
  } finally {
    unregisterInterrupt();
  }

  // ── Post-turn accounting ──────────────────────────────────────────────────

  const failed = result ? applyResultStatus(streamState, result) : false;
  if (result) settleUsage(chatId, streamState, result, model);

  const responseText = finalizeResponseText(streamState);
  const durationMs = Date.now() - t0;
  accountTurn({
    chatId,
    backend: "agy",
    state: streamState,
    durationMs,
    model,
    sessionId: child.conversationId,
    failed,
    toolCalls: ctx.toolMetrics.count,
    context: {
      contextTokens: streamState.contextTokens || undefined,
      numApiCalls: streamState.numApiCalls || undefined,
    },
  });
  nameSessionFromFirstMessage({ chatId, text, previousTurns });

  const delivery = await deliverTurn(
    params,
    streamState,
    responseText,
    _retried,
  );
  if ("retry" in delivery) return delivery.retry;

  incrementTurns(chatId);
  return finishCallbackTurn({
    chatId,
    state: streamState,
    responseText,
    durationMs,
    setupMs,
    turnMs,
    delivery: delivery.decision,
  });
}
