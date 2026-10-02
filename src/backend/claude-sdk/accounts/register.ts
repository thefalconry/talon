/**
 * Register one backend per `claudeAccounts` entry.
 *
 * Each is the Claude SDK driver (`createClaudeSdkFactory`) bound to that
 * account's config dir. Registration is idempotent — doctor and the daemon
 * both call it — and a name another backend already holds is skipped with a
 * warning rather than shadowing it.
 */

import {
  getBackend,
  registerBackend,
} from "../../../core/agent-runtime/backend-registry.js";
import {
  resolveClaudeAccounts,
  setClaudeAccounts,
  type ClaudeAccountConfig,
} from "../../../core/config/claude-accounts.js";
import { logWarn } from "../../../util/log.js";
import { CLAUDE_ACCOUNT_GROUP, createClaudeSdkFactory } from "../factory.js";

/** Returns the ids registered (or already registered) as Claude accounts. */
export function registerClaudeAccountBackends(config?: {
  claudeAccounts?: readonly ClaudeAccountConfig[];
}): string[] {
  const accounts = resolveClaudeAccounts(config?.claudeAccounts);
  setClaudeAccounts(accounts);
  const ids: string[] = [];
  for (const account of accounts) {
    const existing = getBackend(account.id);
    if (existing) {
      if (existing.accountGroup === CLAUDE_ACCOUNT_GROUP) ids.push(account.id);
      else
        logWarn(
          "bot",
          `Claude account "${account.id}" not registered: backend id already taken by ${existing.label}`,
        );
      continue;
    }
    registerBackend(
      createClaudeSdkFactory({
        backendId: account.id,
        label: account.label,
        configDir: account.configDir,
      }),
    );
    ids.push(account.id);
  }
  return ids;
}
