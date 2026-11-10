/**
 * Shared /reset and /status logic for chat frontends.
 *
 * All the frontend-agnostic work lives here so per-frontend copies can't
 * drift; frontends only render `SessionStatusData` in their native markup.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { Backend } from "../../core/agent-runtime/capabilities.js";
import {
  resetSession,
  getSessionInfo,
  getActiveSessionCount,
} from "../../storage/sessions.js";
import { markContextCleared } from "../../storage/history.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { resetPulseCheckpoint } from "../../core/background/pulse/pulse.js";
import { isPulseEnabled } from "../../core/background/pulse/pulse.js";
import { getWorkspaceDiskUsage } from "../../core/vfs/workspace.js";
import { appendDailyLog } from "../../storage/daily-log.js";
import { resolveActiveModelForChat } from "../../core/models/active-model.js";
import { getPooledBackend } from "../../core/engine/backend-controller/index.js";
import {
  buildCacheDisplay,
  buildCacheTempDisplay,
  buildContextDisplay,
  buildDaemonDisplay,
  buildPlanDisplay,
  type CacheDisplay,
  type CacheTempDisplay,
  type ContextDisplay,
  type DaemonDisplay,
  type PlanDisplay,
} from "./status-context.js";
import { getCacheVerdict, getMetrics } from "../../storage/metrics.js";
import { formatDuration } from "./format.js";
import { talonVersionLabel } from "../../util/version.js";

/**
 * Clear a chat's session state everywhere it lives: Talon's session store
 * (the replaced backend session id is archived), the chat's context (a
 * soft reset — see below), the pulse checkpoint, and any in-process
 * backend memory (e.g. openai-agents' MemorySession — stateless backends
 * ignore this). Ends by warming the new session so the next turn (and
 * /status) doesn't pay cold-start latency.
 */
export async function performSessionReset(
  chatId: string,
  backend: Backend | null | undefined,
): Promise<void> {
  const info = getSessionInfo(chatId);
  if (info.turns > 0) {
    const duration = info.createdAt
      ? formatDuration(Date.now() - info.createdAt)
      : "unknown";
    const modelNote =
      info.turns > 5 && info.lastModel ? ` | model: ${info.lastModel}` : "";
    const nameNote = info.sessionName ? ` "${info.sessionName}"` : "";
    appendDailyLog(
      "System",
      `Session reset${nameNote}: ${info.turns} turns, ${duration}${modelNote}`,
    );
  }
  resetSession(chatId);
  // Soft reset, on every frontend: the bot's context starts fresh after
  // this point, but no history row is deleted — the old conversation stays
  // searchable (search_history labels it) and recoverable. Hard-deleting
  // here once wiped weeks of history; only `talon history purge` deletes.
  markContextCleared(chatId);
  resetPulseCheckpoint(chatId);
  backend?.sessions?.resetChat?.(chatId);
  await backend?.sessions?.warmSession?.(chatId);
}

export interface SessionStatusData {
  activeModel: string;
  backendLabel: string;
  effortName: string;
  turnInProgress: boolean;
  pulseOn: boolean;
  context: ContextDisplay;
  cache: CacheDisplay | null;
  /**
   * Whether the chat's prompt prefix is still warm: the last turn's
   * cross-turn cache verdict and how long ago that turn ended. Null when no
   * turn has finished in this process (docs/cache-economics.md).
   */
  cacheTemp: CacheTempDisplay | null;
  plan: PlanDisplay | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  turnsModelLabel: string | undefined;
  lastResponseMs: number;
  avgResponseMs: number;
  fastestMs: number;
  diskBytes: number;
  sessionAge: string;
  sessionName: string | undefined;
  sessionId: string | undefined;
  uptime: string;
  activeSessionCount: number;
  /** Talon version plus runtime, e.g. "Talon v5.10.0 (ab12cd34) · Bun 1.3.9". */
  runtime: string;
  /** Daemon resident set size, in bytes. */
  rssBytes: number;
  /**
   * What the daemon itself costs: resident memory now, plus the CPU a turn
   * spends inside Talon (docs/ts-migration-plan.md, Phase 0).
   */
  daemon: DaemonDisplay;
}

/** Mean turn duration, or 0 before any turn has been timed. */
function averageResponseMs(turns: number, totalResponseMs: number): number {
  return turns > 0 && totalResponseMs ? Math.round(totalResponseMs / turns) : 0;
}

/**
 * Gather everything /status displays. `backend`/`backendId` come from the
 * frontend's own resolution (pool-aware via `resolveChatBackend`).
 */
