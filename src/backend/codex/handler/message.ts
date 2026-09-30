/**
 * Codex main message handler.
 *
 * Orchestrates the turn on top of `@openai/codex-sdk`'s `Thread.runStreamed`.
 * Codex-specific bits: reading the `runStreamed` event stream, translating
 * items into shared stream state (see `events.ts`), resuming via
 * `codex.resumeThread(id)`, the rollout-JSONL live/settle usage accounting
 * (`rollout-accounting.ts`), and the ChatGPT-OAuth model-mismatch recovery
 * ladder. The post-stream phases are the shared ones in
 * `backend/runtime/turn/turn-phases.ts`.
 */

import type { Thread, Usage } from "@openai/codex-sdk";
import type {
  QueryParams,
  QueryResult,
} from "../../runtime/turn/handler-types.js";
import {
  getSession,
  incrementTurns,
  resetSession,
} from "../../../storage/sessions.js";
import { getChatSettings } from "../../../storage/chat-settings.js";
import { log, logError, logWarn } from "../../../util/log.js";
import { traceMessage } from "../../../util/trace.js";
import { incrementCounter } from "../../../storage/metrics.js";

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
  accountTurn,
  accountFailedTurn,
  nameSessionFromFirstMessage,
  finishCallbackTurn,
  type StreamState,
} from "../../runtime/index.js";

import {
  codexSystemPromptSuffix,
  CODEX_DEFAULT_MODEL,
  CODEX_THREAD_PERMISSIONS,
} from "../constants.js";
import {
  frontendsForChat,
  nonTerminalFrontends,
} from "../../runtime/frontends.js";
import { getState } from "../state.js";
import { ensureCodex, getCodexAuthInfo } from "../init.js";
import {
  codexLoginExpiredError,
  isChatGptModelMismatchError,
  isCodexRefreshTokenError,
  isSilentOAuthExitError,
} from "../auth.js";
import {
  chatGptFallbackFor,
  getModelInfo,
  isCodexOAuthIncompat,
  getCodexChatGptDefaultModel,
} from "../models.js";
import { supportsReasoningLevel } from "../../../core/models/reasoning-levels.js";
import { toCodexReasoningEffort } from "../effort.js";
import { markOAuthIncompat } from "../oauth-incompat.js";
import { activeAborts } from "./state.js";
import { CodexUsageExhaustedError, probeUsageExhausted } from "./usage.js";
import { handleEvent, type HandleEventContext } from "./events.js";
import {
  createRolloutAccounting,
  type RolloutAccounting,
} from "./rollout-accounting.js";

// ── Local utility ───────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** The expected close on `end_turn` / a user interrupt: abort after the terminator. */
const isTerminatorAbort = (state: StreamState, err: unknown): boolean =>
  state.turnTerminated &&
  (errMsg(err) === "AbortError" || /abort/i.test(errMsg(err)));

/**
 * Swap an expired-login exit for the user-facing auth error before the
 * shared retry ladder classifies it. The raw SDK text is the CLI banner
 * plus a stderr dump (see `isCodexRefreshTokenError`); left alone it
 * reads as an opaque exit-1 and the user never learns that `codex
 * login` is the fix. Any other error passes through unchanged.
 */
function surfaceLoginExpiry(err: unknown, turnFailedError?: string): unknown {
  return isCodexRefreshTokenError(`${turnFailedError ?? ""} ${errMsg(err)}`)
    ? codexLoginExpiredError(err)
    : err;
}

