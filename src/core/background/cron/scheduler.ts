/**
 * Cron scheduler — runs persistent recurring jobs.
 *
 * Every 60 seconds, checks all enabled jobs. If one is due, executes it.
 * "message" type sends text via injected sendMessage.
 * "query" type runs as an ISOLATED one-shot agent (heartbeat/dream pattern) —
 * its own session, no chat history — so a scheduled task never disturbs the
 * chat session and may run on a different model/provider. The agent delivers
 * to the chat via the messaging tools with an explicit chat_id.
 *
 * A job is scheduled by EITHER a 5-field cron expression (`schedule`) OR a
 * fixed interval (`everyMs`). On top of cadence it supports lifecycle bounds —
 * a not-before (`startAt`), an expiry (`endAt`), a run cap (`maxRuns`, =1 for
 * one-shot) — and a missed-run catch-up policy (`catchup`) that replays runs
 * that were due while Talon was down. The cadence/catch-up arithmetic comes
 * from the native Gleam scheduler-core; this module is the runtime that wires
 * it to real executions, persistence, and the circuit breaker.
 *
 * Knows nothing about the backend or frontend — dependencies are injected.
 */

import { Cron } from "croner";
import { getActiveCount } from "../../engine/dispatcher.js";
import {
  getAllCronJobs,
  getCronJob,
  recordCronRun,
  updateCronJob,
  intervalAnchor,
  isIntervalJob,
  describeSchedule,
  type CronJob,
  type CronRunOutcome,
} from "../../../storage/cron.js";
import { appendDailyLog } from "../../../storage/daily-log.js";
import { log, logError, logWarn } from "../../../util/log.js";
import { raiseAlert, resolveAlert } from "../../frontend-runtime/alerts.js";
import { faultText } from "../../engine/fault-text.js";
import { numericChatIdFor } from "../../frontend-runtime/chat-id.js";
import {
  chooseBackend,
  resolveRoutedModel,
} from "../../engine/backend-router/index.js";
import { runJobOneShot } from "./job-oneshot.js";
import {
  jobAllowsRun,
  pruneJobHealth,
  recordJobFailure,
  recordJobSuccess,
  type JobHealthOptions,
} from "./job-health.js";
import {
  catchupRunCount,
  missedRunCount,
} from "../../../native/scheduler-core.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

type CronDeps = {
  sendMessage: (
    chatId: number,
    text: string,
    stringId?: string,
  ) => Promise<void>;
  /**
   * Resolve the chat's default model + backend, used when a cron query job has
   * no model/provider override of its own.
   */
  resolveChatModel: (
    chatId: string,
  ) => Promise<{ model: string | null; backendId: string }>;
  /**
   * Resolve the deployment's background-capable role backend (heartbeat, else
   * the configured default). Used as a fallback for query jobs that inherited
   * the chat's ambient backend and found it can't run isolated jobs — a
   * `/model` switch in the chat shouldn't silently disable the schedule.
   */
  resolveJobFallback?: () => { model: string | null; backendId: string };
};

let deps: CronDeps | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const TICK_INTERVAL_MS = 60_000;

// ── Public API ───────────────────────────────────────────────────────────────

export function initCron(d: CronDeps): void {
  deps = d;
}

export function startCronTimer(): void {
  if (timer) return;
  log("cron", "Started: checking every 60s");
  timer = setInterval(() => {
    runCronTick().catch((err) => logError("cron", "Tick failed", err));
  }, TICK_INTERVAL_MS);
}

export function stopCronTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ── Core ─────────────────────────────────────────────────────────────────────

// Job IDs currently executing. Prevents a long-running "query" job from being
// dispatched a second time by the next 60-second tick before recordCronRun()
// has had a chance to update lastRunAt.
const runningJobs = new Set<string>();

type ExecuteJobResult =
  { status: "ran" } | { status: "skipped"; reason: string };

// Per-job circuit breaker policy (Gleam scheduler core via job-health):
// 3 consecutive failures open the breaker; cooldown starts at 5 minutes
// and escalates per re-open up to 6 hours. Without this, a job whose
// target chat is gone (or whose query always faults) fails every
// matching tick forever.
const JOB_HEALTH: JobHealthOptions = {
  threshold: 3,
  baseCooldownMs: 5 * 60_000,
  maxCooldownMs: 6 * 60 * 60_000,
};

// Upper bound on how many missed runs a single job replays on startup
// catch-up under the "all" policy — so a job idle through a long outage
// fires a handful of times, not hundreds.
const CATCHUP_MAX = 5;

