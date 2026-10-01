/**
 * AgentRegistry — the live map of sub-agents plus a bounded settled ring.
 *
 * One instance (`agentRegistry`) serves the daemon. It owns identity, the
 * lifecycle state machine, the per-agent mailbox and the parent/child edges;
 * it owns no timers, no backends and no delivery. The runner drives it, the
 * gateway actions read it, and `GET /agents` serves `list()`.
 *
 * The live map is in memory, but every lifecycle change is mirrored to the
 * `agents` table through the `persist` hook (the singleton wires
 * `storage/agents/repo.ts`), so a daemon restart no longer kills an
 * agent: the next boot finds its row still `running` and resumes it —
 * `restore()` is the re-entry point. Tests constructing their own registry
 * pass no hook and stay purely in memory.
 */

import { randomBytes } from "node:crypto";
import type {
  AgentCaps,
  AgentMessage,
  AgentParent,
  AgentRecord,
  AgentResult,
  AgentState,
  AgentTrail,
} from "./types.js";
import type { TaskUsage } from "../tasks/types.js";
import type { AgentSettledEvent, AgentSpawnedEvent } from "../bus/events.js";
import type { ReasoningEffortLevel } from "../types.js";
import type { PersistedAgent } from "../../storage/agents/repo.js";
import * as agentsRepo from "../../storage/agents/repo.js";
import { bus } from "../bus/index.js";
import { logWarn } from "../../util/log.js";
import { RunKilledError } from "./abort-reason.js";

/** Settled agents kept for status queries after they leave the live map. */
const DEFAULT_HISTORY_LIMIT = 100;
/** Messages one agent's mailbox holds before `send_to_agent` is refused. */
const DEFAULT_MAILBOX_LIMIT = 32;

/** What a call site declares when it registers a spawn. */
export interface AgentRegistration {
  readonly label: string;
  readonly brief: string;
  readonly parent: AgentParent;
  readonly backendId: string;
  readonly reasoningEffort?: ReasoningEffortLevel;
  /** The model the caller asked for (unset = backend default). */
  readonly requestedModel?: string;
  /** The run's hard wall-clock cap. */
  readonly timeoutMs?: number;
  /** Working directory the run executes in. */
  readonly cwd?: string;
  /** The spawn asked for the pre-flight lane instruction. */
  readonly preflight?: boolean;
}

/** What the runner knows once the run is actually under way. */
export interface AgentBinding {
  /** The model the backend's catalog resolved to. */
  readonly model: string;
  /** The run's abort handle — `requestKill` pulls this. */
  readonly abort: AbortController;
  /** Task-table id for the run, when one was registered. */
  readonly taskId?: number;
}

/** Terminal patch handed to `settle`. */
export interface AgentSettlement {
  readonly state: Extract<
    AgentState,
    "done" | "failed" | "killed" | "timed_out"
  >;
  readonly result?: AgentResult;
  readonly error?: string;
  readonly usage?: TaskUsage;
  /** What the run had been doing — see `trail.ts`. */
  readonly trail?: AgentTrail;
}

export type RegisterOutcome =
  | { readonly ok: true; readonly record: AgentRecord }
  | { readonly ok: false; readonly error: string };

export interface AgentRegistryOptions {
  readonly historyLimit?: number;
  readonly mailboxLimit?: number;
  /** Sink for `agent.*` lifecycle events — the singleton wires the bus here. */
  readonly publish?: (event: AgentSpawnedEvent | AgentSettledEvent) => void;
  /** Id factory; overridden in tests for deterministic ids. */
  readonly newId?: () => string;
  /**
   * Durable mirror of every lifecycle change — the singleton writes the
   * `agents` table here so a restart can resume the agent. Must not throw
   * (the registry guards it anyway: persistence is never allowed to break a
   * run).
   */
  readonly persist?: (snapshot: PersistedAgent) => void;
  /** Drop a persisted row (a registration that never started). */
  readonly unpersist?: (id: string) => void;
}

type MutableAgentRecord = {
  -readonly [K in keyof AgentRecord]: AgentRecord[K];
} & { children: string[] };