/**
 * One-shot ChatGPT-OAuth model-mismatch recovery.
 *
 * Three failure shapes are handled:
 *
 *   1. **Usage exhausted** (any auth mode) — when the rollout JSONL's
 *      latest `token_count.rate_limits` payload indicates `has_credits:
 *      false` or a populated `rate_limit_reached_type`, the failure
 *      isn't model-incompat at all — the account is out of budget.
 *      Throw `CodexUsageExhaustedError` so the caller surfaces the real
 *      cause; do NOT swap to a fallback model (it would hit the same
 *      wall). Checked FIRST because both the explicit-mismatch and
 *      silent-exit paths can be triggered by exhausted accounts.
 *
 *   2. **Explicit mismatch** — Codex surfaced
 *      `"not supported when using Codex with a ChatGPT account"`. This is
 *      the definitive OAuth-incompat signal and is persisted.
 *
 *   3. **Silent exit-1 on OAuth** — the Codex CLI exited 1 without the
 *      explicit text. Ambiguous; after the usage check rules out
 *      exhaustion, treat it as likely OAuth-incompat and retry on the
 *      OAuth flagship, but do NOT persist it. Gating: only fires when
 *      auth mode is `chatgpt` AND the active model isn't already the
 *      OAuth flagship.
 *
 * Returns a retry promise when explicit-mismatch or silent-exit triggers
 * AND we haven't already retried (`_retried` sentinel prevents recursion).
 */
async function maybeFallbackForChatGptMismatch(
  probeText: string,
  activeModel: string,
  params: QueryParams,
  retried: boolean,
  chatId: string,
  threadId?: string,
): Promise<QueryResult | undefined> {
  if (retried) return undefined;

  const explicit = isChatGptModelMismatchError(probeText);
  const authInfo = getCodexAuthInfo();
  const isOAuth = authInfo?.mode === "chatgpt";
  const silent =
    isOAuth &&
    activeModel !== getCodexChatGptDefaultModel() &&
    isSilentOAuthExitError(probeText);

  if (!explicit && !silent) return undefined;

  // Usage-exhausted check FIRST. If the rollout JSONL says the account
  // has no credits, both the explicit-mismatch and silent-exit shapes
  // are red herrings — the underlying cause is "no quota," and swapping
  // to a fallback model would burn another round-trip into the same
  // wall. Throw a clean error so the caller can surface the real cause.
  const usage = await probeUsageExhausted(threadId);
  if (usage.classification === "exhausted") {
    const detail =
      usage.limitId === "premium"
        ? "premium tier (free ChatGPT OAuth) exhausted"
        : usage.limitId
          ? `${usage.limitId} tier limit reached`
          : "no remaining credits";
    logWarn(
      "agent",
      `[${chatId}] Codex usage exhausted while running ${activeModel}: ` +
        `${detail}${usage.balance ? ` (balance=${usage.balance})` : ""}. ` +
        `NOT swapping to fallback — the same credential hits the same wall.`,
    );
    throw new CodexUsageExhaustedError(activeModel, authInfo?.mode);
  }

  const fallbackModel =
    chatGptFallbackFor(activeModel) ?? getCodexChatGptDefaultModel();
  if (fallbackModel === activeModel) return undefined;

  // Only EXPLICIT mismatch errors are persisted as OAuth-incompat —
  // they're definitive. Silent-exit failures are ambiguous and would
  // over-poison the learning store if persisted. The silent path still
  // triggers an in-session retry below, just without the permanent record.
  if (isOAuth && explicit) {
    const recorded = await markOAuthIncompat(activeModel);
    if (recorded) {
      logWarn(
        "agent",
        `[${chatId}] Codex: recorded ${activeModel} as OAuth-incompat ` +
          `(explicit mismatch) — subsequent turns will skip pre-emptively`,
      );
    }
  }

  // Log wording is honest about the heuristic: explicit mismatch is a
  // verdict, silent exit is a guess. Both retry on the fallback.
  const shape = explicit
    ? "explicit OAuth-incompat mismatch"
    : "silent exit on OAuth (heuristic: treating as possible OAuth-incompat)";
  logWarn(
    "agent",
    `[${chatId}] Codex ${shape} for ${activeModel}; ` +
      `resetting thread and retrying on ${fallbackModel}. ` +
      (isOAuth
        ? `Set TALON_CODEX_KEY or codexApiKey for billing-based access to api-key-only models.`
        : ``),
  );
  resetSession(chatId);
  return await handleMessage({ ...params, model: fallbackModel }, true);
}

/**
 * The turn's user prompt: the shared framing every backend emits, plus
 * whatever this turn's memory retrieval produced. `formatUserPrompt` is
 * the one place `retrievedMemory` is rendered — see
 * `backend/runtime/prompt/prompt-format.ts`.
 */
