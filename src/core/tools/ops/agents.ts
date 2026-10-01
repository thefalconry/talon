/**
 * Sub-agent tools — delegate work to isolated agents and talk to them.
 *
 * Two halves. The **parent** half (`spawn_agent`, `list_agents`,
 * `agent_status`, `wait_for_agent`, `send_to_agent`, `kill_agent`) is what a
 * chat turn — or an agent that is itself delegating — uses. The **agent**
 * half (`report_result`, `message_parent`, `check_inbox`) only works inside a
 * sub-agent run; called from a chat it is refused, because there is no parent
 * to report to.
 *
 * Talon owns the mechanism, not the backend: a sub-agent is an isolated
 * one-shot run, so this works identically on Claude, Codex, Kilo and
 * OpenCode, and a chat on one backend can spawn an agent on another.
 */

import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const SPAWN_DESCRIPTION = `Delegate a self-contained piece of work to a sub-agent and keep working.

The agent runs isolated: its own backend, model, context window and tool
surface, no conversation history, only the brief you write. It reports back
by calling report_result, which wakes this chat with a system message
carrying its summary — you do NOT have to wait for it.

Write the brief as if to a capable colleague who knows nothing about this
conversation: the objective, the context they need, what "done" looks like,
and what to report. Everything they should know must be in the brief.

Good uses: research that would flood this context, a long build/test/verify
loop, several independent investigations at once, work that should run on a
different model than this chat.

Bad uses: anything needing a back-and-forth with the user, trivial work you
could do in one tool call, or work whose result you need in the next second
(spawning costs a model cold-start).

Backend and model default to the caller's (a sub-agent's own children
inherit its backend and model); pass them to put the agent somewhere else (e.g. a cheap model for a mechanical sweep, or a backend with
a bigger context window). Returns the agent id immediately.`;

