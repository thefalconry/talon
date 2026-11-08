/**
 * Heartbeat scheduling + lifecycle — init, the cadence timer (Gleam
 * scheduler-core driven, restart/suspend-safe), the one-at-a-time run guard,
 * and the force/await/status public API.
 */

import { log, logError, logWarn } from "../../../util/log.js";
import { faultText } from "../../engine/fault-text.js";
import {
  catchupRunCount,
  missedRunCount,
  nextDueMs,
} from "../../../native/scheduler-core.js";
import {
  hb,
  readHeartbeatState,
  writeHeartbeatState,
  type HeartbeatConfig,
  type HeartbeatState,
} from "./state.js";
import { HeartbeatTimeoutError, runHeartbeatAgent } from "./agent.js";

const STARTUP_DELAY_MS = 5 * 60 * 1000; // 5-minute delay before first run
const DUE_CHECK_INTERVAL_MS = 60 * 1000;

export function initHeartbeat(cfg: HeartbeatConfig): void {
  hb.config = cfg;
}

/**
 * Start the heartbeat timer. First run happens after a 5-minute startup delay,
 * then repeats at the configured interval.
 */
export function startHeartbeatTimer(intervalMinutes: number): void {
  if (hb.timer || hb.startupTimer) return; // already running or scheduled

  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    logWarn(
      "heartbeat",
      `Refusing to start heartbeat timer with invalid intervalMinutes: ${intervalMinutes}`,
    );
    return;
  }

  hb.intervalMinutesRef = intervalMinutes;
  const intervalMs = intervalMinutes * 60 * 1000;
  log(
    "heartbeat",
    `Starting heartbeat timer (every ${intervalMinutes}min, first due check in 5min)`,
  );

  hb.startupTimer = setTimeout(() => {
    hb.startupTimer = null;
    runIfDue(intervalMs, true);
    // Due checks every minute instead of one fixed setInterval(intervalMs):
    // the cadence is computed from persisted last_run via the Gleam scheduler
    // core, so it survives process restarts (a quick restart no longer resets
    // the phase or double-fires) and system suspends (any number of missed
    // fire times collapses into one catch-up run).
    hb.timer = setInterval(() => {
      runIfDue(intervalMs, false);
    }, DUE_CHECK_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

/**
 * Fire the heartbeat when its cadence says one (or more) runs are due. Decision
 * logic is the Gleam scheduler core: `missedRunCount` counts fire times in
 * (last_run, now], and the "once" catch-up policy collapses them into one run.
 */
function runIfDue(intervalMs: number, startup: boolean): void {
  if (hb.running) return;
  // Inside a failure backoff window — stay quiet instead of re-firing the
  // same error every due check. (Logged once, when the window was set.)
  if (hb.failureBackoff.active()) return;
  const lastRun = readHeartbeatState()?.last_run ?? 0;
  if (lastRun <= 0) {
    // Never ran on this install — fire now to establish the cadence.
    executeHeartbeat("auto").catch(() => {});
    return;
  }
  const now = Date.now();
  const missed = missedRunCount(lastRun, intervalMs, now);
  if (catchupRunCount(missed, "once", 1) > 0) {
    executeHeartbeat("auto").catch(() => {});
  } else if (startup) {
    log(
      "heartbeat",
      `Cadence restored from state — next heartbeat due ${new Date(nextDueMs(lastRun, intervalMs, now)).toISOString()}`,
    );
  }
}

/**
 * Stop the heartbeat timer. Does not wait for in-flight runs. Use
 * awaitCurrentRun() after this to wait for a running heartbeat to finish.
 */
export function stopHeartbeatTimer(): void {
  if (hb.startupTimer) {
    clearTimeout(hb.startupTimer);
    hb.startupTimer = null;
  }
  if (hb.timer) {
    clearInterval(hb.timer);
    hb.timer = null;
    log("heartbeat", "Heartbeat timer stopped");
  }
}

/**
 * Wait for any in-flight heartbeat run to complete.
 * Call after stopHeartbeatTimer() during graceful shutdown.
 */
export async function awaitCurrentRun(timeoutMs = 10_000): Promise<void> {
  if (hb.currentRunPromise) {
    log("heartbeat", "Waiting for in-flight heartbeat to complete...");
    try {
      await Promise.race([
        hb.currentRunPromise,
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            logWarn(
              "heartbeat",
              "In-flight heartbeat did not finish within shutdown budget, proceeding",
            );
            resolve();
          }, timeoutMs);
          t.unref();
        }),
      ]);
    } catch {
      // Already logged in executeHeartbeat
    }
  }
}