function buildTurnPrompt(params: QueryParams): string {
  return formatUserPrompt({
    text: params.text,
    senderName: params.senderName ?? "user",
    senderHandle: params.senderHandle,
    isGroup: params.isGroup,
    messageId: params.messageId,
    retrievedMemory: params.retrievedMemory,
  });
}

// ── Model resolution ────────────────────────────────────────────────────────

/**
 * Codex accepts arbitrary model strings; we pass through whatever the
 * caller resolved (chat-settings → config) and fall back to the auth-aware
 * default: `gpt-5-codex` when an API key is present, the resolved ChatGPT
 * default (`getCodexChatGptDefaultModel`) when only ChatGPT OAuth is configured (because `gpt-5-codex` is rejected with a
 * 400 on ChatGPT-mode accounts). A model known to be OAuth-incompat on a
 * ChatGPT-OAuth account is swapped pre-emptively rather than letting the
 * first turn fail.
 */
function resolveCodexModel(chatId: string, requested: string | undefined) {
  const authInfo = getCodexAuthInfo();
  const authAwareDefault =
    authInfo?.mode === "chatgpt"
      ? getCodexChatGptDefaultModel()
      : CODEX_DEFAULT_MODEL;
  const requestedModel = requested ?? authAwareDefault;
  let activeModel = requestedModel;
  if (authInfo?.mode === "chatgpt" && isCodexOAuthIncompat(requestedModel)) {
    const fallback =
      chatGptFallbackFor(requestedModel) ?? getCodexChatGptDefaultModel();
    // Guard against a learned-but-no-fallback case — only swap when the
    // fallback is actually different from what we'd already run.
    if (fallback !== requestedModel) {
      logWarn(
        "agent",
        `[${chatId}] Codex model ${requestedModel} is OAuth-incompat and ` +
          `current auth is ChatGPT OAuth — pre-emptively falling back to ${fallback}. ` +
          `Set TALON_CODEX_KEY / codexApiKey or change the configured model to silence this.`,
      );
      activeModel = fallback;
    }
  }
  log("agent", `[${chatId}] Codex model resolved: ${activeModel}`);
  return activeModel;
}

/**
 * Availability check (does this model offer the level?) then vocabulary
 * translation (can Codex express it?) — the latter is shared with the
 * one-shot path via `toCodexReasoningEffort` so the two can't drift.
 */
async function buildThreadOptions(
  activeModel: string,
  requestedEffort: ReturnType<typeof getChatSettings>["effort"],
) {
  const activeModelInfo = await getModelInfo(activeModel).catch(
    () => undefined,
  );
  const supportedReasoningLevels =
    activeModelInfo?.supportedReasoningLevels ?? [];
  const modelReasoningEffort =
    requestedEffort &&
    supportsReasoningLevel(requestedEffort, supportedReasoningLevels)
      ? toCodexReasoningEffort(requestedEffort)
      : undefined;
  return {
    activeModelInfo,
    threadOptions: {
      model: activeModel,
      skipGitRepoCheck: true,
      ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
      ...CODEX_THREAD_PERMISSIONS,
    },
  };
}

// ── Stream loop ─────────────────────────────────────────────────────────────

function createEventContext(
  params: QueryParams,
  state: StreamState,
): HandleEventContext {
  return {
    state,
    seenToolCallIds: new Set<string>(),
    startedToolIds: new Set<string>(),
    codexToolMetrics: { count: 0 },
    onTextBlock: params.onTextBlock,
    onToolUse: params.onToolUse,
    onToolStart: params.onToolStart,
    onToolEnd: params.onToolEnd,
    chatId: params.chatId,
  };
}

/** What the stream reported, readable mid-loop by the failure path too. */
type CodexStreamOutcome = {
  usage: Usage | null;
  turnFailedError: string | undefined;
};

