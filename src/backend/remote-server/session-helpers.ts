/**
 * Shared session helpers for the remote-server backend family.
 *
 * Both OpenCode and Kilo expose the same `session.messages` /
 * `session.get` / `question.list` / `question.reply` / `question.reject`
 * HTTP API. The helpers in this module are written against the structural
 * `RemoteSessionClient` interface so either concrete SDK can supply its
 * client and reuse the same logic.
 *
 * What's here:
 *
 *   - {@link RemoteAssistantInfo} / {@link RemoteSessionSnapshot} —
 *     shape of the upstream message info / aggregated snapshot.
 *   - {@link extractPartsSummary} — walk a parts list into text +
 *     tool count + (optional) synthetic-error text. Detects upstream's
 *     `synthetic: true` flag for failure-marker text parts.
 *   - {@link extractAssistantUsage} — token / cost extraction from a
 *     message's `info` blob.
 *   - {@link summarizeAssistantMessages} — aggregate a batch of
 *     `session.messages` rows into per-turn usage totals.
 *   - {@link getTurnSummary} — wrapper that fetches `session.messages`
 *     and runs the summariser.
 *   - {@link getSessionSnapshot} — produce a {@link RemoteSessionSnapshot}
 *     from a session id (used by `bootstrap.ts` / `factory.ts` for the
 *     `/status` enrichment).
 *   - {@link rejectPendingQuestions} — auto-respond to upstream questions
 *     (tool-approval → "always", clarifications → reject).
 *   - {@link approvePendingPermissions} — approve upstream permission asks
 *     that escaped the session ruleset, preventing headless turns from
 *     waiting forever for a TUI response.
 */

import { logWarn } from "../../util/log.js";
import type { RemoteAgentClient } from "./client.js";
import { errMsg } from "./state.js";

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Hard cap on messages fetched per `session.messages` call. Upstream
 * doesn't paginate by default — we pull the most recent slice and dedupe
 * locally. 5000 is enough headroom for several hundred turns even on
 * verbose models.
 */
export const REMOTE_SESSION_MESSAGE_LIMIT = 5000;

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Subset of the upstream `Message.info` shape that Talon reads for
 * accounting. The full type comes from the SDK; we narrow to fields we
 * actually use so the shared helpers can be written against a stable
 * structural type.
 */
export interface RemoteAssistantInfo {
  role?: string;
  finish?: string;
  time?: {
    created?: number;
    completed?: number;
  };
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  providerID?: string;
  modelID?: string;
}

