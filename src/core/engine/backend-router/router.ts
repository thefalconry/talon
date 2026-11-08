/**
 * Plan-aware backend routing for background work.
 *
 * Background work — `spawn_agent` sub-agents, cron `query` jobs, the
 * heartbeat — would otherwise inherit whichever backend the chat is on.
 * On a multi-subscription install that is a good way to burn one plan to its
 * ceiling while another sits idle. When nothing is pinned, this picks the
 * backend with the most headroom instead.
 *
 * The rules, in order:
 *
 *   1. An explicit backend (or a model, which pins its backend) always wins.
 *      Routing is what happens in the *absence* of a choice, never over one.
 *   2. `config.router.enabled: false` returns the caller's own backend —
 *      byte-identical to pre-router Talon.
 *   3. Otherwise: rank the candidates by headroom, skip anyone at or above
 *      `ceilingPercent`, and take the top one.
 *
 * Only backends that can actually host an isolated run are candidates, and
 * routing never boots a cold provider to find out: a backend qualifies when
 * it is pooled with a `background` slot, or when the operator gave it a local
 * budget (`backendBudgets`), which is both an opt-in and the only way it
 * would have a headroom signal. The caller's own backend is always in the
 * running, so there is always an answer.
 *
 * Never between accounts of one provider. Backends in the caller's account
 * group (the `claude` backend and each extra Claude account) are not
 * candidates, and an extra account is never a candidate for anyone else's
 * work either (`explicitOnly`): the router may move work from Claude to
 * Codex when Claude is spent, but never from one Claude subscription to
 * another, nor pick between them. Which account
 * runs a piece of work is always an explicit choice — config, a `/backend`
 * switch, or a tool's `backend` argument (docs/claude-accounts.md).
 */

import type { TalonConfig } from "../../config/index.js";
import type { ReasoningEffortLevel } from "../../types.js";
import { log } from "../../../util/log.js";
import { isRoutingAlternate } from "../../agent-runtime/backend-registry.js";
import {
  acquireBackendInstance,
  getPoolConfig,
  getPooledBackend,
  listAvailableBackends,
} from "../backend-controller/index.js";
import {
  formatHeadroom,
  getBackendHeadroom,
  hasBudget,
  type BackendHeadroom,
} from "./headroom.js";

/** Default for `config.router.ceilingPercent`. */
export const DEFAULT_CEILING_PERCENT = 85;

/** Which background subsystem is asking. Logged, and nothing else — yet. */
export type RoutePurpose = "subagent" | "cron" | "heartbeat";

/**
 * A coarse shape-of-work hint. It never outranks headroom: a class either
 * *vetoes* backends that cannot do the job at all, or breaks a tie.
 */
export type TaskClass = "coding" | "mechanical" | "reasoning";

/**
 * The one place the task-class opinions live. `require` is a veto (applied
 * only when at least one required backend is a candidate, so a deployment
 * without it still gets an answer); `prefer` is tie-break order.
 *
 *   - coding      — agentic edit/test loops; Codex and Claude are the two
 *                   with real harnesses behind them.
 *   - mechanical  — sweeps and reformatting; cheapest first (agy's flash
 *                   tier, then Claude's haiku tier).
 *   - reasoning   — deep thinking (also where `xhigh` effort lands); Claude
 *                   is the only backend Talon drives an opus-class model on.
 */
const TASK_CLASS_RULES: Record<
  TaskClass,
  { readonly prefer: readonly string[]; readonly require?: readonly string[] }
> = {
  coding: { prefer: ["codex", "claude"] },
  mechanical: { prefer: ["agy", "claude"] },
  reasoning: { prefer: ["claude"], require: ["claude"] },
};

/** Ranking priority of a headroom source — measured beats unmeasured. */
const SOURCE_RANK: Record<BackendHeadroom["source"], number> = {
  plan: 0,
  ledger: 1,
  none: 2,
};

export interface RouteHints {
  readonly taskClass?: TaskClass;
  readonly effort?: ReasoningEffortLevel;
}

