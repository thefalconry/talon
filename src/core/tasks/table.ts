/**
 * TaskTable — live registry plus bounded history of agent-work runs.
 *
 * One instance (`taskTable`) serves the whole daemon. Call sites register a
 * run with `begin`/`enqueue` and settle it through the returned TaskHandle;
 * the gateway serves `list()` over HTTP and routes `talon kill` to `kill()`.
 *
 * The table is observational: it never schedules, retries, or times out a
 * run — those disciplines stay with the owning module (weaver, heartbeat,
 * dream, job-oneshot). In-memory only by design: a task is a live run, and
 * a daemon restart ends every run, so persisted rows could only describe
 * work that no longer exists.
 */

import { bus } from "../bus/index.js";
import { logWarn } from "../../util/log.js";
import type { TaskSettledEvent, TaskStartedEvent } from "../bus/events.js";
import type {
  KillOutcome,
  TaskBinding,
  TaskHandle,
  TaskRecord,
  TaskSpec,
  TaskState,
  TaskUsage,
} from "./types.js";

/** Settled tasks kept for `list()` after they leave the live map. */
const DEFAULT_HISTORY_LIMIT = 50;

export interface TaskTableOptions {
  /** Settled tasks kept for `list()` (default 50). */
  readonly historyLimit?: number;
  /**
   * Sink for `task.*` lifecycle events — the singleton wires the bus here.
   * Injected (rather than imported at the emit sites) so unit-constructed
   * tables stay silent.
   */
  readonly publish?: (event: TaskStartedEvent | TaskSettledEvent) => void;
}

type MutableTaskRecord = {
  -readonly [K in keyof TaskRecord]: TaskRecord[K];
};

interface LiveTask {
  readonly record: MutableTaskRecord;
  readonly abort?: () => void;
  killRequested: boolean;
}

export class TaskTable {
  private readonly live = new Map<number, LiveTask>();
  private readonly history: TaskRecord[] = [];
  private readonly historyLimit: number;
  private readonly publish?: (
    event: TaskStartedEvent | TaskSettledEvent,
  ) => void;
  private nextId = 1;

  constructor(options: TaskTableOptions = {}) {
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    if (options.publish) this.publish = options.publish;
  }

  /** Register a run that starts immediately. */
  begin(spec: TaskSpec): TaskHandle {
    const handle = this.enqueue(spec);
    handle.start();
    return handle;
  }

  /** Register a run that is waiting its turn (e.g. a chat's FIFO queue). */
  enqueue(spec: TaskSpec): TaskHandle {
    const id = this.nextId++;
    const record: MutableTaskRecord = {
      id,
      kind: spec.kind,
      label: spec.label,
      state: "queued",
      killable: spec.abort !== undefined,
      queuedAt: Date.now(),
    };
    if (spec.chatId !== undefined) record.chatId = spec.chatId;
    const task: LiveTask = {
      record,
      killRequested: false,
      ...(spec.abort !== undefined ? { abort: spec.abort } : {}),
    };
    this.live.set(id, task);
    return {
      id,
      start: () => this.start(id),
      bind: (binding) => this.bind(id, binding),
      succeed: (usage) => this.settle(id, "done", undefined, usage),
      fail: (error, usage) => this.settle(id, "failed", error, usage),
    };
  }

  /**
   * Request an abort of a live killable task. Returns immediately — the
   * task stays `running` until its owner's failure path lands, at which
   * point it settles as `killed`. Repeat kills are no-ops that still
   * report `ok` (the request stands); the abort hook fires only once.
   */
  kill(id: number): KillOutcome {
    const task = this.live.get(id);
    if (!task) {
      return this.history.some((record) => record.id === id)
        ? { ok: false, reason: "finished" }
        : { ok: false, reason: "not-found" };
    }
    if (!task.abort) return { ok: false, reason: "not-killable" };
    if (!task.killRequested) {
      task.killRequested = true;
      try {
        task.abort();
      } catch (err) {
        // The abort hook contract is "must not throw" — a violation must
        // not break the kill path for the caller, but the run may now
        // never settle, so leave a trace of why.
        logWarn(
          "tasks",
          `Abort hook threw task=${id} kind=${task.record.kind} label=${JSON.stringify(task.record.label)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { ok: true };
  }

  /**
   * Request an abort of every running turn, regardless of chat — the
   * shutdown drain's lever. Returns the number of kill requests issued.
   */
  killAllRunningTurns(): number {
    let killed = 0;
    for (const [id, task] of this.live) {
      if (task.record.kind === "turn" && task.record.state === "running") {
        if (this.kill(id).ok) killed++;
      }
    }
    return killed;
  }

  /**
   * Request an abort for the turn currently running in one chat. Queued turns
   * are deliberately ignored: `/stop` means "stop what is happening now",
   * never "discard my next message".
   */
  killRunningTurn(chatId: string): KillOutcome {
    for (const [id, task] of this.live) {
      if (
        task.record.kind === "turn" &&
        task.record.chatId === chatId &&
        task.record.state === "running"
      ) {
        return this.kill(id);
      }
    }
    return { ok: false, reason: "not-found" };
  }

  /**
   * Every live task plus the bounded settled history, id-ascending.
   * Snapshots are copies — callers can never mutate table state.
   */
  list(): TaskRecord[] {
    const records: TaskRecord[] = this.history.map((record) => ({
      ...record,
    }));
    for (const task of this.live.values()) records.push({ ...task.record });
    return records.sort((a, b) => a.id - b.id);
  }

  private start(id: number): void {
    const task = this.live.get(id);
    if (!task || task.record.state !== "queued") return;
    task.record.state = "running";
    task.record.startedAt = Date.now();
    this.publish?.({ type: "task.started", task: { ...task.record } });
  }

  private bind(id: number, binding: TaskBinding): void {
    const task = this.live.get(id);
    if (!task) return;
    if (binding.model !== undefined) task.record.model = binding.model;
    if (binding.backendId !== undefined)
      task.record.backendId = binding.backendId;
  }

  private settle(
    id: number,
    state: Extract<TaskState, "done" | "failed">,
    error?: unknown,
    usage?: TaskUsage,
  ): void {
    const task = this.live.get(id);
    if (!task) return;
    const { record } = task;
    // A kill only "takes" when the run actually dies: a run that completes
    // despite the abort settles as done, one that unwinds settles as killed.
    record.state = state === "failed" && task.killRequested ? "killed" : state;
    record.endedAt = Date.now();
    if (error !== undefined) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    if (usage !== undefined) record.usage = usage;
    this.live.delete(id);
    this.history.push(record);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    this.publish?.({ type: "task.settled", task: { ...record } });
  }
}

/** The daemon-wide table. Tests needing isolation construct their own. */
export const taskTable = new TaskTable({
  publish: (event) => bus.publish(event),
});