/** Snapshot of one session's lifetime + last-turn assistant info. */
export interface RemoteSessionSnapshot {
  sessionId: string;
  createdAt?: number;
  updatedAt?: number;
  assistant?: {
    providerID?: string;
    modelID?: string;
    createdAt?: number;
    completedAt?: number;
    costUsd: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
  usage?: {
    assistantMessages: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
    totalCacheRead: number;
    totalCacheWrite: number;
    totalCostUsd: number;
  };
}

/** Parsed view of one assistant message. */
export interface ParsedAssistantMessage {
  createdAt: number;
  info?: RemoteAssistantInfo;
  parts: Array<Record<string, unknown>>;
}

/** Per-turn usage totals aggregated from a batch of assistant messages. */
export interface RemoteUsageSummary {
  assistantMessages: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

/**
 * Client surface used by these helpers. Extends the narrow
 * {@link RemoteAgentClient} with the `session.messages` /
 * `question.list/reply/reject` methods that the shared logic depends on
 * but the lifecycle/MCP helpers do not. Both `OpencodeClient` and
 * `KiloClient` structurally satisfy this interface.
 */
export interface RemoteSessionClient extends RemoteAgentClient {
  session: RemoteAgentClient["session"] & {
    messages(args: {
      sessionID: string;
      limit?: number;
    }): Promise<{ data?: unknown }>;
  };
  question: {
    list(): Promise<{ data?: unknown }>;
    reply(args: {
      requestID: string;
      answers: Array<Array<string>>;
    }): Promise<unknown>;
    reject(args: { requestID: string }): Promise<unknown>;
  };
  permission: {
    list(): Promise<{ data?: unknown }>;
    reply(args: {
      requestID: string;
      reply: "once" | "always" | "reject";
    }): Promise<unknown>;
  };
}

// ── Local utility ───────────────────────────────────────────────────────────

function hasAssistantUsage(info: RemoteAssistantInfo | undefined): boolean {
  return Boolean(
    info?.tokens?.input ||
    info?.tokens?.output ||
    info?.tokens?.reasoning ||
    info?.tokens?.cache?.read ||
    info?.tokens?.cache?.write ||
    info?.cost,
  );
}

function createEmptyUsageSummary(): RemoteUsageSummary {
  return {
    assistantMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
  };
}

function parseAssistantMessage(
  message: unknown,
): ParsedAssistantMessage | null {
  if (!message || typeof message !== "object") return null;

  const data = message as {
    info?: RemoteAssistantInfo;
    parts?: Array<Record<string, unknown>>;
  };

  if (data.info?.role !== "assistant") return null;

  return {
    createdAt: data.info?.time?.created ?? 0,
    info: data.info,
    parts: Array.isArray(data.parts) ? data.parts : [],
  };
}

function isMeaningfulAssistantMessage(
  message: ParsedAssistantMessage,
): boolean {
  return Boolean(
    message.parts.length > 0 ||
    message.info?.time?.completed ||
    hasAssistantUsage(message.info),
  );
}

// ── Parts → summary ────────────────────────────────────────────────────────

/**
 * Walk a parts list, concatenating text and counting tool calls.
 *
 * Returns the joined text (with `\n\n` between adjacent text parts to
 * preserve paragraph structure) and the count of tool-use blocks.
 *
 * Upstream flags self-generated synthetic text parts (e.g. "the model
 * hit its output limit while reasoning and produced no actionable
 * output. Try disabling reasoning or increasing the output limit.") with
 * `synthetic: true`. Those aren't a reply from the model — they're the
 * upstream telling us the request failed. Surface them through a
 * separate channel (`syntheticErrorText`) so the handler can convert
 * them into a meaningful Talon error instead of shipping them verbatim.
 *
 * The schema also has `ignored: true` but observation shows it's set on
 * regular text-part replies too (an upstream internal flag, not a
 * "skip me" hint as one would assume). Don't filter on it — doing so
 * wiped out legitimate replies in prod.
 */
export function extractPartsSummary(parts: Array<Record<string, unknown>>): {
  text: string;
  toolCalls: number;
  syntheticErrorText?: string;
} {
  const textParts: string[] = [];
  const syntheticTexts: string[] = [];
  let toolCalls = 0;

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      if (part.synthetic === true) {
        syntheticTexts.push(part.text);
      } else {
        textParts.push(part.text);
      }
    } else if (part.type === "tool") {
      toolCalls++;
    }
  }

  const result: {
    text: string;
    toolCalls: number;
    syntheticErrorText?: string;
  } = {
    text: textParts.join("\n\n").trim(),
    toolCalls,
  };
  if (syntheticTexts.length > 0) {
    result.syntheticErrorText = syntheticTexts.join("\n\n").trim();
  }
  return result;
}

// ── Usage extraction ───────────────────────────────────────────────────────

/** Extract token / cost counters from an assistant `info` blob. */
export function extractAssistantUsage(info: RemoteAssistantInfo | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  providerID?: string;
  modelID?: string;
} {
  return {
    inputTokens: info?.tokens?.input ?? 0,
    outputTokens: info?.tokens?.output ?? 0,
    cacheRead: info?.tokens?.cache?.read ?? 0,
    cacheWrite: info?.tokens?.cache?.write ?? 0,
    costUsd: info?.cost ?? 0,
    providerID: info?.providerID,
    modelID: info?.modelID,
  };
}

// ── Message-batch summariser ──────────────────────────────────────────────

/**
 * Summarise a batch of session messages into per-turn usage totals.
 *
 * Filters to assistant messages newer than `minCreatedAt`. Returns the
 * latest such message (for context-window/model lookup) and the
 * cumulative token/cost totals across all qualifying messages.
 */
export function summarizeAssistantMessages(
  messages: Array<unknown>,
  minCreatedAt = 0,
): {
  latestAssistant?: ParsedAssistantMessage;
  usage: RemoteUsageSummary;
} {
  const usage = createEmptyUsageSummary();
  const assistants = messages
    .map((message) => parseAssistantMessage(message))
    .filter((message): message is ParsedAssistantMessage => Boolean(message))
    .filter(
      (message) =>
        message.createdAt >= minCreatedAt &&
        isMeaningfulAssistantMessage(message),
    );

  for (const assistant of assistants) {
    const assistantUsage = extractAssistantUsage(assistant.info);
    usage.assistantMessages += 1;
    usage.inputTokens += assistantUsage.inputTokens;
    usage.outputTokens += assistantUsage.outputTokens;
    usage.reasoningTokens += assistant.info?.tokens?.reasoning ?? 0;
    usage.cacheRead += assistantUsage.cacheRead;
    usage.cacheWrite += assistantUsage.cacheWrite;
    usage.costUsd += assistantUsage.costUsd;
  }

  const latestAssistant = assistants.sort(
    (left, right) => right.createdAt - left.createdAt,
  )[0];

  return { latestAssistant, usage };
}