export interface RouteRequest {
  readonly purpose: RoutePurpose;
  /** An explicit backend from the caller. Wins outright. */
  readonly requestedBackendId?: string;
  /** An explicit model. Pins whatever backend is serving it. */
  readonly requestedModel?: string;
  /** The backend the caller would have used before routing existed. */
  readonly chatBackendId: string;
  /** Defaults to the config the backend pool was initialised with. */
  readonly config?: TalonConfig;
  readonly hints?: RouteHints;
}

export interface RouteDecision {
  readonly backendId: string;
  /** Only set when the caller pinned one — model choice stays downstream. */
  readonly model?: string;
  /** Human-readable: `pinned`, `disabled`, or why this backend won. */
  readonly reason: string;
  /** True when headroom actually chose this, rather than a pin or a default. */
  readonly routed: boolean;
  /** What the decision saw, for the spawn reply and the log line. */
  readonly headroom?: BackendHeadroom;
}

/** The task class a reasoning-effort level implies, if any. */
export function taskClassForEffort(
  effort: ReasoningEffortLevel | undefined,
): TaskClass | undefined {
  return effort === "xhigh" || effort === "high" ? "reasoning" : undefined;
}

/** `config.router`, with the documented defaults filled in. */
function routerSettings(config: TalonConfig | undefined): {
  enabled: boolean;
  ceilingPercent: number;
} {
  return {
    enabled: config?.router?.enabled ?? true,
    ceilingPercent: config?.router?.ceilingPercent ?? DEFAULT_CEILING_PERCENT,
  };
}

/**
 * Can this backend host an isolated run, without booting it to find out?
 * A pooled instance answers from its capability slots; a cold one qualifies
 * only on an explicit local budget (see the module comment).
 */
function isCandidate(
  id: string,
  config: TalonConfig | undefined,
  chatBackendId: string,
): boolean {
  if (id === chatBackendId) return true;
  // Another login of the caller's own provider is never an alternate, nor
  // is an explicit-only backend (every extra Claude account): no automatic
  // failover or rotation between subscriptions of one provider.
  if (!isRoutingAlternate(id, chatBackendId)) return false;
  const pooled = getPooledBackend(id);
  if (pooled) return Boolean(pooled.background);
  return hasBudget(config, id);
}

/** Percent of the tightest window — what the ceiling is applied to. */
function limitingPercent(entry: BackendHeadroom): number {
  return entry.limiting?.percent ?? 0;
}

/** Comparator: headroom first, then the documented tie-breaks. */
function rank(
  a: BackendHeadroom,
  b: BackendHeadroom,
  chatBackendId: string,
  prefer: readonly string[],
): number {
  // Headroom to 3dp: two backends a thousandth apart are a tie, not a winner.
  const byHeadroom =
    Math.round(b.headroom * 1000) - Math.round(a.headroom * 1000);
  if (byHeadroom !== 0) return byHeadroom;
  const bySource = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (bySource !== 0) return bySource;
  const preferIndex = (id: string): number => {
    const i = prefer.indexOf(id);
    return i === -1 ? prefer.length : i;
  };
  const byPrefer = preferIndex(a.id) - preferIndex(b.id);
  if (byPrefer !== 0) return byPrefer;
  // Cache warmth: a sub-agent is isolated, but the caller's backend is
  // already up and its MCP servers are already spawned.
  if (a.id === chatBackendId) return -1;
  if (b.id === chatBackendId) return 1;
  return a.id.localeCompare(b.id);
}

/**
 * Apply a task class's hard requirement, when a candidate still satisfies it.
 * Runs on the post-ceiling set, so a spent required backend is already gone.
 */
function applyVeto(
  entries: BackendHeadroom[],
  required: readonly string[] | undefined,
): BackendHeadroom[] {
  if (!required || required.length === 0) return entries;
  const kept = entries.filter((e) => required.includes(e.id));
  return kept.length > 0 ? kept : entries;
}

/** Drop candidates at or above the ceiling — unless that drops all of them. */
function applyCeiling(
  entries: BackendHeadroom[],
  ceilingPercent: number,
): { kept: BackendHeadroom[]; allOverCeiling: boolean } {
  const kept = entries.filter((e) => limitingPercent(e) < ceilingPercent);
  if (kept.length > 0) return { kept, allOverCeiling: false };
  // Everything is spent. Running the least-bad one beats running nothing:
  // the background subsystems have no queue to defer into.
  return { kept: entries, allOverCeiling: true };
}