// Wall-clock watermark of the last fully-evaluated tick. Cron dueness is
// window-based — "did a fire time land inside (watermark, now]?" — instead of
// "does the current minute match?". setInterval ticks drift under event-loop
// load, so a tick landing at :29:59 followed by one at :31:01 skips the :30
// minute entirely under minute-equality; the window formulation cannot miss
// it. Initialized to process start: anything earlier is startup-catch-up
// territory (per-job catchup policy), not live-tick recovery.
let lastTickMs = Date.now();

// Hard cap on how far back a live tick will look. Bounds the window when the
// watermark lags (load-shed ticks don't advance it) and keeps a pathological
// stall from replaying ancient fire times outside the catch-up policy.
const MAX_TICK_LOOKBACK_MS = 10 * 60_000;

async function runCronTick(): Promise<void> {
  if (!deps) return;
  // Safety valve — don't pile on if heavily loaded. The watermark is NOT
  // advanced, so the skipped window is re-covered by the next tick (bounded
  // by MAX_TICK_LOOKBACK_MS).
  if (getActiveCount() > 10) return;

  const now = new Date();
  const nowMs = now.getTime();
  const windowStartMs = Math.max(lastTickMs, nowMs - MAX_TICK_LOOKBACK_MS);
  const jobs = getAllCronJobs();
  pruneJobHealth(new Set(jobs.map((j) => j.id)));

  let loadShed = false;
  for (const listed of jobs) {
    // Re-read: each run is awaited, so a slow job lets the next tick start
    // and run later jobs before this loop reaches them. The listing's copy
    // would carry the pre-run lastRunAt and fire such a job a second time.
    const job = getCronJob(listed.id);
    if (!job?.enabled) continue;
    // Expiry takes priority over dueness: a job past its end time is disabled
    // and skipped even if this minute would otherwise match.
    if (expireIfPast(job, nowMs)) continue;
    if (runningJobs.has(job.id)) continue; // already in-flight this tick or a previous one
    if (!isDue(job, now, windowStartMs)) continue;
    if (!jobAllowsRun(job.id, nowMs, JOB_HEALTH)) {
      log("cron", `Skipping "${job.name}" [${job.id}] — breaker open`);
      continue;
    }
    if (getActiveCount() > 10) {
      loadShed = true;
      break;
    }

    await runScheduled(job);
  }

  // Only advance the watermark when every job was evaluated — a load-shed
  // break leaves it in place so unevaluated jobs keep their window.
  if (!loadShed) lastTickMs = nowMs;
}

/**
 * Execute one job and settle all its bookkeeping: circuit breaker, run
 * telemetry (status/duration/error), daily log, and the run-cap check. Holds
 * the per-job in-flight lock for the duration. Never throws — failures are
 * recorded and swallowed. Shared by the tick, startup catch-up, and run-now.
 */
async function runScheduled(job: CronJob): Promise<void> {
  if (runningJobs.has(job.id)) return;
  runningJobs.add(job.id);
  const startedAt = Date.now();
  try {
    log(
      "cron",
      `Executing "${job.name}" [${job.id}] (${job.type}) in chat ${job.chatId}`,
    );
    const result = await executeJob(job);
    const outcome: CronRunOutcome = {
      status: "ok",
      durationMs: Date.now() - startedAt,
    };
    recordJobSuccess(job.id, Date.now(), JOB_HEALTH);
    resolveAlert(
      `cron.job.${job.id}`,
      `Cron job "${job.name}" is running again.`,
    );
    recordCronRun(job.id, outcome);
    appendDailyLog(
      "Cron",
      result.status === "skipped"
        ? `Skipped "${job.name}" (${job.type}) in chat ${job.chatId}: ${result.reason}`
        : `Ran "${job.name}" (${job.type}) in chat ${job.chatId}`,
    );
    if (result.status === "ran") {
      log("cron", `Executed "${job.name}" [${job.id}] in chat ${job.chatId}`);
    }
    enforceRunCap(job.id);
  } catch (err) {
    // A failed run is still a run: it advances lastRunAt and bumps runCount,
    // so it counts toward maxRuns. For interval jobs the anchor IS lastRunAt,
    // so not advancing it would make a flaky job re-fire every 60s tick until
    // the breaker opens. And a capped job — a one-shot above all — whose
    // failure didn't count would stay enabled and fire again at the next
    // matching time: for a date-pinned cron expression that is a year later,
    // long after anyone wanted it.
    recordCronRun(job.id, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    });
    logError(
      "cron",
      `Job "${job.name}" [${job.id}] failed chat=${job.chatId} type=${job.type} ms=${Date.now() - startedAt}`,
      err,
    );
    const cooldown = recordJobFailure(job.id, Date.now(), JOB_HEALTH);
    if (cooldown !== null) {
      const mins = Math.round(cooldown / 60_000);
      logWarn(
        "cron",
        `Breaker opened for "${job.name}" [${job.id}] — cooling down ~${mins}min`,
      );
      // The breaker opens at JOB_HEALTH.threshold consecutive failures —
      // the job is now paused, which the operator should hear about.
      raiseAlert(
        `cron.job.${job.id}`,
        `Cron job "${job.name}" failed ${JOB_HEALTH.threshold} runs in a row: ${faultText(err)}. Paused for ~${mins} min.`,
      );
    }
    if (enforceRunCap(job.id)) {
      // The job's last permitted run failed and it is now retired — nothing
      // will retry it, so the operator has to hear about it.
      raiseAlert(
        `cron.job.${job.id}`,
        `Cron job "${job.name}" failed on its final run and was disabled: ${faultText(err)}. Re-enable or recreate it to try again.`,
      );
    }
  } finally {
    runningJobs.delete(job.id);
  }
}

