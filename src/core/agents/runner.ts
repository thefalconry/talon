/**
 * Runner — turns a spawn request into a live isolated run, and a finished
 * run into a settled record its parent hears about.
 *
 * The shape is the heartbeat / cron-job shape, because a sub-agent *is* one
 * of those: acquire a backend, resolve a model, open a run log, register a
 * task, and hand `runOneShotAgent` to `runIsolatedAgent` for the hard
 * timeout → abort → grace → eviction discipline. Nothing here is
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
 *   - **Restarts don't end runs.** A graceful shutdown — /restart, /update,
 *     SIGTERM — calls `suspendAgents`: every live agent's run spec is
 *     persisted, delivery is switched off, and the runs are aborted. The next
 *     daemon's `resumeSuspendedAgents` re-launches each one under the same id
 *     (so send_to_agent, list_agents and the parent's wake-up still line up)
 *     with the rest of its time budget and a note to check what the cut-off
 *     run already did. Backends expose no resumable one-shot session, so a
 *     resume is a fresh run of the same brief. Bounded: a row is claimed once
 *     per boot, an agent is resumed at most MAX_RESUMES times, only within
 *     RESUME_WINDOW_MS of the shutdown, and only inside the concurrency cap;
 *     anything that can't be resumed settles as `killed` and its parent is
 *     told why.
 */

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
  deliverSettlement,
  initAgentDelivery,
  type AgentDeliveryDeps,
} from "./delivery.js";
import {
  agentLogHeader,
  agentLogPath,
  buildAgentPrompt,
  buildAgentSystemPrompt,
} from "./prompt.js";
import { agentRegistry } from "./registry.js";
import {
  claimSuspendedAgents,
  saveSuspendedAgents,
  type SuspendedAgent,
} from "../../storage/suspended-agents.js";
import type { ReasoningEffortLevel } from "../types.js";
import type { AgentResumeContext } from "./prompt.js";
import type {
  AgentCaps,
  AgentParent,
  AgentRecord,
  AgentSpawnOutcome,
  AgentSpawnSpec,
} from "./types.js";

/** Defaults for `config.agents`, applied when the block is absent. */
export const DEFAULT_AGENT_CAPS: AgentCaps = {
  maxConcurrent: 6,
  maxDepth: 2,
  defaultTimeoutMs: 15 * 60 * 1000,
};

/** Floor and ceiling the tool boundary clamps a requested `timeout_s` into. */
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

const capsHolder: { caps: AgentCaps } = { caps: DEFAULT_AGENT_CAPS };

/** Times one agent may be resumed across restarts before it is given up. */
export const MAX_RESUMES = 3;
/** How long after a shutdown its agents may still be resumed. */
export const RESUME_WINDOW_MS = 60 * 60 * 1000;
/** Least wall-clock a resumed run gets, however little its cap had left. */
export const RESUME_MIN_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * What the runner remembers about each live agent beyond its registry
 * record — exactly what a shutdown must persist to relaunch it.
 */
interface LiveRun {
  readonly spec: AgentSpawnSpec;
  /** This run's wall-clock cap (for a resumed run: what was left). */
  readonly timeoutMs: number;
  /** How many restarts this agent has already been resumed across. */
  readonly resumes: number;
}

const runs = new Map<string, LiveRun>();

/**
 * Set by `suspendAgents` for the rest of the process: new spawns are
 * refused, and settlements are not delivered — every agent the shutdown
 * aborts was handed to the successor, which will report it for real.
 */
let suspending = false;

/** Wire the sub-agent subsystem. Called once from the composition root. */
export function initAgents(
  deps: AgentDeliveryDeps & { caps?: Partial<AgentCaps> },
): void {
  capsHolder.caps = { ...DEFAULT_AGENT_CAPS, ...deps.caps };
  suspending = false;
  runs.clear();
  initAgentDelivery({ execute: deps.execute });
  log(
    "agents",
    `Initialized — maxConcurrent=${capsHolder.caps.maxConcurrent} ` +
      `maxDepth=${capsHolder.caps.maxDepth} ` +
      `timeout=${Math.round(capsHolder.caps.defaultTimeoutMs / 1000)}s`,
  );
}

/** The live caps — read by the tools for their error copy and prompts. */
export function getAgentCaps(): AgentCaps {
  return capsHolder.caps;
}

/**
 * Clamp a model-supplied timeout into the supported window, or fall back to
 * the configured default. Applied at the tool boundary — `spawnAgent` itself
 * honours whatever it is handed, so the runner has one rule and not two.
 */
