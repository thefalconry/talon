/**
 * Codex backend constants.
 */

import { buildDeliveryContract } from "../runtime/prompt/delivery-contract.js";

/**
 * System-prompt suffix appended to the user-configured system prompt.
 *
 * Codex delivery model: the agent's reply comes back as `agent_message`
 * thread items + `thread.runStreamed` events. Talon ships the final
 * `agent_message` content via `onTextBlock` after the turn closes.
 * Delivery tools (`end_turn` / `send` / `react`) work via MCP — the
 * agent's `mcp_tool_call` items route through Talon's MCP server.
 *
 * Both routes are valid — the shared text-or-tools contract
 * (prompts/system/contract-text-or-tools.md) documents the choice.
 * Tool names are frontend-specific (native's send tool is
 * send_message, telegram's is send), so the suffix is built per chat
 * from the chat's owning frontend.
 */
export function codexSystemPromptSuffix(frontend: string): string {
  return `\n\n${buildDeliveryContract("text-or-tools", frontend)}\n`;
}

/** Telegram-shaped default, kept for tests and legacy callers. */
export const CODEX_SYSTEM_PROMPT_SUFFIX = codexSystemPromptSuffix("telegram");

/**
 * Default model used by the Codex backend when none is configured AND
 * API-key billing is present (`CODEX_API_KEY`, `TALON_CODEX_KEY`,
 * `codexApiKey`, or a last-resort generic OpenAI key). The
 * `gpt-5-codex` model is the highest-quality coding model available
 * through Codex on OpenAI's native endpoint but requires API-key
 * billing — it is not granted to ChatGPT subscription accounts.
 */
export const CODEX_DEFAULT_MODEL = "gpt-5-codex";

/**
 * Last-resort default model for the Codex backend when the user is signed
 * in via ChatGPT OAuth (`~/.codex/auth.json` `auth_mode: "chatgpt"`).
 * The `gpt-5-codex` model is rejected with a 400 `invalid_request_error`
 * ("not supported when using Codex with a ChatGPT account") on this auth
 * path.
 *
 * This is only the floor of the resolution ladder — see
 * `getCodexChatGptDefaultModel()` in `models.ts`, which prefers (1) an
 * explicit operator override, then (2) the Codex CLI's own default for the
 * signed-in account (the first listed model in `~/.codex/models_cache.json`
 * by priority). `gpt-6-astra` is the first entry of the model catalog
 * bundled with codex-cli 0.154. The previous value, `gpt-5.5`, was retired
 * for ChatGPT accounts in Sep 2026: every run on it returned
 * `404 The model gpt-5.5 does not exist or you do not have access to it`.
 */
export const CODEX_CHATGPT_DEFAULT_MODEL = "gpt-6-astra";

/**
 * Environment override for the ChatGPT-OAuth default model. Takes
 * precedence over the `codexChatGptDefaultModel` config key.
 */
export const CODEX_CHATGPT_MODEL_ENV = "TALON_CODEX_CHATGPT_MODEL";

/**
 * ThreadOptions permission settings shared by both the chat handler and
 * the heartbeat/dream one-shot path.
 *
 * Talon runs Codex with full permissions — `approvalPolicy: "never"`,
 * `sandboxMode: "danger-full-access"`, and `networkAccessEnabled: true`.
 * Codex is non-interactive in this harness (no UI to surface approval
 * prompts on), and Talon already trusts every other backend (Claude SDK,
 * OpenAI Agents, Kilo, OpenCode) with the same level of
 * access — `bypassPermissions` + `allowDangerouslySkipPermissions: true`
 * is the equivalent in the Claude SDK backend. Restricting Codex more
 * tightly than its sibling backends would just produce silent failures
 * on shell / file / network tool calls without changing the security
 * model: the bot-user identity (claudiusthebot, isolated VPS account,
 * no credentials to user-level data) is the actual security boundary.
 *
 *   - `approvalPolicy: "never"`         — Codex never asks for approval
 *                                         on its native commands
 *                                         (bash, apply_patch, etc).
 *   - `sandboxMode: "danger-full-access"` — full disk + network access
 *                                         inside Codex's sandbox.
 *   - `networkAccessEnabled: true`      — explicit, in case Codex ever
 *                                         defaults the boolean.
 *
 * MCP tool calls have their own approval surface (`AppToolApproval`
 * enum, `default_tools_approval_mode` per server) which Talon also
 * sets to `"approve"` in `mcp-config.ts`.
 */
export const CODEX_THREAD_PERMISSIONS = {
  approvalPolicy: "never" as const,
  sandboxMode: "danger-full-access" as const,
  networkAccessEnabled: true,
} satisfies {
  approvalPolicy: "never";
  sandboxMode: "danger-full-access";
  networkAccessEnabled: boolean;
};

/**
 * Minimum interval between mid-turn rollout JSONL polls for live /status
 * stats. Each poll reverse-scans one file (~O(1) in the common case);
 * 1.5s keeps the stats fresh per API call (calls take 5–30s) without
 * measurable I/O cost on long agentic turns.
 */
export const CODEX_LIVE_POLL_INTERVAL_MS = 1500;
