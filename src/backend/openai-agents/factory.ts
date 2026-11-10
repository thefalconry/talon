/**
 * OpenAI Agents backend factory — wires the SDK into the registry.
 *
 * The backend speaks to OpenAI's Responses API via `@openai/agents`'s
 * official SDK. MCP servers are constructed as `MCPServerStdio`
 * instances at turn time + closed in `finally`.
 *
 * Returns a composed `Backend` with capability slots for chat,
 * background (isolated one-shot runs: sub-agents, cron query jobs,
 * heartbeat, dream), models, and sessions.
 */

import { registerBackend } from "../../core/agent-runtime/backend-registry.js";
import { openAIAgentsDoctorChecks } from "./doctor.js";
import type { BackendFactory } from "../../core/agent-runtime/backend-registry.js";
import { log } from "../../util/log.js";
import { handlerToEvents } from "../runtime/turn/handler-to-events.js";
import { interruptChatTurn } from "../runtime/turn/turn-interrupt.js";
import {
  composeBackend,
  type BackgroundRunner,
  type ChatBackend,
  type ModelCatalog,
  type SessionBackend,
} from "../../core/agent-runtime/capabilities.js";

import { initOpenAIAgentsAgent, getOpenAIBaseUrl } from "./init.js";
import { handleMessage as openAIAgentsHandleMessage } from "./handler/index.js";
import { runOneShotAgent as openAIAgentsRunOneShotAgent } from "./one-shot.js";
import { resetState, clearChatSession } from "./state.js";
import { releaseAllBundles } from "./mcp-pool.js";
import { OPENAI_AGENTS_DEFAULT_MODEL } from "./constants.js";
import {
  resolveModel as openAIResolveModel,
  getModelInfo as openAIGetModelInfo,
  getSettingsPresentation as openAIGetSettingsPresentation,
  getProviders as openAIGetProviders,
  getProviderModels as openAIGetProviderModels,
  formatModelError as openAIFormatModelError,
  listModels as openAIListModels,
} from "./models.js";

const openAIAgentsFactory: BackendFactory = {
  id: "openai-agents",
  label: "OpenAI Agents",
  // Its own shell/file tools can't be withheld per turn, so guest-scoped
  // turns (non-operator senders) are refused rather than run with them.
  guestToolScope: "refused",
  doctor: (config) => openAIAgentsDoctorChecks(config),

  async init(config, ctx) {
    initOpenAIAgentsAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: OpenAI Agents (@openai/agents)");

    const chat: ChatBackend = {
      runChatTurn: (params) =>
        handlerToEvents((p) => openAIAgentsHandleMessage(p), params),
      interruptChatTurn: (chatId) => interruptChatTurn(chatId),
    };

    const background: BackgroundRunner = {
      runOneShotAgent: (p) => openAIAgentsRunOneShotAgent(p),
      // Every run starts a blank conversation (no persisted session to
      // resume), so an interrupted sub-agent is re-briefed instead. No
      // subprocesses to evict either: the model is an HTTP endpoint and
      // the MCP tools live in the daemon's hub.
    };

    const defaultIdSync = (): string | null => {
      const baseUrl = getOpenAIBaseUrl();
      if (baseUrl && baseUrl.length > 0) return null;
      return OPENAI_AGENTS_DEFAULT_MODEL;
    };

    const models: ModelCatalog = {
      resolveModelInfo: (q) => Promise.resolve(openAIResolveModel(q)),
      // Only advertise a canonical default when the backend is
      // pointed at stock OpenAI. Custom baseUrls (OpenRouter, Azure,
      // Ollama, LiteLLM, etc) have no universal default — the
      // catalog varies per endpoint.
      getDefaultModelId: () => defaultIdSync(),
      getRawModelInfo: (id) => Promise.resolve(openAIGetModelInfo(id)),
      getSettingsPresentation: (m, options) =>
        openAIGetSettingsPresentation(m, options),
      getProviders: () => Promise.resolve(openAIGetProviders()),
      getProviderModels: (p, pg, ps) =>
        Promise.resolve(openAIGetProviderModels(p, pg, ps)),
      formatModelError: (q, r) => openAIFormatModelError(q, r),
      listModels: (f) => Promise.resolve(openAIListModels(f)),
    };

    const sessions: SessionBackend = {
      resetChat: (chatId) => clearChatSession(chatId),
    };

    const backend = composeBackend({
      id: "openai-agents",
      label: "OpenAI Agents",
      cacheMetrics: "read",
      chat,
      background,
      models,
      sessions,
    });

    return {
      backend,
      // Cleanup: close every per-chat MCP bundle in the pool so its hub
      // sessions don't outlive the backend itself, then drop the cached
      // state.
      cleanup: async () => {
        await releaseAllBundles();
        resetState();
        log("bot", "OpenAI Agents backend cleaned up");
      },
    };
  },
};

registerBackend(openAIAgentsFactory);
