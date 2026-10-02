/**
 * Register every built-in backend with the registry.
 *
 * Most backends have a `factory.ts` that calls `registerBackend` as a
 * side effect of being imported, so "loading" is importing. The
 * remote-server family (OpenCode and its Kilo fork) has no per-backend
 * module at all: a profile plus the shared factory IS the driver, so
 * those two register from here.
 *
 * One list, used by the daemon's bootstrap, by `talon doctor` (which
 * runs standalone and needs the factories' doctor checks), and by tests
 * that exercise the registry. Adding a backend is adding a line here.
 *
 * `config` adds the configured extra Claude accounts (`claudeAccounts`),
 * one backend each, on the Claude SDK driver.
 */

import {
  hasBackend,
  registerBackend,
} from "../core/agent-runtime/backend-registry.js";
import type { ClaudeAccountConfig } from "../core/config/claude-accounts.js";

export async function loadBuiltinBackends(config?: {
  claudeAccounts?: readonly ClaudeAccountConfig[];
}): Promise<void> {
  await import("./claude-sdk/factory.js");
  const { registerClaudeAccountBackends } =
    await import("./claude-sdk/accounts/register.js");
  registerClaudeAccountBackends(config);
  const { createRemoteBackendFactory } =
    await import("./remote-server/factory.js");
  const { opencodeProfile, kiloProfile } =
    await import("./remote-server/profiles/index.js");
  // The side-effect imports above are no-ops on a second call (module
  // cache); these registrations have to skip an already-registered id
  // themselves, since `registerBackend` rejects duplicates.
  for (const profile of [opencodeProfile, kiloProfile]) {
    if (!hasBackend(profile.id))
      registerBackend(createRemoteBackendFactory(profile));
  }
  await import("./codex/factory.js");
  await import("./agy/factory.js");
  await import("./openai-agents/factory.js");
}
