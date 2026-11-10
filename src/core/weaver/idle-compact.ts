/**
 * Idle compaction — shrink a big chat's session just before its prompt
 * cache expires, the way the Claude CLI's own idle compaction does
 * (docs/cache-economics.md, PR C).
 *
 * After the cache TTL lapses, the next turn re-writes the whole prefix AND
 * the whole transcript at cache-write cost, and every later request in the
 * session re-reads it. Compacting while the cache is still warm reads the
 * transcript at 0.1× instead, and the user's return then writes only the
 * summary.
 *
 * The CLI ships this ("Compacted while idle, before the prompt cache
 * expired"), but only in its interactive REPL: under the SDK (entrypoint
 * `sdk-ts`) it never arms, and Talon's per-turn subprocess exits on
 * `result` anyway. So Talon runs the same policy itself, off unless
 * `cache.idleCompact`:
 *
 *   ARM — when a turn settles: the last main-session API request
 *   (`PromptCacheObservation.lastRequestAt`, turn end when unknown) must
 *   have read or written the cache with an observed 1 h TTL (its write
 *   carried only `ephemeral_1h_input_tokens`, or it inherited one), and
 *   the context must be ≥ `minContextTokens` (default 200 k, floor
 *   100 k). The timer
 *   fires at `lastRequestAt + 0.9 × TTL` — 54 min on 1 h. A new turn
 *   cancels it.
 *
 *   FIRE — queued on the chat's Thread, so it never overlaps a turn. Runs
 *   only if: no turn or request since the one it was armed for, the timer
 *   is < 60 s late, the cache is still warm, the chat is still big, the
 *   next turn would run on the same model, the last turn was not a guest
 *   turn (different tool prefix), and the SDK's last `rate_limit_event`
 *   said `allowed`.
 *
 *   PRECOMPUTE (default) — the backend compacts a FORK of the session
 *   (`fork: true`); the chat's own session is untouched. At the next turn
 *   the fork is switched in only once the source's cache has expired, so
 *   the compacted session is the cheaper resume. That is TTL after the
 *   pass's own `/compact` request, not after `lastRequestAt`: the request
 *   read the cached prefix, and a cache hit refreshes the TTL;
 *   otherwise it is discarded (`returned_early` — the user came back to a
 *   warm cache, which beats a re-written summary). Also discarded when a
 *   newer request or turn happened, the model changed, or the session was
 *   reset. This is the CLI's own precompute variant.
 *
 *   IN-PLACE (`idleCompactMode: "in-place"`, or a backend that did not
 *   honour the fork) — the session itself is compacted at fire time.
 *
 * A TURN DURING A PASS — the pass has two phases. PRE-REQUEST (process
 * spawn, MCP wait, command check, before `/compact` is sent): a turn
 * always aborts it, nothing is billed yet. IN-FLIGHT (the request is
 * sent, its input is billed): `idleCompactOnTurn` decides —
 *   - `"wait"` (default): the pass runs on and the turn, queued behind it
 *     on the Thread, waits; the chat gets one status message. A precompute
 *     that finishes is adopted by that turn even though the cache is still
 *     warm (`adoptEvenIfWarm`) — the summary is paid for, and the warm
 *     cache it would keep is the one the turn is about to leave.
 *   - `"abort"`: abort it — a precompute always, an in-place pass until
 *     its compaction has landed (after that it finishes).
 *   - `"ask"`: ask the chat with two buttons; a click on "abort" aborts as
 *     above, anything else (no click in 30 s, no button support) waits.
 * An aborted pass leaves the session as it was: the backend only rewrites
 * it once the summary is in. The 5-minute cap stays; a pass that fails or
 * times out leaves the waiting turn on the unchanged session.
 *
 * Every turn source that runs in the chat's own session goes through
 * `Weaver.runTurn` and so arms and cancels the timer. Heartbeat, dream
 * and cron `query` jobs run isolated one-shot sessions with their own
 * prefixes: they neither warm the chat's cache nor go through here.
 * Timers, passes and precomputes are in-memory: a restart drops them. The
 * id of a precomputed fork is also persisted until it is adopted or
 * discarded, so a fork a restart orphaned is deleted at the chat's next
 * turn.
 *
 * Never throws: a compaction that fails leaves the session as it was.
 */