interface LiveAgent {
  readonly record: MutableAgentRecord;
  readonly mailbox: AgentMessage[];
  readonly waiters: Set<(record: AgentRecord) => void>;
  abort?: AbortController;
  reported: boolean;
  killRequested: boolean;
  /** Persistence-only facts — see `AgentRegistration` / `PersistedAgent`. */
  requestedModel?: string;
  timeoutMs?: number;
  cwd?: string;
  preflight?: boolean;
  sessionId?: string;
  elapsedMs: number;
  resumeCount: number;
  interruptedAt?: number;
  /**
   * Set when a daemon shutdown interrupts the run. The abort that follows
   * must not be recorded as a kill: the row stays `running` so the next boot
   * resumes it, and the parent is not told the agent died.
   */
  interrupted: boolean;
}

/**
 * Whether two agents were spawned by the same parent.
 *
 * Compared structurally rather than by reference: records come from separate
 * snapshots, so the parent objects are equal in value and never identical.
 * The `kind` check is what stops a chat-parented agent matching an
 * agent-parented one whose id happens to equal a chat key.
 */
function sameParent(a: AgentParent, b: AgentParent): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "chat" && b.kind === "chat"
    ? a.chatId === b.chatId
    : a.kind === "agent" && b.kind === "agent"
      ? a.agentId === b.agentId
      : false;
}

function snapshot(entry: LiveAgent): AgentRecord {
  return {
    ...entry.record,
    children: [...entry.record.children],
    inboxDepth: entry.mailbox.length,
  };
}

/**
 * The abort reason for a kill. A daemon shutdown parks the run rather than
 * killing it (it resumes on the next boot), so its abort must not carry
 * `RunKilledError` — the run log would say "killed on request".
 */
function killReason(entry: LiveAgent, id: string): Error {
  return entry.interrupted
    ? new Error(`agent ${id} interrupted by a daemon shutdown`)
    : new RunKilledError(`agent ${id} killed`);
}

/** The durable shape of one live entry. */
function toPersisted(entry: LiveAgent): PersistedAgent {
  const { record } = entry;
  const saved: PersistedAgent = {
    id: record.id,
    label: record.label,
    brief: record.brief,
    parentKind: record.parent.kind,
    parentId:
      record.parent.kind === "chat"
        ? record.parent.chatId
        : record.parent.agentId,
    backendId: record.backendId,
    depth: record.depth,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: Date.now(),
    inbox: entry.mailbox.map((m) => ({ from: m.from, text: m.text, at: m.at })),
    reported: entry.reported,
    elapsedMs: entry.elapsedMs,
    resumeCount: entry.resumeCount,
  };
  if (record.parent.kind === "chat") {
    saved.parentNumericChatId = record.parent.numericChatId;
  }
  if (record.model !== undefined) saved.model = record.model;
  if (entry.requestedModel !== undefined) {
    saved.requestedModel = entry.requestedModel;
  }
  if (record.reasoningEffort !== undefined) {
    saved.reasoningEffort = record.reasoningEffort;
  }
  if (entry.timeoutMs !== undefined) saved.timeoutMs = entry.timeoutMs;
  if (entry.cwd !== undefined) saved.cwd = entry.cwd;
  if (entry.preflight) saved.preflight = true;
  if (record.startedAt !== undefined) saved.startedAt = record.startedAt;
  if (record.endedAt !== undefined) saved.endedAt = record.endedAt;
  if (entry.sessionId !== undefined) saved.sessionId = entry.sessionId;
  if (record.result) {
    saved.resultSummary = record.result.summary;
    if (record.result.details !== undefined) {
      saved.resultDetails = record.result.details;
    }
  }
  if (record.error !== undefined) saved.error = record.error;
  if (entry.interruptedAt !== undefined) {
    saved.interruptedAt = entry.interruptedAt;
  }
  return saved;
}

export class AgentRegistry {
  private readonly live = new Map<string, LiveAgent>();
  private readonly history: AgentRecord[] = [];
  private readonly historyLimit: number;
  private readonly mailboxLimit: number;
  private readonly publish?: (
    event: AgentSpawnedEvent | AgentSettledEvent,
  ) => void;
  private readonly newId: () => string;
  private readonly persistHook?: (snapshot: PersistedAgent) => void;
  private readonly unpersistHook?: (id: string) => void;

