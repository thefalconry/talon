/**
 * Idle compaction (docs/cache-economics.md PR C): the CLI-shaped policy —
 * a 1 h TTL observed from usage, a timer at lastRequestAt + 0.9 × TTL, the
 * fire-time gates — and the compactor around it: precompute on a fork
 * applied only once the cache has expired (else discarded), in-place as
 * the alternative, and what a turn does to a running pass: abort it before
 * its request is sent, else wait / abort / ask (`idleCompactOnTurn`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Backend,
  SessionCompactOptions,
  SessionCompactResult,
} from "../core/agent-runtime/capabilities.js";
import { composeBackend } from "../core/agent-runtime/capabilities.js";
import type { PromptCacheObservation } from "../storage/sessions.js";

// ── Storage stubs ───────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const T0 = 100 * HOUR;

const session = {
  sessionId: "sess-1" as string | undefined,
  turns: 12,
  lastTurnEndedAt: (T0 + 30_000) as number | undefined,
  turnInProgress: false,
  usage: { contextTokens: 300_000 },
  promptCache: undefined as PromptCacheObservation | undefined,
};
const store = {
  setSessionId: vi.fn((_chatId: string, id: string) => {
    session.sessionId = id;
  }),
  recordSessionCompaction: vi.fn(),
};
const metrics = { incrementCounter: vi.fn(), recordHistogram: vi.fn() };

vi.mock("../storage/sessions.js", () => ({
  getSessionInfo: () => ({
    ...session,
    usage: { ...session.usage },
    promptCache: session.promptCache ? { ...session.promptCache } : undefined,
  }),
  setSessionId: (...a: [string, string]) => store.setSessionId(...a),
  recordSessionCompaction: (...a: unknown[]) =>
    store.recordSessionCompaction(...a),
}));
// The kv table, in memory: survives an IdleCompactor being rebuilt (a restart).
const kv = new Map<string, unknown>();
vi.mock("../storage/kv.js", () => ({
  kvGet: (key: string) => structuredClone(kv.get(key)),
  kvSet: (key: string, value: unknown) => {
    kv.set(key, structuredClone(value));
    return true;
  },
}));
vi.mock("../storage/metrics.js", () => ({
  incrementCounter: (...a: [string]) => metrics.incrementCounter(...a),
  recordHistogram: (...a: [string, number]) => metrics.recordHistogram(...a),
}));

type IdleCompactorDeps =
  import("../core/weaver/idle-compact.js").IdleCompactorDeps;

const {
  decidePrecompute,
  IDLE_COMPACT_TEXT,
  decideWarmCompact,
  IdleCompactor,
  IDLE_COMPACT_DEFAULTS,
  planWarmCompaction,
  resolveIdleCompactSettings,
  WarmCompactTimers,
} = await import("../core/weaver/idle-compact.js");

const ON = {
  enabled: true,
  minContextTokens: 200_000,
  mode: "precompute" as const,
  onTurn: "wait" as const,
};
const FIRE_AT = T0 + 0.9 * HOUR;

function obs(over: Partial<PromptCacheObservation> = {}) {
  return {
    lastRequestAt: T0,
    cached: true,
    ttlMs: HOUR,
    modelId: "opus-x",
    rateLimitStatus: "allowed",
    ...over,
  } as PromptCacheObservation;
}

function info(over: Partial<typeof session> = {}) {
  return {
    ...session,
    promptCache: obs(),
    ...over,
    usage: over.usage ?? { contextTokens: 300_000 },
  } as never;
}

const PLAN = {
  anchor: T0,
  ttlMs: HOUR,
  fireAt: FIRE_AT,
  turnEndedAt: T0 + 30_000,
  modelId: "opus-x",
};

beforeEach(() => {
  vi.clearAllMocks();
  kv.clear();
  session.sessionId = "sess-1";
  session.turns = 12;
  session.lastTurnEndedAt = T0 + 30_000;
  session.turnInProgress = false;
  session.usage = { contextTokens: 300_000 };
  session.promptCache = obs();
});

// ── Settings ────────────────────────────────────────────────────────────────

describe("resolveIdleCompactSettings", () => {
  it("is off by default, at the CLI's 200 k threshold, precomputing", () => {
    expect(resolveIdleCompactSettings({})).toEqual({
      enabled: false,
      minContextTokens: 200_000,
      mode: "precompute",
      onTurn: "wait",
    });
    expect(IDLE_COMPACT_DEFAULTS).toEqual({
      enabled: false,
      minContextTokens: 200_000,
      mode: "precompute",
      onTurn: "wait",
    });
  });

  it("takes the cache block and clamps the threshold to the 100 k floor", () => {
    expect(
      resolveIdleCompactSettings({
        cache: {
          idleCompact: true,
          idleCompactMinContextTokens: 50_000,
          idleCompactMode: "in-place",
          idleCompactOnTurn: "ask",
        },
      }),
    ).toEqual({
      enabled: true,
      minContextTokens: 100_000,
      mode: "in-place",
      onTurn: "ask",
    });
  });
});

// ── Arming ──────────────────────────────────────────────────────────────────

describe("planWarmCompaction", () => {
  it("anchors on the last request, not the turn end: fireAt = lastRequestAt + 0.9 × TTL", () => {
    const out = planWarmCompaction(info(), ON, T0 + 60_000);
    expect(out).toEqual({ plan: PLAN });
    // Turn ended 30 s after the request; the timer still counts from the request.
    expect((out as { plan: { fireAt: number } }).plan.fireAt).toBe(
      T0 + 3_240_000,
    );
  });

  it("arms only on an observed 1 h TTL", () => {
    expect(
      planWarmCompaction(
        info({ promptCache: obs({ ttlMs: 300_000 }) }),
        ON,
        T0,
      ),
    ).toEqual({ skip: "ttl-not-1h" });
    expect(
      planWarmCompaction(
        info({ promptCache: obs({ ttlMs: undefined }) }),
        ON,
        T0,
      ),
    ).toEqual({ skip: "ttl-not-1h" });
    expect(
      planWarmCompaction(info({ promptCache: undefined }), ON, T0),
    ).toEqual({ skip: "ttl-not-1h" });
  });

  it("does not arm on a request that neither read nor wrote the cache", () => {
    expect(
      planWarmCompaction(info({ promptCache: obs({ cached: false }) }), ON, T0),
    ).toEqual({ skip: "uncached" });
  });

  it("skips small chats, guest prefixes, disabled settings and empty sessions", () => {
    expect(
      planWarmCompaction(info({ usage: { contextTokens: 199_999 } }), ON, T0),
    ).toEqual({ skip: "small" });
    expect(
      planWarmCompaction(info({ promptCache: obs({ guest: true }) }), ON, T0),
    ).toEqual({ skip: "guest-prefix" });
    expect(planWarmCompaction(info(), { ...ON, enabled: false }, T0)).toEqual({
      skip: "disabled",
    });
    expect(planWarmCompaction(info({ turns: 0 }), ON, T0)).toEqual({
      skip: "no-session",
    });
  });

  it("refuses to arm a timer that would already be more than 60 s late", () => {
    expect(planWarmCompaction(info(), ON, FIRE_AT + 60_000)).toHaveProperty(
      "plan",
    );
    expect(planWarmCompaction(info(), ON, FIRE_AT + 60_001)).toEqual({
      skip: "late",
    });
  });
});

// ── Fire-time gates ─────────────────────────────────────────────────────────

describe("decideWarmCompact", () => {
  const at = (
    now: number,
    over: Partial<typeof session> = {},
    model = "opus-x",
  ) => decideWarmCompact(info(over), PLAN, ON, model, now);

  it("compacts an idle, big, warm chat on time", () => {
    expect(at(FIRE_AT)).toEqual({ compact: true });
  });

  it("skips a timer more than 60 s late", () => {
    expect(at(FIRE_AT + 60_000)).toEqual({ compact: true });
    expect(at(FIRE_AT + 60_001)).toEqual({ compact: false, reason: "late" });
  });

  it("skips once the cache has expired", () => {
    const late = { ...PLAN, fireAt: T0 + HOUR - 10 };
    expect(decideWarmCompact(info(), late, ON, "opus-x", T0 + HOUR)).toEqual({
      compact: false,
      reason: "cold",
    });
  });

  it("skips after a newer request or turn", () => {
    expect(
      at(FIRE_AT, { promptCache: obs({ lastRequestAt: T0 + 5_000 }) }),
    ).toEqual({ compact: false, reason: "newer-request" });
    expect(at(FIRE_AT, { lastTurnEndedAt: T0 + 99_000 })).toEqual({
      compact: false,
      reason: "newer-turn",
    });
    expect(at(FIRE_AT, { turnInProgress: true })).toEqual({
      compact: false,
      reason: "turn-in-progress",
    });
  });

  it("skips when the next turn would run on another model", () => {
    expect(at(FIRE_AT, {}, "sonnet-y")).toEqual({
      compact: false,
      reason: "model-changed",
    });
  });

  it("skips unless the last rate-limit status was allowed", () => {
    expect(
      at(FIRE_AT, { promptCache: obs({ rateLimitStatus: "allowed_warning" }) }),
    ).toEqual({ compact: false, reason: "rate-limited" });
    // No status seen (an API key never gets one) is not a reason to skip.
    expect(
      at(FIRE_AT, { promptCache: obs({ rateLimitStatus: undefined }) }),
    ).toEqual({ compact: true });
  });

  it("skips a chat that shrank below the threshold", () => {
    expect(at(FIRE_AT, { usage: { contextTokens: 150_000 } })).toEqual({
      compact: false,
      reason: "small",
    });
  });
});

// ── Precompute hand-off ─────────────────────────────────────────────────────

describe("decidePrecompute", () => {
  const pending = {
    forkSessionId: "fork-1",
    sourceSessionId: "sess-1",
    plan: PLAN,
    preTokens: 300_000,
    postTokens: 9_000,
  };

  it("applies the fork only once the cache has expired", () => {
    expect(decidePrecompute(pending, info(), "opus-x", T0 + HOUR)).toEqual({
      apply: true,
    });
    expect(decidePrecompute(pending, info(), "opus-x", T0 + HOUR - 1)).toEqual({
      apply: false,
      reason: "returned_early",
    });
  });

  it("counts the pass's own cache read: the source stays warm until its send time + TTL", () => {
    const refreshed = { ...pending, sourceWarmUntil: FIRE_AT + HOUR };
    // An hour after the last turn's request, but the pass read the prefix at
    // FIRE_AT, so resuming the original session is still the warm read.
    expect(
      decidePrecompute(refreshed, info(), "opus-x", T0 + HOUR + 10 * 60_000),
    ).toEqual({ apply: false, reason: "returned_early" });
    expect(
      decidePrecompute(refreshed, info(), "opus-x", FIRE_AT + HOUR),
    ).toEqual({ apply: true });
  });

  it("adopts a fork a turn waited for while the cache is still warm — other checks stay", () => {
    const waited = { ...pending, adoptEvenIfWarm: true };
    const warm = T0 + HOUR - 60_000;
    expect(decidePrecompute(waited, info(), "opus-x", warm)).toEqual({
      apply: true,
    });
    expect(decidePrecompute(waited, info(), "sonnet-y", warm)).toEqual({
      apply: false,
      reason: "model-changed",
    });
    expect(
      decidePrecompute(waited, info({ sessionId: "sess-2" }), "opus-x", warm),
    ).toEqual({ apply: false, reason: "session-changed" });
    expect(
      decidePrecompute(
        waited,
        info({ lastTurnEndedAt: T0 + 40_000 }),
        "opus-x",
        warm,
      ),
    ).toEqual({ apply: false, reason: "newer-turn" });
  });

  it("discards on a model change, a newer request or turn, or a reset session", () => {
    const late = T0 + 2 * HOUR;
    expect(decidePrecompute(pending, info(), "sonnet-y", late)).toEqual({
      apply: false,
      reason: "model-changed",
    });
    expect(
      decidePrecompute(
        pending,
        info({ promptCache: obs({ lastRequestAt: T0 + 1 }) }),
        "opus-x",
        late,
      ),
    ).toEqual({ apply: false, reason: "newer-request" });
    expect(
      decidePrecompute(
        pending,
        info({ lastTurnEndedAt: T0 + HOUR }),
        "opus-x",
        late,
      ),
    ).toEqual({ apply: false, reason: "newer-turn" });
    expect(
      decidePrecompute(pending, info({ sessionId: undefined }), "opus-x", late),
    ).toEqual({ apply: false, reason: "session-changed" });
  });
});

// ── The compactor ───────────────────────────────────────────────────────────

type CompactFn = (
  chatId: string,
  opts?: SessionCompactOptions,
) => Promise<SessionCompactResult>;

function makeCompactor(input: {
  compactChat: CompactFn;
  mode?: "precompute" | "in-place";
  onTurn?: "wait" | "abort" | "ask";
  model?: string;
  resolveModelId?: () => Promise<string | undefined>;
  ask?: IdleCompactorDeps["ask"];
}) {
  const discardSession = vi.fn(async (_id: string) => {});
  const compactChat = vi.fn(input.compactChat);
  const backend: Backend = composeBackend({
    id: "claude",
    label: "Claude",
    sessions: { compactChat, discardSession },
  });
  /** What `getBackend` answers — a test may switch the chat to another. */
  const current = { backend };
  const tasks: Promise<void>[] = [];
  const notify = vi.fn(async (_target: unknown, _text: string) => {});
  const compactor = new IdleCompactor({
    settings: {
      ...ON,
      mode: input.mode ?? "precompute",
      onTurn: input.onTurn ?? "wait",
    },
    notify,
    ...(input.ask ? { ask: input.ask } : {}),
    getBackend: () => current.backend,
    resolveModelId:
      input.resolveModelId ?? (async () => input.model ?? "opus-x"),
    enqueue: (_chatId, task) => {
      tasks.push(task());
    },
    now: () => Date.now(),
  });
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(tasks);
  };
  return {
    compactor,
    compactChat,
    discardSession,
    settle,
    tasks,
    current,
    notify,
  };
}