import type {
  Backend,
  SessionCompactResult,
} from "../agent-runtime/capabilities.js";
import type { TalonConfig } from "../config/index.js";
import {
  getSessionInfo,
  recordSessionCompaction,
  setSessionId,
  type SessionInfo,
} from "../../storage/sessions.js";
import { incrementCounter, recordHistogram } from "../../storage/metrics.js";
import { kvGet, kvSet } from "../../storage/kv.js";
import { log, logWarn } from "../../util/log.js";

// ── Settings ────────────────────────────────────────────────────────────────

type IdleCompactMode = "precompute" | "in-place";
/** What a turn does to a pass that is already in flight. */
type IdleCompactOnTurn = "wait" | "abort" | "ask";

export type IdleCompactSettings = {
  enabled: boolean;
  /** Only sessions whose context fill is at least this are compacted. */
  minContextTokens: number;
  /** Precompute on a fork (default), or compact the session in place. */
  mode: IdleCompactMode;
  /** A turn arriving while a pass is in flight (request sent). */
  onTurn: IdleCompactOnTurn;
};

/** The CLI's own threshold (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` default). */
const IDLE_COMPACT_DEFAULT_MIN_CONTEXT = 200_000;
/** Below this a compaction costs more than the cold write it saves. */
const IDLE_COMPACT_MIN_CONTEXT_FLOOR = 100_000;

export const IDLE_COMPACT_DEFAULTS: Readonly<IdleCompactSettings> = {
  enabled: false,
  minContextTokens: IDLE_COMPACT_DEFAULT_MIN_CONTEXT,
  mode: "precompute",
  onTurn: "wait",
};

/** The `cache` config block, resolved onto the defaults. */
export function resolveIdleCompactSettings(
  config: Pick<TalonConfig, "cache">,
): IdleCompactSettings {
  const cache = config.cache;
  return {
    enabled: cache?.idleCompact ?? IDLE_COMPACT_DEFAULTS.enabled,
    minContextTokens: Math.max(
      IDLE_COMPACT_MIN_CONTEXT_FLOOR,
      cache?.idleCompactMinContextTokens ??
        IDLE_COMPACT_DEFAULTS.minContextTokens,
    ),
    mode: cache?.idleCompactMode ?? IDLE_COMPACT_DEFAULTS.mode,
    onTurn: cache?.idleCompactOnTurn ?? IDLE_COMPACT_DEFAULTS.onTurn,
  };
}

// ── Timing ──────────────────────────────────────────────────────────────────

/** Only a 1 h TTL arms the timer — the CLI refuses anything else too. */
const WARM_COMPACT_TTL_MS = 3_600_000;
/** Fire at this fraction of the TTL after the last request (CLI: 0.9). */
const WARM_COMPACT_FIRE_FRACTION = 0.9;
/** A timer that fires later than this (a suspended host) is skipped. */
const WARM_COMPACT_MAX_LATE_MS = 60_000;
/** Hard cap on one pass. A big transcript is one long model call. */
const DEFAULT_COMPACT_TIMEOUT_MS = 5 * 60 * 1000;
/** `"ask"`: how long the buttons wait for a click before `"wait"` applies. */
const ASK_TIMEOUT_MS = 30_000;

/** The chat-facing texts. */
export const IDLE_COMPACT_TEXT = {
  waiting: "Compacting this chat, I'll reply in a moment…",
  ask: "This chat is being compacted (~1–2 min). Wait for it or stop it?",
  wait: "Wait",
  abort: "Stop",
  aborted: "Compaction stopped.",
  done: "Compaction finished.",
} as const;

/** What the timer was armed for — compared again when it fires. */
export type WarmCompactPlan = {
  /** `lastRequestAt` (or the turn end when no request was observed). */
  anchor: number;
  ttlMs: number;
  /** `anchor + 0.9 × ttlMs`. */
  fireAt: number;
  /** The last turn end at arm time. */
  turnEndedAt?: number;
  /** The model the last request ran on. */
  modelId?: string;
};

export type WarmCompactSkip =
  | "disabled"
  | "no-session"
  | "ttl-not-1h"
  | "uncached"
  | "guest-prefix"
  | "small"
  | "late"
  | "turn-in-progress"
  | "newer-turn"
  | "newer-request"
  | "cold"
  | "model-changed"
  | "rate-limited";