export const agentTools: ToolDefinition[] = [
  {
    name: "spawn_agent",
    description: SPAWN_DESCRIPTION,
    schema: {
      brief: z
        .string()
        .min(1)
        .describe(
          "The full instructions for the agent. Self-contained: it has no history, only this.",
        ),
      label: z
        .string()
        .min(1)
        .max(48)
        .describe(
          "Short content-free name for listings and logs (e.g. 'pr-triage', 'docs-audit'). Never message content.",
        ),
      backend: z
        .string()
        .optional()
        .describe(
          "Backend id to run on. Unset = inherit: an agent's children run on its own backend and model; a chat's spawns start from the chat's backend (and may be routed to one with more headroom). Must have a background capability and, when the deployment sets agents.allowedBackends, be on that list.",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Model id on the chosen backend. Unset = the parent agent's model when the backend is inherited from one, else that backend's default model. Call list_models for valid ids.",
        ),
      effort: z
        .enum(["minimal", "low", "medium", "high", "xhigh"])
        .optional()
        .describe(
          "Reasoning effort, where the backend has that knob (Claude, Codex). Ignored elsewhere.",
        ),
      timeout_s: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Hard wall-clock cap in seconds (default 900, min 30, max 3600). On timeout the agent is aborted and you are told.",
        ),
      preflight: z
        .boolean()
        .optional()
        .describe(
          "Tell the agent to run the pre-flight lane (`npm run preflight` / run_preflight) before every git push and push only on green. Default: on when the brief mentions a PR, off otherwise.",
        ),
    },
    execute: (params, bridge) => bridge("spawn_agent", params),
    tag: "agents",
  },

  {
    name: "list_agents",
    description:
      "List this chat's sub-agents (descendants included) with their state, backend, model, age and whether a result is available.",
    schema: {},
    execute: (_params, bridge) => bridge("list_agents", {}),
    tag: "agents",
  },

  {
    name: "agent_status",
    description:
      "Full status of one sub-agent: state, backend/model, timings, inbox depth, children, and its result or error once it has settled.",
    schema: {
      agent_id: z.string().describe("Agent id returned by spawn_agent"),
    },
    execute: (params, bridge) => bridge("agent_status", params),
    tag: "agents",
  },

  {
    name: "wait_for_agent",
    description:
      "Block until one agent settles, or until the timeout — whichever comes first. This is a convenience for short waits only: the primary completion channel is the wake-up message the agent's report triggers, which arrives whether or not anyone is waiting. Prefer finishing your turn and letting the report wake you; use this only when the very next thing you do depends on the answer.",
    schema: {
      agent_id: z.string().describe("Agent id to wait on"),
      timeout_s: z
        .number()
        .int()
        .positive()
        .max(120)
        .optional()
        .describe(
          "Seconds to wait (default 60, max 120). Returns the current state on timeout.",
        ),
    },
    execute: (params, bridge) => bridge("wait_for_agent", params),
    tag: "agents",
  },

  {
    name: "send_to_agent",
    description:
      "Put an instruction in a running agent's inbox. The agent sees it the next time it calls check_inbox — this is not an interrupt, so do not expect an immediate change of course.",
    schema: {
      agent_id: z.string().describe("Agent id to message"),
      text: z.string().min(1).describe("The instruction or context to send"),
    },
    execute: (params, bridge) => bridge("send_to_agent", params),
    tag: "agents",
  },

  {
    name: "kill_agent",
    description:
      "Abort a running agent. It settles as 'killed' and you are still told — with whatever it had reported before it died.",
    schema: {
      agent_id: z.string().describe("Agent id to abort"),
    },
    execute: (params, bridge) => bridge("kill_agent", params),
    tag: "agents",
  },

  // ── Agent-side: only valid inside a sub-agent run ─────────────────────────

  {
    name: "report_result",
    description:
      "Sub-agents only. Report your result to whoever spawned you. Call this exactly once, when you are done — it is the ONLY channel your result reaches your parent through. Reporting a failure with what you tried is a valid result; silence is not. Calling this outside a sub-agent run is an error.",
    schema: {
      summary: z
        .string()
        .min(1)
        .describe(
          "A few sentences your parent can act on: what you found or did.",
        ),
      details: z
        .string()
        .optional()
        .describe("Optional evidence: paths, commands, numbers, excerpts."),
    },
    execute: (params, bridge) => bridge("report_result", params),
    tag: "agents",
  },

  {
    name: "message_parent",
    description:
      "Sub-agents only. Send an interim note to whoever spawned you — a finding worth acting on now, a question, or a heads-up. It wakes them, so use it sparingly. It does not end your run and does not count as your result.",
    schema: {
      text: z.string().min(1).describe("The note to send"),
    },
    execute: (params, bridge) => bridge("message_parent", params),
    tag: "agents",
  },

  {
    name: "list_peers",
    description:
      "Sub-agents only. List the other agents your parent spawned alongside you — id, label and what each is working on. These are the only agents you may message directly with message_peer. Call it before assuming you are working alone.",
    schema: {},
    execute: (params, bridge) => bridge("list_peers", params),
    tag: "agents",
  },

  {
    name: "message_peer",
    description:
      "Sub-agents only. Send a note straight to a peer — an agent spawned by the same parent as you — without routing it through your parent. Use it when you find something that changes another agent's work: a shared fact, a dead end worth not repeating, a correction to something you sent earlier. The peer sees it at its next check_inbox, so it is not an interrupt. You can only address peers (see list_peers); any other id is refused. This does not end your run and does not replace report_result.",
    schema: {
      agent_id: z.string().describe("Peer agent id, from list_peers"),
      text: z.string().min(1).describe("What the peer needs to know"),
    },
    execute: (params, bridge) => bridge("message_peer", params),
    tag: "agents",
  },

  {
    name: "check_inbox",
    description:
      "Sub-agents only. Drain anything sent to you — instructions from your parent, and notes from peer agents working alongside you. Each message names its sender. Messages are delivered no other way, so check at milestones: after a phase of work, before a long operation, and before you report.",
    schema: {},
    execute: (_params, bridge) => bridge("check_inbox", {}),
    tag: "agents",
  },
];

/**
 * The pre-flight lane tool. Its own list so it can be appended at the END of
 * ALL_TOOLS (the prompt-cache prefix) rather than beside the agent family.
 */
export const preflightTools: ToolDefinition[] = [
  {
    name: "run_preflight",
    description:
      "Run the pre-flight lane (`npm run preflight`: typecheck, lint, format, architecture/knip/ratchet gates, the unit tests touched by your diff, gitleaks) in a talon checkout on the daemon host and get its verdict. Run it before every `git push` on a PR branch and push only when it is GREEN; a RED result lists each failing step with the tail of its log. Takes a few minutes (hard cap 10). Needs node_modules in the checkout: make worktrees with `node scripts/worktree.mjs add <path> <branch>` (hardlinked shared install, ~0 extra disk) rather than `npm ci`.",
    schema: {
      cwd: z
        .string()
        .optional()
        .describe(
          "Path inside the checkout to check (its git root is used), e.g. /tmp/fix-foo. Defaults to the workspace.",
        ),
    },
    execute: (params, bridge) => bridge("run_preflight", params),
    tag: "agents",
  },
];