  constructor(options: AgentRegistryOptions = {}) {
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.mailboxLimit = options.mailboxLimit ?? DEFAULT_MAILBOX_LIMIT;
    if (options.publish) this.publish = options.publish;
    this.newId =
      options.newId ?? (() => `agt_${randomBytes(4).toString("hex")}`);
    if (options.persist) this.persistHook = options.persist;
    if (options.unpersist) this.unpersistHook = options.unpersist;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Claim a slot and allocate an id. The caps are checked here — before the
   * caller does any async backend work — so two concurrent spawns can never
   * both squeeze past `maxConcurrent`.
   */
  register(spec: AgentRegistration, caps: AgentCaps): RegisterOutcome {
    const depth = this.depthFor(spec.parent);
    if (depth === null) {
      return {
        ok: false,
        error: `Parent agent is no longer running — it cannot spawn children.`,
      };
    }
    if (depth > caps.maxDepth) {
      return {
        ok: false,
        error:
          `Sub-agent depth cap reached (maxDepth ${caps.maxDepth}). ` +
          `Do this work yourself instead of delegating it further.`,
      };
    }
    if (this.live.size >= caps.maxConcurrent) {
      return {
        ok: false,
        error:
          `Sub-agent concurrency cap reached (${caps.maxConcurrent} live). ` +
          `Wait for one to finish (wait_for_agent) or kill one (kill_agent), ` +
          `or raise agents.maxConcurrent in ~/.talon/config.json.`,
      };
    }

    const id = this.newId();
    const record: MutableAgentRecord = {
      id,
      label: spec.label,
      brief: spec.brief,
      parent: spec.parent,
      backendId: spec.backendId,
      state: "queued",
      depth,
      createdAt: Date.now(),
      result: null,
      children: [],
      inboxDepth: 0,
    };
    if (spec.reasoningEffort !== undefined) {
      record.reasoningEffort = spec.reasoningEffort;
    }
    const entry: LiveAgent = {
      record,
      mailbox: [],
      waiters: new Set(),
      reported: false,
      killRequested: false,
      elapsedMs: 0,
      resumeCount: 0,
      interrupted: false,
    };
    if (spec.requestedModel !== undefined) {
      entry.requestedModel = spec.requestedModel;
    }
    if (spec.timeoutMs !== undefined) entry.timeoutMs = spec.timeoutMs;
    if (spec.cwd !== undefined) entry.cwd = spec.cwd;
    if (spec.preflight) entry.preflight = true;
    this.live.set(id, entry);
    if (spec.parent.kind === "agent") {
      this.live.get(spec.parent.agentId)?.record.children.push(id);
    }
    this.persist(entry);
    return { ok: true, record: snapshot(entry) };
  }

  /**
   * Bring a persisted agent back into the live map after a restart, under
   * its original id, with its mailbox, report and resume bookkeeping. It
   * re-enters as `queued` — the runner `start()`s it again like any spawn.
   * Caps are not re-checked: the agent was admitted before the restart.
   *
   * Refused (null) when the id is already live, or when its parent is an
   * agent that did not come back (its report would have nowhere to go).
   */
  restore(saved: PersistedAgent): AgentRecord | null {
    if (this.live.has(saved.id)) return null;
    let parent: AgentParent;
    if (saved.parentKind === "agent") {
      if (!this.live.has(saved.parentId)) return null;
      parent = { kind: "agent", agentId: saved.parentId };
    } else {
      parent = {
        kind: "chat",
        chatId: saved.parentId,
        numericChatId: saved.parentNumericChatId ?? Number(saved.parentId),
      };
    }
    const record: MutableAgentRecord = {
      id: saved.id,
      label: saved.label,
      brief: saved.brief,
      parent,
      backendId: saved.backendId,
      state: "queued",
      depth: saved.depth,
      createdAt: saved.createdAt,
      result: null,
      children: [],
      inboxDepth: 0,
    };
    if (saved.model !== undefined) record.model = saved.model;
    if (saved.reasoningEffort !== undefined) {
      record.reasoningEffort = saved.reasoningEffort as ReasoningEffortLevel;
    }
    if (saved.reported && saved.resultSummary !== undefined) {
      record.result = {
        summary: saved.resultSummary,
        ...(saved.resultDetails !== undefined
          ? { details: saved.resultDetails }
          : {}),
      };
    }
    const entry: LiveAgent = {
      record,
      mailbox: saved.inbox.map((m) => ({ ...m })),
      waiters: new Set(),
      reported: saved.reported,
      killRequested: false,
      elapsedMs: saved.elapsedMs,
      resumeCount: saved.resumeCount,
      interrupted: false,
    };
    if (saved.requestedModel !== undefined) {
      entry.requestedModel = saved.requestedModel;
    }
    if (saved.timeoutMs !== undefined) entry.timeoutMs = saved.timeoutMs;
    if (saved.cwd !== undefined) entry.cwd = saved.cwd;
    if (saved.preflight) entry.preflight = true;
    if (saved.sessionId !== undefined) entry.sessionId = saved.sessionId;
    if (saved.interruptedAt !== undefined) {
      entry.interruptedAt = saved.interruptedAt;
    }
    this.live.set(saved.id, entry);
    if (parent.kind === "agent") {
      this.live.get(parent.agentId)?.record.children.push(saved.id);
    }
    return snapshot(entry);
  }

  /** Count one more restart-resume against this agent and persist it. */
  markResumed(id: string): void {
    const entry = this.live.get(id);
    if (!entry) return;
    entry.resumeCount += 1;
    this.persist(entry);
  }

  /**
   * Record the backend's conversation handle (Claude SDK session id, Codex
   * thread id) as soon as the run reports it — the thing a restart resumes.
   */
  setSessionId(id: string, sessionId: string): void {
    const entry = this.live.get(id);
    if (!entry || entry.sessionId === sessionId) return;
    entry.sessionId = sessionId;
    this.persist(entry);
  }

  /** The persistence-only facts a resume needs, for a live agent. */
  resumeInfo(id: string): {
    sessionId?: string;
    requestedModel?: string;
    timeoutMs?: number;
    cwd?: string;
    elapsedMs: number;
    resumeCount: number;
    interruptedAt?: number;
  } | null {
    const entry = this.live.get(id);
    if (!entry) return null;
    return {
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.requestedModel !== undefined
        ? { requestedModel: entry.requestedModel }
        : {}),
      ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      elapsedMs: entry.elapsedMs,
      resumeCount: entry.resumeCount,
      ...(entry.interruptedAt !== undefined
        ? { interruptedAt: entry.interruptedAt }
        : {}),
    };
  }