type PlanInfo = Pick<
  SessionInfo,
  "turns" | "lastTurnEndedAt" | "usage" | "turnInProgress" | "promptCache"
>;

function validTime(t: number | undefined): t is number {
  return typeof t === "number" && Number.isFinite(t) && t > 0;
}

/**
 * Whether to arm the timer after a turn settled, and for when. Pure.
 */
export function planWarmCompaction(
  info: PlanInfo,
  settings: Pick<IdleCompactSettings, "enabled" | "minContextTokens">,
  now = Date.now(),
): { plan: WarmCompactPlan } | { skip: WarmCompactSkip } {
  if (!settings.enabled) return { skip: "disabled" };
  if (info.turns <= 0) return { skip: "no-session" };
  const cache = info.promptCache;
  if (cache?.ttlMs !== WARM_COMPACT_TTL_MS) return { skip: "ttl-not-1h" };
  if (!cache.cached) return { skip: "uncached" };
  if (cache.guest) return { skip: "guest-prefix" };
  if ((info.usage.contextTokens ?? 0) < settings.minContextTokens) {
    return { skip: "small" };
  }
  const anchor = validTime(cache.lastRequestAt)
    ? cache.lastRequestAt
    : info.lastTurnEndedAt;
  if (!validTime(anchor)) return { skip: "no-session" };
  const fireAt = anchor + WARM_COMPACT_FIRE_FRACTION * cache.ttlMs;
  if (now - fireAt > WARM_COMPACT_MAX_LATE_MS) return { skip: "late" };
  return {
    plan: {
      anchor,
      ttlMs: cache.ttlMs,
      fireAt,
      ...(validTime(info.lastTurnEndedAt)
        ? { turnEndedAt: info.lastTurnEndedAt }
        : {}),
      ...(cache.modelId ? { modelId: cache.modelId } : {}),
    },
  };
}

/**
 * The gates at fire time. Pure. `modelId` is the model the chat's next
 * turn would run on.
 */
export function decideWarmCompact(
  info: PlanInfo,
  plan: WarmCompactPlan,
  settings: Pick<IdleCompactSettings, "enabled" | "minContextTokens">,
  modelId: string | undefined,
  now = Date.now(),
): { compact: true } | { compact: false; reason: WarmCompactSkip } {
  const no = (reason: WarmCompactSkip) => ({ compact: false as const, reason });
  if (!settings.enabled) return no("disabled");
  if (info.turns <= 0) return no("no-session");
  if (info.turnInProgress) return no("turn-in-progress");
  if (info.lastTurnEndedAt !== plan.turnEndedAt) return no("newer-turn");
  const cache = info.promptCache;
  if (cache && validTime(cache.lastRequestAt)) {
    if (cache.lastRequestAt !== plan.anchor) return no("newer-request");
  }
  if (now - plan.fireAt > WARM_COMPACT_MAX_LATE_MS) return no("late");
  if (now >= plan.anchor + plan.ttlMs) return no("cold");
  if ((info.usage.contextTokens ?? 0) < settings.minContextTokens) {
    return no("small");
  }
  if (plan.modelId && modelId && plan.modelId !== modelId) {
    return no("model-changed");
  }
  const status = cache?.rateLimitStatus;
  if (status && status !== "allowed") return no("rate-limited");
  return { compact: true };
}

// ── Precompute ──────────────────────────────────────────────────────────────

/** A compacted fork waiting for the next turn. */
export type PrecomputedCompaction = {
  forkSessionId: string;
  /** The chat's session the fork was taken from. */
  sourceSessionId: string | undefined;
  plan: WarmCompactPlan;
  preTokens: number;
  postTokens?: number;
  /**
   * Deletes the fork — bound to the backend (and its account) that made
   * it, so a discard does not depend on what the chat runs on later.
   */
  discard?: (sessionId: string) => Promise<void>;
  /**
   * A turn waited for this pass (`idleCompactOnTurn: "wait"`): adopt the
   * fork at that turn even while the cache is warm — no `returned_early`.
   */
  adoptEvenIfWarm?: boolean;
  /**
   * Until when the SOURCE session's cache stays warm. The pass's own
   * `/compact` request read that cached prefix (the 0.1× read the design
   * relies on), and a cache hit refreshes its TTL, so this is the request's
   * send time + TTL rather than `plan.anchor + ttlMs`. Absent = the anchor.
   */
  sourceWarmUntil?: number;
};

