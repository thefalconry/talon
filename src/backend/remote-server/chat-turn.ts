/**
 * The chat-turn orchestration for the remote-server family — one message
 * in, one `QueryResult` out.
 *
 * Resolves the active model against the server's catalog, makes sure the
 * server, session, and this chat's MCP servers exist, builds the prompt
 * pair, drives the turn (`./turn.ts`), then runs the shared post-turn
 * phases (`backend/runtime/turn/turn-phases.ts`) with the one family-specific
 * step in between: the usage fallback from the session summary.
 *
 * Kilo and OpenCode ran byte-for-byte copies of this (modulo the backend
 * name in log lines). The copies are gone; `RemoteChatBindings` is the
 * seam a backend supplies, and it is a subset of what `bindRemoteServer`
 * already returns.
 */

import { getSession, incrementTurns } from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { log, logError } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import type {
  QueryParams,
  QueryResult,
} from "../runtime/turn/handler-types.js";
import {
  frontendsForChat,
  nonTerminalFrontends,
} from "../runtime/frontends.js";
import {
  createStreamState,
  recordTokens,
  finalizeResponseText,
  formatUserPrompt,
  prepareSystemPrompt,
  routeDelivery,
  applyRetryDecision,
  registerTurnInterrupt,
  accountTurn,
  accountFailedTurn,
  nameSessionFromFirstMessage,
  finishCallbackTurn,
} from "../runtime/index.js";
import type { RemoteAgentClient } from "./client.js";
import type { RemoteServerBindings } from "./server-bindings.js";
import { getTurnSummary, type RemoteSessionClient } from "./session-helpers.js";
import { runRemoteTurn, type RemoteTurnClient } from "./turn.js";

/** What a backend hands the shared handler: its id/label plus server bindings. */
export type RemoteChatBindings<TClient extends RemoteAgentClient> = Pick<
  RemoteServerBindings<TClient>,
  | "getConfig"
  | "ensureServer"
  | "trackActiveTurn"
  | "parseModelSelection"
  | "resolveProviderID"
  | "ensureSession"
  | "ensureChatMcpServer"
  | "ensurePluginMcpServers"
  | "buildToolOverrides"
  | "systemPromptSuffix"
> & {
  /** Registry id — the `backend` column in turn metrics ("kilo"). */
  id: string;
  /** Display label for log lines and retry classification ("Kilo"). */
  label: string;
};

