/**
 * Runner — turns a spawn request into a live isolated run, and a finished
 * run into a settled record its parent hears about.
 *
 * The shape is the heartbeat / cron-job shape, because a sub-agent *is* one
 * of those: acquire a backend, resolve a model, open a run log, register a
 * task, and hand `runOneShotAgent` to `runIsolatedAgent` for the (optional)
 * hard timeout → abort → grace → eviction discipline. Nothing here is
 * backend-specific, which is the whole point: sub-agents work on Claude,
 * Codex, Kilo, OpenCode and any future backend with a background capability.
 *
 * What is specific to agents:
 *
 *   - **Identity.** Each run gets `contextLabel: "agent:<id>"`, which the
 *     backends turn into a per-agent MCP tool session and the gateway reads
 *     back to know which agent is calling `report_result`.
 *   - **Result precedence.** The `report_result` tool wins; otherwise the
 *     run's last assistant text is used; with neither, the run is a failure,
 *     because a sub-agent that says nothing has not done its job.
 *   - **Settlement is the delivery trigger.** Every terminal state — done,
 *     failed, killed, timed out — reaches the parent. Silence is never an
 *     outcome.
 *
 * `spawnAgent` returns as soon as the run is under way: the caller (a chat
 * turn or another agent) keeps working and hears back through the wake turn
 * or its mailbox.
 *
 *   - **Restarts are not deaths.** Every agent is mirrored to the `agents`
 *     table (see the registry's `persist` hook). A daemon shutdown parks the
 *     live ones (`interruptAgentsForRestart`) before it tears the backends
 *     down, so the abort that follows is not recorded as a kill and the
 *     parent is not told the agent died. On the next boot
 *     `resumeAgentsAfterRestart` brings each one back under its original id:
 *     on a backend that can resume (Claude SDK session, Codex thread) it
 *     continues its own conversation with a short "you were interrupted"
 *     note; elsewhere it is re-briefed with the tail of its previous run log.
 */

import { readFile } from "node:fs/promises";
import { dirs } from "../../util/paths.js";
import { log, logError, logWarn } from "../../util/log.js";
import {
  acquireBackendInstance,
  getBackendIdForChat,
  isModelValidForBackend,
} from "../engine/backend-controller/index.js";
import {
  chooseBackend,
  recordBackendRunFailure,
  recordBackendRunSuccess,
  recordBackendRunUsage,
  taskClassForEffort,
} from "../engine/backend-router/index.js";
import type {
  Backend,
  BackgroundRunner,
} from "../agent-runtime/capabilities.js";
import { taskTable } from "../tasks/index.js";
import type { TaskHandle, TaskUsage } from "../tasks/types.js";
import type { OneShotAgentParams } from "../types.js";
import {
  IsolatedAgentTimeoutError,
  runIsolatedAgent,
} from "../background/isolated-agent.js";
import { openRunLog } from "../background/run-log.js";
import { agentContextLabel } from "./context.js";
import {
  deliverMessage,
  deliverSettlement,
  initAgentDelivery,
  type AgentDeliveryDeps,
} from "./delivery.js";
import {
  agentLogHeader,
  agentLogPath,
  agentResumeLogHeader,
  buildAgentPrompt,
  buildAgentSystemPrompt,
  buildRebriefPrompt,
  buildResumePrompt,
  buildStallPing,
  buildStallWarning,
} from "./prompt.js";
import { closeTrail, openTrail, type RunTrail } from "./trail.js";
import { startWatchdog, type WatchdogHandle } from "./watchdog.js";
import * as agentsRepo from "../../storage/agents/repo.js";
import type { PersistedAgent } from "../../storage/agents/repo.js";
import { agentRegistry } from "./registry.js";
import type {
  AgentCaps,
  AgentParent,
  AgentRecord,
  AgentSpawnOutcome,
  AgentSpawnSpec,
  AgentTrail,
} from "./types.js";

/**
 * Defaults for `config.agents`, applied when the block is absent. No hard
 * timeout: the no-progress watchdog ends a run that has gone quiet, and a
 * run that is still working is left to finish.
 */
export const DEFAULT_AGENT_CAPS: AgentCaps = {
  maxConcurrent: 6,
  maxDepth: 2,
  stallTimeoutMs: 15 * 60 * 1000,
};

