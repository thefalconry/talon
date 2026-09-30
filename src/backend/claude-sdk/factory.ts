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
 */

import { registerBackend } from "../../core/agent-runtime/backend-registry.js";
import type { BackendFactory } from "../../core/agent-runtime/backend-registry.js";
import { log } from "../../util/log.js";
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

const claudeSdkFactory: BackendFactory = {
  // The config schema uses `"claude"` for backward compatibility with
  // talon.json files predating the registry. Matching the id here means
  // no migration is needed.
  id: "claude",
  label: "Anthropic",
  // Guest turns run with no SDK built-ins and only guest-allowed MCP
  // servers (see options.ts), so the hub's guest scope is the whole surface.
  guestToolScope: "enforced",
  doctor: (config, isActive) => claudeDoctorChecks(config, isActive),

  async init(config, ctx) {
    // Everything SDK-side goes through the agent-host seam
    // (docs/agent-host-sidecar.md). Phase 1 binds the in-process client,
    // which calls the same functions this factory used to call inline;
    // Phase 2 swaps in a process-backed client behind the same interface.
    const host = createInProcessAgentHost(config, ctx.getBridgePort);
    await host.hello();
    log("bot", "Backend: Claude SDK (@anthropic-ai/claude-agent-sdk)");

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
        getOffer: () => getBankedResetOffer(),
        claim: (grantId, requestId) => claimBankedReset(grantId, requestId),
      },
    };

    const backend = composeBackend({
      id: "claude",
      label: "Anthropic",
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
  },
};

registerBackend(claudeSdkFactory);
