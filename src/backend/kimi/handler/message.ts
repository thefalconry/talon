/**
 * Kimi main message handler.
 *
 * Drives one turn on the chat via `kimi -p ... --output-format stream-json`
 * and folds the result back through the shared post-stream phases.
 */

import type {
  QueryParams,
  QueryResult,
} from "../../runtime/turn/handler-types.js";
import { getSession, incrementTurns, setSessionId } from "../../../storage/sessions.js";
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
import { kimiSystemPromptSuffix } from "../constants.js";
import { getState, kimiBinary, type KimiSessionUsage } from "../state.js";
import {
  applyKimiEvent,
  createKimiEventContext,
  type KimiEventContext,
  type KimiEvent,
  type KimiTurnTokens,
} from "../events.js";
import { getDefaultModelId } from "../models.js";
import {
  ensureChild,
  killChild,
  KimiTurnAborted,
  type KimiChild,
  type KimiSpawnSpec,
} from "../process/child.js";
import { kimiAuthError, isKimiAuthFailure } from "../auth.js";

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

function isTerminatorAbort(state: StreamState, err: unknown): boolean {
  return (
    state.turnTerminated &&
    (err instanceof KimiTurnAborted || /abort/i.test(errMsg(err)))
  );
}

function makeStepHandler(
  ctx: KimiEventContext,
  chatId: string,
  child: KimiChild,
): (event: KimiEvent) => void {
  return (event) => {
    applyKimiEvent(event, ctx);
    if (!ctx.state.turnTerminated || !child.alive) return;
    log("agent", `[${chatId}] terminator fired — killing kimi child`);
    killChild(chatId, "terminator");
  };
}

function settleUsage(
  chatId: string,
  state: StreamState,
  tokens: KimiTurnTokens | undefined,
  model: string,
  sessionId?: string,
): void {
  const turnTokens = tokens ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  recordTokens(state, turnTokens);
  const snapshot: KimiSessionUsage = {
    ...turnTokens,
    contextModelId: model,
  };
  const store = getState().lastUsage;
  store.set(chatId, snapshot);
  if (sessionId) store.set(sessionId, snapshot);
}

async function deliverTurn(
  params: QueryParams,
  state: StreamState,
  responseText: string,
  retried: boolean,
): Promise<{ decision: DeliveryDecision } | { retry: QueryResult }> {
  try {
    return {
      decision: await routeDelivery({
        backendLabel: "Kimi",
        chatId: params.chatId,
        state,
        responseText,
        onTextBlock: params.onTextBlock,
        metricNamespace: "kimi",
        propagateDeliveryFailure: true,
      }),
    };
  } catch (err) {
    if (!(err instanceof TextBlockDeliveryError) || retried) throw err;
    incrementCounter("delivery.text_block_retry");
    logWarn(
      "agent",
      `[${params.chatId}] ${err.message}; re-prompting Kimi with delivery failure`,
    );
    return {
      retry: await handleMessage(
        { ...params, text: buildDeliveryFailureReminder(err) },
        true,
      ),
    };
  }
}

function buildTurnInput(inputs: {
  params: QueryParams;
  config: NonNullable<ReturnType<typeof getState>["config"]>;
  session: ReturnType<typeof getSession>;
  previousTurns: number;
}): string {
  const { params, config, session, previousTurns } = inputs;
  const override = getState().systemPromptOverride;
  const systemPrompt =
    override ??
    prepareSystemPrompt({
      config,
      previousTurns,
      backendSuffix: kimiSystemPromptSuffix(
        frontendsForChat(
          params.chatId,
          nonTerminalFrontends(config.frontend),
        )[0] ?? "telegram",
      ),
      chatId: params.chatId,
      sessionEpoch: session.createdAt,
    }).text;
  const prompt = formatUserPrompt({
    text: params.text,
    senderName: params.senderName ?? "user",
    senderHandle: params.senderHandle,
    isGroup: params.isGroup,
    messageId: params.messageId,
    retrievedMemory: params.retrievedMemory,
  });
  return previousTurns === 0 ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
}

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  const config = getState().config;
  if (!config) throw new Error("Kimi agent not initialized");

  const { chatId, text, senderName, isGroup } = params;
  const t0 = Date.now();
  const session = getSession(chatId);
  const previousTurns = session.turns;
  const chatSettings = getChatSettings(chatId);

  const activeModel =
    params.model ?? chatSettings.model ?? config.model ?? getDefaultModelId();

  const inputText = buildTurnInput({ params, config, session, previousTurns });

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  const workspace = config.workspace || dirs.workspace;
  const spawnSpec: KimiSpawnSpec = {
    binary: kimiBinary(config.kimiBinary),
    cwd: workspace,
    model: activeModel,
    addDirs: [workspace],
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
  };

  const child = ensureChild(chatId, spawnSpec);
  const streamState = createStreamState(chatId);
  const ctx = createKimiEventContext(streamState, chatId, {
    onStreamDelta: params.onStreamDelta,
    onToolUse: params.onToolUse,
    onToolStart: params.onToolStart,
    onToolEnd: params.onToolEnd,
  });

  const unregisterInterrupt = registerTurnInterrupt(chatId, () => {
    streamState.turnTerminated = true;
    killChild(chatId, "interrupt");
  });

  const setupMs = Date.now() - t0;
  let turnMs = 0;
  let turnResult: { sessionId?: string; usage?: KimiTurnTokens } | undefined;

  try {
    const turnStart = Date.now();
    turnResult = await child.runTurn(inputText, {
      onStep: makeStepHandler(ctx, chatId, child),
    });
    turnMs = Date.now() - turnStart;
    if (turnResult.sessionId && turnResult.sessionId !== session.sessionId) {
      setSessionId(chatId, turnResult.sessionId);
    }
  } catch (err) {
    if (!isTerminatorAbort(streamState, err)) {
      const surfaced = isKimiAuthFailure(`${child.stderrSnapshot} ${errMsg(err)}`)
        ? kimiAuthError(err)
        : err;
      const decision = await applyRetryDecision({
        err: surfaced,
        chatId,
        activeModel,
        retried: _retried,
        params,
        recurseWithRetried: (p) => handleMessage(p, true),
        backendLabel: "Kimi",
        resetNoun: "session",
      });
      if (decision.retry) return decision.retry;

      accountFailedTurn({
        backend: "kimi",
        chatId,
        state: streamState,
        durationMs: Date.now() - t0,
        model: activeModel,
        toolCalls: ctx.toolMetrics.count,
      });
      logError("agent", `[${chatId}] kimi error: ${decision.classified.message}`);
      throw decision.classified;
    }
  } finally {
    unregisterInterrupt();
  }

  settleUsage(chatId, streamState, turnResult?.usage, activeModel, child.sessionId);

  const responseText = finalizeResponseText(streamState);
  const durationMs = Date.now() - t0;

  accountTurn({
    chatId,
    backend: "kimi",
    state: streamState,
    durationMs,
    model: activeModel,
    sessionId: child.sessionId,
    failed: false,
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
