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

/** The activation prompt — the brief, framed as the job to start on. */
export function buildAgentPrompt(brief: string): string {
  return (
    `[System: AGENT BRIEF. Work this to a conclusion, then call ` +
    `report_result exactly once.]\n\n${brief}`
  );
}

/** Human time for an interruption stamp. */
function stamp(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/**
 * The note a resumed agent receives when its own backend conversation is
 * continued after a daemon restart. The transcript — brief, tool calls,
 * results — is intact above it, so this only says what happened and what
 * to be careful of.
 */
export function buildResumePrompt(args: {
  interruptedAt: number;
  elapsedMinutes: number;
}): string {
  return (
    `[System: You were interrupted by a daemon restart at ` +
    `${stamp(args.interruptedAt)} (about ${args.elapsedMinutes} min into ` +
    `your run). Your conversation so far is intact above — continue the ` +
    `brief from where you left off; do not start over. Anything that was ` +
    `mid-flight when the restart hit (a shell command, a build, a tool call ` +
    `with no result) may not have completed: check the actual state (files, ` +
    `git status, processes) before relying on it or repeating it. Call ` +
    `check_inbox — messages sent while you were down are still there. When ` +
    `you are done, call report_result exactly once.]`
  );
}

/**
 * The activation prompt for an interrupted agent whose backend cannot
 * resume a conversation: the original brief again, plus what the previous
 * attempt did (the tail of its run log) so it picks up rather than redoes.
 */
export function buildRebriefPrompt(args: {
  brief: string;
  interruptedAt: number;
  elapsedMinutes: number;
  logPath: string;
  logTail: string;
}): string {
  const tail = args.logTail.trim()
    ? `\n\nTail of the previous attempt's run log (full log: ` +
      `${args.logPath}):\n\n<previous-run-log>\n${args.logTail}\n` +
      `</previous-run-log>`
    : `\n\n(The previous attempt's run log is at ${args.logPath}.)`;
  return (
    `${buildAgentPrompt(args.brief)}\n\n` +
    `[System: RESUMED AFTER A DAEMON RESTART. You already worked on this ` +
    `brief for about ${args.elapsedMinutes} min before a daemon restart ` +
    `interrupted you at ${stamp(args.interruptedAt)}; this backend could not ` +
    `resume that conversation, so you are starting a new one. Do NOT start ` +
    `over: read what the previous attempt did below, inspect the state it ` +
    `left (files, branches, commits, processes) and continue from there. ` +
    `Call check_inbox — messages sent while you were down are still there.]` +
    tail
  );
}

/** Run-log separator written when a restarted agent resumes. */
export function agentResumeLogHeader(
  record: AgentRecord,
  model: string,
  interruptedAt: number,
  sessionId?: string,
): string {
  return (
    `\n\n---\n\n# resumed after daemon restart — ${new Date().toISOString()}\n` +
    `**Interrupted:** ${new Date(interruptedAt).toISOString()} ` +
    `**Backend:** ${record.backendId} **Model:** ${model} ` +
    `**Mode:** ${sessionId ? `session resume (${sessionId})` : "re-briefed"}\n\n`
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
