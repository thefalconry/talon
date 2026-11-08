/**
 * Turn health — turns the per-turn outcomes the dispatcher sees into
 * operator alerts.
 *
 * Every chat turn on every backend settles through `execute`, so this is
 * the one place that can tell "one bad turn" from "this chat is broken"
 * or "this backend is down":
 *
 *   - `backend.auth.<backend>` / `backend.quota.<backend>` — the backend
 *     lost its login or ran out of quota. Raised on the first such
 *     failure: nothing but a human (a re-login, a plan change, waiting
 *     out a window the operator should know about) clears it.
 *   - `turn.failing.<chatId>` — the chat's last 3 turns failed.
 *   - `backend.failing.<backend>` — the backend failed turns in 3
 *     different chats within 10 minutes.
 *   - `dispatcher.stuck` — the watchdog saw work arrive and nothing
 *     finish or make progress for 10 minutes (see util/watchdog.ts).
 *
 * Auth and quota failures carry their own alert, so they do not also
 * count toward the two failure streaks. Every alert resolves on the next
 * successful turn on the same chat / backend. A stopped turn is neither.
 */

import { AgentRunError } from "../agent-runtime/events.js";
import { TalonError } from "../errors.js";
import { raiseAlert, resolveAlert } from "../frontend-runtime/alerts.js";
import { taskTable } from "../tasks/index.js";
import { log, logWarn } from "../../util/log.js";
import type { StuckLoopListener } from "../../util/watchdog.js";
import { faultText } from "./fault-text.js";

const CHAT_STREAK_THRESHOLD = 3;
const BACKEND_CHAT_THRESHOLD = 3;
const BACKEND_WINDOW_MS = 10 * 60_000;

/**
 * Login / credential failures across backends: Claude Code's "Not logged
 * in · Please run /login", an expired OAuth token, Codex's refresh-token
 * 401, Antigravity's "not authenticated", a bare 401/403.
 */
const AUTH_RE =
  /not logged in|please run \/login|not (?:yet )?authenticated|authentication (?:required|failed|error)|unauthori[sz]ed|invalid (?:api[ _-]?key|x-api-key|bearer|token|credentials)|(?:oauth |access )?token (?:has )?expired|login expired|refresh_token_invalidated|failed to refresh token|permission_error|\b40[13]\b/i;