/**
 * Force a heartbeat run immediately. Resolves when the heartbeat completes.
 * Throws if a heartbeat is already running.
 */
export async function forceHeartbeat(): Promise<void> {
  if (hb.running) throw new Error("Heartbeat already running");
  await executeHeartbeat("forced");
}

/** Get the current heartbeat status. */
export function getHeartbeatStatus(): HeartbeatState | null {
  return readHeartbeatState();
}

/** Arm the failure backoff so the due check stops re-firing for a while. */
function backOff(err: unknown): void {
  const until = hb.failureBackoff.fail(err);
  logWarn(
    "heartbeat",
    `heartbeat.backoff failures=${hb.failureBackoff.failures} ` +
      `until=${new Date(until).toISOString()} error="${faultText(err)}"`,
  );
}

async function executeHeartbeat(trigger: "auto" | "forced"): Promise<void> {
  if (hb.running) return;

  const state = readHeartbeatState();
  const now = Date.now();
  const previousRunCount = state?.run_count ?? 0;
  const previousLastRun = state?.last_run ?? 0;

  hb.running = true;
  // Mark as running with last_started, but preserve last_run from previous run
  writeHeartbeatState({
    last_run: previousLastRun,
    last_started: now,
    status: "running",
    run_count: previousRunCount,
  });
  log(
    "heartbeat",
    `${trigger === "forced" ? "Force-triggering" : "Triggering"} heartbeat #${previousRunCount + 1} (last run: ${previousLastRun ? new Date(previousLastRun).toISOString() : "never"})`,
  );

  const run = (async () => {
    try {
      const heartbeatLogPath = await runHeartbeatAgent(
        previousLastRun,
        previousRunCount + 1,
      );
      // Only update last_run and increment run_count on success
      const persisted = writeHeartbeatState({
        last_run: Date.now(),
        last_started: now,
        status: "idle",
        run_count: previousRunCount + 1,
      });
      // A run whose last_run didn't stick looks overdue to the next due
      // check, which would run the whole agent again every minute.
      if (persisted) hb.failureBackoff.succeed();
      else backOff(new Error("heartbeat state was not persisted"));
      log(
        "heartbeat",
        `Heartbeat #${previousRunCount + 1} complete (${trigger}), log: ${heartbeatLogPath}`,
      );
    } catch (err) {
      logError(
        "heartbeat",
        `Heartbeat #${previousRunCount + 1} failed (${trigger})`,
        err,
      );
      // Timeouts consume the full hour budget — advance state so the next
      // heartbeat sees a fresh window and a bumped run_count instead of
      // re-triggering against the same `last_run` forever. Non-timeout errors
      // retry from the previous successful run (no budget consumed).
      const isTimeout = err instanceof HeartbeatTimeoutError;
      const persisted = writeHeartbeatState({
        last_run: isTimeout ? Date.now() : previousLastRun,
        last_started: now,
        status: "idle",
        run_count: isTimeout ? previousRunCount + 1 : previousRunCount,
      });
      // Timeouts advance last_run (budget consumed), so the cadence itself
      // spaces the next attempt — if that write landed. Every other failure
      // retries against the same last_run — back off so the due check
      // doesn't hammer it every minute.
      if (!isTimeout || !persisted) backOff(err);
      if (trigger === "forced") throw err;
    } finally {
      hb.running = false;
      hb.currentRunPromise = null;
    }
  })();

  hb.currentRunPromise = run;
  await run;
}