// ── Session-messages fetch ─────────────────────────────────────────────────

/**
 * Fetch and dedupe one session's messages list. Both backends expose
 * `session.messages` with the same shape.
 */
export async function listSessionMessages(
  oc: RemoteSessionClient,
  sessionId: string,
  limit: number = REMOTE_SESSION_MESSAGE_LIMIT,
): Promise<Array<unknown>> {
  const resp = await oc.session.messages({
    sessionID: sessionId,
    limit,
  });
  const page = Array.isArray(resp.data) ? resp.data : [];
  const messages: Array<unknown> = [];
  const seenMessageIds = new Set<string>();

  for (const message of page) {
    const messageInfo = (message as Record<string, unknown>)?.info as
      { id?: string } | undefined;
    const id = messageInfo?.id;
    if (id && seenMessageIds.has(id)) continue;
    if (id) seenMessageIds.add(id);
    messages.push(message);
  }

  return messages;
}

/**
 * Aggregate the most recent turn's assistant messages into a usage summary.
 *
 * `minCreatedAt` filters out messages older than the current turn — the
 * caller typically passes the timestamp of the user message that started
 * the turn.
 */
export async function getTurnSummary(
  oc: RemoteSessionClient,
  sessionId: string,
  minCreatedAt: number,
): Promise<{
  latestAssistant?: ParsedAssistantMessage;
  usage: RemoteUsageSummary;
}> {
  const messages = await listSessionMessages(oc, sessionId);
  return summarizeAssistantMessages(messages, minCreatedAt);
}

// ── Session snapshot ───────────────────────────────────────────────────────

/**
 * Build a {@link RemoteSessionSnapshot} for the given session id.
 *
 * Returns `undefined` if no session id was provided (caller convenience
 * — lets `bootstrap.ts` write `getSessionSnapshot(session?.sessionId)`
 * without a null-check before).
 */
export async function getSessionSnapshot(
  oc: RemoteSessionClient,
  sessionId: string | undefined,
): Promise<RemoteSessionSnapshot | undefined> {
  if (!sessionId) return undefined;

  const [sessionResp, messages] = await Promise.all([
    oc.session.get({ sessionID: sessionId }),
    listSessionMessages(oc, sessionId),
  ]);

  const sessionInfo =
    ((sessionResp as { data?: unknown }).data as
      | {
          time?: {
            created?: number;
            updated?: number;
          };
        }
      | undefined) ?? {};
  const summary = summarizeAssistantMessages(messages);
  const latestAssistant = summary.latestAssistant;
  const usage = extractAssistantUsage(latestAssistant?.info);

  return {
    sessionId,
    createdAt: sessionInfo.time?.created,
    updatedAt: sessionInfo.time?.updated,
    assistant: latestAssistant
      ? {
          providerID: usage.providerID,
          modelID: usage.modelID,
          createdAt: latestAssistant.info?.time?.created,
          completedAt: latestAssistant.info?.time?.completed,
          costUsd: usage.costUsd,
          totalTokens: latestAssistant.info?.tokens?.total ?? 0,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: latestAssistant.info?.tokens?.reasoning ?? 0,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        }
      : undefined,
    usage: {
      assistantMessages: summary.usage.assistantMessages,
      totalInputTokens: summary.usage.inputTokens,
      totalOutputTokens: summary.usage.outputTokens,
      totalReasoningTokens: summary.usage.reasoningTokens,
      totalCacheRead: summary.usage.cacheRead,
      totalCacheWrite: summary.usage.cacheWrite,
      totalCostUsd: summary.usage.costUsd,
    },
  };
}

// ── Pending-question guard ──────────────────────────────────────────────────

function summarizeQuestionHeaders(
  questions: Array<Record<string, unknown>>,
): string {
  return questions
    .map((question) => {
      if (typeof question.header === "string" && question.header.trim()) {
        return question.header.trim();
      }
      if (typeof question.question === "string" && question.question.trim()) {
        return question.question.trim();
      }
      return null;
    })
    .filter((value): value is string => Boolean(value))
    .join(" | ");
}