export type PrecomputeDiscard =
  | "returned_early"
  | "session-changed"
  | "newer-request"
  | "newer-turn"
  | "model-changed";

/**
 * At the next turn: switch to the fork only once the cache it would have
 * read has expired — counting the refresh the pass's own read gave it
 * (`sourceWarmUntil`). Pure.
 */
export function decidePrecompute(
  pending: PrecomputedCompaction,
  info: Pick<SessionInfo, "sessionId" | "lastTurnEndedAt" | "promptCache">,
  modelId: string | undefined,
  now = Date.now(),
): { apply: true } | { apply: false; reason: PrecomputeDiscard } {
  const no = (reason: PrecomputeDiscard) => ({ apply: false as const, reason });
  if (info.sessionId !== pending.sourceSessionId) return no("session-changed");
  const last = info.promptCache?.lastRequestAt;
  if (validTime(last) && last !== pending.plan.anchor) {
    return no("newer-request");
  }
  if (info.lastTurnEndedAt !== pending.plan.turnEndedAt) {
    return no("newer-turn");
  }
  if (pending.plan.modelId && modelId && pending.plan.modelId !== modelId) {
    return no("model-changed");
  }
  const warmUntil =
    pending.sourceWarmUntil ?? pending.plan.anchor + pending.plan.ttlMs;
  if (!pending.adoptEvenIfWarm && now < warmUntil) {
    return no("returned_early");
  }
  return { apply: true };
}

// ── Pending forks (restart safety) ──────────────────────────────────────────

/** kv key: chatId → the id of a precomputed fork not yet adopted or discarded. */
const PENDING_FORKS_KEY = "idle-compact.pending-forks";

type PendingForks = Record<
  string,
  { forkSessionId: string; backendId: string }
>;

function readPendingForks(): PendingForks {
  const value = kvGet<PendingForks>(PENDING_FORKS_KEY);
  return value && typeof value === "object" ? value : {};
}

function writePendingFork(
  chatId: string,
  entry: PendingForks[string] | undefined,
): void {
  const all = readPendingForks();
  if (entry) all[chatId] = entry;
  else if (chatId in all) delete all[chatId];
  else return;
  kvSet(PENDING_FORKS_KEY, all);
}

// ── Timers ──────────────────────────────────────────────────────────────────

/**
 * Per-chat timers. One pending timer per chat at most: arming again
 * replaces it, a new turn cancels it. Unref'd — a pending compaction
 * never holds the daemon up — and they die with the process.
 */
export class WarmCompactTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(chatId: string, delayMs: number, fire: () => void): void {
    this.cancel(chatId);
    const timer = setTimeout(
      () => {
        this.timers.delete(chatId);
        fire();
      },
      Math.max(0, delayMs),
    );
    timer.unref?.();
    this.timers.set(chatId, timer);
  }

  cancel(chatId: string): void {
    const timer = this.timers.get(chatId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(chatId);
  }

  has(chatId: string): boolean {
    return this.timers.has(chatId);
  }
}

// ── The compactor ───────────────────────────────────────────────────────────

export type IdleCompactorDeps = {
  settings: IdleCompactSettings;
  getBackend: (chatId: string) => Backend;
  /** The model id the chat's next turn would run on. */
  resolveModelId: (chatId: string) => Promise<string | undefined>;
  /** Queue a task on the chat's Thread (after any queued turns). */
  enqueue: (chatId: string, task: () => Promise<void>) => void;
  /** Send the chat a plain status message. Best-effort. */
  notify?: (target: ChatTarget, text: string) => Promise<void>;
  /**
   * Ask the chat with inline buttons (`"ask"`). Undefined = the chat's
   * frontend has no buttons (or the send failed): the caller waits.
   */
  ask?: (
    target: ChatTarget,
    question: {
      text: string;
      buttons: ReadonlyArray<{ id: "wait" | "abort"; label: string }>;
      signal: AbortSignal;
    },
  ) => Promise<
    | {
        choice: Promise<string | undefined>;
        update: (text: string) => Promise<void>;
      }
    | undefined
  >;
  now?: () => number;
  timeoutMs?: number;
  askTimeoutMs?: number;
};

/** Where a turn came from — what a status message or question goes to. */
export type ChatTarget = { chatId: string; numericChatId: number };