// ── Lifecycle bounds ─────────────────────────────────────────────────────────

/**
 * Disable a job that has reached its run cap (`maxRuns`; =1 means one-shot).
 * Call after every run — successful or failed — once runCount has been
 * bumped. Returns true when this call retired the job.
 */
function enforceRunCap(id: string): boolean {
  const job = getCronJob(id);
  if (!job || !job.enabled) return false;
  if (job.maxRuns !== undefined && job.runCount >= job.maxRuns) {
    updateCronJob(id, { enabled: false });
    log(
      "cron",
      `Job "${job.name}" [${id}] reached run cap (${job.maxRuns}) — disabled`,
    );
    appendDailyLog(
      "Cron",
      `Job "${job.name}" finished after ${job.runCount} run(s)`,
    );
    return true;
  }
  return false;
}

/**
 * Disable a job whose `endAt` has passed. Returns true when it expired this
 * call (so the caller can skip it for the rest of the tick).
 */
function expireIfPast(job: CronJob, nowMs: number): boolean {
  if (job.endAt !== undefined && nowMs > job.endAt) {
    updateCronJob(job.id, { enabled: false });
    log("cron", `Job "${job.name}" [${job.id}] passed its end time — disabled`);
    appendDailyLog("Cron", `Job "${job.name}" expired (reached end time)`);
    return true;
  }
  return false;
}

// ── Startup catch-up ─────────────────────────────────────────────────────────

/**
 * Replay runs that were due while Talon was down. Called once on startup after
 * the dispatcher and frontend are wired. Honors each job's `catchup` policy
 * (default "skip" = no-op, so jobs created before this feature are unaffected).
 * The native scheduler-core decides how many runs to replay; "all" is capped
 * at CATCHUP_MAX.
 */
export async function runStartupCatchup(): Promise<void> {
  if (!deps) return;
  const nowMs = Date.now();
  for (const job of getAllCronJobs()) {
    // Same load back-pressure the tick honors — don't pile replays onto an
    // already-busy startup.
    if (getActiveCount() > 10) break;
    if (!job.enabled) continue;
    const policy = job.catchup ?? "skip";
    if (policy === "skip") continue;
    if (expireIfPast(job, nowMs)) continue;
    if (job.startAt !== undefined && nowMs < job.startAt) continue;

    const missed = countMissedRuns(job, nowMs);
    const toRun = catchupRunCount(missed, policy, CATCHUP_MAX);
    if (toRun <= 0) continue;

    // Replays collapse to "now" by design: each runScheduled stamps lastRunAt =
    // now, so after the (capped) replays the job resumes cleanly from the
    // present rather than chasing every historical slot. The first replay takes
    // the in-flight lock before yielding, so a concurrent tick can't double-fire.

    log(
      "cron",
      `Catch-up: "${job.name}" [${job.id}] missed ${missed} run(s), replaying ${toRun} (${policy})`,
    );
    appendDailyLog(
      "Cron",
      `Catch-up replayed ${toRun} missed run(s) of "${job.name}"`,
    );
    for (let i = 0; i < toRun; i++) {
      // Re-read each iteration: a run-cap or expiry hit mid-replay must stop us.
      const fresh = getCronJob(job.id);
      if (!fresh || !fresh.enabled) break;
      await runScheduled(fresh);
    }
  }
}