function isToolApprovalQuestion(
  questions: Array<Record<string, unknown>>,
): boolean {
  return questions.some((q) => {
    const header = String(q.header ?? q.question ?? "").toLowerCase();
    return (
      header.includes("tool") ||
      header.includes("approve") ||
      header.includes("permission") ||
      header.includes("allow")
    );
  });
}

/**
 * Auto-respond to pending upstream questions for this session.
 *
 * Talon manages its own tool permissions, so any "approve this tool?"
 * question is auto-approved with "always". Non-tool questions (which
 * shouldn't normally occur with our config but might appear if the
 * model decided to ask the user something) are rejected so the model
 * gets a definitive answer and keeps moving.
 *
 * Idempotent via `seenQuestionIds`: a question already handled in this
 * turn is not re-handled (upstream lists pending questions until
 * they're answered, so the loop in the handler can call this every
 * 350ms without re-firing the same answer).
 */
export async function rejectPendingQuestions(
  oc: RemoteSessionClient,
  sessionId: string,
  chatId: string,
  seenQuestionIds: Set<string>,
  backendLabel: string,
): Promise<void> {
  const questionsResp = await oc.question.list();
  const pendingQuestions = Array.isArray(questionsResp.data)
    ? questionsResp.data
    : [];

  for (const request of pendingQuestions) {
    if (!request || typeof request !== "object") continue;

    const data = request as {
      id?: string;
      sessionID?: string;
      questions?: Array<Record<string, unknown>>;
    };

    const requestId = data.id;
    if (!requestId || data.sessionID !== sessionId) continue;
    if (seenQuestionIds.has(requestId)) continue;

    seenQuestionIds.add(requestId);
    const questions = Array.isArray(data.questions) ? data.questions : [];
    const summary = summarizeQuestionHeaders(questions);

    try {
      if (isToolApprovalQuestion(questions)) {
        // Auto-approve tool usage — Talon manages its own tool access
        const answers = questions.map(() => ["always"]);
        await oc.question.reply({ requestID: requestId, answers });
        logWarn(
          "agent",
          `[${chatId}] Auto-approved ${backendLabel} tool question ${requestId}${
            summary ? `: ${summary}` : ""
          }`,
        );
      } else {
        await oc.question.reject({ requestID: requestId });
        logWarn(
          "agent",
          `[${chatId}] Rejected ${backendLabel} question ${requestId}${
            summary ? `: ${summary}` : ""
          }`,
        );
      }
    } catch (err) {
      logWarn(
        "agent",
        `[${chatId}] Failed to handle ${backendLabel} question ${requestId}: ${errMsg(err)}`,
      );
    }
  }
}

/**
 * Approve pending upstream permission requests for this session.
 *
 * Remote agent servers normally resolve these from the permission ruleset
 * installed at session creation. New permission categories can still appear
 * upstream, though, and a headless Talon process has no TUI to answer them.
 * Polling the pending list is therefore a fail-safe: approve each request
 * once, scoped strictly to the current session, and deduplicate until the
 * server removes it from the list.
 */
export async function approvePendingPermissions(
  oc: RemoteSessionClient,
  sessionId: string,
  chatId: string,
  seenPermissionIds: Set<string>,
  backendLabel: string,
): Promise<void> {
  const permissionsResp = await oc.permission.list();
  const pendingPermissions = Array.isArray(permissionsResp.data)
    ? permissionsResp.data
    : [];

  for (const request of pendingPermissions) {
    if (!request || typeof request !== "object") continue;

    const data = request as {
      id?: string;
      sessionID?: string;
      permission?: string;
      patterns?: string[];
    };
    const requestId = data.id;
    if (!requestId || data.sessionID !== sessionId) continue;
    if (seenPermissionIds.has(requestId)) continue;

    seenPermissionIds.add(requestId);
    try {
      await oc.permission.reply({ requestID: requestId, reply: "once" });
      const detail = [
        data.permission,
        ...(Array.isArray(data.patterns) ? data.patterns : []),
      ]
        .filter(Boolean)
        .join(" ");
      logWarn(
        "agent",
        `[${chatId}] Auto-approved ${backendLabel} permission ${requestId}${
          detail ? `: ${detail}` : ""
        }`,
      );
    } catch (err) {
      logWarn(
        "agent",
        `[${chatId}] Failed to approve ${backendLabel} permission ${requestId}: ${errMsg(err)}`,
      );
    }
  }
}