/** What started a turn (`ExecuteParams.source`); only "message" is a user. */
export type TurnSource = "message" | "pulse" | "cron" | "trigger" | "agent";

type RunningPass = {
  abort: AbortController;
  /** The `/compact` request is sent: in flight, its input billed. */
  requestSent: boolean;
  /** When the request was sent — its cache read refreshed the TTL. */
  requestSentAt?: number;
  /** The compaction has landed (boundary in). */
  landed: boolean;
  fork: boolean;
  /** A turn arrived in flight and waits for the pass. */
  turnWaiting: boolean;
  /** The chat was told (status message or question) — once per pass. */
  chatTold: boolean;
  /** Ends a pending `"ask"` question when the pass is over. */
  over: AbortController;
};

/**
 * The Weaver's idle-compaction state: timers, the running pass and the
 * precomputed forks, per chat. The Weaver calls `onTurnQueued` when a turn
 * arrives, `beforeTurn` right before the backend runs it, and
 * `onTurnSettled` when it is over.
 */
export class IdleCompactor {
  private readonly timers = new WarmCompactTimers();
  private readonly passes = new Map<string, RunningPass>();
  private readonly precomputed = new Map<string, PrecomputedCompaction>();
  /**
   * Backends that answered `unsupported` (e.g. a Claude CLI without
   * `/compact`). Remembered for the process lifetime, so an idle chat does
   * not spawn a CLI every hour only to learn that again; a restart (after
   * an upgrade, say) asks afresh.
   */
  private readonly unsupported = new Set<string>();

