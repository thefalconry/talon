/**
 * Decoupled-job one-shot orchestrator.
 *
 * When a trigger or cron `query` job carries a model override whose provider
 * differs from the chat's backend, the wake-up can't ride the chat session — a
 * session id is backend-specific. So it runs as an isolated one-shot on the
 * target backend (heartbeat/dream pattern): own backend, own context window, no
 * chat history. The agent still gets the outbound frontend tools (via the job
 * context label) so it can deliver to the chat with an explicit `chat_id`.
 *
 * This module is deliberately thin: it owns acquisition + log wiring, and
 * delegates the prompt shape to {@link ./job-prompt} and the timeout/abort
 * discipline to {@link ../isolated-agent}.
 */

import { dirs } from "../../../util/paths.js";
import { log, logWarn } from "../../../util/log.js";
import {
  acquireBackendInstance,
  isModelValidForBackend,
} from "../../engine/backend-controller/index.js";
import {
  recordBackendRunFailure,
  recordBackendRunSuccess,
  recordBackendRunUsage,
} from "../../engine/backend-router/index.js";
import { taskTable } from "../../tasks/index.js";
import type { OneShotAgentParams } from "../../types.js";
import { runIsolatedAgent } from "../isolated-agent.js";
import { openRunLog } from "../run-log.js";
import {
  buildJobSystemPrompt,
  jobLogPath,
  JOB_CONTEXT_LABEL,
  type JobKind,
} from "./job-prompt.js";

/** Default hard timeout for an isolated job run (10 minutes). */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

export interface JobOneShotParams {
  /** Chat the job belongs to (used for delivery via the messaging tools). */
  readonly chatId: string;
  /** Target backend/provider id (already validated as available). */
  readonly backendId: string;
  /** Model id to run on (already validated against the target backend). */
  readonly model: string;
  /** Opus-authored brief that becomes the agent's system prompt. */
  readonly instructions?: string;
  /** The wake/cron payload — already carries its `[System: ...]` header. */
  readonly payload: string;
  /** Short label for the log file (the trigger/cron name). */
  readonly label: string;
  /** Job kind, for the log + system prompt copy. */
  readonly kind: JobKind;
  /** Optional override of the hard timeout. */
  readonly timeoutMs?: number;
  /**
   * Backend to retry on when the primary one can't host an isolated run.
   *
   * A cron `query` job with no provider override inherits the chat's *ambient*
   * backend, which any `/model` switch can change out from under it — including
   * to a provider with no background capability (or one where the chat's model
   * isn't selectable). That has nothing to do with the job, so rather than skip
   * it, fall back to the deployment's background-capable role backend
   * (heartbeat, else the configured default). Omitted for jobs that pinned
   * their own provider: an explicit choice is honoured or skipped, never
   * silently rerouted.
   */
  readonly fallback?: { readonly backendId: string; readonly model: string };
}

export type JobOneShotResult =
  { status: "ran" } | { status: "skipped"; reason: string };

/** Open a per-run log file and return an appender bound to it. */
function openJobLog(
  kind: JobKind,
  label: string,
  backendId: string,
  model: string,
): Promise<(text: string) => Promise<void>> {
  return openRunLog(
    jobLogPath(kind, label),
    `# ${kind} job "${label}" — ${new Date().toISOString()}\n` +
      `**Backend:** ${backendId} **Model:** ${model}\n\n`,
  );
}

// The warning is deferred to runJobOneShot: an attempt that fails here may
// still succeed on the fallback backend, and a run that ultimately ran must
// not leave a "skipped" warning in the logs.
function skipJob(reason: string): JobOneShotResult {
  return { status: "skipped", reason };
}

function reportSkip(
  params: JobOneShotParams,
  reason: string,
): JobOneShotResult {
  logWarn(
    params.kind === "cron" ? "cron" : "triggers",
    `isolated job "${params.label}" skipped: ${reason}`,
  );
  return { status: "skipped", reason };
}