/**
 * How many fire times were missed in (anchor, now] — the input to the catch-up
 * policy. Interval jobs use the native missed-run math; cron jobs walk fire
 * times from the anchor, capped so a long-idle job stays cheap to evaluate.
 */
function countMissedRuns(job: CronJob, nowMs: number): number {
  const anchor = intervalAnchor(job);
  if (isIntervalJob(job)) {
    return missedRunCount(anchor, job.everyMs as number, nowMs);
  }
  if (!job.schedule) return 0;
  try {
    const cron = new Cron(job.schedule, {
      timezone: job.timezone ?? undefined,
    });
    let count = 0;
    let cursor = cron.nextRun(new Date(anchor));
    // `< CATCHUP_MAX` so the walk stops at the cap exactly (a lower bound for a
    // long outage); catchupRunCount applies the same cap to the replay count.
    while (cursor && cursor.getTime() <= nowMs && count < CATCHUP_MAX) {
      count++;
      cursor = cron.nextRun(cursor);
    }
    return count;
  } catch {
    return 0;
  }
}

// ── Run now (manual trigger) ─────────────────────────────────────────────────

/**
 * Execute a job immediately, bypassing its schedule and circuit breaker — for
 * manual "run now" testing. The run is still recorded (telemetry + run cap), so
 * a one-shot run-now also retires the job. Returns an error string if the job
 * is missing or already running.
 */
export async function runJobNow(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!deps) return { ok: false, error: "Scheduler not initialized" };
  const job = getCronJob(id);
  if (!job) return { ok: false, error: `Job ${id} not found` };
  if (runningJobs.has(id))
    return { ok: false, error: "Job is already running" };

  await runScheduled(job);

  const after = getCronJob(id);
  if (after?.lastStatus === "error") {
    return { ok: false, error: after.lastError ?? "Job failed" };
  }
  return { ok: true };
}

// Track jobs that have already logged a bad-schedule warning to avoid log spam
// (isDue runs every 60s — a single bad job would flood the logs otherwise).
// Capped to prevent unbounded growth from ephemeral job IDs.
const warnedBadSchedule = new Set<string>();
const MAX_WARNED_SCHEDULES = 200;

function isDue(job: CronJob, now: Date, windowStartMs: number): boolean {
  const nowMs = now.getTime();

  // Not-before gate (both modes): never fire before startAt.
  if (job.startAt !== undefined && nowMs < job.startAt) return false;

  // Backward clock guard (both modes): if the last run is in the future (NTP
  // jumped the clock back), wait for wall-clock to catch up rather than firing
  // a burst.
  if (job.lastRunAt !== undefined && job.lastRunAt > nowMs) return false;

  return isIntervalJob(job)
    ? isIntervalDue(job, nowMs)
    : isCronDue(job, now, windowStartMs);
}

/**
 * Interval mode: due once `everyMs` has elapsed since the anchor (the last
 * run, else the job's start instant). A fresh job therefore first fires one
 * interval after it becomes eligible, not the instant it's created.
 */
function isIntervalDue(job: CronJob, nowMs: number): boolean {
  return nowMs - intervalAnchor(job) >= (job.everyMs as number);
}

/**
 * Cron mode: due when a scheduled fire time fell inside (floor, now], where
 * the floor is the tick window start raised by lastRunAt (dedupe — never
 * re-fire a slot that already ran) and startAt (never count fire times from
 * before the job's not-before gate). Window semantics make dueness immune to
 * tick drift: a fire time in a minute no tick landed on is still caught by
 * the next tick, because the window spans the gap.
 */
function isCronDue(job: CronJob, now: Date, windowStartMs: number): boolean {
  if (!job.schedule) return false;
  try {
    const cron = new Cron(job.schedule, {
      timezone: job.timezone ?? undefined,
    });

    // Schedule parsed fine — clear stale warning immediately so it can
    // re-trigger if the schedule breaks again later (regardless of whether
    // the job is actually due right now)
    warnedBadSchedule.delete(job.id);

    const floorMs = Math.max(
      windowStartMs,
      job.lastRunAt ?? 0,
      job.startAt ?? 0,
    );
    // croner's nextRun is strictly-after its argument, so the fire time at
    // exactly floorMs is excluded — (floor, now].
    const next = cron.nextRun(new Date(floorMs));
    if (!next || next.getTime() > now.getTime()) return false;

    // Prevent duplicate runs — ensure at least 55 seconds since last execution
    if (job.lastRunAt && now.getTime() - job.lastRunAt < 55_000) return false;

    return true;
  } catch (err) {
    if (!warnedBadSchedule.has(job.id)) {
      if (warnedBadSchedule.size >= MAX_WARNED_SCHEDULES) {
        const oldest = warnedBadSchedule.values().next().value;
        if (oldest !== undefined) warnedBadSchedule.delete(oldest);
      }
      warnedBadSchedule.add(job.id);
      logWarn(
        "cron",
        `Invalid cron schedule for job "${job.id}": ${err instanceof Error ? err.message : err}`,
      );
    }
    return false;
  }
}