  constructor(private readonly deps: IdleCompactorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Timer pending for the chat (tests, /status). */
  isArmed(chatId: string): boolean {
    return this.timers.has(chatId);
  }

  /** A precompute is waiting for the chat's next turn. */
  hasPrecompute(chatId: string): boolean {
    return this.precomputed.has(chatId);
  }

  /**
   * A turn is coming: cancel the timer, and settle a running pass — abort
   * it before its request is sent, else apply `onTurn` (module comment).
   *
   * Only a user's message is told or asked anything. A background turn
   * (trigger wake, sub-agent report, pulse, device job) has nobody waiting
   * on a reply, so a question or a "replying shortly" message would come
   * out of nowhere: it waits silently, which `"ask"` also falls back to.
   */
  onTurnQueued(
    chatId: string,
    target?: ChatTarget,
    source: TurnSource = "message",
  ): void {
    this.timers.cancel(chatId);
    const pass = this.passes.get(chatId);
    if (!pass || pass.abort.signal.aborted) return;
    if (!pass.requestSent) {
      pass.abort.abort();
      return;
    }
    if (pass.chatTold) return; // decided by an earlier user turn
    const policy = this.deps.settings.onTurn;
    if (policy === "abort") {
      abortPass(pass);
      return;
    }
    pass.turnWaiting = true;
    if (source !== "message") {
      incrementCounter("session.idle_compact.turn_background_wait");
      return;
    }
    pass.chatTold = true;
    const to = target ?? { chatId, numericChatId: Number(chatId) };
    if (policy === "ask" && this.deps.ask) void this.ask(to, pass);
    else this.notify(to, IDLE_COMPACT_TEXT.waiting);
    incrementCounter(`session.idle_compact.turn_${policy}`);
  }

  private notify(target: ChatTarget, text: string): void {
    void this.deps.notify?.(target, text).catch((err: unknown) => {
      logWarn(
        "dispatcher",
        `idle compaction chat=${target.chatId}: status message failed: ${errorText(err)}`,
      );
    });
  }

  /** `"ask"`: buttons, a 30 s wait, then abort on a click on "abort". */
  private async ask(target: ChatTarget, pass: RunningPass): Promise<void> {
    const ask = new AbortController();
    const timer = setTimeout(
      () => ask.abort(),
      this.deps.askTimeoutMs ?? ASK_TIMEOUT_MS,
    );
    timer.unref?.();
    const onOver = () => ask.abort();
    pass.over.signal.addEventListener("abort", onOver, { once: true });
    try {
      const handle = await this.deps.ask!(target, {
        text: IDLE_COMPACT_TEXT.ask,
        buttons: [
          { id: "wait", label: IDLE_COMPACT_TEXT.wait },
          { id: "abort", label: IDLE_COMPACT_TEXT.abort },
        ],
        signal: ask.signal,
      });
      if (!handle) {
        // No buttons here: "wait", announced like it.
        if (!pass.over.signal.aborted) {
          this.notify(target, IDLE_COMPACT_TEXT.waiting);
        }
        return;
      }
      const choice = await handle.choice;
      if (pass.over.signal.aborted) {
        await handle.update(IDLE_COMPACT_TEXT.done);
        return;
      }
      if (choice === "abort" && abortPass(pass)) {
        incrementCounter("session.idle_compact.turn_ask_abort");
        await handle.update(IDLE_COMPACT_TEXT.aborted);
        return;
      }
      // "wait", no click in time, or an in-place pass that already landed.
      await handle.update(IDLE_COMPACT_TEXT.waiting);
    } catch (err) {
      logWarn(
        "dispatcher",
        `idle compaction chat=${target.chatId}: ask failed: ${errorText(err)}`,
      );
    } finally {
      clearTimeout(timer);
      pass.over.signal.removeEventListener("abort", onOver);
    }
  }

  /** A turn settled: arm the timer when the chat qualifies. */
  onTurnSettled(chatId: string): void {
    if (!this.deps.settings.enabled) return;
    try {
      if (this.unsupported.has(this.deps.getBackend(chatId).id)) return;
      const now = this.now();
      const planned = planWarmCompaction(
        getSessionInfo(chatId),
        this.deps.settings,
        now,
      );
      if (!("plan" in planned)) return;
      const { plan } = planned;
      this.timers.schedule(chatId, plan.fireAt - now, () => {
        this.deps.enqueue(chatId, () => this.fire(chatId, plan));
      });
    } catch (err) {
      logWarn(
        "dispatcher",
        `idle compaction arm chat=${chatId} threw: ${errorText(err)}`,
      );
    }
  }

  /**
   * Right before the backend runs a turn: apply or discard a waiting
   * precompute. Cheap — no model call. Never throws.
   */
  async beforeTurn(chatId: string, modelId: string): Promise<void> {
    const pending = this.precomputed.get(chatId);
    if (!pending) {
      await this.discardOrphan(chatId);
      return;
    }
    this.precomputed.delete(chatId);
    try {
      writePendingFork(chatId, undefined);
      const verdict = decidePrecompute(
        pending,
        getSessionInfo(chatId),
        modelId,
        this.now(),
      );
      if (verdict.apply) {
        setSessionId(chatId, pending.forkSessionId);
        recordSessionCompaction(
          chatId,
          pending.postTokens !== undefined
            ? { contextTokens: pending.postTokens }
            : {},
        );
        // The chat's session changes only now, so this is where the fork
        // counts as a compaction (the backend skips it for a fork pass).
        recordAdoptedCompaction(pending.preTokens, pending.postTokens);
        incrementCounter("session.idle_compact");
        incrementCounter("session.idle_compact.applied");
        recordSaved(pending.preTokens, pending.postTokens);
        log(
          "dispatcher",
          `idle compaction chat=${chatId}: ${pending.adoptEvenIfWarm ? "the turn waited for the pass" : "cache expired"}, resuming the precomputed fork ${pending.forkSessionId}`,
        );
        return;
      }
      incrementCounter("session.idle_compact.discarded");
      incrementCounter(`session.idle_compact.discarded.${verdict.reason}`);
      log(
        "dispatcher",
        `idle compaction chat=${chatId}: precompute discarded (${verdict.reason})`,
      );
      await pending.discard?.(pending.forkSessionId);
    } catch (err) {
      logWarn(
        "dispatcher",
        `idle compaction chat=${chatId}: precompute hand-off threw: ${errorText(err)}`,
      );
    }
  }

  /**
   * A fork precomputed before a restart and never adopted: no in-memory
   * record is left, only the persisted id. Delete it — on the backend
   * that made it; a chat that moved to another backend just drops the id.
   */
  private async discardOrphan(chatId: string): Promise<void> {
    try {
      const orphan = readPendingForks()[chatId];
      if (!orphan) return;
      writePendingFork(chatId, undefined);
      const backend = this.deps.getBackend(chatId);
      if (backend.id !== orphan.backendId) return;
      incrementCounter("session.idle_compact.discarded.orphan");
      log(
        "dispatcher",
        `idle compaction chat=${chatId}: deleting the fork ${orphan.forkSessionId} a restart orphaned`,
      );
      await backend.sessions?.discardSession?.(orphan.forkSessionId);
    } catch (err) {
      logWarn(
        "dispatcher",
        `idle compaction chat=${chatId}: orphaned fork cleanup threw: ${errorText(err)}`,
      );
    }
  }

  /** The timer fired and the Thread reached the task. Never throws. */
  private async fire(chatId: string, plan: WarmCompactPlan): Promise<void> {
    // Registered before the first await, so a turn queued while the model
    // id resolves (`onTurnQueued`) finds the pass and aborts it.
    const pass: RunningPass = {
      abort: new AbortController(),
      requestSent: false,
      landed: false,
      fork: this.deps.settings.mode === "precompute",
      turnWaiting: false,
      chatTold: false,
      over: new AbortController(),
    };
    this.passes.set(chatId, pass);
    try {
      const backend = this.deps.getBackend(chatId);
      if (!backend.sessions?.compactChat) return;
      const modelId = await this.deps.resolveModelId(chatId);
      if (pass.abort.signal.aborted) {
        incrementCounter("session.idle_compact.aborted");
        log("dispatcher", `idle compaction chat=${chatId}: aborted by a turn`);
        return;
      }
      const skip = this.gate(chatId, plan, modelId);
      if (skip) {
        incrementCounter(`session.idle_compact.skipped.${skip}`);
        log("dispatcher", `idle compaction chat=${chatId} skipped: ${skip}`);
        return;
      }
      await this.runPass(chatId, backend, plan, pass);
    } catch (err) {
      logWarn(
        "dispatcher",
        `idle compaction chat=${chatId} threw: ${errorText(err)}`,
      );
    } finally {
      if (this.passes.get(chatId) === pass) this.passes.delete(chatId);
      pass.over.abort();
    }
  }

  private gate(
    chatId: string,
    plan: WarmCompactPlan,
    modelId: string | undefined,
  ): WarmCompactSkip | undefined {
    const decision = decideWarmCompact(
      getSessionInfo(chatId),
      plan,
      this.deps.settings,
      modelId,
      this.now(),
    );
    return decision.compact ? undefined : decision.reason;
  }

  private async runPass(
    chatId: string,
    backend: Backend,
    plan: WarmCompactPlan,
    pass: RunningPass,
  ): Promise<void> {
    const { fork } = pass;
    const info = getSessionInfo(chatId);
    const contextTokens = info.usage.contextTokens ?? 0;
    log(
      "dispatcher",
      `idle compaction (${fork ? "precompute" : "in-place"}) chat=${chatId}: ` +
        `context ${contextTokens} tokens, ${Math.round((plan.anchor + plan.ttlMs - this.now()) / 60_000)}m before the cache expires`,
    );
    const startedAt = Date.now();
    let result: SessionCompactResult;
    try {
      result = await backend.sessions!.compactChat!(chatId, {
        ...(plan.modelId ? { modelId: plan.modelId } : {}),
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS,
        fork,
        signal: pass.abort.signal,
        onBoundary: () => {
          pass.requestSent = true;
          pass.requestSentAt ??= this.now();
          pass.landed = true;
        },
        onRequestSent: () => {
          pass.requestSent = true;
          pass.requestSentAt ??= this.now();
        },
      });
    } catch (err) {
      result = { status: "failed", error: errorText(err) };
    }
    recordHistogram("session.idle_compact.duration_ms", Date.now() - startedAt);
    this.settlePass(chatId, result, {
      plan,
      sourceSessionId: info.sessionId,
      contextTokens,
      fork,
      backend,
      turnWaiting: pass.turnWaiting && !pass.abort.signal.aborted,
      ...(pass.requestSentAt !== undefined
        ? { requestSentAt: pass.requestSentAt }
        : {}),
    });
  }

  private settlePass(
    chatId: string,
    result: SessionCompactResult,
    ctx: {
      plan: WarmCompactPlan;
      sourceSessionId: string | undefined;
      contextTokens: number;
      fork: boolean;
      backend: Backend;
      /** A turn is queued behind this pass, waiting for it. */
      turnWaiting: boolean;
      requestSentAt?: number;
    },
  ): void {
    if (result.status === "aborted") {
      incrementCounter("session.idle_compact.aborted");
      log("dispatcher", `idle compaction chat=${chatId}: aborted by a turn`);
      return;
    }
    if (result.status === "failed") {
      incrementCounter("session.idle_compact.failed");
      logWarn(
        "dispatcher",
        `idle compaction chat=${chatId} failed: ${result.error} — the session is unchanged`,
      );
      return;
    }
    if (result.status === "unsupported") {
      if (!this.unsupported.has(ctx.backend.id)) {
        this.unsupported.add(ctx.backend.id);
        logWarn(
          "dispatcher",
          `idle compaction is unavailable on backend ${ctx.backend.id}: ${result.reason} — not arming it again until a restart`,
        );
      }
      incrementCounter("session.idle_compact.unsupported");
      return;
    }
    if (result.status === "skipped") {
      incrementCounter("session.idle_compact.skipped.backend");
      log(
        "dispatcher",
        `idle compaction chat=${chatId} skipped by the backend: ${result.reason}`,
      );
      return;
    }
    const preTokens = result.preTokens || ctx.contextTokens;
    recordPassUsage(chatId, result);
    const forked =
      ctx.fork &&
      result.sessionId !== undefined &&
      result.sessionId !== ctx.sourceSessionId;
    if (forked) {
      const { backend } = ctx;
      const forkSessionId = result.sessionId!;
      // A pass that read the source's cached prefix refreshed it. Without
      // usage figures, assume it did: that is the read the design pays for.
      const readCache = result.usage ? result.usage.cacheRead > 0 : true;
      const sourceWarmUntil =
        readCache && ctx.requestSentAt !== undefined
          ? Math.max(ctx.plan.anchor, ctx.requestSentAt) + ctx.plan.ttlMs
          : undefined;
      this.precomputed.set(chatId, {
        forkSessionId,
        sourceSessionId: ctx.sourceSessionId,
        plan: ctx.plan,
        preTokens,
        ...(result.postTokens !== undefined
          ? { postTokens: result.postTokens }
          : {}),
        discard: async (id) => {
          await backend.sessions?.discardSession?.(id);
        },
        ...(ctx.turnWaiting ? { adoptEvenIfWarm: true } : {}),
        ...(sourceWarmUntil !== undefined ? { sourceWarmUntil } : {}),
      });
      writePendingFork(chatId, { forkSessionId, backendId: backend.id });
      incrementCounter("session.idle_compact.precomputed");
      return;
    }
    // In place (asked for, or the fork was not honoured).
    if (result.sessionId && result.sessionId !== ctx.sourceSessionId) {
      setSessionId(chatId, result.sessionId);
    }
    recordSessionCompaction(
      chatId,
      result.postTokens !== undefined
        ? { contextTokens: result.postTokens }
        : {},
    );
    incrementCounter("session.idle_compact");
    incrementCounter("session.idle_compact.in_place");
    recordSaved(preTokens, result.postTokens);
  }
}

/**
 * Abort a pass a turn will not wait for — an in-place one only before it
 * landed. False when it could not be aborted.
 */
function abortPass(pass: RunningPass): boolean {
  if (!pass.fork && pass.landed) return false;
  pass.abort.abort();
  return true;
}

/** The pass's billed usage, into the session totals and the histograms. */
function recordPassUsage(
  chatId: string,
  result: Extract<SessionCompactResult, { status: "compacted" }>,
): void {
  if (!result.usage) return;
  // Whether the pass read the transcript from cache (warm) or re-wrote it
  // (a prefix mismatch) — the number that says the warm path pays.
  recordHistogram(
    "session.idle_compact.cache_read_tokens",
    result.usage.cacheRead,
  );
  recordHistogram(
    "session.idle_compact.cache_write_tokens",
    result.usage.cacheWrite,
  );
  recordSessionCompaction(chatId, result.usage);
}

/**
 * The same counters a compaction boundary in a turn's stream records
 * (`recordCompactBoundary`), for a precomputed fork the chat adopted.
 */
function recordAdoptedCompaction(pre: number, post: number | undefined): void {
  incrementCounter("session.compacted.manual");
  recordHistogram("session.compact.pre_tokens", pre);
  if (post !== undefined) recordHistogram("session.compact.post_tokens", post);
}

function recordSaved(pre: number, post: number | undefined): void {
  if (post === undefined) return;
  recordHistogram("session.idle_compact.saved_tokens", Math.max(0, pre - post));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