function decisionFor(
  winner: BackendHeadroom,
  allOverCeiling: boolean,
): RouteDecision {
  const reason = allOverCeiling
    ? `every backend is over the ceiling — least spent: ${formatHeadroom(winner)}`
    : `most headroom ${Math.round(winner.headroom * 100)}%`;
  return {
    backendId: winner.id,
    reason,
    routed: true,
    headroom: winner,
  };
}

function logDecision(
  request: RouteRequest,
  decision: RouteDecision,
  candidates: BackendHeadroom[],
): void {
  const seen = candidates.map((c) => `${c.id}=${formatHeadroom(c)}`).join(", ");
  log(
    "router",
    `${request.purpose}: → ${decision.backendId} (${decision.reason})` +
      (seen ? ` | candidates: ${seen}` : ""),
  );
}

/**
 * Choose the backend a piece of background work should run on.
 *
 * Never throws and never returns nothing: every path ends at a real backend
 * id, falling back to the caller's own.
 */
export async function chooseBackend(
  request: RouteRequest,
): Promise<RouteDecision> {
  const { chatBackendId, purpose } = request;

  if (request.requestedBackendId || request.requestedModel) {
    const decision: RouteDecision = {
      backendId: request.requestedBackendId ?? chatBackendId,
      reason: "pinned",
      routed: false,
      ...(request.requestedModel ? { model: request.requestedModel } : {}),
    };
    log("router", `${purpose}: → ${decision.backendId} (pinned)`);
    return decision;
  }

  const config = request.config ?? getPoolConfig() ?? undefined;
  const settings = routerSettings(config);
  if (!settings.enabled) {
    return { backendId: chatBackendId, reason: "disabled", routed: false };
  }

  const ids = listAvailableBackends(config)
    .filter(({ id }) => isCandidate(id, config, chatBackendId))
    .map(({ id, label }) => ({ id, label }));
  if (ids.length === 0) {
    return { backendId: chatBackendId, reason: "no candidates", routed: false };
  }

  const measured = await Promise.all(
    ids.map(({ id, label }) => getBackendHeadroom(id, label, config)),
  );

  const rules = request.hints?.taskClass
    ? TASK_CLASS_RULES[request.hints.taskClass]
    : undefined;
  // Ceiling first, THEN the veto: a hard task-class requirement must not be
  // able to send work to a backend that is out of plan. A lesser model that
  // runs beats the right one that rate-limits.
  const { kept, allOverCeiling } = applyCeiling(
    measured,
    settings.ceilingPercent,
  );
  const eligible = applyVeto(kept, rules?.require);
  const ordered = [...eligible].sort((a, b) =>
    rank(a, b, chatBackendId, rules?.prefer ?? []),
  );
  const winner = ordered[0];
  if (!winner) {
    return { backendId: chatBackendId, reason: "no candidates", routed: false };
  }

  const decision = decisionFor(winner, allOverCeiling);
  logDecision(request, decision, measured);
  return decision;
}

/**
 * The default model for a backend the router just picked.
 *
 * A routed run cannot carry the caller's model across — a model id is
 * backend-specific. Config's `backendDefaults` wins (it is the operator's
 * answer to "what should this provider run"), then the backend's own
 * canonical default. Resolves `null` when neither exists, which the call
 * sites read as "stay where you were".
 */
export async function resolveRoutedModel(
  backendId: string,
  config?: TalonConfig,
): Promise<string | null> {
  const settings = config ?? getPoolConfig() ?? undefined;
  const configured = settings?.backendDefaults?.[backendId];
  if (configured) return configured;
  try {
    const pooled = getPooledBackend(backendId);
    if (pooled) return (await pooled.models?.getDefaultModelId()) ?? null;
    const acquired = await acquireBackendInstance(backendId);
    try {
      return (await acquired.backend.models?.getDefaultModelId()) ?? null;
    } finally {
      await acquired.release();
    }
  } catch {
    return null;
  }
}
