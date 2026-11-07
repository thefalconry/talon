/**
 * Trigger tools — bot-authored watcher scripts that wake the bot on demand.
 *
 * Triggers are long-running supervised subprocesses written by the model
 * itself. They poll, watch, or wait for arbitrary conditions and signal
 * back via a stdout protocol or by exiting. Each fire wakes the bot with
 * a system message containing the trigger's payload, so it can decide
 * whether to message the user, take an action, or do nothing.
 */

import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const TRIGGER_DESCRIPTION = `Create a long-running watcher script. The script runs as a supervised
subprocess and signals back via stdout or its exit code.

Stdout protocol:
  - A line starting with "TALON_FIRE: <text>" fires a wake-up immediately
    (the script keeps running). Use this for watchers that emit multiple
    events.
  - Exiting 0 fires a final wake-up with the tail of stdout/stderr as the
    payload.
  - Exiting non-zero fires an error wake-up with the exit code and log tail.
  - Hard timeout (default 24h, max 7d) kills the script and fires a
    "timed_out" wake-up.

Languages: "bash", "python", "node", "lua".

Lua is special: it runs in a WASM sandbox (Lua 5.4) with NO host filesystem,
network, environment, or subprocess access — io/os only see an in-memory FS.
A "talon" table provides the host API: talon.fire(text) emits a TALON_FIRE
wake-up, talon.log(text) writes to the run log, talon.sleep(ms) sleeps.
print() is safe and cannot forge the fire protocol. Pick lua for
pure-compute or timer-driven logic; pick bash/python/node when the watcher
needs network or file access.

Examples:
  bash, name="pr-merge-watch":
    while [ "$(gh pr view 35337 --json state -q .state)" != "MERGED" ]; do
      sleep 60
    done
    echo "PR #35337 merged"

  python, name="poly-iran-swing" (mid-run multi-fire):
    import time, json, subprocess
    start = float(get_price())
    while True:
      px = float(get_price())
      if abs(px - start) / start > 0.05:
        print(f"TALON_FIRE: price moved to {px}", flush=True)
        start = px
      time.sleep(120)

The script is killed if Talon shuts down. Set persistent=true to respawn it
automatically on the next Talon start — only triggers interrupted by
shutdown/crash are respawned (not ones that exited on their own), the
script must be safe to re-run from scratch, and timeout_seconds is ignored
(persistent triggers run until cancelled or until Talon shuts down).

Wake mode. By default (mode="chat") every wake-up resumes THIS chat's session,
so the handling turn sees the whole conversation — and pays to re-read it.
For frequent, mechanical events set mode="isolated": each wake then runs as an
isolated one-shot job (like a cron "query" job) — its own session, NO chat
history, the event payload as the task and "instructions" as its system brief
(e.g. "Follow skill X. Message the user only if Y."). The isolated run reaches
the chat only by calling the messaging tools with this chat's chat_id; if it
sends nothing, the chat sees nothing. It may run on a cheaper model or another
provider (model/provider, same rules as create_cron_job). One run per trigger
at a time: fires that arrive during a run are coalesced into one follow-up run
(duplicates collapsed, at most 20 queued). A skipped/failed run posts one
short notice to the chat (at most every 30 min). Use chat mode when the wake
needs conversation context; isolated when the instructions are self-contained.

Per-chat cap on active triggers (default 5; config triggers.maxActivePerChat,
with an optional separate triggers.maxPersistentPerChat budget).`;

export const triggerTools: ToolDefinition[] = [
  {
    name: "trigger_create",
    description: TRIGGER_DESCRIPTION,
    schema: {
      name: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "Short identifier, unique per chat (letters, digits, space, dot, dash, underscore)",
        ),
      language: z
        .enum(["bash", "python", "node", "lua"])
        .describe(
          "Interpreter to run the script under (lua = WASM-sandboxed, no host access)",
        ),
      script: z
        .string()
        .min(1)
        .describe(
          "The full script body. Stdout is monitored for TALON_FIRE: lines.",
        ),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Hard kill timeout in seconds. Default 86400 (24h), max 604800 (7d).",
        ),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("Human-readable note about what the trigger watches for"),
      persistent: z
        .boolean()
        .optional()
        .describe(
          "If true, respawn this trigger automatically when Talon restarts. Default false.",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Optional model override for the wake-up turn. Unset = this chat's model (preferred). mode=\"chat\": set only when the wake-up handling is mechanical and a cheaper model from the SAME backend suffices; the wake-up still resumes this chat's session, so it must be a selectable model id on this chat's backend (cross-backend ids are rejected). mode=\"isolated\": any model valid on the run's backend (this chat's, or 'provider' when set). Call list_models to see valid ids.",
        ),
      mode: z
        .enum(["chat", "isolated"])
        .optional()
        .describe(
          'Where wake-ups run. "chat" (default) resumes this chat\'s session with full history. "isolated" runs each wake as a one-shot job with no chat history (cheap for frequent events); it delivers only via messaging tools with an explicit chat_id.',
        ),
      instructions: z
        .string()
        .max(4000)
        .optional()
        .describe(
          'mode="isolated" only: system brief for every wake run — what to do with an event and when to message the user (e.g. "Follow skill szufla-wake."). The run has no chat history, so make it self-contained.',
        ),
      provider: z
        .string()
        .optional()
        .describe(
          "mode=\"isolated\" only: backend/provider id to run wakes on (requires 'model'). Unset = this chat's backend, possibly routed to one with more plan headroom. Call list_backends to see ids.",
        ),
      wake_timeout_seconds: z
        .number()
        .int()
        .min(30)
        .max(3600)
        .optional()
        .describe(
          'mode="isolated" only: hard time limit per wake run, in seconds (30-3600). Default 600.',
        ),
    },
    execute: (params, bridge) => bridge("trigger_create", params),
    tag: "triggers",
  },

  {
    name: "trigger_list",
    description:
      "List all triggers in the current chat with their status, runtime, and fire count.",
    schema: {},
    execute: (_params, bridge) => bridge("trigger_list", {}),
    tag: "triggers",
  },

  {
    name: "trigger_cancel",
    description:
      "Cancel a running trigger (sends SIGTERM, then SIGKILL after 5s grace).",
    schema: {
      trigger_id: z.string().describe("Trigger ID to cancel"),
    },
    execute: (params, bridge) => bridge("trigger_cancel", params),
    tag: "triggers",
  },

  {
    name: "trigger_logs",
    description:
      "Read the tail of a trigger's run log (interleaved stdout + stderr, exit markers).",
    schema: {
      trigger_id: z.string().describe("Trigger ID to read logs for"),
      lines: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Number of trailing lines to return (default 80, max 500)"),
    },
    execute: (params, bridge) => bridge("trigger_logs", params),
    tag: "triggers",
  },

  {
    name: "trigger_delete",
    description:
      "Delete a trigger. Cancels it first if running, then removes its script and log from disk.",
    schema: {
      trigger_id: z.string().describe("Trigger ID to delete"),
    },
    execute: (params, bridge) => bridge("trigger_delete", params),
    tag: "triggers",
  },
];
