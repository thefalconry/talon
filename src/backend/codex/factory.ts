/**
 * Codex backend factory — wires the OpenAI Codex SDK into the registry.
 *
 * Returns a composed `Backend` with capability slots for chat,
 * background, models, and sessions. The dispatcher and frontend
 * consumers read through those slots.
 */

import { registerBackend } from "../../core/agent-runtime/backend-registry.js";
import { codexDoctorChecks } from "./doctor.js";
import type { BackendFactory } from "../../core/agent-runtime/backend-registry.js";
import { log } from "../../util/log.js";
import { handlerToEvents } from "../runtime/turn/handler-to-events.js";
import { interruptChatTurn } from "../runtime/turn/turn-interrupt.js";
import {
  composeBackend,
  type ChatBackend,
  type BackgroundRunner,
  type ModelCatalog,
  type UsageTelemetry,
} from "../../core/agent-runtime/capabilities.js";
import {
  getAuthFailure as getCodexAuthFailure,
  getPlanUsage as getCodexPlanUsage,
} from "./plan-usage.js";

import { initCodexAgent, getCodexAuthInfo } from "./init.js";
import { handleMessage as codexHandleMessage } from "./handler/index.js";
import { runOneShotAgent as codexRunOneShotAgent } from "./one-shot.js";
import { resetState as resetCodexState } from "./state.js";
import {
  CODEX_DEFAULT_MODEL,
  CODEX_CHATGPT_DEFAULT_MODEL,
} from "./constants.js";
import {
  resolveModel as codexResolveModel,
  getModelInfo as codexGetModelInfo,
  getSettingsPresentation as codexGetSettingsPresentation,
  getProviders as codexGetProviders,
  getProviderModels as codexGetProviderModels,
  formatModelError as codexFormatModelError,
  listModels as codexListModels,
} from "./models.js";

const codexFactory: BackendFactory = {
  id: "codex",
  label: "Codex",
  // Its own shell/file tools can't be withheld per turn, so guest-scoped
  // turns (non-operator senders) are refused rather than run with them.
  guestToolScope: "refused",
  doctor: (config) => codexDoctorChecks(config),

  async init(config, ctx) {
    initCodexAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: Codex (@openai/codex-sdk)");

    const chat: ChatBackend = {
      runChatTurn: (params) =>
        handlerToEvents((p) => codexHandleMessage(p), params),
      interruptChatTurn: (chatId) => interruptChatTurn(chatId),
    };

    const background: BackgroundRunner = {
      runOneShotAgent: (p) => codexRunOneShotAgent(p),
      // Codex spawns per-turn CLI subprocesses that the SDK reaps on its own
      // — no explicit orphan-eviction path needed here.
    };

    const models: ModelCatalog = {
      resolveModelInfo: (q) => codexResolveModel(q),
      getDefaultModelId: () => {
        const auth = getCodexAuthInfo();
        return auth?.mode === "chatgpt"
          ? CODEX_CHATGPT_DEFAULT_MODEL
          : CODEX_DEFAULT_MODEL;
      },
      getRawModelInfo: (id) => codexGetModelInfo(id),
      getSettingsPresentation: (m, options) =>
        codexGetSettingsPresentation(m, options),
      getProviders: () => codexGetProviders(),
      getProviderModels: (p, pg, ps) => codexGetProviderModels(p, pg, ps),
      formatModelError: (q, r) => codexFormatModelError(q, r),
      listModels: (f) => codexListModels(f),
    };

    // Codex has no in-memory session state — `handleMessage` owns
    // the per-chat thread lifecycle directly via `setSessionId` on
    // `storage/sessions.ts`. No `sessions` slot needed; `/reset`
    // clears the stored thread id through the storage path.
    // No per-session snapshot to offer, but a ChatGPT-plan install can
    // report its rate-limit windows.
    const usage: UsageTelemetry = {
      getPlanUsage: () => getCodexPlanUsage(),
      getAuthFailure: () => getCodexAuthFailure(),
    };

    const backend = composeBackend({
      id: "codex",
      label: "Codex",
      cacheMetrics: "read",
      chat,
      background,
      models,
      usage,
    });

    return {
      backend,
      cleanup: () => {
        resetCodexState();
        log("bot", "Codex backend cleaned up");
      },
    };
  },
};

registerBackend(codexFactory);
