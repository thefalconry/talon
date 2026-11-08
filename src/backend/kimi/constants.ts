/**
 * Moonshot Kimi Code CLI (`kimi`) backend constants.
 *
 * The CLI is Moonshot AI's Kimi Code CLI driven in non-interactive prompt
 * mode (`kimi -p <prompt> --output-format stream-json`). Talon drives each turn
 * with `-p` and maintains session continuity using `-S <session_id>` or `--session <session_id>`.
 */

import { buildDeliveryContract } from "../runtime/prompt/delivery-contract.js";

/**
 * System-prompt suffix appended to the user-configured system prompt.
 *
 * Kimi has no system-prompt CLI flag, so the assembled prompt rides
 * in as a fenced block on the FIRST turn of a conversation (see
 * `handler/message.ts`); resumed conversations inherit it from their
 * stored history.
 *
 * The contract is `text-only`: kimi reads MCP servers only from shared
 * `mcp.json` files and has no per-process MCP flag, so Talon's frontend
 * tools (`end_turn`, `send`, `react`, ...) are not wired into it, and
 * the prompt must not tell the model to call them.
 */
export function kimiSystemPromptSuffix(frontend: string): string {
  return `\n\n${buildDeliveryContract("text-only", frontend)}\n`;
}

/** Telegram-shaped default, kept for the one-shot path and tests. */
export const KIMI_SYSTEM_PROMPT_SUFFIX = kimiSystemPromptSuffix("telegram");

/**
 * Default model when none is configured.
 * Matches default_model in ~/.kimi-code/config.toml.
 */
export const KIMI_DEFAULT_MODEL = "openrouter/moonshotai/kimi-k3";

/** Minimum `kimi --version` the backend is known to work against. */
export const KIMI_MIN_VERSION = "2.0.0";

/**
 * Env var every spawned `kimi` carries, set to its chat id or one-shot
 * context label. kimi's argv holds only the prompt and flags, so this tag
 * is what lets the orphan sweep find a leaked run by its label.
 */
export const KIMI_RUN_LABEL_ENV = "TALON_KIMI_RUN_LABEL";

/** Grace between SIGTERM and SIGKILL when tearing a child down. */
export const KIMI_KILL_GRACE_MS = 2000;

/**
 * Fixed CLI flags every prompt run is spawned with.
 */
export const KIMI_BASE_ARGS: readonly string[] = [
  "--output-format",
  "stream-json",
];