/** Floor the tool boundary clamps a requested `timeout_s` up to. */
const MIN_TIMEOUT_MS = 30_000;

/** Raised to abort a run the no-progress watchdog gave up on. */
class AgentStalledError extends Error {
  constructor(idleMs: number) {
    super(
      `stalled: no tool call or output for ${Math.round(idleMs / 60_000)} min`,
    );
    this.name = "AgentStalledError";
  }
}

const capsHolder: { caps: AgentCaps } = { caps: DEFAULT_AGENT_CAPS };

/** Wire the sub-agent subsystem. Called once from the composition root. */
export function initAgents(
  deps: AgentDeliveryDeps & { caps?: Partial<AgentCaps> },
): void {
  capsHolder.caps = { ...DEFAULT_AGENT_CAPS, ...deps.caps };
  initAgentDelivery({ execute: deps.execute });
  log(
    "agents",
    `Initialized — maxConcurrent=${capsHolder.caps.maxConcurrent} ` +
      `maxDepth=${capsHolder.caps.maxDepth} ` +
      `timeout=${describeTimeout(capsHolder.caps.defaultTimeoutMs)} ` +
      `ceiling=${describeTimeout(capsHolder.caps.maxTimeoutMs)} ` +
      `stall=${describeTimeout(capsHolder.caps.stallTimeoutMs || undefined)}` +
      (capsHolder.caps.allowedBackends?.length
        ? ` allowedBackends=${capsHolder.caps.allowedBackends.join(",")}`
        : ""),
  );
}

/** The live caps — read by the tools for their error copy and prompts. */
export function getAgentCaps(): AgentCaps {
  return capsHolder.caps;
}

/** "15m" / "90s" / "none" — for logs and tool text. */
export function describeTimeout(ms: number | undefined): string {
  if (ms === undefined || !(ms > 0)) return "none";
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
}

/**
 * The hard timeout a run gets: the requested one, else
 * `agents.defaultTimeoutMs`, either capped by `agents.maxTimeoutMs`; with
 * none of those set, `undefined` — no hard timeout. Applied by the runner,
 * so a resumed run follows the same rule as a fresh one.
 */
function effectiveTimeout(requestedMs: number | undefined): number | undefined {
  const { defaultTimeoutMs, maxTimeoutMs } = capsHolder.caps;
  const base = requestedMs ?? defaultTimeoutMs;
  if (base === undefined) return maxTimeoutMs;
  return maxTimeoutMs !== undefined ? Math.min(maxTimeoutMs, base) : base;
}

/**
 * The tool boundary's rule: a model-supplied timeout is floored at 30s,
 * then resolved like any other (`effectiveTimeout`). Returns `undefined`
 * for "no hard timeout".
 */
export function clampTimeout(
  requestedMs: number | undefined,
): number | undefined {
  return effectiveTimeout(
    requestedMs !== undefined && Number.isFinite(requestedMs)
      ? Math.max(MIN_TIMEOUT_MS, requestedMs)
      : undefined,
  );
}

/** The backend an agent inherits when the caller didn't pick one. */
function inheritedBackendId(parent: AgentParent): string | null {
  if (parent.kind === "chat") return getBackendIdForChat(parent.chatId);
  return agentRegistry.get(parent.agentId)?.backendId ?? null;
}

/** Where a spawn lands: backend, the model it inherits, and why. */
interface SpawnTarget {
  readonly backendId: string | null;
  /** The parent agent's model, inherited by an unpinned child. */
  readonly inheritedModel?: string;
  readonly routing?: string;
}

/**
 * Which backend this agent runs on, and why.
 *
 * An explicit backend (or model — a model id is backend-specific, so naming
 * one pins its backend) is honoured as written. A child of another agent
 * with neither inherits its parent's backend *and* model: a tree of agents
 * stays on the backend its root was put on, so a parent that chose (or was
 * told to use) a backend does not see its children wander off to another
 * subscription. A top-level spawn with neither is a routing decision:
 * sub-agents are isolated one-shots with no session to keep warm, so they
 * are the cheapest work to move onto whichever subscription has room.
 */