export function clampTimeout(requestedMs: number | undefined): number {
  if (requestedMs === undefined) return capsHolder.caps.defaultTimeoutMs;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, requestedMs));
}

/** The backend an agent inherits when the caller didn't pick one. */
function inheritedBackendId(parent: AgentParent): string | null {
  if (parent.kind === "chat") return getBackendIdForChat(parent.chatId);
  return agentRegistry.get(parent.agentId)?.backendId ?? null;
}

/**
 * Which backend this agent runs on, and why.
 *
 * An explicit backend (or model — a model id is backend-specific, so naming
 * one pins its backend) is honoured as written. With neither, the run is a
 * routing decision: sub-agents are isolated one-shots with no session to
 * keep warm, so they are the cheapest work to move onto whichever
 * subscription has room.
 */
async function resolveSpawnBackend(
  spec: AgentSpawnSpec,
): Promise<{ backendId: string | null; routing?: string }> {
  if (spec.backendId) return { backendId: spec.backendId };
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
  return {
    backendId: decision.backendId,
    ...(decision.routed ? { routing: decision.reason } : {}),
  };
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
  if (suspending) {
    return {
      ok: false,
      error:
        "The daemon is restarting — running agents will resume in the next " +
        "process. Spawn this once it is back.",
    };
  }
  const routed = await resolveSpawnBackend(spec);
  const backendId = routed.backendId;
  if (!backendId) {
    return {
      ok: false,
      error:
        "Could not resolve a backend for this agent — pass one explicitly.",
    };
  }

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
    },
    capsHolder.caps,
  );
  if (!registered.ok) return registered;
  const launched = await launchRun(registered.record, {
    spec,
    timeoutMs: spec.timeoutMs ?? capsHolder.caps.defaultTimeoutMs,
    resumes: 0,
  });
  if (!launched.ok) return launched;
  return {
    ok: true,
    agentId: registered.record.id,
    backendId,
    model: launched.model,
    ...(routed.routing ? { routing: routed.routing } : {}),
  };
}

/**
 * Acquire the backend and resolve the model for a registered agent, then
 * start its run. A registration that fails here is discarded without trace.
 */
async function launchRun(
  record: AgentRecord,
  run: LiveRun,
  resumed?: AgentResumeContext,
): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
  const { backendId } = record;
  runs.set(record.id, run);
  const discard = (): void => {
    runs.delete(record.id);
    agentRegistry.discard(record.id);
  };

  let acquired: Awaited<ReturnType<typeof acquireBackendInstance>>;
  try {
    acquired = await acquireBackendInstance(backendId);
  } catch (err) {
    discard();
    return {
      ok: false,
      error: `Backend "${backendId}" is unavailable: ${errText(err)}`,
    };
  }

  const resolved = await resolveRun(
    acquired.backend,
    backendId,
    run.spec.model,
  );
  if (!resolved.ok) {
    discard();
    await acquired.release();
    return resolved;
  }

  // The run owns the instance from here: `runAgent` releases it on every
  // path, including the ones that throw.
  void runAgent(record, run, resolved, acquired, resumed);
  return { ok: true, model: resolved.model };
}

