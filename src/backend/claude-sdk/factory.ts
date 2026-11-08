/**
 * Claude SDK backend factory — wires the Anthropic Claude Agent SDK
 * into the registry.
 *
 * Unlike Kilo/OpenCode (which run a local HTTP server), the Claude SDK
 * spawns a per-query subprocess. So this factory also wires the
 * `tools.refreshTools` hot-swap path used by plugin reload + the
 * `background.evictOrphanSubprocesses` cleanup helper.
 *
 * Returns a composed `Backend` with capability slots for chat,
 * background, models, sessions, tools, and control.
 *
 * One factory per Claude login: `claude` (the default account, registered
 * here) and one per `claudeAccounts` entry (accounts/register.ts). They
 * share this driver and differ only in the account their spawns run as.
 */

import {
  registerBackend,
  setClaudeAccountFactoryMaker,
} from "../../core/agent-runtime/backend-registry.js";
import type { BackendFactory } from "../../core/agent-runtime/backend-registry.js";
import type { BackendId } from "../../core/agent-runtime/model-ref.js";
import { log } from "../../util/log.js";
import { ensureSharedProjects } from "../../core/auth/claude-projects.js";
import {
  defaultClaudeConfigDir,
  type ClaudeAccount,
} from "../../core/config/claude-accounts.js";
import {
  composeBackend,
  type ChatBackend,
  type BackgroundRunner,
  type ModelCatalog,
  type SessionBackend,
  type SystemControl,
  type ToolRuntime,
  type UsageTelemetry,
} from "../../core/agent-runtime/capabilities.js";

import {
  updateSystemPrompt as claudeUpdateSystemPrompt,
  evictOrphanSubprocesses as claudeEvictOrphanSubprocesses,
} from "./index.js";
import { createInProcessAgentHost } from "./host/in-process.js";
import { claimBankedReset, getBankedResetOffer } from "./usage/banked-reset.js";

import * as modelProvider from "./model-provider.js";
import { claudeDoctorChecks } from "./doctor.js";
import { claudeAccountDoctorChecks } from "./accounts/doctor.js";
import {
  DEFAULT_CLAUDE_ACCOUNT,
  type ClaudeRunAccount,
} from "./accounts/account.js";

/**
 * Every Claude login is one account group and one session store: the
 * router never moves work between them, and a chat switched between them
 * keeps its session (the transcripts are shared — accounts/projects-link.ts).
 */
export const CLAUDE_ACCOUNT_GROUP = "claude";

export function createClaudeSdkFactory(
  account: ClaudeRunAccount = DEFAULT_CLAUDE_ACCOUNT,
): BackendFactory {
  const isDefault = account.configDir === undefined;
  return {
    id: account.backendId,
    label: account.label,
    // Guest turns run with no SDK built-ins and only guest-allowed MCP
    // servers (see options.ts), so the hub's guest scope is the whole
    // surface.
    guestToolScope: "enforced",
    accountGroup: CLAUDE_ACCOUNT_GROUP,
    sessionStore: CLAUDE_ACCOUNT_GROUP,
    // An extra account runs only where it was chosen explicitly.
    ...(isDefault ? {} : { explicitOnly: true }),
    doctor: isDefault
      ? (config, isActive) => claudeDoctorChecks(config, isActive)
      : async (config, isActive) => [
          // The binary and the pinned models matter for whichever Claude
          // backend serves chats; for an idle account only its login does.
          ...(isActive ? await claudeDoctorChecks(config, true) : []),
          ...(await claudeAccountDoctorChecks(account, isActive)),
        ],
    init: (config, ctx) => initClaudeBackend(account, config, ctx),
  };
}

/** The backend for one `claudeAccounts` entry. */
export function createClaudeAccountFactory(
  account: ClaudeAccount,
): BackendFactory {
  return createClaudeSdkFactory({
    backendId: account.id,
    label: account.label,
    configDir: account.configDir,
  });
}