export async function collectSessionStatus(
  chatId: string,
  config: TalonConfig,
  backend: Backend | null,
  backendId: string | null,
): Promise<SessionStatusData> {
  const info = getSessionInfo(chatId);
  const u = info.usage;
  const chatSets = getChatSettings(chatId);
  // Consume the resolved `ModelRef` so context window, cache support, and
  // display name come from one enriched object instead of three separate
  // fetches. The ref resolver wraps the same 5-step chain as
  // `resolveActiveModelForChat`, so the active model id is identical.
  const { ref: modelRef } = await resolveActiveModelForChat(
    chatId,
    backend,
    backendId,
    config,
  );
  const activeModel = modelRef?.id ?? "No model selected";

  let ctxMax = u.contextWindow; // from SDK modelUsage, preserved across turns
  let inputTokens = u.totalInputTokens;
  let outputTokens = u.totalOutputTokens;
  let cacheRead = u.totalCacheRead;
  let cacheWrite = u.totalCacheWrite;
  let turnsModelLabel = info.lastModel;

  if (modelRef?.contextWindow) {
    ctxMax = ctxMax || modelRef.contextWindow;
  }
  if (backend?.usage?.getSessionSnapshot && info.sessionId) {
    const snap = await backend.usage
      .getSessionSnapshot(info.sessionId)
      .catch(() => undefined);
    if (snap) {
      inputTokens = snap.inputTokens ?? inputTokens;
      outputTokens = snap.outputTokens ?? outputTokens;
      cacheRead = snap.cacheRead ?? cacheRead;
      cacheWrite = snap.cacheWrite ?? cacheWrite;
      if (snap.contextModelId) turnsModelLabel = snap.contextModelId;
      // Re-fetch context window for the actual model if different
      if (
        snap.contextModelId &&
        snap.contextModelId !== activeModel &&
        backend.models?.getRawModelInfo
      ) {
        const ctxModelInfo = await backend.models
          .getRawModelInfo(snap.contextModelId)
          .catch(() => undefined);
        if (ctxModelInfo?.contextWindow) ctxMax = ctxModelInfo.contextWindow;
      }
    }
  }

  const cache = buildCacheDisplay({
    cacheMetrics: backend?.cacheMetrics,
    inputTokens,
    cacheRead,
    cacheWrite,
  });

  const context = buildContextDisplay({
    contextTokens: u.contextTokens,
    lastPromptTokens: u.lastPromptTokens,
    contextWindow: ctxMax,
  });

  // Plan limits belong to the account, not the chat: fall back to the pooled
  // Claude backend so the section still shows while another provider serves
  // this chat.
  const planSource = backend?.usage?.getPlanUsage
    ? backend
    : getPooledBackend("claude");
  const plan = buildPlanDisplay(
    await planSource?.usage?.getPlanUsage?.().catch(() => undefined),
  );

  const memory = process.memoryUsage();

  return {
    activeModel,
    backendLabel: backend?.label ?? "",
    effortName: chatSets.effort ?? "adaptive",
    turnInProgress: Boolean(info.turnInProgress),
    pulseOn: isPulseEnabled(chatId),
    context,
    cache,
    cacheTemp: buildCacheTempDisplay({
      verdict: getCacheVerdict(chatId),
      lastTurnEndedAt: info.lastTurnEndedAt,
    }),
    plan,
    inputTokens,
    outputTokens,
    costUsd: u.estimatedCostUsd,
    turns: info.turns,
    turnsModelLabel,
    lastResponseMs: u.lastResponseMs || 0,
    avgResponseMs: averageResponseMs(info.turns, u.totalResponseMs),
    fastestMs: u.fastestResponseMs === Infinity ? 0 : u.fastestResponseMs || 0,
    diskBytes: getWorkspaceDiskUsage(config.workspace),
    sessionAge: info.createdAt
      ? formatDuration(Date.now() - info.createdAt)
      : "—",
    sessionName: info.sessionName,
    sessionId: info.sessionId,
    uptime: formatDuration(process.uptime() * 1000),
    activeSessionCount: getActiveSessionCount(),
    runtime: `Talon ${talonVersionLabel()} · ${
      process.versions.bun
        ? `Bun ${process.versions.bun}`
        : `Node ${process.versions.node}`
    }`,
    rssBytes: memory.rss,
    daemon: buildDaemonDisplay({
      rssBytes: memory.rss,
      heapBytes: memory.heapUsed,
      cpuPerTurn: getMetrics().histograms["turn.cpu_ms"],
    }),
  };
}