  /**
   * A daemon shutdown is about to abort every run. Stamp each live agent as
   * interrupted — charging the time it has run so far against its timeout —
   * and persist that while the row is still `running`, so the next boot
   * resumes it. From here on the abort that tears the run down is not a
   * kill: `isInterrupted` tells the runner to leave the row alone.
   * Returns how many agents were parked.
   */
  interruptAll(now: number = Date.now()): number {
    let parked = 0;
    for (const entry of this.live.values()) {
      if (entry.interrupted) continue;
      entry.interrupted = true;
      if (entry.record.startedAt !== undefined) {
        entry.elapsedMs += Math.max(0, now - entry.record.startedAt);
      }
      entry.interruptedAt = now;
      this.persist(entry);
      parked++;
    }
    return parked;
  }

  /** Whether a shutdown interrupted this (still live) agent. */
  isInterrupted(id: string): boolean {
    return this.live.get(id)?.interrupted ?? false;
  }

  /**
   * Drop an interrupted agent from the live map WITHOUT recording a terminal
   * state — the persisted row stays `running` for the next boot. Waiters are
   * released with the current snapshot; no `agent.settled` is published,
   * because nothing settled.
   */
  releaseInterrupted(id: string): AgentRecord | null {
    const entry = this.live.get(id);
    if (!entry || !entry.interrupted) return null;
    const record = snapshot(entry);
    this.live.delete(id);
    for (const waiter of entry.waiters) waiter(record);
    entry.waiters.clear();
    return record;
  }

  /**
   * Drop a registration that never started (backend/model resolution failed).
   * It leaves no trace: nothing ran, so there is nothing to report on.
   */
  discard(id: string): void {
    const entry = this.live.get(id);
    if (!entry) return;
    this.live.delete(id);
    this.unpersist(id);
    const parent = entry.record.parent;
    if (parent.kind === "agent") {
      const children = this.live.get(parent.agentId)?.record.children;
      const at = children?.indexOf(id) ?? -1;
      if (children && at >= 0) children.splice(at, 1);
    }
  }