/**
 * One attempt on one backend: acquire it, check it can actually host an
 * isolated run, execute, and always release it afterwards.
 */
async function attemptJobOneShot(
  params: JobOneShotParams,
  backendId: string,
  model: string,
): Promise<JobOneShotResult> {
  let acquired: Awaited<ReturnType<typeof acquireBackendInstance>>;
  try {
    acquired = await acquireBackendInstance(backendId);
  } catch (err) {
    return skipJob(
      `provider "${backendId}" is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { backend, release } = acquired;
  try {
    const background = backend.background;
    if (!background) {
      return skipJob(
        `provider "${backendId}" can't run isolated jobs (no background capability).`,
      );
    }

    let modelValid = false;
    try {
      modelValid = await isModelValidForBackend(backend, model);
    } catch (err) {
      return skipJob(
        `could not validate model "${model}" on provider "${backendId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!modelValid) {
      return skipJob(
        `model "${model}" is not selectable on provider "${backendId}".`,
      );
    }

    const appendLog = await openJobLog(
      params.kind,
      params.label,
      backendId,
      model,
    );

    const abortController = new AbortController();
    const task = taskTable.begin({
      kind: params.kind,
      label: params.label,
      chatId: params.chatId,
      abort: () => abortController.abort(),
    });
    task.bind({ model, backendId });

    const oneShot: OneShotAgentParams = {
      prompt: params.payload,
      systemPrompt: buildJobSystemPrompt(
        params.chatId,
        params.kind,
        params.instructions,
      ),
      contextLabel: JOB_CONTEXT_LABEL,
      workspace: dirs.workspace,
      model,
      abortController,
      appendLog,
    };

    try {
      const usage = await runIsolatedAgent({
        background,
        params: oneShot,
        timeoutMs: params.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
        logCategory: params.kind === "cron" ? "cron" : "triggers",
        // No evictLabel: the job context label is shared with heartbeat, so a
        // sweep here could kill a concurrent heartbeat's subprocess. Bounded
        // abort-grace is enough.
      });
      task.succeed(usage ?? undefined);
      recordBackendRunUsage(backendId, usage ?? undefined);
      recordBackendRunSuccess(backendId);
    } catch (err) {
      task.fail(err);
      recordBackendRunFailure(backendId, err);
      throw err;
    }
    log(
      params.kind === "cron" ? "cron" : "triggers",
      `isolated job "${params.label}" ran on ${backendId}/${model}`,
    );
    return { status: "ran" };
  } finally {
    await release();
  }
}

/**
 * Run a trigger/cron wake-up as an isolated one-shot.
 *
 * Tries the requested backend first. When that backend can't host the run at
 * all — no background capability, unavailable, or the inherited model isn't
 * selectable on it — and a distinct {@link JobOneShotParams.fallback} was
 * supplied, the job is retried there instead of being skipped. A job is only
 * reported as skipped once every candidate has been ruled out.
 */
export async function runJobOneShot(
  params: JobOneShotParams,
): Promise<JobOneShotResult> {
  const first = await attemptJobOneShot(params, params.backendId, params.model);
  if (first.status === "ran") return first;

  const { fallback } = params;
  if (
    !fallback ||
    (fallback.backendId === params.backendId && fallback.model === params.model)
  ) {
    return reportSkip(params, first.reason);
  }

  log(
    params.kind === "cron" ? "cron" : "triggers",
    `isolated job "${params.label}": ${params.backendId}/${params.model} can't host it (${first.reason}) — retrying on ${fallback.backendId}/${fallback.model}`,
  );
  const second = await attemptJobOneShot(
    params,
    fallback.backendId,
    fallback.model,
  );
  if (second.status === "ran") return second;
  return reportSkip(
    params,
    `${first.reason} Fallback ${fallback.backendId}/${fallback.model} also unusable: ${second.reason}`,
  );
}