async function driveCodexStream(inputs: {
  thread: Thread;
  inputText: string;
  abortController: AbortController;
  eventContext: HandleEventContext;
  rollout: RolloutAccounting;
  outcome: CodexStreamOutcome;
}): Promise<void> {
  const { abortController, eventContext, rollout, outcome } = inputs;
  const { state, chatId } = eventContext;
  const { events } = await inputs.thread.runStreamed(inputs.inputText, {
    signal: abortController.signal,
  });

  for await (const event of events) {
    if (abortController.signal.aborted && !state.turnTerminated) break;
    handleEvent(event, eventContext);

    if (event.type === "thread.started") {
      rollout.threadId = event.thread_id;
    } else if (event.type === "turn.completed") {
      outcome.usage = event.usage;
    } else if (event.type === "turn.failed") {
      outcome.turnFailedError = event.error.message;
    } else if (event.type === "error") {
      outcome.turnFailedError = event.message;
    }

    rollout.pollLive();

    // Terminator-driven abort: a delivery tool already shipped the
    // reply via the bridge. Cancel further model generation to skip
    // the wrap-up round-trip Codex would otherwise burn.
    if (state.turnTerminated && !abortController.signal.aborted) {
      log("agent", `[${chatId}] terminator fired — aborting Codex turn`);
      try {
        abortController.abort();
      } catch (err) {
        logWarn("agent", `[${chatId}] abort failed: ${errMsg(err)}`);
      }
    }
  }
}

/**
 * The failure ladder: ChatGPT-OAuth mismatch recovery, then the shared
 * retry decision, then terminal-failure accounting and the throw.
 */
