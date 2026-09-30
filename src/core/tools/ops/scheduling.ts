/**
 * Scheduling tools — cron CRUD and scheduled message cancellation.
 */

import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const schedulingTools: ToolDefinition[] = [
  {
    name: "cancel_scheduled",
    description: "Cancel a scheduled message.",
    schema: { schedule_id: z.string() },
    execute: (params, bridge) => bridge("cancel_scheduled", params),
    frontends: ["telegram", "discord", "whatsapp"],
    tag: "scheduling",
  },

  {
    name: "list_scheduled",
    description:
      "List pending scheduled messages in this chat (id, seconds until send, text). Scheduled messages persist across restarts.",
    schema: {},
    execute: (_params, bridge) => bridge("list_scheduled", {}),
    frontends: ["telegram", "discord", "whatsapp"],
    tag: "scheduling",
  },

  {
    name: "create_cron_job",
    description: `Create a persistent scheduled job. Jobs survive restarts.

Cadence — give EXACTLY ONE of:
  • schedule: a 5-field cron expression "minute hour day month weekday"
      "0 9 * * *"     = every day at 9:00 AM
      "30 14 * * 1-5" = weekdays at 2:30 PM
      "*/15 * * * *"  = every 15 minutes
      "0 8 * * 1"     = every Monday at 8:00 AM
  • every_seconds: a fixed interval in seconds (≥ 60), e.g. 5400 = every 90 min.

Type "message" sends the content as a text message.
Type "query" runs the content as a Claude prompt with full tool access, as an ISOLATED one-shot — its own session, no chat history. So a "query" cron job never touches the chat session, and may run on a cheaper model or a different provider.

Lifecycle (all optional):
  • once: true        — run a single time, then auto-disable (a one-shot). For "run at 3pm tomorrow", pair a cron/interval that next fires then with once.
  • max_runs: N       — auto-disable after N runs.
  • start_at / end_at — ISO-8601 timestamp (or epoch ms). Don't fire before start_at; auto-disable after end_at.
  • catchup           — what to do with runs missed while Talon was down: "once" (default — one catch-up run), "skip" (drop missed runs), or "all" (replay each missed run, capped).
  • timeout_seconds   — hard time limit for one run of a "query" job (default 600, max 14400). Raise it for long tasks such as waiting on CI before merging.

A failed run counts toward max_runs, so a one-shot that fails is retired (with an alert) rather than left to fire again at the next matching time.

Model: leave "model"/"provider" unset to use this chat's model. Set "model" for a valid model on this chat's backend, or set both "provider" and "model" for another backend that supports isolated jobs. "instructions" can provide a short system brief for query jobs.`,
    schema: {
      name: z.string().describe("Human-readable name for the job"),
      schedule: z
        .string()
        .optional()
        .describe(
          "Cron expression (5-field: minute hour day month weekday). Provide this OR every_seconds, not both.",
        ),
      every_seconds: z
        .number()
        .optional()
        .describe(
          "Fixed interval in seconds (≥ 60). Provide this OR schedule, not both.",
        ),
      type: z
        .enum(["message", "query"])
        .describe(
          "Job type: 'message' sends text, 'query' runs a Claude prompt",
        ),
      content: z.string().describe("Message text or query prompt"),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone (e.g. 'America/New_York') for cron schedules. Defaults to system timezone.",
        ),
      once: z
        .boolean()
        .optional()
        .describe("Run only once, then auto-disable (sugar for max_runs: 1)."),
      max_runs: z
        .number()
        .optional()
        .describe("Auto-disable after this many runs."),
      start_at: z
        .string()
        .optional()
        .describe("Don't fire before this ISO-8601 timestamp (or epoch ms)."),
      end_at: z
        .string()
        .optional()
        .describe(
          "Auto-disable after this ISO-8601 timestamp (or epoch ms). Must be in the future.",
        ),
      catchup: z
        .enum(["skip", "once", "all"])
        .optional()
        .describe(
          "Missed-run policy for downtime: once (default — one catch-up run), skip, or all (capped).",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Optional model override for 'query' jobs. Unset = this chat's model. Since cron runs isolated, this may be a cheaper model — on this chat's backend, or (with 'provider') a different one. Call list_models to see valid ids.",
        ),
      provider: z
        .string()
        .optional()
        .describe(
          "Optional backend/provider id for the 'query' override (e.g. a cheaper provider). Requires 'model'. Unset = this chat's backend. Call list_backends to see ids.",
        ),
      instructions: z
        .string()
        .optional()
        .describe(
          "Optional short brief for the isolated run — what the job is and how to do it. Becomes the run's system prompt; recommended when using a cheaper override model.",
        ),
      timeout_seconds: z
        .number()
        .optional()
        .describe(
          "Hard time limit for one run of a 'query' job, in seconds (60–14400). Unset = 600.",
        ),
    },
    execute: (params, bridge) => bridge("create_cron_job", params),
    tag: "scheduling",
  },

  {
    name: "list_cron_jobs",
    description:
      "List all cron jobs in the current chat: status, schedule (cron or interval), run count, last-run outcome, next run time, and any bounds (run cap, start/end window, catch-up policy, model).",
    schema: {},
    execute: (_params, bridge) => bridge("list_cron_jobs", {}),
    tag: "scheduling",
  },

  {
    name: "edit_cron_job",
    description:
      "Edit an existing cron job. Only provide the fields you want to change. Setting schedule switches to cron mode; setting every_seconds switches to interval mode. Pass an empty string to start_at/end_at/max_runs/model/provider/instructions to clear it.",
    schema: {
      job_id: z.string().describe("Job ID to edit"),
      name: z.string().optional().describe("New name"),
      schedule: z
        .string()
        .optional()
        .describe("New cron expression (switches to cron mode)"),
      every_seconds: z
        .number()
        .optional()
        .describe("New interval in seconds (≥ 60; switches to interval mode)"),
      type: z.enum(["message", "query"]).optional().describe("New job type"),
      content: z.string().optional().describe("New content"),
      enabled: z.boolean().optional().describe("Enable or disable the job"),
      timezone: z.string().optional().describe("New IANA timezone"),
      once: z
        .boolean()
        .optional()
        .describe("Make it a one-shot (max_runs: 1)."),
      max_runs: z
        .number()
        .optional()
        .describe("New run cap (empty string clears it)."),
      start_at: z
        .string()
        .optional()
        .describe("New start time (ISO-8601/epoch ms; empty clears)."),
      end_at: z
        .string()
        .optional()
        .describe("New end time (ISO-8601/epoch ms; empty clears)."),
      catchup: z
        .enum(["skip", "once", "all"])
        .optional()
        .describe("New missed-run policy."),
      model: z
        .string()
        .optional()
        .describe("New model override (empty string clears it)."),
      provider: z
        .string()
        .optional()
        .describe("New backend/provider override (empty string clears it)."),
      instructions: z
        .string()
        .optional()
        .describe("New isolated-run system brief (empty string clears it)."),
      timeout_seconds: z
        .number()
        .optional()
        .describe(
          "New per-run time limit for a 'query' job, in seconds (60–14400).",
        ),
    },
    execute: (params, bridge) => bridge("edit_cron_job", params),
    tag: "scheduling",
  },

  {
    name: "run_cron_job",
    description:
      "Run a cron job right now, ignoring its schedule (for testing or an ad-hoc run). The run is recorded like a scheduled one, so a one-shot job will retire after it.",
    schema: {
      job_id: z.string().describe("Job ID to run now"),
    },
    execute: (params, bridge) => bridge("run_cron_job", params),
    tag: "scheduling",
  },

  {
    name: "delete_cron_job",
    description: "Delete a cron job permanently.",
    schema: {
      job_id: z.string().describe("Job ID to delete"),
    },
    execute: (params, bridge) => bridge("delete_cron_job", params),
    tag: "scheduling",
  },
];