async function resolveSpawnBackend(spec: AgentSpawnSpec): Promise<SpawnTarget> {
  if (spec.backendId) return { backendId: spec.backendId };
  if (spec.parent.kind === "agent" && !spec.model) {
    const parent = agentRegistry.get(spec.parent.agentId);
    if (parent) {
      return {
        backendId: parent.backendId,
        ...(parent.model ? { inheritedModel: parent.model } : {}),
      };
    }
  }
  const inherited = inheritedBackendId(spec.parent);
  if (!inherited) return { backendId: null };
  const taskClass = taskClassForEffort(spec.reasoningEffort);
  const decision = await chooseBackend({
    purpose: "subagent",
    chatBackendId: inherited,
    ...(spec.model ? { requestedModel: spec.model } : {}),
    ...(taskClass || spec.reasoningEffort
      ? {
          hints: {
            ...(taskClass ? { taskClass } : {}),
            ...(spec.reasoningEffort ? { effort: spec.reasoningEffort } : {}),
          },
        }
      : {}),
  });
  // A routed pick outside the allowlist falls back to the inherited
  // backend rather than refusing a spawn the caller never pinned.
  if (
    decision.routed &&
    !isBackendAllowed(decision.backendId) &&
    isBackendAllowed(inherited)
  ) {
    return { backendId: inherited };
  }
  return {
    backendId: decision.backendId,
    ...(decision.routed ? { routing: decision.reason } : {}),
  };
}

/** Whether `agents.allowedBackends` (when set) lets an agent run here. */
function isBackendAllowed(backendId: string): boolean {
  const allowed = capsHolder.caps.allowedBackends;
  return !allowed || allowed.length === 0 || allowed.includes(backendId);
}

/** The tool error for a backend outside `agents.allowedBackends`. */
function disallowedBackendError(backendId: string): string {
  const allowed = capsHolder.caps.allowedBackends ?? [];
  return (
    `Backend "${backendId}" is not allowed for sub-agents ` +
    `(agents.allowedBackends: ${allowed.join(", ")}). Pass one of those ` +
    `as backend, or leave it unset to inherit.`
  );
}

