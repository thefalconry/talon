/**
 * No-progress watchdog for a sub-agent run.
 *
 * Replaces the old "everyone gets a 15-minute hard cap" safety net with one
 * that only fires on an agent that has actually gone quiet. With
 * `stallMs = N`, measured from the last sign of life (a run-log line or an
 * assistant text — see `RunTrail`):
 *
 *   - after N   → the agent is pinged (a message in its own mailbox);
 *   - after 2N  → its parent is told, so it can intervene or kill early;
 *   - after 3N  → the run is aborted and settles as `timed_out` ("stalled").
 *
 * Any activity resets the ladder. The watchdog owns one unref'd interval and
 * nothing else; every action is a callback, so it is trivially testable.
 */

export interface WatchdogActions {
  /** Last sign of life, epoch ms. */
  readonly lastActivityAt: () => number;
  readonly pingAgent: (idleMs: number) => void;
  readonly warnParent: (idleMs: number, killInMs: number) => void;
  readonly kill: (idleMs: number) => void;
}

export interface WatchdogHandle {
  stop(): void;
  /** Evaluate now — exposed for tests; the interval calls it too. */
  check(now?: number): void;
}

/** Start a watchdog. `stallMs <= 0` returns an inert handle. */
export function startWatchdog(
  stallMs: number,
  actions: WatchdogActions,
  checkEveryMs: number = Math.max(1_000, Math.min(60_000, stallMs / 4)),
): WatchdogHandle {
  if (!(stallMs > 0)) return { stop: () => {}, check: () => {} };
  // 0 = quiet, 1 = pinged, 2 = parent warned, 3 = killed.
  let stage = 0;
  let stageAnchor = actions.lastActivityAt();

  const check = (now: number = Date.now()): void => {
    if (stage >= 3) return;
    const last = actions.lastActivityAt();
    if (last !== stageAnchor) {
      // Signs of life since the last escalation — start over.
      stageAnchor = last;
      stage = 0;
    }
    const idle = now - last;
    if (stage < 1 && idle >= stallMs) {
      stage = 1;
      actions.pingAgent(idle);
    }
    if (stage < 2 && idle >= 2 * stallMs) {
      stage = 2;
      actions.warnParent(idle, Math.max(0, 3 * stallMs - idle));
    }
    if (stage < 3 && idle >= 3 * stallMs) {
      stage = 3;
      actions.kill(idle);
      stop();
    }
  };

  const timer = setInterval(() => check(), checkEveryMs);
  timer.unref();
  const stop = (): void => clearInterval(timer);
  return { stop, check };
}
