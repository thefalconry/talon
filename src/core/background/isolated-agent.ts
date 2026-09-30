/**
 * Generic isolated one-shot agent runner.
 *
 * Runs a `background.runOneShotAgent` under a hard timeout with the same
 * abort → bounded-grace → (optional) orphan-eviction discipline heartbeat uses,
 * so any unattended one-shot (heartbeat, dream, decoupled jobs) gets robust
 * cancellation instead of hand-rolling it per caller.
 *
 * Flow: race the agent against a timeout. On timeout, abort the controller and
 * give the backend a bounded grace window to honour it; if it doesn't, optionally
 * ask the backend to evict orphan subprocesses (Linux /proc sweep). Eviction is
 * opt-in via `evictLabel` because it matches subprocesses by an env tag — a
 * caller that shares a tag with another context (e.g. heartbeat) should leave it
 * unset to avoid sweeping the other context's subprocesses.
 */

import type { BackgroundRunner } from "../agent-runtime/capabilities.js";
import type { OneShotAgentParams, OneShotUsage } from "../types.js";
import { logWarn, logError, type LogComponent } from "../../util/log.js";

/** Default bounded grace after an abort before giving up on the backend. */
const DEFAULT_ABORT_GRACE_MS = 30 * 1000;

/**
 * Thrown when the hard timeout fires. A distinct class (rather than a string
 * match on the message) so a caller can tell "ran out of wall-clock" apart
 * from "the backend failed" and settle its own state accordingly.
 */
export class IsolatedAgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`isolated agent timed out after ${timeoutMs}ms`);
    this.name = "IsolatedAgentTimeoutError";
  }
}

export interface IsolatedRunOptions {
  readonly background: BackgroundRunner;
  /** Fully-built one-shot params (must carry an `abortController`). */
  readonly params: OneShotAgentParams;
  /** Hard timeout before the run is aborted. */
  readonly timeoutMs: number;
  /** Bounded grace for the backend to honour the abort (default 30s). */
  readonly abortGraceMs?: number;
  /**
   * When set, evict orphan subprocesses carrying this context tag if the backend
   * ignores the abort. Leave unset when the tag is shared with another context.
   */
  readonly evictLabel?: string;
  /** Log category for the abort/eviction diagnostics (default "triggers"). */
  readonly logCategory?: LogComponent;
}

/**
 * Resolves to the value, or the string "timed_out" if `ms` elapses first.
 * A rejection of `promise` inside the window propagates — `.catch()` it
 * first for a never-throwing race.
 */
export async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | "timed_out"> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    handle = setTimeout(() => resolve("timed_out"), ms);
    handle.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

/**
 * Run the one-shot under a hard timeout. Throws on timeout (after the grace
 * window) and re-throws any agent error. Resolves with the run's token
 * usage when the backend reports it.
 */
export async function runIsolatedAgent(
  opts: IsolatedRunOptions,
): Promise<OneShotUsage | void> {
  const { background, params, timeoutMs } = opts;
  const graceMs = opts.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  const category = opts.logCategory ?? "triggers";

  // Doubles as the "did we time out?" flag: set before the abort, so a
  // backend that rejects synchronously from its abort handler can't make the
  // run look like an ordinary failure.
  let timeoutError: IsolatedAgentTimeoutError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const agentPromise = background.runOneShotAgent(params);

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutError = new IsolatedAgentTimeoutError(timeoutMs);
      try {
        params.abortController.abort(timeoutError);
      } catch {
        /* ignore */
      }
      reject(timeoutError);
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([agentPromise, timeoutPromise]);
  } catch (err) {
    // Snapshot + clear before any await so a late timer can't reclassify a
    // non-timeout failure as a timeout (heartbeat learned this the hard way).
    const wasTimeout = timeoutError;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!wasTimeout) {
      await agentPromise.catch(() => {});
      throw err;
    }
    const settled = await raceWithTimeout(
      agentPromise.catch(() => "settled"),
      graceMs,
    );
    if (settled === "timed_out" && opts.evictLabel) {
      const evict = background.evictOrphanSubprocesses;
      if (evict) {
        evict(opts.evictLabel).catch((sweepErr: unknown) => {
          logError(category, "orphan subprocess sweep failed", sweepErr);
        });
      } else {
        logWarn(category, "backend ignored abort and has no eviction hook");
      }
    }
    // A backend that honours the abort rejects with its own error, which can
    // win the race against the timeout's rejection. The run still ran out of
    // wall-clock, so that is what the caller is told either way.
    throw wasTimeout;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