/** The chat a run's task belongs to, for `talon ps`. */
function taskChatId(parent: AgentParent): string | undefined {
  if (parent.kind === "chat") return parent.chatId;
  const root = agentRegistry.get(parent.agentId)?.parent;
  return root?.kind === "chat" ? root.chatId : undefined;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the model for a run: an explicit id is validated against the
 * backend, an absent one falls back to that backend's own default. Returns
 * the error text a tool should show instead of throwing.
 */
async function resolveRun(
  backend: Backend,
  backendId: string,
  requested: string | undefined,
): Promise<
  | { ok: true; model: string; background: BackgroundRunner }
  | { ok: false; error: string }
> {
  const background = backend.background;
  if (!background) {
    return {
      ok: false,
      error:
        `Backend "${backendId}" cannot host a sub-agent (it has no ` +
        `background capability). Pick another backend or leave it unset.`,
    };
  }
  if (requested) {
    let valid = false;
    try {
      valid = await isModelValidForBackend(backend, requested);
    } catch (err) {
      return {
        ok: false,
        error: `Could not validate model "${requested}" on backend "${backendId}": ${errText(err)}`,
      };
    }
    if (!valid) {
      return {
        ok: false,
        error:
          `Model "${requested}" is not selectable on backend "${backendId}". ` +
          `Call list_models to see valid ids, or leave model unset to use ` +
          `that backend's default.`,
      };
    }
    return { ok: true, model: requested, background };
  }
  let fallback: string | null | undefined;
  try {
    fallback = await backend.models?.getDefaultModelId();
  } catch (err) {
    return {
      ok: false,
      error: `Backend "${backendId}" could not report a default model: ${errText(err)}`,
    };
  }
  if (!fallback) {
    return {
      ok: false,
      error:
        `Backend "${backendId}" has no default model — pass an explicit ` +
        `model (list_models shows what it offers).`,
    };
  }
  return { ok: true, model: fallback, background };
}

/**
 * Spawn a sub-agent. Resolves once the run is under way (or refused) — never
 * when the agent finishes; that arrives through delivery.
 */
export async function spawnAgent(
  spec: AgentSpawnSpec,
): Promise<AgentSpawnOutcome> {
  const routed = await resolveSpawnBackend(spec);
  const backendId = routed.backendId;
  if (!backendId) {
    return {
      ok: false,
      error:
        "Could not resolve a backend for this agent — pass one explicitly.",
    };
  }
  if (!isBackendAllowed(backendId)) {
    return { ok: false, error: disallowedBackendError(backendId) };
  }
  const model = spec.model ?? routed.inheritedModel;

  // Register first: the slot and the depth are claimed synchronously, so two
  // concurrent spawns can never both slip past maxConcurrent while awaiting
  // the backend. A registration that never starts is discarded without trace.
  const registered = agentRegistry.register(
    {
      label: spec.label,
      brief: spec.brief,
      parent: spec.parent,
      backendId,
      ...(spec.reasoningEffort
        ? { reasoningEffort: spec.reasoningEffort }
        : {}),
      ...(spec.model ? { requestedModel: spec.model } : {}),
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      cwd: dirs.workspace,
      ...(spec.preflight ? { preflight: true } : {}),
    },
    capsHolder.caps,
  );
  if (!registered.ok) return registered;
  const record = registered.record;

  let acquired: Awaited<ReturnType<typeof acquireBackendInstance>>;
  try {
    acquired = await acquireBackendInstance(backendId);
  } catch (err) {
    agentRegistry.discard(record.id);
    return {
      ok: false,
      error: `Backend "${backendId}" is unavailable: ${errText(err)}`,
    };
  }

  const resolved = await resolveRun(acquired.backend, backendId, model);
  if (!resolved.ok) {
    agentRegistry.discard(record.id);
    await acquired.release();
    return resolved;
  }

  // The run owns the instance from here: `runAgent` releases it on every
  // path, including the ones that throw.
  void runAgent(record, spec, resolved, acquired);
  return {
    ok: true,
    agentId: record.id,
    backendId,
    model: resolved.model,
    ...(routed.routing ? { routing: routed.routing } : {}),
  };
}

/**
 * How a restarted run picks up. `sessionId` set = continue that backend
 * conversation; unset = a fresh conversation re-briefed with `prompt`.
 */
interface ResumePlan {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly interruptedAt: number;
}

/** Build the one-shot params for a run, wired to its log and text capture. */
async function buildRunParams(
  record: AgentRecord,
  spec: AgentSpawnSpec,
  model: string,
  abortController: AbortController,
  capture: { last: string },
  trail: RunTrail,
  resume?: ResumePlan,
): Promise<OneShotAgentParams> {
  const writeLog = await openRunLog(
    agentLogPath(record.id),
    resume
      ? agentResumeLogHeader(
          record,
          model,
          resume.interruptedAt,
          resume.sessionId,
        )
      : agentLogHeader(record, model),
  );
  const id = record.id;
  const appendLog = (text: string): Promise<void> => {
    trail.onLog(text);
    return writeLog(text);
  };
  return {
    prompt: resume
      ? resume.prompt
      : buildAgentPrompt(record.brief, {
          preflight: spec.preflight === true,
        }),
    systemPrompt: buildAgentSystemPrompt({
      agentId: record.id,
      label: record.label,
      parent: record.parent,
      depth: record.depth,
      maxDepth: capsHolder.caps.maxDepth,
    }),
    workspace: dirs.workspace,
    model,
    contextLabel: agentContextLabel(record.id),
    abortController,
    appendLog,
    onAssistantText: (text) => {
      const trimmed = text.trim();
      if (trimmed) capture.last = trimmed;
      trail.onAssistantText(text);
    },
    // Persisted the moment the backend reports it, so a restart at any
    // point after the first message can resume the conversation.
    onSessionId: (sessionId) => agentRegistry.setSessionId(id, sessionId),
    ...(resume?.sessionId ? { resumeSessionId: resume.sessionId } : {}),
    ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
  };
}

/** Settle a run that returned normally, applying the result precedence. */
function settleSuccess(
  id: string,
  task: TaskHandle,
  lastText: string,
  usage: TaskUsage | undefined,
  trail: AgentTrail,
): AgentRecord | null {
  if (agentRegistry.hasReported(id)) {
    task.succeed(usage);
    return agentRegistry.settle(id, {
      state: "done",
      trail,
      ...(usage ? { usage } : {}),
    });
  }
  if (lastText) {
    task.succeed(usage);
    return agentRegistry.settle(id, {
      state: "done",
      result: { summary: lastText },
      trail,
      ...(usage ? { usage } : {}),
    });
  }
  const error =
    "the agent finished without calling report_result and produced no text";
  task.fail(new Error(error), usage);
  return agentRegistry.settle(id, {
    state: "failed",
    error,
    trail,
    ...(usage ? { usage } : {}),
  });
}

/**
 * Settle a run that threw: timeout, stall, kill, or a genuine failure.
 * `stalled` is the watchdog's own abort reason, checked first because a
 * backend that honours the abort rejects with its own error.
 */
function settleFailure(
  id: string,
  task: TaskHandle,
  err: unknown,
  trail: AgentTrail,
  stalled?: AgentStalledError,
): AgentRecord | null {
  const state =
    stalled || err instanceof IsolatedAgentTimeoutError
      ? "timed_out"
      : agentRegistry.killRequested(id)
        ? "killed"
        : "failed";
  task.fail(stalled ?? err);
  return agentRegistry.settle(id, {
    state,
    error: errText(stalled ?? err),
    trail,
  });
}

/**
 * Start the no-progress watchdog for one run (see `watchdog.ts`). Its kill
 * aborts the run with an `AgentStalledError` recorded in `watch.stalled`,
 * which the settle path reads to classify the run `timed_out`.
 */
function watchRun(
  id: string,
  trail: RunTrail,
  abortController: AbortController,
): { watch: { stalled?: AgentStalledError }; watchdog: WatchdogHandle } {
  const watch: { stalled?: AgentStalledError } = {};
  const watchdog = startWatchdog(capsHolder.caps.stallTimeoutMs, {
    lastActivityAt: () => trail.lastActivityAt,
    pingAgent: (idleMs) => {
      agentRegistry.push(id, {
        from: "watchdog",
        text: buildStallPing(idleMs, capsHolder.caps.stallTimeoutMs),
        at: Date.now(),
      });
      logWarn(
        "agents",
        `${id} quiet for ${Math.round(idleMs / 1000)}s — pinged`,
      );
    },
    warnParent: (idleMs, killInMs) => {
      const current = agentRegistry.get(id);
      if (!current) return;
      void deliverMessage(
        current,
        buildStallWarning(current, idleMs, killInMs),
      ).catch((err: unknown) =>
        logError("agents", `stall warning delivery failed for ${id}`, err),
      );
    },
    kill: (idleMs) => {
      watch.stalled = new AgentStalledError(idleMs);
      logWarn("agents", `${id}: ${watch.stalled.message} — aborting`);
      try {
        abortController.abort(watch.stalled);
      } catch {
        /* the settle path below still runs */
      }
    },
  });
  return { watch, watchdog };
}

/**
 * Drive one run end to end. Never rejects — it is the tail of a
 * fire-and-forget spawn, so every failure has to end as a settled record
 * their parent is told about.
 */
async function runAgent(
  record: AgentRecord,
  spec: AgentSpawnSpec,
  resolved: { model: string; background: BackgroundRunner },
  acquired: Awaited<ReturnType<typeof acquireBackendInstance>>,
  resume?: ResumePlan,
): Promise<void> {
  const { model, background } = resolved;
  const { release } = acquired;
  const id = record.id;
  const abortController = new AbortController();
  const capture = { last: "" };
  const timeoutMs = effectiveTimeout(spec.timeoutMs);
  const trail = openTrail(id);
  const { watch, watchdog } = watchRun(id, trail, abortController);

  // Registered as queued, bound, then started — so a kill arriving in the
  // gap between the task existing and the abort handle being published still
  // reaches the run.
  const chatId = taskChatId(record.parent);
  const task = taskTable.enqueue({
    kind: "agent",
    label: record.label,
    abort: () => void agentRegistry.requestKill(id),
    ...(chatId !== undefined ? { chatId } : {}),
  });
  task.bind({ model, backendId: record.backendId });
  agentRegistry.start(id, { model, abort: abortController, taskId: task.id });
  task.start();

  let settled: AgentRecord | null = null;
  try {
    const params = await buildRunParams(
      record,
      spec,
      model,
      abortController,
      capture,
      trail,
      resume,
    );
    if (agentRegistry.isInterrupted(id)) {
      settled = null;
    } else if (abortController.signal.aborted) {
      // A kill that lands during startup — while the backend is being
      // acquired or the log opened — must not be lost. Handing an
      // already-aborted signal to a backend relies on it checking, and not
      // every SDK does; settling here is the one behaviour that always holds.
      settled = settleFailure(
        id,
        task,
        new Error("aborted before the run started"),
        trail.snapshot(),
      );
    } else {
      const usage = await runIsolatedAgent({
        background,
        params,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        logCategory: "agents",
        // Safe to sweep: the context label is unique to this agent, so no
        // other context's subprocesses share the tag.
        evictLabel: agentContextLabel(id),
      });
      recordBackendRunUsage(record.backendId, usage ?? undefined);
      // A backend may swallow the shutdown abort and return normally — the
      // run still did not finish, so it must not settle as done/failed, and
      // it says nothing about the backend's health either way.
      if (agentRegistry.isInterrupted(id)) {
        settled = null;
      } else {
        if (watch.stalled) {
          // The backend swallowed the watchdog's abort and returned.
          settled = settleFailure(
            id,
            task,
            watch.stalled,
            trail.snapshot(),
            watch.stalled,
          );
        } else {
          recordBackendRunSuccess(record.backendId);
          settled = settleSuccess(
            id,
            task,
            capture.last,
            usage ?? undefined,
            trail.snapshot(),
          );
        }
      }
    }
  } catch (err) {
    if (agentRegistry.isInterrupted(id)) {
      settled = null;
    } else {
      if (!watch.stalled) recordBackendRunFailure(record.backendId, err);
      settled = settleFailure(id, task, err, trail.snapshot(), watch.stalled);
    }
  } finally {
    watchdog.stop();
    closeTrail(id);
    await release().catch((err: unknown) =>
      logError("agents", `failed to release backend for ${id}`, err),
    );
  }

  if (agentRegistry.isInterrupted(id)) {
    // Parked by a daemon shutdown: the persisted row stays `running` for
    // the next boot to resume. No settlement, no delivery, no reaping — the
    // parent is not told its agent died, because it didn't.
    task.fail(new Error("interrupted by daemon shutdown — will resume"));
    agentRegistry.releaseInterrupted(id);
    log("agents", `${id} "${record.label}" interrupted by shutdown — parked`);
    return;
  }
  if (!settled) return;
  log(
    "agents",
    `${id} "${settled.label}" → ${settled.state} ` +
      `(${settled.backendId}/${model}, timeout ${describeTimeout(timeoutMs)})`,
  );
  reapChildren(settled);
  await deliverSettlement(settled).catch((err: unknown) =>
    logError("agents", `delivery failed for ${id}`, err),
  );
}

/**
 * Kill a settled agent's still-running children. Their reports would have
 * nowhere to go, so leaving them running only spends tokens.
 */
function reapChildren(record: AgentRecord): void {
  for (const child of agentRegistry.liveChildren(record.id)) {
    logWarn(
      "agents",
      `killing ${child}: its parent ${record.id} settled as ${record.state}`,
    );
    killAgent(child);
  }
}

/**
 * Request a kill. Routed through the task table when the run has a task, so
 * `talon ps` shows it as `killed` rather than `failed` — one kill path, two
 * surfaces. Returns false when the agent is unknown or already settled.
 */
export function killAgent(agentId: string): boolean {
  const record = agentRegistry.get(agentId);
  if (!record || !agentRegistry.isLive(agentId)) return false;
  if (record.taskId !== undefined) return taskTable.kill(record.taskId).ok;
  return agentRegistry.requestKill(agentId);
}

/**
 * Park every live agent for the next boot. Called FIRST in a graceful
 * shutdown — before the frontends and the backend pool go down, since
 * tearing a backend down aborts the runs on it and an unparked agent would
 * record that abort as its death. Idempotent.
 */
export function interruptAgentsForRestart(): number {
  const parked = agentRegistry.interruptAll();
  if (parked > 0) {
    log("agents", `Shutdown: parked ${parked} running agent(s) for resume`);
  }
  return parked;
}

/**
 * Abort every live agent — the shutdown lever, alongside heartbeat's and
 * cron's. Agents are parked first (a no-op if the shutdown already did), so
 * this abort ends the process's hold on them without ending the agents:
 * the next boot resumes them. Returns how many aborts were requested.
 */
export function shutdownAgents(): number {
  interruptAgentsForRestart();
  const killed = agentRegistry.killAll();
  if (killed > 0) log("agents", `Shutdown: aborted ${killed} running agent(s)`);
  return killed;
}

// ── Resume after restart ─────────────────────────────────────────────────────

/** A restart may resume one agent at most this many times. */
export const MAX_AGENT_RESUMES = 3;
/** An agent interrupted longer ago than this is not resumed. */
const AGENT_RESUME_STALE_MS = 24 * 60 * 60 * 1000;
/** A resumed run always gets at least this much wall-clock. */
const AGENT_RESUME_MIN_TIMEOUT_MS = 10 * 60 * 1000;
/** Settled rows are kept this long for inspection, then pruned at boot. */
const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How much of the previous run log a re-briefed agent is shown. */
const REBRIEF_LOG_TAIL_CHARS = 12_000;

/** The last `max` characters of an agent's previous run log, if any. */
async function previousLogTail(agentId: string, max: number): Promise<string> {
  try {
    const text = await readFile(agentLogPath(agentId), "utf-8");
    return text.length > max ? `…${text.slice(text.length - max)}` : text;
  } catch {
    return "";
  }
}

/** Settle a restored agent without running it, and tell its parent. */
async function settleRestored(
  record: AgentRecord,
  patch: Parameters<typeof agentRegistry.settle>[1],
): Promise<void> {
  const settled = agentRegistry.settle(record.id, patch);
  if (!settled) return;
  log(
    "agents",
    `${record.id} "${record.label}" → ${settled.state} (after restart)`,
  );
  reapChildren(settled);
  await deliverSettlement(settled).catch((err: unknown) =>
    logError("agents", `delivery failed for ${record.id}`, err),
  );
}

/** Mark a row that cannot even be restored (its parent agent is gone). */
function abandonRow(saved: PersistedAgent, error: string): void {
  try {
    agentsRepo.upsert({
      ...saved,
      state: "failed",
      error,
      endedAt: Date.now(),
      updatedAt: Date.now(),
    });
  } catch (err) {
    logError("agents", `could not mark ${saved.id} abandoned`, err);
  }
}

/**
 * Resolve the model a resumed run uses: the one it ran on, else the one it
 * asked for, else the backend default — a model withdrawn across the
 * restart must not strand the agent.
 */
async function resolveResumeRun(
  backend: Backend,
  backendId: string,
  candidates: ReadonlyArray<string | undefined>,
): Promise<Awaited<ReturnType<typeof resolveRun>>> {
  let last: Awaited<ReturnType<typeof resolveRun>> = {
    ok: false,
    error: "no model",
  };
  const tried = new Set<string | undefined>();
  for (const candidate of [...candidates, undefined]) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    last = await resolveRun(backend, backendId, candidate);
    if (last.ok) return last;
  }
  return last;
}

