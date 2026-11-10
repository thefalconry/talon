/**
 * Claude SDK backend constants — thinking effort, streaming, and
 * chat-specific tool whitelist.
 *
 * Core whitelist lives in core/constants.ts (kept separate so the chat
 * additions live next to the rest of the chat-handler config).
 */

import { ALLOWED_TOOLS_CORE } from "../../core/constants.js";

// Re-export so existing backend imports keep working
/**
 * Whitelist of built-in tools available to the main chat handler.
 *
 * Chat gets two extras on top of the core whitelist:
 * - `Agent`: Claude Code's in-process sub-agent dispatch (Explore / Plan /
 *   etc.). Only offered when `allowNativeSubagents` is on (off by default
 *   — see NATIVE_SUBAGENT_TOOLS); the heartbeat path never offers it
 *   because nested agents complicate orphan tracking.
 * - `Skill`: required for `/skill` commands and other skill-driven flows.
 *   The SDK auto-includes Skill when `skills` are passed via options, but
 *   we list it explicitly so the tool surface is unambiguous from a single
 *   constants file.
 */
export const ALLOWED_TOOLS_CHAT = [
  ...ALLOWED_TOOLS_CORE,
  "Agent",
  "Skill",
] as const;

/**
 * Claude Code's own in-process sub-agent tool. The SDK names it `Agent`;
 * older Claude Code builds call the same tool `Task` (the SDK types still
 * refer to "the Agent/Task tool"). Both names are listed so the block holds
 * across SDK versions.
 *
 * These sub-agents live inside a single turn: when the turn ends they die
 * with no report, yet every tool call they made is billed. A model that
 * reaches for them instead of Talon's own `spawn_agent` (tracked, reported,
 * headroom-guarded) can burn a whole plan window for nothing, so they are
 * blocked by default — see `allowNativeSubagents` in the config.
 */
const NATIVE_SUBAGENT_TOOLS = ["Agent", "Task"] as const;

const NATIVE_SUBAGENT_TOOL_SET: ReadonlySet<string> = new Set(
  NATIVE_SUBAGENT_TOOLS,
);

/** True for a built-in tool name that is Claude Code's own sub-agent tool. */
export function isNativeSubagentTool(name: string): boolean {
  return NATIVE_SUBAGENT_TOOL_SET.has(name);
}

/**
 * The SDK `disallowedTools` entry for a run: the native sub-agent tools
 * unless the deployment opted back in. `disallowedTools` is applied on top
 * of the `tools` whitelist and also blocks harness-internal dispatch, so
 * it is the belt to the whitelist's braces.
 */
export function nativeSubagentDisallowedTools(
  allowNativeSubagents: boolean | undefined,
): string[] {
  return allowNativeSubagents ? [] : [...NATIVE_SUBAGENT_TOOLS];
}

// ── Thinking / effort configuration ────────────────────────────────────────

export const EFFORT_MAP: Record<
  string,
  {
    thinking: { type: "adaptive" | "disabled" };
    effort?: "low" | "medium" | "high" | "max";
  }
> = {
  off: { thinking: { type: "disabled" } },
  low: { thinking: { type: "adaptive" }, effort: "low" },
  medium: { thinking: { type: "adaptive" }, effort: "medium" },
  high: { thinking: { type: "adaptive" }, effort: "high" },
  max: { thinking: { type: "adaptive" }, effort: "max" },
};

// ── Streaming ──────────────────────────────────────────────────────────────

/** Minimum interval (ms) between streaming delta callbacks to avoid flooding frontends. */
export const STREAM_INTERVAL = 1000;

// ── Transcript retention ───────────────────────────────────────────────────

/**
 * Settings layered onto every Claude Code process Talon spawns, as the
 * SDK's `settings` option (the CLI's `--settings` flag).
 *
 * Claude Code runs a background retention sweep (at most once a day, shared
 * across every CLI process through `~/.claude/.last-cleanup`) that deletes
 * session transcripts in `~/.claude/projects` older than `cleanupPeriodDays`
 * — 30 days when nothing sets it. Talon resumes chats by session id, so a
 * swept transcript silently breaks a long-lived chat and loses its history.
 *
 * The user's own `~/.claude/settings.json` only applies while user settings
 * are loaded, the file parses, and HOME / CLAUDE_CONFIG_DIR match the
 * user's. Setting it per run removes that dependency. The CLI rejects 0 and
 * recommends a large value for long retention; 100000 days is effectively
 * forever. A managed policy-tier `cleanupPeriodDays` still takes precedence.
 */
export const CLAUDE_RETENTION_SETTINGS = {
  cleanupPeriodDays: 100_000,
} as const;