/** Build the one-shot params for a run, wired to its log and text capture. */
async function buildRunParams(
  record: AgentRecord,
  spec: AgentSpawnSpec,
  model: string,
  abortController: AbortController,
  capture: { last: string },
  resumed: AgentResumeContext | undefined,
): Promise<OneShotAgentParams> {
  const appendLog = await openRunLog(
    agentLogPath(record.id),
    agentLogHeader(record, model),
  );
  return {
    prompt: buildAgentPrompt(record.brief, {
      preflight: spec.preflight === true,
      ...(resumed ? { resumed } : {}),
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
    },
    ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
  };
}

/** Settle a run that returned normally, applying the result precedence. */
function settleSuccess(
  id: string,
  task: TaskHandle,
  lastText: string,
  usage: TaskUsage | undefined,
): AgentRecord | null {
  if (agentRegistry.hasReported(id)) {
    task.succeed(usage);
    return agentRegistry.settle(id, {
      state: "done",
      ...(usage ? { usage } : {}),
    });
  }
  if (lastText) {
    task.succeed(usage);
    return agentRegistry.settle(id, {
      state: "done",
      result: { summary: lastText },
      ...(usage ? { usage } : {}),
    });
  }
  const error =
    "the agent finished without calling report_result and produced no text";
  task.fail(new Error(error), usage);
  return agentRegistry.settle(id, {
    state: "failed",
    error,
    ...(usage ? { usage } : {}),
  });
}

/** Settle a run that threw: timeout, kill, or a genuine failure. */
function settleFailure(
  id: string,
  task: TaskHandle,
  err: unknown,
): AgentRecord | null {
  const state =
    err instanceof IsolatedAgentTimeoutError
      ? "timed_out"
      : agentRegistry.killRequested(id)
        ? "killed"
        : "failed";
  task.fail(err);
  return agentRegistry.settle(id, { state, error: errText(err) });
}

/**
 * Drive one run end to end. Never rejects — it is the tail of a
 * fire-and-forget spawn, so every failure has to end as a settled record
 * their parent is told about.
 */
async function runAgent(
  record: AgentRecord,
  run: LiveRun,
  resolved: { model: string; background: BackgroundRunner },
  acquired: Awaited<ReturnType<typeof acquireBackendInstance>>,
  resumed: AgentResumeContext | undefined,
): Promise<void> {
  const { model, background } = resolved;
  const { release } = acquired;
  const { spec, timeoutMs } = run;
  const id = record.id;
  const abortController = new AbortController();
  const capture = { last: "" };

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
      resumed,
    );
    if (abortController.signal.aborted) {
      // A kill that lands during startup — while the backend is being
      // acquired or the log opened — must not be lost. Handing an
      // already-aborted signal to a backend relies on it checking, and not
      // every SDK does; settling here is the one behaviour that always holds.
      settled = settleFailure(
        id,
        task,
        new Error("aborted before the run started"),
      );
    } else {
      const usage = await runIsolatedAgent({
        background,
        params,
        timeoutMs,
        logCategory: "agents",
        // Safe to sweep: the context label is unique to this agent, so no
        // other context's subprocesses share the tag.
        evictLabel: agentContextLabel(id),
      });
      recordBackendRunUsage(record.backendId, usage ?? undefined);
      recordBackendRunSuccess(record.backendId);
      settled = settleSuccess(id, task, capture.last, usage ?? undefined);
    }
  } catch (err) {
    recordBackendRunFailure(record.backendId, err);
    settled = settleFailure(id, task, err);
  } finally {
    await release().catch((err: unknown) =>
      logError("agents", `failed to release backend for ${id}`, err),
    );
  }

  runs.delete(id);
  if (!settled) return;
  if (suspending) {
    // Handed to the successor by suspendAgents — it reports for real.
    log("agents", `${id} "${settled.label}" suspended for resume`);
    return;
  }
  log(
    "agents",
    `${id} "${settled.label}" → ${settled.state} ` +
      `(${settled.backendId}/${model}, ${timeoutMs}ms cap)`,
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
 * The shutdown lever: hand every live agent to the next daemon, then abort
 * it. Called first thing in graceful shutdown — before the drain and the
 * backend teardown that would otherwise fail the runs and wake their parents
 * with a failure. Returns how many agents were persisted for resume.
 *
 * An agent someone already asked to kill is not persisted: it settles as
 * the kill asked, it just isn't reported (the process is going down).
 */
export function suspendAgents(now: number = Date.now()): number {
  suspending = true;
  const suspended: SuspendedAgent[] = [];
  for (const id of agentRegistry.liveIds()) {
    const record = agentRegistry.get(id);
    const run = runs.get(id);
    if (!record || !run || agentRegistry.killRequested(id)) continue;
    const startedAt = record.startedAt ?? now;
    suspended.push({
      id,
      label: record.label,
      brief: record.brief,
      parent: record.parent,
      backendId: record.backendId,
      ...(record.model ? { model: record.model } : {}),
      ...(record.reasoningEffort
        ? { reasoningEffort: record.reasoningEffort }
        : {}),
      timeoutMs: run.timeoutMs,
      elapsedMs: Math.max(0, now - startedAt),
      preflight: run.spec.preflight === true,
      depth: record.depth,
      suspendedAt: now,
      resumes: run.resumes,
      inbox: agentRegistry.drain(id),
    });
  }
  const saved = saveSuspendedAgents(suspended);
  const aborted = agentRegistry.killAll();
  if (suspended.length > 0) {
    log(
      "agents",
      saved
        ? `Shutdown: suspended ${suspended.length} running agent(s) for resume`
        : `Shutdown: could not persist ${suspended.length} agent(s) — they are lost`,
    );
  }
  if (aborted > suspended.length) {
    log(
      "agents",
      `Shutdown: aborted ${aborted - suspended.length} agent(s) already being killed`,
    );
  }
  return saved ? suspended.length : 0;
}

/** Why a suspended agent cannot be resumed now, or null when it can. */
function resumeRefusal(agent: SuspendedAgent, now: number): string | null {
  if (agent.resumes >= MAX_RESUMES) {
    return (
      `interrupted by a daemon restart ${agent.resumes + 1} times — not ` +
      `resumed again. Re-spawn it if the work still matters.`
    );
  }
  const downMs = now - agent.suspendedAt;
  if (downMs > RESUME_WINDOW_MS) {
    return (
      `interrupted by a daemon shutdown and not resumed: the daemon was ` +
      `down for ${Math.round(downMs / 60_000)} min. Re-spawn it if the ` +
      `work still matters.`
    );
  }
  return null;
}

type ResumeOutcome = { ok: true } | { ok: false; error: string };

/** Relaunch one suspended agent under its old id. */
async function resumeOne(
  agent: SuspendedAgent,
  claimed: readonly SuspendedAgent[],
  now: number,
): Promise<ResumeOutcome> {
  const refusal = resumeRefusal(agent, now);
  if (refusal) return { ok: false, error: refusal };

  const timeoutMs = Math.max(
    RESUME_MIN_TIMEOUT_MS,
    agent.timeoutMs - agent.elapsedMs,
  );
  const reasoningEffort = agent.reasoningEffort as
    ReasoningEffortLevel | undefined;
  const spec: AgentSpawnSpec = {
    brief: agent.brief,
    label: agent.label,
    parent: agent.parent,
    backendId: agent.backendId,
    ...(agent.model ? { model: agent.model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    timeoutMs,
    preflight: agent.preflight,
  };
  const registered = agentRegistry.register(
    {
      label: agent.label,
      brief: agent.brief,
      parent: agent.parent,
      backendId: agent.backendId,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
    capsHolder.caps,
    { id: agent.id },
  );
  if (!registered.ok) {
    return {
      ok: false,
      error: `could not be resumed after a restart: ${registered.error}`,
    };
  }
  for (const message of agent.inbox) agentRegistry.push(agent.id, message);

  const children = claimed
    .filter((c) => c.parent.kind === "agent" && c.parent.agentId === agent.id)
    .map((c) => c.id);
  const launched = await launchRun(
    registered.record,
    { spec, timeoutMs, resumes: agent.resumes + 1 },
    { logPath: agentLogPath(agent.id), children },
  );
  if (!launched.ok) {
    return {
      ok: false,
      error: `could not be resumed after a restart: ${launched.error}`,
    };
  }
  log(
    "agents",
    `${agent.id} "${agent.label}" resumed after restart ` +
      `(${agent.backendId}/${launched.model}, ${timeoutMs}ms left, ` +
      `resume ${agent.resumes + 1}/${MAX_RESUMES})`,
  );
  return { ok: true };
}

/** Settle an agent that can't be resumed as `killed` and tell its parent. */
async function abandon(
  agent: SuspendedAgent,
  error: string,
  now: number,
): Promise<void> {
  const startedAt = agent.suspendedAt - agent.elapsedMs;
  const reasoningEffort = agent.reasoningEffort as
    ReasoningEffortLevel | undefined;
  const record: AgentRecord = {
    id: agent.id,
    label: agent.label,
    brief: agent.brief,
    parent: agent.parent,
    backendId: agent.backendId,
    ...(agent.model ? { model: agent.model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    state: "killed",
    depth: agent.depth,
    createdAt: startedAt,
    startedAt,
    endedAt: now,
    result: null,
    error,
    children: [],
    inboxDepth: 0,
  };
  logWarn("agents", `${agent.id} "${agent.label}" not resumed: ${error}`);
  agentRegistry.adoptSettled(record);
  await deliverSettlement(record).catch((err: unknown) =>
    logError("agents", `delivery failed for ${agent.id}`, err),
  );
}

/**
 * Boot half of `suspendAgents`: claim what the previous daemon persisted and
 * relaunch it, parents before children (so a child re-registers under a live
 * parent). Call once the frontends are up — an agent that can't be resumed
 * wakes its parent chat. Never rejects. Returns how many were resumed.
 */
export async function resumeSuspendedAgents(
  now: number = Date.now(),
): Promise<number> {
  const claimed = claimSuspendedAgents();
  let resumed = 0;
  for (const agent of claimed) {
    let outcome: ResumeOutcome;
    try {
      outcome = await resumeOne(agent, claimed, now);
    } catch (err) {
      outcome = {
        ok: false,
        error: `could not be resumed after a restart: ${errText(err)}`,
      };
    }
    if (outcome.ok) resumed++;
    else await abandon(agent, outcome.error, now);
  }
  if (claimed.length > 0) {
    log(
      "agents",
      `Resumed ${resumed}/${claimed.length} agent(s) interrupted by the last shutdown`,
    );
  }
  return resumed;
}