/** Bring one interrupted agent back. Never throws. */
async function resumeOne(saved: PersistedAgent, now: number): Promise<void> {
  // A crash leaves no interruption stamp: charge the run up to its last
  // persisted write, which is as close as anyone can know.
  const interruptedAt = saved.interruptedAt ?? saved.updatedAt;
  const elapsedMs =
    saved.interruptedAt === undefined && saved.startedAt !== undefined
      ? saved.elapsedMs + Math.max(0, saved.updatedAt - saved.startedAt)
      : saved.elapsedMs;

  // Already back (a second resume pass in the same process) — leave it be.
  if (agentRegistry.isLive(saved.id)) return;
  const record = agentRegistry.restore({ ...saved, elapsedMs, interruptedAt });
  if (!record) {
    abandonRow(
      saved,
      "interrupted by a daemon restart; its parent agent did not survive it",
    );
    logWarn("agents", `${saved.id}: parent gone after restart — abandoned`);
    return;
  }

  if (saved.reported) {
    // It finished its job (report_result landed) and was only waiting to
    // wind down — deliver what it said instead of running it again.
    await settleRestored(record, { state: "done" });
    return;
  }
  if (saved.resumeCount >= MAX_AGENT_RESUMES) {
    await settleRestored(record, {
      state: "failed",
      error:
        `interrupted by ${saved.resumeCount + 1} daemon restarts; not ` +
        `resumed again. Its run log is ${agentLogPath(saved.id)}.`,
    });
    return;
  }
  if (now - interruptedAt > AGENT_RESUME_STALE_MS) {
    await settleRestored(record, {
      state: "failed",
      error:
        `interrupted by a daemon restart at ${new Date(interruptedAt).toISOString()} ` +
        `and the daemon was down too long to resume it. Its run log is ` +
        `${agentLogPath(saved.id)}.`,
    });
    return;
  }

  const backendId = saved.backendId;
  let acquired: Awaited<ReturnType<typeof acquireBackendInstance>>;
  try {
    acquired = await acquireBackendInstance(backendId);
  } catch (err) {
    await settleRestored(record, {
      state: "failed",
      error:
        `interrupted by a daemon restart, and its backend "${backendId}" ` +
        `is unavailable after it: ${errText(err)}`,
    });
    return;
  }
  const resolved = await resolveResumeRun(acquired.backend, backendId, [
    saved.model,
    saved.requestedModel,
  ]);
  if (!resolved.ok) {
    await acquired.release().catch(() => {});
    await settleRestored(record, {
      state: "failed",
      error: `interrupted by a daemon restart and could not resume: ${resolved.error}`,
    });
    return;
  }

  const canResume =
    resolved.background.supportsResume === true &&
    saved.sessionId !== undefined;
  const minutes = Math.round(elapsedMs / 60_000);
  const plan: ResumePlan = canResume
    ? {
        prompt: buildResumePrompt({ interruptedAt, elapsedMinutes: minutes }),
        sessionId: saved.sessionId!,
        interruptedAt,
      }
    : {
        prompt: buildRebriefPrompt({
          brief: saved.brief,
          preflight: saved.preflight === true,
          interruptedAt,
          elapsedMinutes: minutes,
          logPath: agentLogPath(saved.id),
          logTail: await previousLogTail(saved.id, REBRIEF_LOG_TAIL_CHARS),
        }),
        interruptedAt,
      };

  // An uncapped run stays uncapped; a capped one gets what it had left.
  const cap = effectiveTimeout(saved.timeoutMs);
  const timeoutMs =
    cap === undefined
      ? undefined
      : Math.max(AGENT_RESUME_MIN_TIMEOUT_MS, cap - elapsedMs);
  const spec: AgentSpawnSpec = {
    brief: saved.brief,
    label: saved.label,
    parent: record.parent,
    backendId,
    ...(saved.requestedModel ? { model: saved.requestedModel } : {}),
    ...(record.reasoningEffort
      ? { reasoningEffort: record.reasoningEffort }
      : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(saved.preflight ? { preflight: true } : {}),
  };
  agentRegistry.markResumed(record.id);
  log(
    "agents",
    `${record.id} "${record.label}" resuming after restart ` +
      `(${canResume ? `session ${saved.sessionId}` : "re-briefed"}, ` +
      `${backendId}/${resolved.model}, timeout ${describeTimeout(timeoutMs)}, ` +
      `resume #${saved.resumeCount + 1})`,
  );
  void runAgent(record, spec, resolved, acquired, plan);
}

/**
 * Boot-time: respawn every agent the previous process left running. Call
 * once, after the dispatcher, backend pool and frontends are up (a resumed
 * agent reaches its tools and its parent through them). Parents come back
 * before their children, so a child re-attaches to its live parent.
 * Returns how many rows were considered.
 */
export async function resumeAgentsAfterRestart(): Promise<number> {
  const now = Date.now();
  try {
    const pruned = agentsRepo.pruneSettled(now - SETTLED_RETENTION_MS);
    if (pruned > 0) log("agents", `Pruned ${pruned} settled agent row(s)`);
  } catch (err) {
    logError("agents", "prune of settled agent rows failed", err);
  }
  let rows: PersistedAgent[];
  try {
    rows = agentsRepo.listInterrupted();
  } catch (err) {
    logError("agents", "could not read interrupted agents", err);
    return 0;
  }
  if (rows.length === 0) return 0;
  log("agents", `Resuming ${rows.length} agent(s) interrupted by the restart`);
  for (const saved of rows) {
    try {
      await resumeOne(saved, now);
    } catch (err) {
      logError("agents", `resume of ${saved.id} failed`, err);
    }
  }
  return rows.length;
}