const compacted = (over: Partial<SessionCompactResult> = {}) =>
  ({
    status: "compacted",
    preTokens: 300_000,
    postTokens: 9_000,
    sessionId: "fork-1",
    usage: {
      inputTokens: 5,
      outputTokens: 900,
      cacheRead: 299_000,
      cacheWrite: 1_000,
    },
    ...over,
  }) as SessionCompactResult;

describe("IdleCompactor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 30_000); // the turn just settled
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms at lastRequestAt + 0.9 × TTL and precomputes a fork on the chat's last model", async () => {
    const c = makeCompactor({ compactChat: async () => compacted() });
    c.compactor.onTurnSettled("c1");
    expect(c.compactor.isArmed("c1")).toBe(true);

    await vi.advanceTimersByTimeAsync(FIRE_AT - (T0 + 30_000) - 1);
    expect(c.compactChat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await c.settle();

    expect(c.compactChat).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ fork: true, modelId: "opus-x" }),
    );
    expect(c.compactor.hasPrecompute("c1")).toBe(true);
    // The chat's own session is untouched until the next turn decides.
    expect(store.setSessionId).not.toHaveBeenCalled();
    expect(store.recordSessionCompaction).toHaveBeenCalledWith("c1", {
      inputTokens: 5,
      outputTokens: 900,
      cacheRead: 299_000,
      cacheWrite: 1_000,
    });
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.precomputed",
    );
  });

  it("applies the precompute at a turn after the cache expired", async () => {
    const c = makeCompactor({ compactChat: async () => compacted() });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();

    vi.setSystemTime(T0 + 2 * HOUR);
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(store.setSessionId).toHaveBeenCalledWith("c1", "fork-1");
    expect(store.recordSessionCompaction).toHaveBeenLastCalledWith("c1", {
      contextTokens: 9_000,
    });
    expect(c.discardSession).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.applied",
    );
    expect(c.compactor.hasPrecompute("c1")).toBe(false);
  });

  it("discards the precompute when the user returns before the cache expired", async () => {
    const c = makeCompactor({ compactChat: async () => compacted() });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();

    vi.setSystemTime(T0 + HOUR - 60_000);
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(store.setSessionId).not.toHaveBeenCalled();
    expect(c.discardSession).toHaveBeenCalledWith("fork-1");
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.discarded.returned_early",
    );
    expect(session.sessionId).toBe("sess-1");
  });

  it("discards the precompute when the model changed", async () => {
    const c = makeCompactor({ compactChat: async () => compacted() });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();

    vi.setSystemTime(T0 + 2 * HOUR);
    await c.compactor.beforeTurn("c1", "sonnet-y");
    expect(store.setSessionId).not.toHaveBeenCalled();
    expect(c.discardSession).toHaveBeenCalledWith("fork-1");
  });

  it("does not arm a 5-minute-TTL chat", () => {
    session.promptCache = obs({ ttlMs: 300_000 });
    const c = makeCompactor({ compactChat: async () => compacted() });
    c.compactor.onTurnSettled("c1");
    expect(c.compactor.isArmed("c1")).toBe(false);
  });

  it("a queued turn cancels the timer", async () => {
    const c = makeCompactor({ compactChat: async () => compacted() });
    c.compactor.onTurnSettled("c1");
    c.compactor.onTurnQueued("c1");
    expect(c.compactor.isArmed("c1")).toBe(false);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(c.compactChat).not.toHaveBeenCalled();
  });

  it("skips when the model changed or a newer request happened before the timer fired", async () => {
    const c = makeCompactor({
      compactChat: async () => compacted(),
      model: "sonnet-y",
    });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();
    expect(c.compactChat).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.skipped.model-changed",
    );

    const d = makeCompactor({ compactChat: async () => compacted() });
    vi.setSystemTime(T0 + 30_000);
    d.compactor.onTurnSettled("c1");
    session.promptCache = obs({ lastRequestAt: T0 + 40_000 });
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await d.settle();
    expect(d.compactChat).not.toHaveBeenCalled();
  });

  it("skips a timer that fired more than 60 s late (suspended host)", async () => {
    const c = makeCompactor({ compactChat: async () => compacted() });
    c.compactor.onTurnSettled("c1");
    // The host slept through the fire time: the clock jumps, the timer
    // callback runs afterwards.
    vi.setSystemTime(FIRE_AT + 120_000);
    await vi.advanceTimersByTimeAsync(FIRE_AT - (T0 + 30_000));
    await c.settle();
    expect(c.compactChat).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.skipped.late",
    );
  });

  it("in place: records the compacted session at fire time", async () => {
    const c = makeCompactor({
      mode: "in-place",
      compactChat: async () => compacted({ sessionId: "sess-1" }),
    });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();
    expect(c.compactChat).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ fork: false }),
    );
    expect(store.setSessionId).not.toHaveBeenCalled();
    expect(store.recordSessionCompaction).toHaveBeenLastCalledWith("c1", {
      contextTokens: 9_000,
    });
    expect(c.compactor.hasPrecompute("c1")).toBe(false);
    expect(metrics.recordHistogram).toHaveBeenCalledWith(
      "session.idle_compact.saved_tokens",
      291_000,
    );
  });

  it("precompute the CLI did not fork (same id back) is recorded as in place", async () => {
    const c = makeCompactor({
      compactChat: async () => compacted({ sessionId: undefined }),
    });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();
    expect(c.compactor.hasPrecompute("c1")).toBe(false);
    expect(store.recordSessionCompaction).toHaveBeenLastCalledWith("c1", {
      contextTokens: 9_000,
    });
  });

  it("a turn arriving mid-pass aborts it before the boundary; the session is untouched", async () => {
    let seen: SessionCompactOptions | undefined;
    const c = makeCompactor({
      mode: "in-place",
      compactChat: (_id, opts) =>
        new Promise((resolve) => {
          seen = opts;
          opts?.signal?.addEventListener("abort", () =>
            resolve({ status: "aborted" }),
          );
        }),
    });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await vi.waitFor(() => expect(seen).toBeDefined());

    c.compactor.onTurnQueued("c1");
    expect(seen?.signal?.aborted).toBe(true);
    await c.settle();
    expect(store.setSessionId).not.toHaveBeenCalled();
    expect(store.recordSessionCompaction).not.toHaveBeenCalled();
    expect(session.sessionId).toBe("sess-1");
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.aborted",
    );
  });

  it("an in-place pass past its boundary is left to finish", async () => {
    let finish!: () => void;
    let seen: SessionCompactOptions | undefined;
    const c = makeCompactor({
      mode: "in-place",
      compactChat: (_id, opts) =>
        new Promise((resolve) => {
          seen = opts;
          opts?.onBoundary?.();
          finish = () => resolve(compacted({ sessionId: "sess-1" }));
        }),
    });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await vi.waitFor(() => expect(seen).toBeDefined());

    c.compactor.onTurnQueued("c1");
    expect(seen?.signal?.aborted).toBe(false);
    finish();
    await c.settle();
    expect(store.recordSessionCompaction).toHaveBeenLastCalledWith("c1", {
      contextTokens: 9_000,
    });
  });

  it("onTurn abort: a precompute past its boundary still has its signal aborted by a turn", async () => {
    // What the compactor owns: the signal. That the Claude backend honours
    // it after the boundary (and deletes the fork) is pinned in
    // claude-sdk-compact.test.ts — this backend ignores the abort and
    // finishes, the worst case the compactor must still handle.
    let finish!: () => void;
    let seen: SessionCompactOptions | undefined;
    const c = makeCompactor({
      onTurn: "abort",
      compactChat: (_id, opts) =>
        new Promise((resolve) => {
          seen = opts;
          opts?.onBoundary?.();
          finish = () => resolve(compacted());
        }),
    });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await vi.waitFor(() => expect(seen).toBeDefined());
    c.compactor.onTurnQueued("c1");
    expect(seen?.signal?.aborted).toBe(true);
    finish();
    await c.settle();
    // The late fork reaches the turn while the cache is still warm: the
    // turn discards it rather than resuming it.
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(store.setSessionId).not.toHaveBeenCalled();
    expect(c.discardSession).toHaveBeenCalledWith("fork-1");
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.discarded.returned_early",
    );
  });

  it("a turn queued while the model id resolves aborts the pass before it starts", async () => {
    let resolveModel!: (id: string) => void;
    const c = makeCompactor({
      compactChat: async () => compacted(),
      resolveModelId: () =>
        new Promise((resolve) => {
          resolveModel = resolve;
        }),
    });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await vi.waitFor(() => expect(resolveModel).toBeDefined());

    c.compactor.onTurnQueued("c1");
    resolveModel("opus-x");
    await c.settle();
    expect(c.compactChat).not.toHaveBeenCalled();
    expect(c.compactor.hasPrecompute("c1")).toBe(false);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.aborted",
    );
  });

  it("discards a precompute on the backend that made it, not the chat's current one", async () => {
    const c = makeCompactor({ compactChat: async () => compacted() });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();

    const otherDiscard = vi.fn(async (_id: string) => {});
    c.current.backend = composeBackend({
      id: "codex",
      label: "Codex",
      sessions: { discardSession: otherDiscard },
    });
    await c.compactor.beforeTurn("c1", "opus-x"); // warm: returned_early
    expect(c.discardSession).toHaveBeenCalledWith("fork-1");
    expect(otherDiscard).not.toHaveBeenCalled();
  });

  it("deletes a fork a restart orphaned at the chat's next turn", async () => {
    const c = makeCompactor({ compactChat: async () => compacted() });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();
    expect(c.compactor.hasPrecompute("c1")).toBe(true);

    // Restart: a fresh compactor, nothing in memory, the kv row survives.
    const after = makeCompactor({ compactChat: async () => compacted() });
    expect(after.compactor.hasPrecompute("c1")).toBe(false);
    await after.compactor.beforeTurn("c1", "opus-x");
    expect(after.discardSession).toHaveBeenCalledWith("fork-1");
    expect(store.setSessionId).not.toHaveBeenCalled();
    // Once only.
    await after.compactor.beforeTurn("c1", "opus-x");
    expect(after.discardSession).toHaveBeenCalledTimes(1);
  });

  it("forgets the persisted fork once it is adopted", async () => {
    const c = makeCompactor({ compactChat: async () => compacted() });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();
    vi.setSystemTime(T0 + 2 * HOUR);
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(store.setSessionId).toHaveBeenCalledWith("c1", "fork-1");

    const after = makeCompactor({ compactChat: async () => compacted() });
    await after.compactor.beforeTurn("c1", "opus-x");
    expect(after.discardSession).not.toHaveBeenCalled();
  });

  it("a failed pass changes nothing and never throws", async () => {
    const c = makeCompactor({
      compactChat: async () => {
        throw new Error("boom");
      },
    });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();
    expect(store.setSessionId).not.toHaveBeenCalled();
    expect(store.recordSessionCompaction).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.failed",
    );
  });
});