export async function runRemoteChatTurn<TClient extends RemoteAgentClient>(
  bindings: RemoteChatBindings<TClient>,
  params: QueryParams,
  retried = false,
): Promise<QueryResult> {
  const { id, label } = bindings;
  const config = bindings.getConfig();
  if (!config) throw new Error(`${label} agent not initialized`);

  const { chatId, text, senderName, onTextBlock, onToolUse } = params;
  const t0 = Date.now();
  const session = getSession(chatId);
  const previousTurns = session.turns;

  // Resolve active model + provider lookup against the server's catalog.
  const chatSettings = getChatSettings(chatId);
  const activeModel = params.model ?? chatSettings.model ?? config.model;
  const { providerID: selectedProviderID, modelID } =
    bindings.parseModelSelection(activeModel);

  const oc = await bindings.ensureServer();
  const providerID =
    selectedProviderID ?? (await bindings.resolveProviderID(oc, modelID));
  log(
    "agent",
    `[${chatId}] ${label} model resolved: provider=${providerID} model=${modelID}` +
      (selectedProviderID ? "" : " (provider via catalog lookup)"),
  );
  const sessionId = await bindings.ensureSession(oc, chatId);
  const chatMcpServerName = await bindings.ensureChatMcpServer(oc, chatId);
  const pluginMcpServerNames = await bindings.ensurePluginMcpServers(
    oc,
    chatId,
  );
  const toolOverrides = await bindings.buildToolOverrides(
    oc,
    chatMcpServerName,
    pluginMcpServerNames,
  );

  // Build the prompt (time tag + sender + msg_id + recalled memory).
  const prompt = buildTurnPrompt(params);

  // Per-session frozen prompt + this backend's delivery suffix.
  const { text: systemPrompt } = prepareSystemPrompt({
    config,
    previousTurns,
    backendSuffix: bindings.systemPromptSuffix(
      frontendsForChat(chatId, nonTerminalFrontends(config.frontend))[0] ??
        "telegram",
    ),
    chatId,
    sessionEpoch: session.createdAt,
  });

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup: params.isGroup });

  // Bind the stream state to the chat so token mutators mirror counts
  // into the live-turn overlay — /status updates while the turn runs.
  const state = createStreamState(chatId);
  state.newSessionId = sessionId;
  const turnClient = oc as unknown as RemoteTurnClient;
  // A user interrupt is a synthetic turn terminator: marking the flag
  // before aborting the session routes the close through the same clean
  // path a model-fired end_turn takes (MessageAborted swallowed as the
  // expected close, no retry), settling with whatever the turn produced.
  const unregisterInterrupt = registerTurnInterrupt(chatId, async () => {
    state.turnTerminated = true;
    await turnClient.session.abort({ sessionID: sessionId });
  });
  // Stopping the backend mid-turn (a `/model` swap, shutdown) aborts this
  // controller, which rejects the turn promptly instead of leaving it to
  // the deadline.
  const stopController = new AbortController();
  const untrackTurn = bindings.trackActiveTurn(stopController);
  const promptStartedAt = Date.now();

  const setupMs = Date.now() - t0;
  let promptMs = 0;

  try {
    // Drive the turn: subscribe to SSE events in parallel with promptAsync,
    // surface tool calls + terminator into shared state, and exit when the
    // turn closes / goes idle. `onStreamDelta` is intentionally NOT
    // forwarded — the frontend contract is "send the final reply once", not
    // live edit_message updates. Final delivery happens through
    // `end_turn` / `send`.
    const turnStart = Date.now();
    await runRemoteTurn({
      label,
      oc: turnClient,
      sessionId,
      prompt,
      systemPrompt,
      providerID,
      modelID,
      state,
      chatId,
      seenQuestionIds: new Set<string>(),
      seenPermissionIds: new Set<string>(),
      seenToolCallIds: new Set<string>(),
      toolOverrides,
      onStreamDelta: undefined,
      onTextBlock,
      onToolUse,
      stopSignal: stopController.signal,
    });
    promptMs = Date.now() - turnStart;
  } catch (err) {
    const outcome = await applyRetryDecision({
      err,
      chatId,
      activeModel,
      retried,
      params,
      recurseWithRetried: (p) => runRemoteChatTurn(bindings, p, true),
      backendLabel: label,
    });
    if (outcome.retry) return outcome.retry;

    // Terminal failure — account for whatever the turn consumed before
    // dying (the retry path above did its own accounting inside the
    // recursive attempt).
    accountFailedTurn({
      backend: id,
      chatId,
      state,
      durationMs: Date.now() - t0,
      model: activeModel,
    });
    logError(
      "agent",
      `[${chatId}] ${label} error: ${outcome.classified.message}`,
    );
    throw outcome.classified;
  } finally {
    untrackTurn();
    unregisterInterrupt();
    // Note: we deliberately do NOT disconnect the chat MCP server here.
    // The server is named per-chat so it's safe to keep across turns;
    // re-spawning the subprocess each turn cost ~800ms per message.
    // Per-prompt overrides isolate visibility across concurrent chats.
  }

  // ── Post-loop accounting ──────────────────────────────────────────────────

  await fillUsageFromSummary(
    oc as unknown as RemoteSessionClient,
    sessionId,
    promptStartedAt,
    state,
  );

  const responseText = finalizeResponseText(state);
  const durationMs = Date.now() - t0;
  accountTurn({
    chatId,
    backend: id,
    state,
    durationMs,
    model: activeModel,
    sessionId: state.newSessionId,
  });
  incrementTurns(chatId);
  nameSessionFromFirstMessage({ chatId, text, previousTurns });

  // ── Delivery — the decision tree shared by every backend ──────────────────
  const delivery = await routeDelivery({
    backendLabel: label,
    chatId,
    state,
    responseText,
    onTextBlock,
  });

  return finishCallbackTurn({
    chatId,
    state,
    responseText,
    durationMs,
    setupMs,
    turnMs: promptMs,
    delivery,
    detail: `events=${formatEventCounts(state.eventCounts)}`,
  });
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

/**
 * If the SSE loop missed the usage info, fall back to the session summary
 * endpoint (which always reflects the final server state). Best-effort:
 * session summaries can race on cancellation, so a failure leaves the
 * counts at zero.
 */
async function fillUsageFromSummary(
  oc: RemoteSessionClient,
  sessionId: string,
  promptStartedAt: number,
  state: ReturnType<typeof createStreamState>,
): Promise<void> {
  if (
    state.sdkInputTokens !== 0 ||
    state.sdkOutputTokens !== 0 ||
    state.sdkCacheRead !== 0
  ) {
    return;
  }
  try {
    const summary = await getTurnSummary(oc, sessionId, promptStartedAt);
    if (summary.usage.assistantMessages > 0) {
      recordTokens(state, {
        inputTokens: summary.usage.inputTokens,
        outputTokens: summary.usage.outputTokens,
        cacheRead: summary.usage.cacheRead,
        cacheWrite: summary.usage.cacheWrite,
      });
    }
  } catch {
    // best-effort — session summaries can race on cancellation
  }
}

/**
 * Compact summary of which SSE event types fired this turn. `none` for a
 * silent turn (itself a useful diagnostic — the SSE socket dropped or never
 * matched our session id). Otherwise renders as `delta×42,part.updated×1`.
 */
function formatEventCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  // Trim the noisy `message.` / `session.` prefixes so the line stays
  // readable in the live log tail.
  return entries
    .map(([type, n]) => `${type.replace(/^(message|session)\./, "")}×${n}`)
    .join(",");
}
