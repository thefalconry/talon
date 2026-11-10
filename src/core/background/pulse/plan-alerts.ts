/**
 * Plan rate-limit warnings.
 *
 * Off unless `planAlerts` is enabled. Polls the subscription's windows on a
 * timer and messages the admin chat the first time one crosses the
 * threshold, so a long background run doesn't walk into the ceiling
 * unannounced.
 *
 * One message per window per reset cycle: the reset timestamp identifies the
 * cycle, and a window that drops back under the threshold re-arms (which is
 * also what covers windows the plan reports no reset for).
 */

import { getPooledBackend } from "../../engine/backend-controller/index.js";
import { log, logWarn } from "../../../util/log.js";
import { formatSmartTimestamp } from "../../../util/time.js";
import { listClaudeAccounts } from "../../config/claude-accounts.js";

const CHECK_INTERVAL_MS = 5 * 60_000;

export interface PlanAlertDeps {
  sendMessage: (
    chatId: number,
    text: string,
    stringId?: string,
  ) => Promise<void>;
  enabled: boolean;
  threshold: number;
  /** Chat the warnings go to. Callers resolve the admin default. */
  chatId: string | undefined;
}

let deps: PlanAlertDeps | undefined;
let timer: ReturnType<typeof setInterval> | null = null;

/** Window label → the reset cycle it was last warned about. */
const warned = new Map<string, string>();

export function initPlanAlerts(d: PlanAlertDeps): void {
  deps = d;
  stopPlanAlerts();
  warned.clear();
  if (!d.enabled) return;
  if (!d.chatId) {
    logWarn(
      "bot",
      "planAlerts is on but no chat to warn — set planAlertChatId or adminUserId",
    );
    return;
  }
  timer = setInterval(() => {
    void checkPlanAlerts();
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  log("bot", `Plan alerts: on (threshold ${d.threshold}%)`);
}

export function stopPlanAlerts(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function warningText(
  label: string,
  percent: number,
  resetsAt: string | undefined,
): string {
  const ts = resetsAt ? Date.parse(resetsAt) : NaN;
  const reset = Number.isFinite(ts)
    ? `, resets ${formatSmartTimestamp(Math.round(ts / 60_000) * 60_000)}`
    : "";
  return `⚠️ Plan limit — ${label} at ${percent}% used${reset}.`;
}

/** One pass. Exported so the timer isn't the only way to drive it. */
export async function checkPlanAlerts(): Promise<void> {
  const d = deps;
  if (!d?.enabled || !d.chatId) return;

  // The default Claude account, then each extra one (only those running —
  // an alert never boots a backend). Each account's windows are its own.
  const ids = ["claude", ...listClaudeAccounts().map((a) => a.id)];
  for (const id of ids) {
    const usage = await getPooledBackend(id)
      ?.usage?.getPlanUsage?.()
      .catch(() => undefined);
    if (usage) await alertWindows(d, id, usage.windows);
  }
}

async function alertWindows(
  d: PlanAlertDeps,
  backendId: string,
  windows: readonly { label: string; percent: number; resetsAt?: string }[],
): Promise<void> {
  for (const window of windows) {
    // The default account keeps its historical keys and wording.
    const key =
      backendId === "claude" ? window.label : `${backendId}:${window.label}`;
    const label =
      backendId === "claude" ? window.label : `${backendId} ${window.label}`;
    // An unwarned window that is back under the threshold re-arms.
    if (window.percent < d.threshold) {
      warned.delete(key);
      continue;
    }
    const cycle = window.resetsAt ?? "";
    if (warned.get(key) === cycle) continue;
    warned.set(key, cycle);

    const text = warningText(label, window.percent, window.resetsAt);
    try {
      await d.sendMessage(Number(d.chatId), text, d.chatId);
      log("bot", `Plan alert sent: ${label} at ${window.percent}%`);
    } catch (err) {
      // Keep it marked as warned — a frontend that can't deliver now won't
      // deliver on the next tick either, and retrying would spam on recovery.
      logWarn(
        "bot",
        `Plan alert delivery failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

export function resetPlanAlertsForTest(): void {
  stopPlanAlerts();
  deps = undefined;
  warned.clear();
}