async function recoverCodexFailure(inputs: {
  err: unknown;
  params: QueryParams;
  retried: boolean;
  activeModel: string;
  state: StreamState;
  rollout: RolloutAccounting;
  outcome: CodexStreamOutcome;
  toolCalls: number;
  t0: number;
}): Promise<QueryResult> {
  const { err, params, retried, activeModel, state, rollout, outcome } = inputs;
  const { chatId } = params;

  // Check both the captured event-stream message and the thrown error —
  // Codex SDK surfaces it via both channels. Only use the thread ID from
  // this run.
  const fallback = await maybeFallbackForChatGptMismatch(
    `${outcome.turnFailedError ?? ""} ${errMsg(err)}`,
    activeModel,
    params,
    retried,
    chatId,
    rollout.threadId,
  );
  if (fallback) return fallback;

  const decision = await applyRetryDecision({
    err: surfaceLoginExpiry(err, outcome.turnFailedError),
    chatId,
    activeModel,
    retried,
    params,
    recurseWithRetried: (p) => handleMessage(p, true),
    backendLabel: "Codex",
    resetNoun: "thread",
  });
  if (decision.retry) return decision.retry;

  // Terminal failure — recover whatever usage the rollout recorded
  // before the turn died, then account for it.
  await rollout.settle(outcome.usage).catch(() => {});
  accountFailedTurn({
    backend: "codex",
    chatId,
    state,
    durationMs: Date.now() - inputs.t0,
    model: activeModel,
    toolCalls: inputs.toolCalls,
  });
  logError("agent", `[${chatId}] Codex error: ${decision.classified.message}`);
  throw decision.classified;
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  const config = getState().config;
  if (!config) {
    throw new Error("Codex agent not initialized");
  }
  const codex = ensureCodex(params.chatId);

  const { chatId, text, senderName, isGroup } = params;
  const t0 = Date.now();
  const session = getSession(chatId);
  const previousTurns = session.turns;

  const chatSettings = getChatSettings(chatId);
  const activeModel = resolveCodexModel(
    chatId,
    params.model ?? chatSettings.model ?? config.model,
  );

  // Per-session frozen prompt + Codex-specific delivery suffix.
  const { text: systemPrompt } = prepareSystemPrompt({
    config,
    previousTurns,
    backendSuffix: codexSystemPromptSuffix(
      frontendsForChat(chatId, nonTerminalFrontends(config.frontend))[0] ??
        "telegram",
    ),
    chatId,
    sessionEpoch: session.createdAt,
  });

  const prompt = buildTurnPrompt(params);

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  // Resume the stored Codex thread (persisted under `~/.codex/sessions/`).
  const { activeModelInfo, threadOptions } = await buildThreadOptions(
    activeModel,
    chatSettings.effort,
  );
  const thread: Thread = session.sessionId
    ? codex.resumeThread(session.sessionId, threadOptions)
    : codex.startThread(threadOptions);

  // Chat-bound state mirrors counts into the live-turn overlay.
  const streamState = createStreamState(chatId);
  const rollout = await createRolloutAccounting({
    state: streamState,
    sessionId: session.sessionId,
  });
  const eventContext = createEventContext(params, streamState);
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

  const outcome: CodexStreamOutcome = {
    usage: null,
    turnFailedError: undefined,
  };
  const setupMs = Date.now() - t0;
  let turnMs = 0;

  try {
    const turnStart = Date.now();
    // `runStreamed` has no `system` slot: prepend the system prompt as a
    // fenced block on the first turn only; resumed threads inherit it.
    const inputText =
      previousTurns === 0 ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
    await driveCodexStream({
      thread,
      inputText,
      abortController,
      eventContext,
      rollout,
      outcome,
    });
    turnMs = Date.now() - turnStart;
  } catch (err) {
    // Aborted-by-terminator path is the expected close on `end_turn`.
    if (!isTerminatorAbort(streamState, err)) {
      return await recoverCodexFailure({
        err,
        params,
        retried: _retried,
        activeModel,
        state: streamState,
        rollout,
        outcome,
        toolCalls: eventContext.codexToolMetrics.count,
        t0,
      });
    }
  } finally {
    unregisterInterrupt();
    if (activeAborts.get(chatId) === abortController) {
      activeAborts.delete(chatId);
    }
  }

  // ── Post-loop accounting ──────────────────────────────────────────────────

  // Event-only ChatGPT-mismatch recovery: if the SDK emitted a
  // `turn.failed` carrying the mismatch text but DIDN'T rethrow, the
  // catch block above never fired. Catch it here too.
  if (outcome.turnFailedError && !_retried) {
    const fallback = await maybeFallbackForChatGptMismatch(
      outcome.turnFailedError,
      activeModel,
      params,
      _retried,
      chatId,
    );
    if (fallback) return fallback;
  }

  await rollout.settle(outcome.usage);

  // Surface a synthetic error if Codex failed the turn upstream.
  if (outcome.turnFailedError) {
    streamState.syntheticError = outcome.turnFailedError;
  }

  const responseText = finalizeResponseText(streamState);
  const durationMs = Date.now() - t0;
  accountTurn({
    chatId,
    backend: "codex",
    state: streamState,
    durationMs,
    model: activeModel,
    sessionId: rollout.threadId,
    failed: Boolean(outcome.turnFailedError),
    toolCalls: eventContext.codexToolMetrics.count,
    context: {
      // contextTokens comes from the rollout JSONL when available. Falls
      // back to 0 → /status shows "unknown", correct under-promise behaviour.
      contextTokens: streamState.contextTokens || undefined,
      // Prefer the rollout's reported context window over the static catalog.
      contextWindow:
        streamState.contextWindow ?? activeModelInfo?.contextWindow,
      numApiCalls: streamState.numApiCalls || undefined,
    },
  });
  nameSessionFromFirstMessage({ chatId, text, previousTurns });

  // ── Delivery — decision tree shared with the other backends ────────────────
  let delivery;
  try {
    delivery = await routeDelivery({
      backendLabel: "Codex",
      chatId,
      state: streamState,
      responseText,
      onTextBlock: params.onTextBlock,
      propagateDeliveryFailure: true,
    });
  } catch (err) {
    if (err instanceof TextBlockDeliveryError && !_retried) {
      incrementCounter("delivery.text_block_retry");
      logWarn(
        "agent",
        `[${chatId}] ${err.message}; re-prompting Codex with delivery failure`,
      );
      return handleMessage(
        { ...params, text: buildDeliveryFailureReminder(err) },
        true,
      );
    }
    throw err;
  }

  incrementTurns(chatId);
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