// Internal exports for tests — window-based dueness is regression-critical
// (a drifted tick must not skip a scheduled minute).
export const _cronInternals = {
  isDue,
  isCronDue,
};

/**
 * Where an unpinned `query` job runs.
 *
 * A job that named no provider used to inherit the chat's ambient backend.
 * It is an isolated one-shot with no session to keep warm, so it is free to
 * run wherever there is plan headroom instead — but only when the job named
 * no model either: a model id is backend-specific, so naming one pins the
 * backend that understands it.
 *
 * A routed job cannot carry the chat's model across, so it takes the target
 * backend's default. If that backend can't name one, the job stays where it
 * was rather than being sent somewhere it has no model to run.
 */
async function routeQueryJob(
  job: CronJob,
  chat: { model: string | null; backendId: string },
): Promise<{ backendId: string; model: string | null }> {
  const decision = await chooseBackend({
    purpose: "cron",
    chatBackendId: chat.backendId,
    ...(job.model ? { requestedModel: job.model } : {}),
  });
  if (job.model) return { backendId: decision.backendId, model: job.model };
  if (!decision.routed || decision.backendId === chat.backendId) {
    return { backendId: chat.backendId, model: chat.model };
  }
  const model = await resolveRoutedModel(decision.backendId);
  if (!model) {
    logWarn(
      "cron",
      `job "${job.name}": routed to ${decision.backendId} but it names no ` +
        `default model — staying on ${chat.backendId}`,
    );
    return { backendId: chat.backendId, model: chat.model };
  }
  return { backendId: decision.backendId, model };
}

/** Default hard limit per query run; a job's own `timeoutMs` overrides it. */
const CRON_JOB_TIMEOUT_MS = 10 * 60_000;

export async function executeJob(job: CronJob): Promise<ExecuteJobResult> {
  if (!deps) return { status: "skipped", reason: "cron is not initialised" };

  const numericChatId = numericChatIdFor(job.chatId);

  if (job.type === "message") {
    await deps.sendMessage(numericChatId, job.content, job.chatId);
    return { status: "ran" };
  }

  // type === "query" — run as an ISOLATED one-shot (no chat session). Resolve
  // the target backend + model: a job-level override wins (and may name a
  // different provider, since the run is isolated), otherwise fall back to the
  // chat's backend + active model.
  let backendId: string;
  let model: string | null;
  // A job that pinned its own provider is honoured as written — no fallback.
  // One that inherited the chat's ambient backend gets a safety net, because
  // that backend can change under it at any time (`/model`, a rebind).
  let fallback: { backendId: string; model: string } | undefined;
  if (job.provider) {
    backendId = job.provider;
    model = job.model ?? null;
  } else {
    const chat = await deps.resolveChatModel(job.chatId);
    const routed = await routeQueryJob(job, chat);
    backendId = routed.backendId;
    model = routed.model;
    const candidate = deps.resolveJobFallback?.();
    if (candidate?.model) {
      fallback = { backendId: candidate.backendId, model: candidate.model };
    }
  }
  if (!model) {
    throw new Error(
      `Cron job "${job.name}": no model resolved for backend "${backendId}" — set a model or pick a model for the chat's backend.`,
    );
  }

  const payload =
    `[System: CRON JOB "${job.name}" (schedule: ${describeSchedule(job)}). ` +
    `Execute the task. Be concise and action-oriented.]\n\n${job.content}`;

  // runJobOneShot enforces its own hard timeout (with abort + grace), so no
  // outer withTimeout wrapper is needed here.
  const result = await runJobOneShot({
    chatId: job.chatId,
    backendId,
    model,
    ...(job.instructions ? { instructions: job.instructions } : {}),
    payload,
    label: job.name,
    kind: "cron",
    timeoutMs: job.timeoutMs ?? CRON_JOB_TIMEOUT_MS,
    ...(fallback ? { fallback } : {}),
  });
  if (result.status === "skipped") {
    await deps.sendMessage(
      numericChatId,
      `Cron job "${job.name}" skipped: ${result.reason} Update or delete the job to stop this notice.`,
      job.chatId,
    );
  }
  return result;
}
