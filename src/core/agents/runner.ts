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
} from "./prompt.js";
import * as agentsRepo from "../../storage/repositories/agents-repo.js";
import type { PersistedAgent } from "../../storage/repositories/agents-repo.js";
import { agentRegistry } from "./registry.js";
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
      ...(spec.model ? { requestedModel: spec.model } : {}),
      timeoutMs: spec.timeoutMs ?? capsHolder.caps.defaultTimeoutMs,
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

  const resolved = await resolveRun(acquired.backend, backendId, spec.model);
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
  resume?: ResumePlan,
): Promise<OneShotAgentParams> {
  const appendLog = await openRunLog(
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
  const timeoutMs = spec.timeoutMs ?? capsHolder.caps.defaultTimeoutMs;

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
      // A backend may swallow the shutdown abort and return normally — the
      // run still did not finish, so it must not settle as done/failed, and
      // it says nothing about the backend's health either way.
      if (agentRegistry.isInterrupted(id)) {
        settled = null;
      } else {
        recordBackendRunSuccess(record.backendId);
        settled = settleSuccess(id, task, capture.last, usage ?? undefined);
      }
    }
  } catch (err) {
    if (agentRegistry.isInterrupted(id)) {
      settled = null;
    } else {
      recordBackendRunFailure(record.backendId, err);
      settled = settleFailure(id, task, err);
    }
  } finally {
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

  const budget =
    (saved.timeoutMs ?? capsHolder.caps.defaultTimeoutMs) - elapsedMs;
  const timeoutMs = Math.max(AGENT_RESUME_MIN_TIMEOUT_MS, budget);
  const spec: AgentSpawnSpec = {
    brief: saved.brief,
    label: saved.label,
    parent: record.parent,
    backendId,
    ...(saved.requestedModel ? { model: saved.requestedModel } : {}),
    ...(record.reasoningEffort
      ? { reasoningEffort: record.reasoningEffort }
      : {}),
    timeoutMs,
    ...(saved.preflight ? { preflight: true } : {}),
  };
  agentRegistry.markResumed(record.id);
  log(
    "agents",
    `${record.id} "${record.label}" resuming after restart ` +
      `(${canResume ? `session ${saved.sessionId}` : "re-briefed"}, ` +
      `${backendId}/${resolved.model}, ${Math.round(timeoutMs / 1000)}s left, ` +
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
