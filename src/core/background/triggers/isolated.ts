/**
 * Isolated trigger wakes — run a trigger's wake-ups as one-shot jobs instead
 * of resuming the chat session.
 *
 * A chat-mode wake (the default) resumes the chat session, so every fire
 * re-reads the whole conversation. For a watcher that fires several times an
 * hour with a small event that is almost all overhead. A trigger created with
 * `mode: "isolated"` instead hands each wake to the same executor cron `query`
 * jobs use: its own session, no chat history, the trigger's own brief as the
 * system prompt, and an optional model/provider. The run reaches the chat only
 * through the messaging tools (explicit `chat_id`), exactly like a cron job.
 *
 * Concurrency is one run per trigger at a time. Fires that arrive while a run
 * is in flight queue on the trigger's lane and are coalesced into ONE follow-up
 * run (exact-duplicate payloads collapsed, oldest dropped past
 * {@link MAX_PENDING}), so a burst costs two runs, not N. The lane lives in
 * memory: pending events are lost on restart, the trigger configuration is not
 * (it is stored on the trigger row, so persistent triggers keep their mode).
 *
 * When a run is skipped (no usable backend/model) or throws, the chat gets one
 * short plain-text notice — no model turn — at most once per
 * {@link FAILURE_NOTICE_COOLDOWN_MS} per trigger, so a broken provider can't
 * flood the chat.
 */

import {
  DEFAULT_WAKE_TIMEOUT_MS,
  getTrigger,
  type Trigger,
} from "../../../storage/triggers.js";
import { log, logError } from "../../../util/log.js";
import { depsHolder, lifecycle } from "./state.js";

/** Events held for the follow-up run while one is in flight. */
export const MAX_PENDING = 20;
/** Minimum gap between two failure notices for the same trigger. */
const FAILURE_NOTICE_COOLDOWN_MS = 30 * 60_000;

export type IsolatedWakeEvent = {
  /** "signalled" for a mid-run TALON_FIRE, else the terminal status. */
  readonly status: string;
  readonly payload: string;
  readonly at: number;
};

type Lane = {
  running: boolean;
  pending: IsolatedWakeEvent[];
  /** Events dropped from `pending` since the last run started. */
  dropped: number;
  /** Exact-duplicate events collapsed since the last run started. */
  duplicates: number;
};

const lanes = new Map<string, Lane>();
const lastFailureNoticeAt = new Map<string, number>();

/** True when the trigger's wakes should run isolated rather than in the chat. */
export function isIsolated(t: Pick<Trigger, "wakeMode">): boolean {
  return t.wakeMode === "isolated";
}

/**
 * Queue one wake for an isolated trigger. Starts a run immediately when the
 * lane is idle; otherwise the event waits for the follow-up run. Resolves when
 * the lane has drained (tests await it; production callers fire-and-forget).
 */
export function dispatchIsolatedWake(
  t: Trigger,
  event: IsolatedWakeEvent,
): Promise<void> {
  let lane = lanes.get(t.id);
  if (!lane) {
    lane = { running: false, pending: [], dropped: 0, duplicates: 0 };
    lanes.set(t.id, lane);
  }
  if (
    lane.pending.some(
      (e) => e.payload === event.payload && e.status === event.status,
    )
  ) {
    lane.duplicates++;
  } else {
    lane.pending.push(event);
    if (lane.pending.length > MAX_PENDING) {
      lane.dropped += lane.pending.length - MAX_PENDING;
      lane.pending.splice(0, lane.pending.length - MAX_PENDING);
    }
  }
  if (lane.running) return Promise.resolve();
  return drain(t.id, lane);
}

async function drain(triggerId: string, lane: Lane): Promise<void> {
  lane.running = true;
  try {
    while (lane.pending.length > 0) {
      if (lifecycle.shuttingDown) {
        lane.pending = [];
        break;
      }
      // Re-read: the trigger may have been deleted (or reconfigured) while
      // the previous run was in flight.
      const t = getTrigger(triggerId);
      if (!t) {
        lane.pending = [];
        break;
      }
      const batch = lane.pending;
      const dropped = lane.dropped;
      const duplicates = lane.duplicates;
      lane.pending = [];
      lane.dropped = 0;
      lane.duplicates = 0;
      await runOnce(t, batch, { dropped, duplicates });
    }
  } finally {
    lane.running = false;
    if (lane.pending.length === 0) lanes.delete(triggerId);
  }
}

