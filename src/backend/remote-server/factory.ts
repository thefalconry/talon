/**
 * Compose a registry `BackendFactory` for a remote-server backend.
 *
 * The capability wiring is identical for every member of the family:
 * chat through the shared handler, one-shot through the shared runner, the
 * catalog-driven model slots, session snapshots off the server, plugin-MCP
 * refresh, warm-after-reset, and the system-prompt control. A backend
 * supplies its id/label/SDK name and the bound functions; this returns the
 * factory for `registerBackend`.
 */

import type {
  BackendFactory,
  FrontendName,
} from "../../core/agent-runtime/backend-registry.js";
import type { BackendId } from "../../core/agent-runtime/model-ref.js";
import {
  composeBackend,
  type BackgroundRunner,
  type ChatBackend,
  type ModelCatalog,
  type SessionBackend,
  type SystemControl,
  type ToolRuntime,
  type UsageTelemetry,
} from "../../core/agent-runtime/capabilities.js";
import type { OneShotAgentParams, OneShotUsage } from "../../core/types.js";
import type { TalonConfig } from "../../core/config/index.js";
import { binaryOnPath } from "../../util/binary-on-path.js";
import { log } from "../../util/log.js";
import { handlerToEvents } from "../runtime/turn/handler-to-events.js";
import type {
  QueryParams,
  QueryResult,
} from "../runtime/turn/handler-types.js";
import { interruptChatTurn } from "../runtime/turn/turn-interrupt.js";
import type { RemoteModelProvider } from "./model-catalog/provider.js";
import type { RemoteSessionSnapshot } from "./session-helpers.js";

export interface RemoteBackendFactoryInputs {
  /** Registry id — matches `config.backend` ("kilo"). */
  id: BackendId;
  /** Display label ("Kilo"). */
  label: string;
  /** npm package of the SDK, for the startup log line. */
  sdkPackage: string;
  init(
    config: TalonConfig,
    getGatewayPort?: () => number,
    frontend?: FrontendName,
  ): void;
  stop(): void;
  handleMessage(params: QueryParams): Promise<QueryResult>;
  runOneShotAgent(params: OneShotAgentParams): Promise<OneShotUsage | void>;
  getSessionSnapshot(
    sessionId: string | undefined,
  ): Promise<RemoteSessionSnapshot | undefined>;
  models: RemoteModelProvider;
  refreshPluginMcpServers: ToolRuntime["refreshTools"];
  warmSession(chatId: string): Promise<void>;
  updateSystemPrompt(prompt: string): void;
}

export function createRemoteBackendFactory(
  inputs: RemoteBackendFactoryInputs,
): BackendFactory {
  const { id, label } = inputs;
  return {
    id,
    label,
    // The server's built-in shell/file tools can't be withheld per turn,
    // so guest-scoped turns (non-operator senders) are refused.
    guestToolScope: "refused",
    // The SDK ships as an npm dep but only talks to a server it spawns from
    // the CLI of the same name (`cross-spawn` → PATH lookup). A present
    // package with an absent binary fails at the first turn with a bare
    // ENOENT, so doctor checks what actually gets executed.
    async doctor() {
      return [
        binaryOnPath(id)
          ? { label: `${label} CLI installed`, status: "ok" }
          : {
              label: `${label} CLI not found`,
              status: "fail",
              detail: `the ${label} SDK spawns \`${id}\` — install it or this backend cannot start`,
              issue: true,
            },
      ];
    },
    async init(config, ctx) {
      inputs.init(config, ctx.getBridgePort, ctx.frontendName);
      log("bot", `Backend: ${label} (${inputs.sdkPackage})`);

      const chat: ChatBackend = {
        runChatTurn: (params) =>
          handlerToEvents((p) => inputs.handleMessage(p), params),
        interruptChatTurn: (chatId) => interruptChatTurn(chatId),
      };

      const background: BackgroundRunner = {
        runOneShotAgent: (p) => inputs.runOneShotAgent(p),
        // A long-lived HTTP server — no per-query subprocesses, so
        // `evictOrphanSubprocesses` is intentionally not implemented.
      };

      const m = inputs.models;
      const models: ModelCatalog = {
        resolveModelInfo: (q) => m.resolveModel(q),
        // Catalog-driven backend with no canonical default — fall through
        // to `config.backendDefaults.<id>`.
        getDefaultModelId: () => undefined,
        getRawModelInfo: (modelId) => m.getModelInfo(modelId),
        getSettingsPresentation: (activeModel, options) =>
          m.getSettingsPresentation(activeModel, options),
        getProviders: () => m.getProviders(),
        getProviderModels: (p, pg, ps) => m.getProviderModels(p, pg, ps),
        formatModelError: (q, r) => m.formatModelError(q, r),
        listModels: (f) => m.listModels(f),
      };

      const usage: UsageTelemetry = {
        getSessionSnapshot: async (sessionId) => {
          const snap = await inputs.getSessionSnapshot(sessionId);
          if (!snap) return undefined;
          return {
            inputTokens: snap.usage?.totalInputTokens,
            outputTokens: snap.usage?.totalOutputTokens,
            cacheRead: snap.usage?.totalCacheRead,
            cacheWrite: snap.usage?.totalCacheWrite,
            contextModelId: snap.assistant?.modelID,
          };
        },
      };

      const tools: ToolRuntime = {
        refreshTools: (chatId) => inputs.refreshPluginMcpServers(chatId),
      };

      // Session state lives on the server, and `/reset` already clears
      // Talon's stored id centrally (storage/sessions.ts), so the next turn
      // creates a fresh one — no `resetChat` needed. `warmSession`
      // front-loads that creation plus the plugin-MCP sweep, matching what
      // the Claude backend does after a reset.
      const sessions: SessionBackend = {
        warmSession: (chatId) => inputs.warmSession(chatId),
      };

      const control: SystemControl = {
        updateSystemPrompt: (prompt) => inputs.updateSystemPrompt(prompt),
      };

      const backend = composeBackend({
        id,
        label,
        cacheMetrics: "readwrite",
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
          inputs.stop();
        },
      };
    },
  };
}
