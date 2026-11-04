/**
 * Kimi backend factory — wires Moonshot's `kimi` CLI into the registry.
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

import { initKimiAgent } from "./init.js";
import { kimiDoctorChecks } from "./doctor.js";
import { handleMessage } from "./handler/index.js";
import { runOneShotAgent } from "./one-shot.js";
import { evictOrphanSubprocesses } from "./process/orphans.js";
import { getState, resetState } from "./state.js";
import { resetChat, warmSession, refreshTools } from "./sessions.js";
import { killAllChildren } from "./process/child.js";
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

const kimiFactory: BackendFactory = {
  id: "kimi",
  label: "Kimi",
  doctor: (config, isActive) => kimiDoctorChecks(config, isActive),

  async init(config, ctx) {
    initKimiAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: Kimi (@moonshot-ai/kimi-code, headless stream-json)");

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

    const usage: UsageTelemetry = {
      getSessionSnapshot: async (chatId) => getState().lastUsage.get(chatId),
      getPlanUsage: async () => undefined,
    };

    const control: SystemControl = {
      updateSystemPrompt: (prompt) => {
        getState().systemPromptOverride = prompt;
      },
    };

    const backend = composeBackend({
      id: "kimi",
      label: "Kimi",
      cacheMetrics: "none",
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
        resetModelCache();
        resetState();
        log("bot", "Kimi backend cleaned up");
      },
    };
  },
};

registerBackend(kimiFactory);
