/**
 * Watchdog -- tracks bot health and recent errors.
 * Monitors message processing activity and bridge HTTP server responsiveness.
 */

import { existsSync, mkdirSync } from "node:fs";
import { logWarn } from "./log.js";

// ── Message processing tracking ──────────────────────────────────────────────

let lastProcessedAt = Date.now();
let lastReceivedAt = 0;
let lastActivityAt = 0;
let totalMessagesProcessed = 0;
const startTime = Date.now();

/**
 * Record that a message ARRIVED (enqueued for processing). Paired with
 * `recordMessageProcessed`, this is what lets the watchdog tell a wedged
 * message loop (work arrived, nothing finishing) apart from a bot that's
 * simply idle because nobody is talking to it. Idle is not a fault.
 */
export function recordMessageReceived(): void {
  lastReceivedAt = Date.now();
}

/** Record that a message was successfully processed. */
export function recordMessageProcessed(): void {
  lastProcessedAt = Date.now();
  totalMessagesProcessed++;
  resetStuckWarnBackoff();
}

/**
 * Record that a running turn showed signs of life: a backend event (tool
 * call, text delta, result) flowed through the shuttle. A long agentic
 * turn is not a wedged loop — an hour-long grind that keeps calling tools
 * used to trip the stuck warning at the 10-minute mark and re-warn on
 * backoff until it finished, because `lastProcessedAt` only advances at
 * turn end. Stuck detection measures silence since the last event, not
 * turn length.
 */
export function recordTurnActivity(): void {
  lastActivityAt = Date.now();
  resetStuckWarnBackoff();
}

/**
 * Record that a message's turn settled in failure. The loop is moving —
 * the error was reported and the queue slot freed — so advance the stuck
 * clock without counting a success. Without this, one failed turn leaves
 * `lastProcessedAt` stale forever and the watchdog reports a wedged loop
 * (and an unhealthy bridge) on a bot that is actually idle.
 */
export function recordMessageSettled(): void {
  lastProcessedAt = Date.now();
  resetStuckWarnBackoff();
}

/**
 * Test-only: reset the activity clocks to "just processed, nothing pending"
 * at the CURRENT Date.now(). Fake-timer suites need this because each test
 * restarts its fake clock at the real now, while timestamps recorded by an
 * earlier test may sit hours into that test's own fake future.
 */
export function resetWatchdogActivityForTests(): void {
  lastProcessedAt = Date.now();
  lastReceivedAt = 0;
  lastActivityAt = 0;
  resetStuckWarnBackoff();
}

/**
 * How long the newest RECEIVED message has been waiting with no processing
 * completed after it AND no turn activity since. Zero when idle, keeping
 * up, or mid-turn with events still flowing.
 */
function stuckMs(now: number): number {
  if (lastReceivedAt === 0 || lastReceivedAt <= lastProcessedAt) return 0;
  return now - Math.max(lastReceivedAt, lastActivityAt);
}

/** How long the newest RECEIVED message has been waiting for completion. */
function pendingMs(now: number): number {
  return now - lastReceivedAt;
}

/** Get total messages processed since startup. */
export function getTotalMessagesProcessed(): number {
  return totalMessagesProcessed;
}

/** Get bot uptime in milliseconds. */
export function getUptimeMs(): number {
  return Date.now() - startTime;
}

// ── Error tracking ───────────────────────────────────────────────────────────

type ErrorRecord = {
  message: string;
  timestamp: number;
};

const recentErrors: ErrorRecord[] = [];
const MAX_ERRORS = 20;

/** Record an error for admin visibility. */
export function recordError(message: string): void {
  recentErrors.push({ message, timestamp: Date.now() });
  if (recentErrors.length > MAX_ERRORS) {
    recentErrors.splice(0, recentErrors.length - MAX_ERRORS);
  }
}

/** Get the last N errors. */
export function getRecentErrors(limit = 5): ErrorRecord[] {
  return recentErrors.slice(-limit);
}