/** Subscription / credit exhaustion — a limit a short retry won't clear. */
const QUOTA_RE =
  /usage limit|usage exhausted|you['’]ve hit your .{0,40}limit|out of (?:extra usage|credits)|insufficient_quota|quota (?:exceeded|exhausted)|exceeded your current quota|credit balance is too low|no remaining credits/i;

type TurnFault = "auth" | "quota" | "error";

export type TurnBinding = {
  chatId: string;
  backendId: string;
  model?: string;
  source?: string;
  durationMs: number;
};

/** chatId → consecutive failed turns. */
const chatStreaks = new Map<string, number>();
/** backend → chatId → time of that chat's latest failure. */
const backendFailures = new Map<string, Map<string, number>>();

/** What kind of failure `err` is — null when it is not a fault at all. */
function classifyTurnFault(err: unknown): TurnFault | null {
  if (err instanceof TalonError) {
    if (err.reason === "stopped") return null;
    if (err.reason === "auth") return "auth";
    if (err.reason === "usage_limit") return "quota";
  }
  if (err instanceof AgentRunError) {
    if (err.kind === "aborted") return null;
    if (err.kind === "auth") return "auth";
  }
  if (err instanceof Error && err.name === "AbortError") return null;
  const text =
    err instanceof AgentRunError
      ? `${err.message} ${err.raw ?? ""}`
      : err instanceof Error
        ? err.message
        : String(err);
  if (QUOTA_RE.test(text)) return "quota";
  if (AUTH_RE.test(text)) return "auth";
  if (err instanceof AgentRunError && err.kind === "rate_limit") {
    // A non-retryable rate-limit event is a usage limit, not a 429.
    return err.retryable ? "error" : "quota";
  }
  return "error";
}

function describe(b: TurnBinding): string {
  return b.model ? `${b.backendId}/${b.model}` : b.backendId;
}

/** Record a turn that completed. Clears every alert it can vouch for. */
export function noteTurnSucceeded(b: TurnBinding): void {
  const streak = chatStreaks.get(b.chatId);
  if (streak) {
    chatStreaks.delete(b.chatId);
    log(
      "dispatcher",
      `turn.recovered chat=${b.chatId} backend=${b.backendId} after_failures=${streak} ms=${b.durationMs}`,
    );
    resolveAlert(
      `turn.failing.${b.chatId}`,
      `Chat ${b.chatId} is answering again (${describe(b)}).`,
    );
  }
  if (backendFailures.delete(b.backendId)) {
    resolveAlert(
      `backend.failing.${b.backendId}`,
      `The ${b.backendId} backend is completing turns again.`,
    );
  }
  resolveAlert(
    `backend.auth.${b.backendId}`,
    `The ${b.backendId} backend is signed in again.`,
  );
  resolveAlert(
    `backend.quota.${b.backendId}`,
    `The ${b.backendId} backend has quota again.`,
  );
}

/** Record a turn that threw. Raises once a threshold is crossed. */
export function noteTurnFailed(b: TurnBinding, err: unknown): void {
  const fault = classifyTurnFault(err);
  if (fault === null) return;
  const detail = faultText(err);
  const prior = chatStreaks.get(b.chatId) ?? 0;
  const count = fault === "error" ? prior + 1 : prior;
  logWarn(
    "dispatcher",
    `turn.fail chat=${b.chatId} backend=${b.backendId} model=${b.model ?? "?"} ` +
      `source=${b.source ?? "?"} cause=${fault} streak=${count} ` +
      `ms=${b.durationMs} error="${detail}"`,
  );
  if (fault === "auth") {
    raiseAlert(
      `backend.auth.${b.backendId}`,
      `The ${b.backendId} backend is not signed in: ${detail}. Every chat on it fails until it is re-authenticated.`,
      { severity: "critical" },
    );
    return;
  }
  if (fault === "quota") {
    raiseAlert(
      `backend.quota.${b.backendId}`,
      `The ${b.backendId} backend is out of quota: ${detail}. Chats on it fail until the limit resets.`,
    );
    return;
  }
  chatStreaks.set(b.chatId, count);
  if (count >= CHAT_STREAK_THRESHOLD) {
    raiseAlert(
      `turn.failing.${b.chatId}`,
      `Chat ${b.chatId} has failed its last ${count} turns on ${describe(b)}: ${detail}`,
    );
  }
  noteBackendFailure(b, detail);
}

function noteBackendFailure(b: TurnBinding, detail: string): void {
  const now = Date.now();
  let chats = backendFailures.get(b.backendId);
  if (!chats) {
    chats = new Map();
    backendFailures.set(b.backendId, chats);
  }
  chats.set(b.chatId, now);
  for (const [chatId, at] of chats) {
    if (now - at > BACKEND_WINDOW_MS) chats.delete(chatId);
  }
  if (chats.size >= BACKEND_CHAT_THRESHOLD) {
    raiseAlert(
      `backend.failing.${b.backendId}`,
      `The ${b.backendId} backend failed turns in ${chats.size} chats in the last 10 min. Last error: ${detail}`,
    );
  }
}

/** The turns in flight, for the stuck-loop alert: what is wedged where. */
function describeTurnQueue(now = Date.now()): string {
  const turns = taskTable
    .list()
    .filter(
      (t) =>
        t.kind === "turn" && (t.state === "running" || t.state === "queued"),
    );
  if (turns.length === 0) return "No turn is running or queued.";
  const running = turns
    .filter((t) => t.state === "running")
    .map((t) => {
      const mins = Math.round((now - (t.startedAt ?? t.queuedAt)) / 60_000);
      const on = t.backendId
        ? ` on ${t.backendId}${t.model ? `/${t.model}` : ""}`
        : "";
      return `chat ${t.chatId ?? "?"}${on} (${mins} min)`;
    });
  const queued = turns.length - running.length;
  const parts = [
    running.length ? `Running: ${running.join(", ")}.` : "Nothing is running.",
  ];
  if (queued) parts.push(`${queued} turn(s) queued.`);
  return parts.join(" ");
}

/** Watchdog hook: the stuck message loop as an operator alert. */
export const stuckLoopAlert: StuckLoopListener = {
  onStuck: ({ pendingMins, silentMins }) =>
    raiseAlert(
      "dispatcher.stuck",
      `The message loop looks stuck: a message received ${pendingMins} min ago is unprocessed and no turn has made progress for ${silentMins} min. ${describeTurnQueue()}`,
    ),
  onRecovered: () =>
    resolveAlert("dispatcher.stuck", "The message loop is processing again."),
};

/** Test seam: forget every streak. */
export function resetTurnHealthForTest(): void {
  chatStreaks.clear();
  backendFailures.clear();
}
