/**
 * Backend circuit breaker — "is this backend actually working right now?"
 *
 * Headroom answers "how much plan is left". It says nothing about whether
 * runs on the backend succeed. In Sep 2026 Codex's login expired and its
 * default model was retired, so every run on it failed. Codex still had no
 * usage signal and read as 100% headroom, and the router kept sending
 * background work there for 36 hours. This module holds the missing
 * signal, fed by the outcome of every routed run:
 *
 *   - an auth failure (401, expired login, "run `… login`") opens the
 *     breaker at once: the next run is not going to fix a credential;
 *   - {@link BREAKER_FAILURE_THRESHOLD} consecutive failures of any other
 *     kind open it too;
 *   - a success closes it and clears the count.
 *
 * An open breaker reads as zero headroom (see `headroom.ts`) until its
 * cool-off ends. After that the backend is half-open: it can win again,
 * and one more failure without a success in between re-opens it straight
 * away with twice the cool-off, capped at {@link BREAKER_MAX_COOLOFF_MS}.
 *
 * State lives in memory only. A restart gives every backend a fresh
 * chance, which is what an operator who just ran `codex login` and
 * restarted expects.
 */

import { logWarn } from "../../../util/log.js";

/** Consecutive non-auth failures that open the breaker. */
export const BREAKER_FAILURE_THRESHOLD = 3;
/** First cool-off. Each re-trip without a success in between doubles it. */
export const BREAKER_BASE_COOLOFF_MS = 15 * 60_000;
/** Ceiling on the cool-off. */
export const BREAKER_MAX_COOLOFF_MS = 4 * 60 * 60_000;

interface BreakerState {
  /** Failures since the last success. */
  consecutive: number;
  /** Times the breaker has opened since the last success. */
  trips: number;
  /** Epoch ms the current cool-off ends; undefined when never opened. */
  openUntil?: number;
  /** Why it last opened. */
  reason?: string;
}

/** An open breaker, as `headroom.ts` and the router log see it. */
export interface OpenBreaker {
  readonly reason: string;
  /** Epoch ms the cool-off ends. */
  readonly until: number;
}

const breakers = new Map<string, BreakerState>();

/**
 * Credential failures, not model or transport ones. Covers what the
 * backends actually say: HTTP 401, Codex's "refresh token" / "login
 * expired" wording, agy's "authentication required", and any "run
 * `x login`" remedy.
 */
const AUTH_FAILURE_RE =
  /\b401\b|unauthori[sz]ed|authentication (?:required|failed)|not (?:logged|signed) in|log(?:in|ged in) (?:has )?expired|refresh[_ ]token|invalid[_ ](?:api[_ ])?key|run [`'"]?[\w-]+ login/i;

/** Whether an error message describes a credential problem. */
export function isAuthFailureMessage(message: string): boolean {
  return AUTH_FAILURE_RE.test(message);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A run the caller cancelled says nothing about the backend. A timeout
 * does count: a backend that hangs is as unusable as one that errors.
 */
function isCallerAbort(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  return /aborted before the run started/i.test(messageOf(err));
}

function stateFor(id: string): BreakerState {
  let state = breakers.get(id);
  if (!state) {
    state = { consecutive: 0, trips: 0 };
    breakers.set(id, state);
  }
  return state;
}

function open(id: string, state: BreakerState, reason: string, now: number) {
  state.trips += 1;
  const cooloff = Math.min(
    BREAKER_BASE_COOLOFF_MS * 2 ** (state.trips - 1),
    BREAKER_MAX_COOLOFF_MS,
  );
  state.openUntil = now + cooloff;
  state.reason = reason;
  logWarn(
    "router",
    `breaker open for ${id} (${reason}) — no routed work for ` +
      `${Math.round(cooloff / 60_000)}m`,
  );
}

/** Record a failed run on a backend. */
export function recordBackendRunFailure(
  id: string,
  err: unknown,
  now = Date.now(),
): void {
  if (isCallerAbort(err)) return;
  const state = stateFor(id);
  state.consecutive += 1;
  const message = messageOf(err).split("\n")[0]?.trim().slice(0, 160) ?? "";
  // Already open: a failure in the cool-off (a pinned run, say) must not
  // stretch it.
  if (state.openUntil !== undefined && now < state.openUntil) return;
  if (isAuthFailureMessage(message)) {
    open(id, state, `auth failure: ${message}`, now);
    return;
  }
  // Half-open (tripped before, no success since): the probe failed, so
  // re-open at once rather than waiting for a fresh run of failures.
  if (state.trips > 0) {
    open(id, state, `still failing after cool-off: ${message}`, now);
    return;
  }
  if (state.consecutive >= BREAKER_FAILURE_THRESHOLD) {
    open(
      id,
      state,
      `${state.consecutive} consecutive failures: ${message}`,
      now,
    );
  }
}

/** Record a successful run: the backend works, forget its failures. */
export function recordBackendRunSuccess(id: string): void {
  breakers.delete(id);
}

/** The breaker, when it is open at `now`; undefined when the backend may run. */
export function openBreaker(
  id: string,
  now = Date.now(),
): OpenBreaker | undefined {
  const state = breakers.get(id);
  if (!state?.openUntil || now >= state.openUntil) return undefined;
  return { reason: state.reason ?? "failing", until: state.openUntil };
}

/** Test seam — close every breaker. */
export function resetBackendBreakersForTest(): void {
  breakers.clear();
}