describe("IdleCompactor: a turn during a pass", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 30_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const TARGET = { chatId: "c1", numericChatId: 1 };

  /** A pass the test drives: request sent, boundary, finish. */
  function driven() {
    const ctl = {
      seen: undefined as SessionCompactOptions | undefined,
      finish: (_r?: SessionCompactResult) => {},
    };
    const compactChat: CompactFn = (_id, opts) =>
      new Promise((resolve) => {
        ctl.seen = opts;
        ctl.finish = (r = compacted()) => resolve(r);
        opts?.signal?.addEventListener("abort", () =>
          resolve({ status: "aborted" }),
        );
      });
    return { ctl, compactChat };
  }

  async function start(
    c: ReturnType<typeof makeCompactor>,
    ctl: ReturnType<typeof driven>["ctl"],
  ) {
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await vi.waitFor(() => expect(ctl.seen).toBeDefined());
  }

  function fakeAsk(click?: "wait" | "abort") {
    const update = vi.fn(async (_text: string) => {});
    const signals: AbortSignal[] = [];
    const ask = vi.fn<NonNullable<IdleCompactorDeps["ask"]>>(async (_t, q) => {
      signals.push(q.signal);
      return {
        choice: click
          ? Promise.resolve(click)
          : new Promise<string | undefined>((resolve) =>
              q.signal.addEventListener("abort", () => resolve(undefined)),
            ),
        update,
      };
    });
    return { ask, update, signals };
  }

  it.each(["wait", "abort", "ask"] as const)(
    "onTurn %s: a turn before the request is sent aborts the pass, silently",
    async (onTurn) => {
      const p = driven();
      const a = fakeAsk("wait");
      const c = makeCompactor({
        onTurn,
        compactChat: p.compactChat,
        ask: a.ask,
      });
      await start(c, p.ctl);
      c.compactor.onTurnQueued("c1", TARGET);
      expect(p.ctl.seen?.signal?.aborted).toBe(true);
      await c.settle();
      expect(c.compactor.hasPrecompute("c1")).toBe(false);
      expect(c.notify).not.toHaveBeenCalled();
      expect(a.ask).not.toHaveBeenCalled();
    },
  );

  it("onTurn wait: an in-flight precompute runs on and the waiting turn adopts it on a warm cache", async () => {
    const p = driven();
    const c = makeCompactor({ compactChat: p.compactChat });
    await start(c, p.ctl);
    expect(p.ctl.seen?.timeoutMs).toBe(5 * 60 * 1000);
    p.ctl.seen?.onRequestSent?.();

    c.compactor.onTurnQueued("c1", TARGET);
    c.compactor.onTurnQueued("c1", TARGET); // a second turn: no second message
    expect(p.ctl.seen?.signal?.aborted).toBe(false);
    expect(c.notify).toHaveBeenCalledTimes(1);
    expect(c.notify).toHaveBeenCalledWith(TARGET, IDLE_COMPACT_TEXT.waiting);

    p.ctl.finish();
    await c.settle();
    expect(Date.now()).toBeLessThan(T0 + HOUR); // still warm
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(store.setSessionId).toHaveBeenCalledWith("c1", "fork-1");
    expect(c.discardSession).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.applied",
    );
  });

  it("onTurn wait: an in-flight in-place pass completes before the turn", async () => {
    const p = driven();
    const c = makeCompactor({ mode: "in-place", compactChat: p.compactChat });
    await start(c, p.ctl);
    p.ctl.seen?.onRequestSent?.();
    c.compactor.onTurnQueued("c1", TARGET);
    expect(p.ctl.seen?.signal?.aborted).toBe(false);
    p.ctl.finish(compacted({ sessionId: "sess-1" }));
    await c.settle();
    expect(store.recordSessionCompaction).toHaveBeenLastCalledWith("c1", {
      contextTokens: 9_000,
    });
  });

  it("onTurn wait: a pass that fails (or times out) leaves the turn on the unchanged session", async () => {
    const p = driven();
    const c = makeCompactor({ compactChat: p.compactChat });
    await start(c, p.ctl);
    p.ctl.seen?.onRequestSent?.();
    c.compactor.onTurnQueued("c1", TARGET);
    p.ctl.finish({ status: "failed", error: "timed out after 300000ms" });
    await c.settle();
    expect(c.compactor.hasPrecompute("c1")).toBe(false);
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(store.setSessionId).not.toHaveBeenCalled();
    expect(session.sessionId).toBe("sess-1");
  });

  it.each(["precompute", "in-place"] as const)(
    "onTurn abort: an in-flight %s pass is aborted (in place: before its boundary)",
    async (mode) => {
      const p = driven();
      const c = makeCompactor({
        mode,
        onTurn: "abort",
        compactChat: p.compactChat,
      });
      await start(c, p.ctl);
      p.ctl.seen?.onRequestSent?.();
      c.compactor.onTurnQueued("c1", TARGET);
      expect(p.ctl.seen?.signal?.aborted).toBe(true);
      await c.settle();
      expect(c.compactor.hasPrecompute("c1")).toBe(false);
      expect(c.notify).not.toHaveBeenCalled();
      expect(store.setSessionId).not.toHaveBeenCalled();
    },
  );

  it("onTurn ask: a click on [Stop] aborts the in-flight pass", async () => {
    const p = driven();
    const a = fakeAsk("abort");
    const c = makeCompactor({
      onTurn: "ask",
      compactChat: p.compactChat,
      ask: a.ask,
    });
    await start(c, p.ctl);
    p.ctl.seen?.onRequestSent?.();
    c.compactor.onTurnQueued("c1", TARGET);
    expect(a.ask).toHaveBeenCalledWith(
      TARGET,
      expect.objectContaining({
        text: IDLE_COMPACT_TEXT.ask,
        buttons: [
          { id: "wait", label: "Wait" },
          { id: "abort", label: "Stop" },
        ],
      }),
    );
    await vi.waitFor(() => expect(p.ctl.seen?.signal?.aborted).toBe(true));
    await c.settle();
    expect(a.update).toHaveBeenCalledWith(IDLE_COMPACT_TEXT.aborted);
    expect(c.compactor.hasPrecompute("c1")).toBe(false);
  });

  it("onTurn ask: a click on [Wait] waits and adopts the fork", async () => {
    const p = driven();
    const a = fakeAsk("wait");
    const c = makeCompactor({
      onTurn: "ask",
      compactChat: p.compactChat,
      ask: a.ask,
    });
    await start(c, p.ctl);
    p.ctl.seen?.onRequestSent?.();
    c.compactor.onTurnQueued("c1", TARGET);
    await vi.waitFor(() =>
      expect(a.update).toHaveBeenCalledWith(IDLE_COMPACT_TEXT.waiting),
    );
    expect(p.ctl.seen?.signal?.aborted).toBe(false);
    p.ctl.finish();
    await c.settle();
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(store.setSessionId).toHaveBeenCalledWith("c1", "fork-1");
  });

  it("onTurn ask: no click within 30 s applies wait", async () => {
    const p = driven();
    const a = fakeAsk();
    const c = makeCompactor({
      onTurn: "ask",
      compactChat: p.compactChat,
      ask: a.ask,
    });
    await start(c, p.ctl);
    p.ctl.seen?.onRequestSent?.();
    c.compactor.onTurnQueued("c1", TARGET);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(a.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.signals[0]?.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(a.update).toHaveBeenCalledWith(IDLE_COMPACT_TEXT.waiting),
    );
    expect(p.ctl.seen?.signal?.aborted).toBe(false);
    p.ctl.finish();
    await c.settle();
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(store.setSessionId).toHaveBeenCalledWith("c1", "fork-1");
  });

  it("onTurn ask: the pass finishing first ends the question", async () => {
    const p = driven();
    const a = fakeAsk();
    const c = makeCompactor({
      onTurn: "ask",
      compactChat: p.compactChat,
      ask: a.ask,
    });
    await start(c, p.ctl);
    p.ctl.seen?.onRequestSent?.();
    c.compactor.onTurnQueued("c1", TARGET);
    await vi.waitFor(() => expect(a.signals).toHaveLength(1));
    p.ctl.finish();
    await c.settle();
    await vi.waitFor(() =>
      expect(a.update).toHaveBeenCalledWith(IDLE_COMPACT_TEXT.done),
    );
  });

  it("onTurn ask: a frontend without buttons falls back to wait", async () => {
    const p = driven();
    const ask = vi.fn<NonNullable<IdleCompactorDeps["ask"]>>(
      async () => undefined,
    );
    const c = makeCompactor({ onTurn: "ask", compactChat: p.compactChat, ask });
    await start(c, p.ctl);
    p.ctl.seen?.onRequestSent?.();
    c.compactor.onTurnQueued("c1", TARGET);
    await vi.waitFor(() =>
      expect(c.notify).toHaveBeenCalledWith(TARGET, IDLE_COMPACT_TEXT.waiting),
    );
    expect(p.ctl.seen?.signal?.aborted).toBe(false);
    p.ctl.finish();
    await c.settle();
    expect(c.compactor.hasPrecompute("c1")).toBe(true);
  });
});