async function initClaudeBackend(
  account: ClaudeRunAccount,
  config: Parameters<BackendFactory["init"]>[0],
  ctx: Parameters<BackendFactory["init"]>[1],
): ReturnType<BackendFactory["init"]> {
  // Everything SDK-side goes through the agent-host seam
  // (docs/agent-host-sidecar.md). Phase 1 binds the in-process client,
  // which calls the same functions this factory used to call inline;
  // Phase 2 swaps in a process-backed client behind the same interface.
  // An extra account reads the default account's transcripts, so a chat
  // switched onto it resumes its session (core/auth/claude-projects.ts).
  if (account.configDir) {
    await ensureSharedProjects(
      account.configDir,
      defaultClaudeConfigDir(),
      account.backendId,
    );
  }
  const host = createInProcessAgentHost(config, ctx.getBridgePort, account);
  await host.hello();
  log(
    "bot",
    `Backend: Claude SDK (@anthropic-ai/claude-agent-sdk) as ${account.backendId}`,
  );

  const chat: ChatBackend = {
    runChatTurn: (params) => host.runTurn(params),
    interruptChatTurn: (chatId) => host.interrupt(chatId),
  };

  const background: BackgroundRunner = {
    runOneShotAgent: (p) => host.runOneShot(p),
    // Honours resumeSessionId (SDK `resume`) and reports the session id.
    supportsResume: true,
    // Not a protocol-table row yet: subprocess eviction reaches into
    // the SDK's own children, so it belongs to the host — but the
    // design's message table has no request for it. Tracked as an open
    // question against Phase 2; bound directly until it gains one.
    evictOrphanSubprocesses: (label) => claudeEvictOrphanSubprocesses(label),
  };

  const models: ModelCatalog = {
    resolveModelInfo: (q) => modelProvider.resolveModel(q),
    // Claude SDK ships a canonical `"default"` alias the runtime
    // resolves to the recommended model. Returning it keeps reset
    // + backend-switch on "Default (recommended)" rather than
    // freezing a specific id that may go stale across SDK upgrades.
    getDefaultModelId: () => "default",
    getRawModelInfo: (id) => modelProvider.getModelInfo(id),
    getSettingsPresentation: (m, options) =>
      modelProvider.getSettingsPresentation(m, options),
    getProviders: () => modelProvider.getProviders(),
    getProviderModels: (p, pg, ps) =>
      modelProvider.getProviderModels(p, pg, ps),
    formatModelError: (q, r) => modelProvider.formatModelError(q, r),
    // The one catalog member that asks the host: `list_models` is the
    // protocol's model row. The seven above are daemon-side formatting
    // over `core/models/catalog.ts`, which `hello` populates.
    listModels: (f) => host.listModels(f),
  };

  // Claude SDK's per-turn subprocess model has no shared session
  // state to reset; `warmSession` is the only useful hook. The
  // dispatcher's `/reset` clears Talon's stored session id via
  // `storage/sessions.ts:resetSession` regardless.
  const sessions: SessionBackend = {
    warmSession: (chatId) => host.warmSession(chatId),
  };

  const tools: ToolRuntime = {
    refreshTools: (chatId) => host.refreshTools(chatId),
  };

  const control: SystemControl = {
    updateSystemPrompt: (prompt) => claudeUpdateSystemPrompt(prompt),
  };

  // No per-session snapshot to offer (each turn is a fresh subprocess),
  // but the subscription's rate-limit windows are readable.
  const usage: UsageTelemetry = {
    getPlanUsage: () => host.planUsage(),
    bankedResets: {
      getOffer: () => getBankedResetOffer(undefined, account.configDir),
      claim: (grantId, requestId) =>
        claimBankedReset(grantId, requestId, account.configDir),
    },
  };

  const backend = composeBackend({
    id: account.backendId as BackendId,
    label: account.label,
    cacheMetrics: "readwrite",
    chat,
    background,
    models,
    sessions,
    tools,
    usage,
    control,
  });

  return { backend };
}

// The config schema uses `"claude"` for backward compatibility with
// talon.json files predating the registry. Matching the id here means no
// migration is needed.
registerBackend(createClaudeSdkFactory());
// Accounts added at runtime (/auth, `talon accounts add`) register through
// core, which can't import this driver.
setClaudeAccountFactoryMaker(createClaudeAccountFactory);