  /** Move a queued agent to running and publish `agent.spawned`. */
  start(id: string, binding: AgentBinding): void {
    const entry = this.live.get(id);
    if (!entry || entry.record.state !== "queued") return;
    entry.abort = binding.abort;
    // A kill can arrive while the agent is still `queued` — before any abort
    // handle exists, so requestKill's `entry.abort?.abort()` was a no-op that
    // only set the flag. When the handle finally binds here, honour that
    // pending kill; otherwise the fresh, un-aborted controller lets the run
    // proceed and the kill is silently lost. The runner checks the signal
    // right after start() and settles the run as "killed".
    if (entry.killRequested) {
      try {
        binding.abort.abort(killReason(entry, id));
      } catch (err) {
        logWarn(
          "agents",
          `Abort hook threw on start agent=${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    entry.record.model = binding.model;
    entry.record.state = "running";
    entry.record.startedAt = Date.now();
    if (binding.taskId !== undefined) entry.record.taskId = binding.taskId;
    this.persist(entry);
    const { record } = entry;
    this.publish?.({
      type: "agent.spawned",
      agentId: record.id,
      label: record.label,
      parentKind: record.parent.kind,
      parent:
        record.parent.kind === "chat"
          ? record.parent.chatId
          : record.parent.agentId,
      backendId: record.backendId,
      model: binding.model,
      depth: record.depth,
    });
  }

  /**
   * Record the agent's own report. Exactly once per run: a second call is
   * refused so the parent can never be handed two different answers.
   */
  report(id: string, result: AgentResult): boolean {
    const entry = this.live.get(id);
    if (!entry || entry.reported) return false;
    entry.reported = true;
    entry.record.result = result;
    this.persist(entry);
    return true;
  }

  /** Whether this agent has already called `report_result`. */
  hasReported(id: string): boolean {
    return this.live.get(id)?.reported ?? false;
  }

  /** Settle an agent. Idempotent — the first terminal state wins. */
  settle(id: string, patch: AgentSettlement): AgentRecord | null {
    const entry = this.live.get(id);
    if (!entry) return null;
    const { record } = entry;
    record.state = patch.state;
    record.endedAt = Date.now();
    if (patch.result !== undefined) record.result = patch.result;
    if (patch.error !== undefined) record.error = patch.error;
    if (patch.usage !== undefined) record.usage = patch.usage;
    if (patch.trail !== undefined) record.trail = patch.trail;

    const settled = snapshot(entry);
    this.persist(entry);
    this.live.delete(id);
    this.history.push(settled);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    for (const waiter of entry.waiters) waiter(settled);
    entry.waiters.clear();
    this.publish?.({
      type: "agent.settled",
      agentId: settled.id,
      label: settled.label,
      state: settled.state,
      durationMs:
        (settled.endedAt ?? 0) - (settled.startedAt ?? settled.createdAt),
    });
    return settled;
  }

  // ── Kill ──────────────────────────────────────────────────────────────────

  /**
   * Request an abort. Returns false when the agent is unknown or already
   * settled. The agent stays `running` until its runner's failure path lands,
   * which is where it settles as `killed`.
   */
  requestKill(id: string): boolean {
    const entry = this.live.get(id);
    if (!entry) return false;
    if (!entry.killRequested) {
      entry.killRequested = true;
      try {
        entry.abort?.abort(killReason(entry, id));
      } catch (err) {
        // An abort hook must not be able to break the kill path — but a
        // throwing one may leave the agent running, so say so.
        logWarn(
          "agents",
          `Abort hook threw agent=${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return true;
  }

  /** Whether a kill was requested for this (still live) agent. */
  killRequested(id: string): boolean {
    return this.live.get(id)?.killRequested ?? false;
  }

  /** Request an abort of every live agent. Returns how many were signalled. */
  killAll(): number {
    let killed = 0;
    for (const id of this.live.keys()) {
      if (this.requestKill(id)) killed++;
    }
    return killed;
  }

  // ── Mailbox ───────────────────────────────────────────────────────────────

  /**
   * Push a message into a live agent's mailbox. Refused (false) when the
   * agent is gone or its mailbox is full — a bounded queue that silently
   * dropped instructions would be worse than one that says it is full.
   */
  push(id: string, message: AgentMessage): boolean {
    const entry = this.live.get(id);
    if (!entry) return false;
    if (entry.mailbox.length >= this.mailboxLimit) return false;
    entry.mailbox.push(message);
    this.persist(entry);
    return true;
  }

  /** Drain and return everything waiting for an agent, oldest first. */
  drain(id: string): AgentMessage[] {
    const entry = this.live.get(id);
    if (!entry) return [];
    const drained = entry.mailbox.splice(0, entry.mailbox.length);
    if (drained.length > 0) this.persist(entry);
    return drained;
  }

  /** The mailbox cap, for the error text the actions surface. */
  get mailboxCapacity(): number {
    return this.mailboxLimit;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** One agent, live or in the settled ring. */
  get(id: string): AgentRecord | null {
    const entry = this.live.get(id);
    if (entry) return snapshot(entry);
    return this.history.find((record) => record.id === id) ?? null;
  }

  /** Whether the agent is still live (queued or running). */
  isLive(id: string): boolean {
    return this.live.has(id);
  }

  /**
   * Ids of this agent's children that are still live. Answered from the
   * settled ring too — the caller that needs it most is the runner reaping
   * the children of an agent that just settled.
   */
  liveChildren(id: string): string[] {
    const children = this.get(id)?.children ?? [];
    return children.filter((child) => this.live.has(child));
  }

  /**
   * An agent's live **peers** — the other agents sharing its parent.
   *
   * This is the addressing scope for agent-to-agent messaging, and it is
   * deliberately narrower than "everything under the same chat". A swarm is
   * a set of siblings spawned for one job, so siblings are the useful unit;
   * widening to the whole chat tree would let an agent reach a cousin from an
   * unrelated piece of work it knows nothing about.
   *
   * Live only: a settled agent has no mailbox to deliver into, and offering
   * it as a peer would only produce a delivery failure one call later.
   */
  peersOf(id: string): AgentRecord[] {
    const self = this.get(id);
    if (!self) return [];
    const peers: AgentRecord[] = [];
    for (const entry of this.live.values()) {
      const record = snapshot(entry);
      if (record.id === id) continue;
      if (sameParent(record.parent, self.parent)) peers.push(record);
    }
    return peers.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Live agents plus the bounded settled ring, oldest first. */
  list(): AgentRecord[] {
    const records = [...this.history];
    for (const entry of this.live.values()) records.push(snapshot(entry));
    return records.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Every agent whose ancestry roots in this chat, descendants included. */
  listForChat(chatKey: string): AgentRecord[] {
    return this.list().filter((record) => this.rootChat(record) === chatKey);
  }

  /** Live (queued + running) agent count — what `maxConcurrent` bounds. */
  liveCount(): number {
    return this.live.size;
  }

  /**
   * Resolve when the agent settles, or after `timeoutMs` with whatever the
   * registry knows now. Never rejects: a bounded wait is a status query, not
   * a failure mode.
   */
  waitForSettle(id: string, timeoutMs: number): Promise<AgentRecord | null> {
    const entry = this.live.get(id);
    if (!entry) return Promise.resolve(this.get(id));
    return new Promise<AgentRecord | null>((resolve) => {
      const done = (record: AgentRecord | null): void => {
        clearTimeout(timer);
        entry.waiters.delete(waiter);
        resolve(record);
      };
      const waiter = (record: AgentRecord): void => done(record);
      const timer = setTimeout(() => done(this.get(id)), timeoutMs);
      timer.unref();
      entry.waiters.add(waiter);
    });
  }

  /** Drop every record — tests only; the daemon holds one registry for life. */
  resetForTest(): void {
    this.live.clear();
    this.history.splice(0, this.history.length);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Mirror one entry to the durable store. Never throws into a run. */
  private persist(entry: LiveAgent): void {
    if (!this.persistHook) return;
    try {
      this.persistHook(toPersisted(entry));
    } catch (err) {
      logWarn(
        "agents",
        `persist failed agent=${entry.record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private unpersist(id: string): void {
    if (!this.unpersistHook) return;
    try {
      this.unpersistHook(id);
    } catch (err) {
      logWarn(
        "agents",
        `unpersist failed agent=${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Depth a child of this parent would have, or null when the parent is an
   * agent that is no longer live (its children would have nowhere to report).
   */
  private depthFor(parent: AgentParent): number | null {
    if (parent.kind === "chat") return 0;
    const entry = this.live.get(parent.agentId);
    if (!entry) return null;
    return entry.record.depth + 1;
  }

  /** The chat an agent's ancestry roots in, or null if that chain is gone. */
  private rootChat(record: AgentRecord): string | null {
    let current: AgentRecord | null = record;
    // Bounded by maxDepth in practice; the cap here only guards a cycle that
    // the registry's own invariants already make impossible.
    for (let hop = 0; current && hop <= 16; hop++) {
      if (current.parent.kind === "chat") return current.parent.chatId;
      current = this.get(current.parent.agentId);
    }
    return null;
  }
}

/** The daemon-wide registry. Tests needing isolation construct their own. */
export const agentRegistry = new AgentRegistry({
  publish: (event) => bus.publish(event),
  persist: (saved) => agentsRepo.upsert(saved),
  unpersist: (id) => void agentsRepo.remove(id),
});