describe("IdleCompactor: review fixes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 30_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const TARGET = { chatId: "c1", numericChatId: 1 };

  /** A pass whose request is sent at fire time, as the real backend reports. */
  const sentThenCompacted =
    (over: Partial<SessionCompactResult> = {}): CompactFn =>
    async (_id, opts) => {
      opts?.onRequestSent?.();
      return compacted(over);
    };

  it("keeps the source while the pass's own cache read keeps it warm", async () => {
    const c = makeCompactor({ compactChat: sentThenCompacted() });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();

    // Past lastRequestAt + TTL, but within the pass's send time + TTL.
    vi.setSystemTime(T0 + HOUR + 10 * 60_000);
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(store.setSessionId).not.toHaveBeenCalled();
    expect(c.discardSession).toHaveBeenCalledWith("fork-1");
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.discarded.returned_early",
    );
  });

  it("adopts the fork once the refreshed cache has expired too", async () => {
    const c = makeCompactor({ compactChat: sentThenCompacted() });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();

    vi.setSystemTime(FIRE_AT + HOUR + 1_000);
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(store.setSessionId).toHaveBeenCalledWith("c1", "fork-1");
  });

  it("keeps lastRequestAt + TTL when the pass did not read the cache", async () => {
    const c = makeCompactor({
      compactChat: sentThenCompacted({
        usage: {
          inputTokens: 300_000,
          outputTokens: 900,
          cacheRead: 0,
          cacheWrite: 300_000,
        },
      } as Partial<SessionCompactResult>),
    });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();

    vi.setSystemTime(T0 + HOUR + 1_000);
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(store.setSessionId).toHaveBeenCalledWith("c1", "fork-1");
  });

  it("counts a fork as a compaction only when a turn adopts it", async () => {
    const c = makeCompactor({ compactChat: sentThenCompacted() });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();
    expect(metrics.incrementCounter).not.toHaveBeenCalledWith(
      "session.compacted.manual",
    );

    vi.setSystemTime(FIRE_AT + HOUR + 1_000);
    await c.compactor.beforeTurn("c1", "opus-x");
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.compacted.manual",
    );
    expect(metrics.recordHistogram).toHaveBeenCalledWith(
      "session.compact.pre_tokens",
      300_000,
    );
  });

  it("a background turn mid-pass waits silently; a later user turn is still told", async () => {
    let finish: (r: SessionCompactResult) => void = () => {};
    let seen: SessionCompactOptions | undefined;
    const ask = vi.fn<NonNullable<IdleCompactorDeps["ask"]>>();
    const c = makeCompactor({
      onTurn: "ask",
      ask,
      compactChat: (_id, opts) =>
        new Promise((resolve) => {
          seen = opts;
          finish = resolve;
        }),
    });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await vi.waitFor(() => expect(seen).toBeDefined());
    seen?.onRequestSent?.();

    for (const source of ["trigger", "agent", "pulse"] as const) {
      c.compactor.onTurnQueued("c1", TARGET, source);
    }
    expect(seen?.signal?.aborted).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(c.notify).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.turn_background_wait",
    );

    ask.mockResolvedValue(undefined); // no buttons: falls back to the status line
    c.compactor.onTurnQueued("c1", TARGET, "message");
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));

    finish(compacted());
    await c.settle();
  });

  it("stops arming a backend that answered unsupported", async () => {
    const c = makeCompactor({
      compactChat: async () => ({
        status: "unsupported",
        reason: "the Claude CLI does not offer /compact",
      }),
    });
    c.compactor.onTurnSettled("c1");
    await vi.advanceTimersByTimeAsync(FIRE_AT - Date.now());
    await c.settle();
    expect(c.compactChat).toHaveBeenCalledTimes(1);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "session.idle_compact.unsupported",
    );

    vi.setSystemTime(T0 + 30_000);
    c.compactor.onTurnSettled("c1");
    expect(c.compactor.isArmed("c1")).toBe(false);
  });
});

describe("WarmCompactTimers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps one timer per chat; re-arming replaces, cancel clears", () => {
    const timers = new WarmCompactTimers();
    const first = vi.fn();
    const second = vi.fn();
    timers.schedule("c1", 1_000, first);
    timers.schedule("c1", 2_000, second);
    vi.advanceTimersByTime(1_500);
    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(second).toHaveBeenCalledOnce();
    expect(timers.has("c1")).toBe(false);

    timers.schedule("c1", 1_000, first);
    timers.cancel("c1");
    vi.advanceTimersByTime(2_000);
    expect(first).not.toHaveBeenCalled();
  });
});
