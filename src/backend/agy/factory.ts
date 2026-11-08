/**
 * Antigravity backend factory — wires Google's `agy` CLI into the
 * registry.
 *
 * Returns a composed `Backend` with every capability slot Talon's core
 * knows about: chat (+ interrupt), background (+ orphan eviction),
 * models, sessions, tools, usage and control. The transport is a
 * long-lived per-chat subprocess (`process.ts`), so the slots that
 * exist for process-shaped backends — `sessions.resetChat`,
 * `tools.refreshTools`, `background.evictOrphanSubprocesses` — are all
 * meaningful here and all implemented.
 */

import { registerBackend } from "../../core/agent-runtime/backend-registry.js";
import type { BackendFactory } from "../../core/agent-runtime/backend-registry.js";
import { log } from "../../util/log.js";
import { handlerToEvents } from "../runtime/turn/handler-to-events.js";
import { interruptChatTurn } from "../runtime/turn/turn-interrupt.js";
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

import { initAgyAgent } from "./init.js";
import { agyDoctorChecks } from "./doctor.js";
import { handleMessage } from "./handler/index.js";
import { runOneShotAgent } from "./one-shot.js";
import { evictOrphanSubprocesses } from "./process/orphans.js";
import { getState, resetState } from "./state.js";
import { resetChat, warmSession, refreshTools } from "./sessions.js";
import { killAllChildren } from "./process/child.js";
import { getAgyPlanUsage, resetAgyPlanUsage } from "./plan-usage.js";
import { unregisterAllMcp } from "./mcp/register.js";
import {
  resolveModel,
  getDefaultModelId,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
  resetModelCache,
} from "./models.js";

const agyFactory: BackendFactory = {
  id: "agy",
  label: "Antigravity",
  // Its own shell/file tools can't be withheld per turn, so guest-scoped
  // turns (non-operator senders) are refused rather than run with them.
  guestToolScope: "refused",
  doctor: (config, isActive) => agyDoctorChecks(config, isActive),

  async init(config, ctx) {
    initAgyAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: Antigravity (agy CLI, headless stream-json)");

    const chat: ChatBackend = {
      runChatTurn: (params) => handlerToEvents((p) => handleMessage(p), params),
      interruptChatTurn: (chatId) => interruptChatTurn(chatId),
    };

    const background: BackgroundRunner = {
      runOneShotAgent: (p) => runOneShotAgent(p),
      evictOrphanSubprocesses: (label) => evictOrphanSubprocesses(label),
    };

    const models: ModelCatalog = {
      resolveModelInfo: (q) => resolveModel(q),
      getDefaultModelId: () => getDefaultModelId(),
      getRawModelInfo: (id) => getModelInfo(id),
      getSettingsPresentation: (m, options) =>
        getSettingsPresentation(m, options),
      getProviders: () => getProviders(),
      getProviderModels: (p, pg, ps) => getProviderModels(p, pg, ps),
      formatModelError: (q, r) => formatModelError(q, r),
      listModels: (f) => listModels(f),
    };

    const sessions: SessionBackend = {
      resetChat: (chatId) => resetChat(chatId),
      warmSession: (chatId) => warmSession(chatId),
    };

    const tools: ToolRuntime = {
      refreshTools: (chatId) => refreshTools(chatId),
    };

    // agy reports cache READS only (`cache_read_tokens`); there is no
    // cache-write counter in its usage payload, hence `cacheMetrics: "read"`.
    const usage: UsageTelemetry = {
      getSessionSnapshot: async (chatId) => getState().lastUsage.get(chatId),
      // Quota windows come from `agy -p /usage --output-format text`
      // (see plan-usage.ts): at most one spawn per cache window, and
      // undefined on any failure so headroom falls back to the local
      // `backendBudgets` ledger.
      getPlanUsage: () => getAgyPlanUsage(),
    };

    const control: SystemControl = {
      updateSystemPrompt: (prompt) => {
        // Applies to the next NEW conversation only — a resumed one
        // has the old prompt frozen into its history. Same semantics
        // as codex.
        getState().systemPromptOverride = prompt;
      },
    };

    const backend = composeBackend({
      id: "agy",
      label: "Antigravity",
      cacheMetrics: "read",
      chat,
      background,
      models,
      sessions,
      tools,
      usage,
      control,
    });

    return {
      backend,
      cleanup: () => {
        killAllChildren("shutdown");
        unregisterAllMcp();
        resetModelCache();
        resetAgyPlanUsage();
        resetState();
        log("bot", "Antigravity backend cleaned up");
      },
    };
  },
};

registerBackend(agyFactory);
