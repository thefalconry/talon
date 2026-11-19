/**
 * Cron CRUD — create / list / edit / delete scheduled jobs for a chat.
 */

import {
  addCronJob,
  getCronJob,
  getCronJobsForChat,
  updateCronJob,
  deleteCronJob,
  generateCronId,
  describeSchedule,
  nextRunAt,
} from "../../../storage/cron.js";
import { runJobNow } from "../../background/cron/scheduler.js";
import { parseCronSpec } from "../../background/cron/spec.js";
import { log } from "../../../util/log.js";
import { validateIsolatedJobTarget } from "./validation.js";
import type { SharedActionHandlers } from "./types.js";

export const cronHandlers: SharedActionHandlers = {
  create_cron_job: async (body, chatId, _backend, chatKey) => {
    const parsed = parseCronSpec(body);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const spec = parsed.effective;
    const {
      name,
      type: jobType,
      schedule,
      everyMs,
      startAt,
      endAt,
      maxRuns,
    } = spec;

    // Validate the target backend/model up front so a bad id or unsupported
    // backend is rejected here instead of silently failing at fire time.
    if (jobType === "query") {
      const modelErr = await validateIsolatedJobTarget(
        chatKey,
        spec.model,
        spec.provider,
      );
      if (modelErr) return { ok: false, error: modelErr };
    }

    const id = generateCronId();
    addCronJob({
      ...spec,
      id,
      chatId: chatKey,
      enabled: true,
      createdAt: Date.now(),
      runCount: 0,
    });
    log(
      "gateway",
      `create_cron_job: "${name}" [${schedule ?? `every ${everyMs}ms`}]`,
    );

    const created = getCronJob(id);
    const nextMs = created ? nextRunAt(created) : null;
    const bounds = [
      maxRuns !== undefined ? `max runs: ${maxRuns}` : null,
      startAt !== undefined
        ? `starts: ${new Date(startAt).toISOString()}`
        : null,
      endAt !== undefined ? `ends: ${new Date(endAt).toISOString()}` : null,
      spec.catchup ? `catch-up: ${spec.catchup}` : null,
      spec.timeoutMs !== undefined
        ? `timeout: ${Math.round(spec.timeoutMs / 1000)}s`
        : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      ok: true,
      text:
        `Created cron job "${name}" (id: ${id})\n` +
        `Schedule: ${created ? describeSchedule(created) : (schedule ?? "interval")}\n` +
        `Type: ${jobType}\n` +
        `Next run: ${nextMs ? new Date(nextMs).toISOString() : "unknown"}` +
        (bounds ? `\n${bounds}` : ""),
    };
  },

  list_cron_jobs: (body, chatId, _backend, chatKey) => {
    const jobs = getCronJobsForChat(chatKey);
    if (jobs.length === 0)
      return { ok: true, text: "No cron jobs in this chat." };
    const fmt = (ms: number) =>
      new Date(ms).toISOString().slice(0, 16).replace("T", " ");
    const lines = jobs.map((j) => {
      const status = j.enabled ? "enabled" : "disabled";
      const lastRun = j.lastRunAt ? fmt(j.lastRunAt) : "never";
      const nextMs = j.enabled ? nextRunAt(j) : null;
      const nextRun = nextMs ? fmt(nextMs) : "—";
      const outcome = j.lastStatus
        ? ` [${j.lastStatus}${
            j.lastStatus === "error" && j.lastError
              ? `: ${j.lastError.slice(0, 60)}`
              : ""
          }]`
        : "";
      const bounds: string[] = [];
      if (j.maxRuns !== undefined)
        bounds.push(`cap ${j.runCount}/${j.maxRuns}`);
      if (j.startAt !== undefined) bounds.push(`from ${fmt(j.startAt)}`);
      if (j.endAt !== undefined) bounds.push(`until ${fmt(j.endAt)}`);
      if (j.catchup && j.catchup !== "skip")
        bounds.push(`catch-up: ${j.catchup}`);
      if (j.model) bounds.push(`model: ${j.model}`);
      if (j.timeoutMs !== undefined)
        bounds.push(`timeout: ${Math.round(j.timeoutMs / 1000)}s`);
      return [
        `- ${j.name} (${status})`,
        `  ID: ${j.id}`,
        `  Schedule: ${describeSchedule(j)}${j.timezone ? ` (${j.timezone})` : ""}`,
        `  Type: ${j.type}`,
        `  Content: ${j.content.slice(0, 100)}${j.content.length > 100 ? "..." : ""}`,
        `  Runs: ${j.runCount}${outcome} | Last: ${lastRun} | Next: ${nextRun}`,
        bounds.length ? `  Bounds: ${bounds.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    });
    return {
      ok: true,
      text: `Cron jobs (${jobs.length}):\n\n${lines.join("\n\n")}`,
    };
  },

  edit_cron_job: async (body, chatId, _backend, chatKey) => {
    const jobId = String(body.job_id ?? "");
    if (!jobId) return { ok: false, error: "Missing job_id" };
    const job = getCronJob(jobId);
    if (!job) return { ok: false, error: `Job ${jobId} not found` };
    if (job.chatId !== chatKey)
      return { ok: false, error: "Job belongs to a different chat" };

    const parsed = parseCronSpec(body, job);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const { updates, effective } = parsed;

    // Validate the effective post-edit target so provider+model edits are
    // checked together using cron's cross-provider rules.
    if (
      effective.type === "query" &&
      ("model" in updates || "provider" in updates || "type" in updates)
    ) {
      const modelErr = await validateIsolatedJobTarget(
        chatKey,
        effective.model,
        effective.provider,
      );
      if (modelErr) return { ok: false, error: modelErr };
    }

    // If a lowered run cap already met/exceeds runCount, retire the job now so
    // it can't sneak one more run before enforceRunCap catches it post-run.
    if (
      effective.maxRuns !== undefined &&
      job.runCount >= effective.maxRuns &&
      updates.enabled !== true
    )
      updates.enabled = false;

    const updated = updateCronJob(jobId, updates);
    return {
      ok: true,
      text: `Updated job "${updated?.name ?? jobId}". Fields changed: ${Object.keys(updates).join(", ")}`,
    };
  },

  run_cron_job: async (body, chatId, _backend, chatKey) => {
    const jobId = String(body.job_id ?? "");
    if (!jobId) return { ok: false, error: "Missing job_id" };
    const job = getCronJob(jobId);
    if (!job) return { ok: false, error: `Job ${jobId} not found` };
    if (job.chatId !== chatKey)
      return { ok: false, error: "Job belongs to a different chat" };
    const result = await runJobNow(jobId);
    if (!result.ok) return { ok: false, error: result.error ?? "Run failed" };
    log("gateway", `run_cron_job: "${job.name}" [${jobId}]`);
    return { ok: true, text: `Ran job "${job.name}" (${jobId}) now.` };
  },

  delete_cron_job: (body, chatId, _backend, chatKey) => {
    const jobId = String(body.job_id ?? "");
    if (!jobId) return { ok: false, error: "Missing job_id" };
    const job = getCronJob(jobId);
    if (!job) return { ok: false, error: `Job ${jobId} not found` };
    if (job.chatId !== chatKey)
      return { ok: false, error: "Job belongs to a different chat" };
    deleteCronJob(jobId);
    return { ok: true, text: `Deleted cron job "${job.name}" (${jobId})` };
  },
};
