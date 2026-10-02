/**
 * Module-level state for the Claude SDK backend.
 *
 * Owns the mutable config and bridge port references and exposes
 * initialization functions + internal getters for sibling modules.
 */

import type { TalonConfig } from "../../core/config/index.js";
import { getModels } from "../../core/models/catalog.js";
import { registerClaudeModels } from "./models/index.js";
import {
  DEFAULT_CLAUDE_ACCOUNT,
  sdkEnvFor,
  type ClaudeRunAccount,
} from "./accounts/account.js";

// ── State ────────────────────────────────────────────────────────────────────

let config: TalonConfig | undefined;
let bridgePortFn: () => number = () => 19876;

// ── Public API (re-exported from barrel) ────────────────────────────────────

/**
 * Initialise the Claude SDK driver. Every Claude account's backend calls
 * this with the same config; the module state it sets is account-neutral
 * (the account itself travels with each run — see accounts/account.ts).
 */
export async function initAgent(
  cfg: TalonConfig,
  getBridgePort?: () => number,
  account: ClaudeRunAccount = DEFAULT_CLAUDE_ACCOUNT,
): Promise<void> {
  config = cfg;
  if (getBridgePort) bridgePortFn = getBridgePort;

  // The Agent SDK spawns an embedded Claude Code subprocess.
  // If CLAUDECODE is set (e.g. running from a Claude Code terminal),
  // the subprocess refuses to start with a nested-session error that
  // gets swallowed — causing an infinite hang on Windows.
  delete process.env.CLAUDECODE;

  // The model catalog is the same for every account: an extra account
  // booting after another Claude backend reuses what that one discovered
  // rather than spawning its own probes.
  if (account.configDir && getModels("anthropic").length > 0) return;

  // Discover available models from the SDK — fatal if this fails
  const env = sdkEnvFor(account);
  await registerClaudeModels({
    model: cfg.model,
    cwd: cfg.workspace,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(cfg.claudeBinary
      ? { pathToClaudeCodeExecutable: cfg.claudeBinary }
      : {}),
    ...(env ? { env } : {}),
  });
}

/** Update the system prompt on the live config. Used by plugin hot-reload
 *  so the next message picks up new plugin tool descriptions. */
export function updateSystemPrompt(prompt: string): void {
  if (config) config.systemPrompt = prompt;
}

// ── Internal getters (used by sibling modules, NOT re-exported) ─────────────

export function getConfig(): TalonConfig {
  if (!config)
    throw new Error("Agent not initialized. Call initAgent() first.");
  return config;
}

export function getBridgePort(): number {
  return bridgePortFn();
}
