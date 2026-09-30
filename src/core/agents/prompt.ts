/**
 * Pure helpers for a sub-agent run — its system prompt, its activation
 * prompt, its log path and the prompt headers its parent sees.
 *
 * Kept free of side effects (no fs, no backend, no registry) so the wording
 * every other subsystem asserts on is trivially unit-testable, and so the
 * runner stays about lifecycle.
 */

import { resolve } from "node:path";
import { dirs } from "../../util/paths.js";
import { loadSystemTemplate } from "../prompt/templates.js";
import type { AgentParent, AgentRecord } from "./types.js";

/** Where sub-agent run logs live: `~/.talon/workspace/logs/agents/`. */
const AGENT_LOGS_DIR = resolve(dirs.logs, "agents");

/** Absolute path of one agent's run log. */
export function agentLogPath(agentId: string): string {
  return resolve(AGENT_LOGS_DIR, `${agentId}.md`);
}

/** How a parent is named to its child and in wake prompts. */
export function describeParent(parent: AgentParent): string {
  return parent.kind === "chat"
    ? `chat ${parent.chatId}`
    : `sub-agent ${parent.agentId}`;
}

/**
 * The agent's system prompt: who it is, how to report, how to talk to its
 * parent, and what it may not do. The brief itself is the *user* prompt —
 * same split as the isolated cron/trigger jobs, so the framing half stays
 * identical (and cacheable) across every run.
 */
export function buildAgentSystemPrompt(args: {
  agentId: string;
  label: string;
  parent: AgentParent;
  depth: number;
  maxDepth: number;
}): string {
  return loadSystemTemplate("agent-brief", {
    agentId: args.agentId,
    label: args.label,
    parent: describeParent(args.parent),
    depth: String(args.depth),
    maxDepth: String(args.maxDepth),
    canSpawn: args.depth < args.maxDepth ? "yes" : "",
  });
}

/**
 * The standing pre-flight instruction appended to a PR-opening agent's
 * brief: run the light CI suite locally, push only on green. GitHub then
 * confirms a change instead of being the first compiler it meets.
 */
const PREFLIGHT_INSTRUCTION =
  "[Pre-flight lane] Before every `git push`, run `npm run preflight` in " +
  "the repo (or call the run_preflight tool with cwd set to your checkout). " +
  "Push only when it is green. If it is red, fix it — or, when a failure " +
  "is genuinely out of scope, say in the PR body which step failed and why " +
  "you pushed anyway.";

/** A brief that opens, updates or talks about a pull request. */
const PR_BRIEF = /\bPRs?\b|pull[ -]requests?/i;

/**
 * Whether a spawn gets the pre-flight instruction: the caller's explicit
 * choice when given, otherwise on for any brief that mentions a PR.
 */
export function wantsPreflight(brief: string, explicit?: boolean): boolean {
  return explicit ?? PR_BRIEF.test(brief);
}

/** The activation prompt — the brief, framed as the job to start on. */
export function buildAgentPrompt(
  brief: string,
  options: { preflight?: boolean } = {},
): string {
  const lane = options.preflight ? `\n\n${PREFLIGHT_INSTRUCTION}` : "";
  return (
    `[System: AGENT BRIEF. Work this to a conclusion, then call ` +
    `report_result exactly once.]\n\n${brief}${lane}`
  );
}

/** Header line of a run log. */
export function agentLogHeader(record: AgentRecord, model: string): string {
  return (
    `# sub-agent ${record.id} "${record.label}" — ${new Date().toISOString()}\n` +
    `**Parent:** ${describeParent(record.parent)} ` +
    `**Backend:** ${record.backendId} **Model:** ${model} ` +
    `**Depth:** ${record.depth}\n\n` +
    `## Brief\n\n${record.brief}\n\n`
  );
}

/** One-line token summary for the report a parent chat is woken with. */
function usageLine(record: AgentRecord): string {
  const usage = record.usage;
  if (!usage) return "";
  return (
    `\n\nTokens: in=${usage.inputTokens} out=${usage.outputTokens} ` +
    `cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite}`
  );
}

/**
 * The wake prompt a parent chat receives when one of its agents settles.
 * Shaped like the trigger wake-up: a `[System: …]` header telling the model
 * what this is and that it must decide what to do, then the payload.
 */
export function buildSettlementPrompt(record: AgentRecord): string {
  const body = record.result
    ? record.result.details
      ? `${record.result.summary}\n\n${record.result.details}`
      : record.result.summary
    : (record.error ?? "(the agent produced no result)");
  const duration = record.endedAt
    ? Math.round(
        (record.endedAt - (record.startedAt ?? record.createdAt)) / 1000,
      )
    : 0;
  return (
    `[System: AGENT FINISHED. Sub-agent ${record.id} "${record.label}" ` +
    `ended as "${record.state}" after ${duration}s. This is the report from ` +
    `an agent you spawned earlier. Decide whether to act on it, tell the ` +
    `user, or do nothing.]\n\n` +
    `[Agent "${record.label}" (${record.id}) — ${record.state}]\n\n` +
    `${body}${usageLine(record)}`
  );
}

/** The wake prompt for an interim `message_parent` note. */
export function buildMessagePrompt(record: AgentRecord, text: string): string {
  return (
    `[System: AGENT MESSAGE from ${record.id} "${record.label}". ` +
    `This is an interim note from an agent you spawned; it is still ` +
    `running. Decide whether to act, reply with send_to_agent, or do ` +
    `nothing.]\n\n${text}`
  );
}