async function runOnce(
  t: Trigger,
  batch: IsolatedWakeEvent[],
  counts: { dropped: number; duplicates: number },
): Promise<void> {
  const deps = depsHolder.deps;
  if (!deps?.runIsolated) {
    logError(
      "triggers",
      `isolated wake for "${t.name}" [${t.id}] dropped — no isolated runner wired`,
    );
    return;
  }
  let failure: string | undefined;
  try {
    const result = await deps.runIsolated({
      chatId: t.chatId,
      name: t.name,
      kind: "trigger",
      ...(t.model ? { model: t.model } : {}),
      ...(t.provider ? { provider: t.provider } : {}),
      ...(t.instructions ? { instructions: t.instructions } : {}),
      payload: buildIsolatedWakePrompt(t, batch, counts),
      timeoutMs: t.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS,
    });
    if (result.status === "skipped") failure = `skipped: ${result.reason}`;
    else {
      lastFailureNoticeAt.delete(t.id);
      log(
        "triggers",
        `isolated wake "${t.name}" [${t.id}] ran (${batch.length} event(s))`,
      );
    }
  } catch (err) {
    failure = `failed: ${err instanceof Error ? err.message : String(err)}`;
    logError("triggers", `isolated wake failed [${t.id}]`, err);
  }
  if (failure) await noticeFailure(t, failure);
}

async function noticeFailure(t: Trigger, failure: string): Promise<void> {
  const now = Date.now();
  const last = lastFailureNoticeAt.get(t.id);
  if (last !== undefined && now - last < FAILURE_NOTICE_COOLDOWN_MS) return;
  lastFailureNoticeAt.set(t.id, now);
  const notify = depsHolder.deps?.notify;
  if (!notify) return;
  try {
    await notify(
      t.numericChatId,
      `Trigger "${t.name}" (${t.id}) isolated wake ${failure} ` +
        `The watcher keeps running; fix its model/provider or cancel it to stop this notice.`,
      t.chatId,
    );
  } catch (err) {
    logError("triggers", `isolated wake failure notice failed [${t.id}]`, err);
  }
}

/**
 * The user message for one isolated run: the trigger identity, its note, and
 * every coalesced event in arrival order. The trigger's `instructions` travel
 * separately as the system brief.
 */
export function buildIsolatedWakePrompt(
  t: Pick<Trigger, "id" | "name" | "description" | "chatId">,
  batch: readonly IsolatedWakeEvent[],
  counts: { dropped: number; duplicates: number } = {
    dropped: 0,
    duplicates: 0,
  },
): string {
  const n = batch.length;
  const header =
    `[System: TRIGGER WAKE (isolated). Trigger "${t.name}" (${t.id}) ` +
    `delivered ${n} event${n === 1 ? "" : "s"}. You are NOT in the chat ` +
    `session and have no conversation history. Handle the event(s) per your ` +
    `instructions. Message the user only when warranted, via the messaging ` +
    `tool with chat_id="${t.chatId}"; otherwise do nothing.]`;
  const lines = [header];
  if (t.description) lines.push(`Trigger note: ${t.description}`);
  const extra: string[] = [];
  if (counts.duplicates > 0)
    extra.push(`${counts.duplicates} duplicate event(s) collapsed`);
  if (counts.dropped > 0)
    extra.push(`${counts.dropped} older event(s) dropped (queue full)`);
  if (extra.length > 0) lines.push(`(${extra.join("; ")})`);
  batch.forEach((e, i) => {
    const when = new Date(e.at).toISOString().slice(0, 19) + "Z";
    const head =
      n === 1
        ? `--- ${e.status} at ${when} ---`
        : `--- event ${i + 1}/${n}: ${e.status} at ${when} ---`;
    lines.push(`${head}\n${e.payload || "(no output)"}`);
  });
  return lines.join("\n\n");
}

/** Test-only: forget all lanes and notice timestamps. */
export function _resetIsolatedLanes(): void {
  lanes.clear();
  lastFailureNoticeAt.clear();
}