// ── Inactivity monitoring ────────────────────────────────────────────────────

const STUCK_WARN_MS = 10 * 60 * 1000; // 10 minutes with unprocessed work
const STUCK_WARN_MAX_BACKOFF_MS = 60 * 60 * 1000;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let stuckWarnBackoffMs = STUCK_WARN_MS;
let nextStuckWarnAt = 0;

/**
 * Who hears about a wedged loop beyond the log. util is a leaf, so the
 * engine registers this (it raises the operator alert and knows what is
 * queued); the watchdog only says when it starts and when it ends.
 */
export type StuckLoopListener = {
  onStuck(info: { pendingMins: number; silentMins: number }): void;
  onRecovered(): void;
};
let stuckListener: StuckLoopListener | null = null;
let stuckReported = false;

export function setStuckLoopListener(listener: StuckLoopListener | null): void {
  stuckListener = listener;
}

function resetStuckWarnBackoff(): void {
  stuckWarnBackoffMs = STUCK_WARN_MS;
  nextStuckWarnAt = 0;
  if (stuckReported) {
    stuckReported = false;
    try {
      stuckListener?.onRecovered();
    } catch {
      /* a listener fault must not break turn bookkeeping */
    }
  }
}

export function startWatchdog(workspaceDir?: string): void {
  if (watchdogTimer) return;

  watchdogTimer = setInterval(() => {
    // Warn only when work is actually stuck — a message arrived, nothing
    // has finished processing since, and the turn has gone silent (no
    // backend events) for the threshold. A quiet chat used to trip this
    // every minute all night ("No messages processed for N minutes"), and a
    // long tool-calling turn used to trip it at the 10-minute mark; both
    // buried real warnings in noise. Repeat warnings back off exponentially.
    const now = Date.now();
    const stuck = stuckMs(now);
    if (stuck > STUCK_WARN_MS && now >= nextStuckWarnAt) {
      const silentMins = Math.round(stuck / 60000);
      const pendingMins = Math.round(pendingMs(now) / 60000);
      logWarn(
        "watchdog",
        `Message received ${pendingMins} minutes ago is still unprocessed with no turn activity for ${silentMins} minutes — the message loop may be wedged`,
      );
      stuckReported = true;
      try {
        stuckListener?.onStuck({ pendingMins, silentMins });
      } catch (err) {
        logWarn("watchdog", `stuck-loop listener failed: ${String(err)}`);
      }
      nextStuckWarnAt = now + stuckWarnBackoffMs;
      stuckWarnBackoffMs = Math.min(
        stuckWarnBackoffMs * 2,
        STUCK_WARN_MAX_BACKOFF_MS,
      );
    }

    // Ensure workspace still exists (might have been deleted externally)
    if (workspaceDir && !existsSync(workspaceDir)) {
      logWarn("watchdog", "Workspace directory missing — recreating");
      try {
        mkdirSync(workspaceDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  }, 60_000); // Check every minute
}

export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

// ── Health check ─────────────────────────────────────────────────────────────

export type HealthStatus = {
  healthy: boolean;
  uptimeMs: number;
  totalMessagesProcessed: number;
  lastProcessedAt: number;
  msSinceLastMessage: number;
  recentErrorCount: number;
};

/** Get current health status (exportable for external monitoring). */
export function getHealthStatus(): HealthStatus {
  const now = Date.now();
  const msSinceLastMessage = now - lastProcessedAt;
  return {
    // Unhealthy only when the message loop is actually stuck: a received
    // message has gone 30+ minutes with no processing completing after it.
    // Mere idleness (nobody texting the bot) used to flip this false and
    // show a red "unhealthy" row in the companion diagnostics overnight.
    healthy: stuckMs(now) < 30 * 60_000,
    uptimeMs: now - startTime,
    totalMessagesProcessed,
    lastProcessedAt,
    msSinceLastMessage,
    recentErrorCount: recentErrors.length,
  };
}
