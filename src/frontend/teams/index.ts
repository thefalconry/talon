/**
 * Teams frontend — bidirectional messaging via Power Automate + Graph API.
 *
 * SEND (Talon → Teams):  POST Adaptive Cards to a Power Automate workflow webhook URL.
 * RECEIVE (Teams → Talon): Poll group chat messages via Microsoft Graph API
 *                          using Chat.Read scope (no admin consent needed).
 *
 * No Azure AD app registration, no Bot Framework, no admin consent.
 *
 * This file is wiring only: it constructs the shared runtime (runtime.ts)
 * and owns the frontend lifecycle. The behaviour lives in the modules —
 * chat-discovery, poll, commands, turn, outbound.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { log } from "../../util/log.js";
import { createTeamsActionHandler } from "./actions.js";
import { resolveChatId, seedLastSeen } from "./chat-discovery.js";
import { initGraphClient } from "./graph.js";
import { sendText } from "./outbound.js";
import { startPolling, stopPolling } from "./poll.js";
import { createTeamsRuntime } from "./runtime.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type TeamsFrontend = {
  name: "teams";
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

// ── Frontend factory ─────────────────────────────────────────────────────────

export function createTeamsFrontend(
  config: TalonConfig,
  gateway: Gateway,
): TeamsFrontend {
  const runtime = createTeamsRuntime(config, gateway);

  const context: ContextManager = {
    acquire: (chatId: number, stringId?: string) =>
      gateway.setContext(chatId, stringId, "teams"),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  return {
    name: "teams",
    context,

    // Teams has no typing indicator via webhooks
    sendTyping: async () => {},

    sendMessage: (_chatId: number, text: string) => sendText(runtime, text),

    getBridgePort: () => gateway.getPort(),

    async init() {
      // Register action handler with the gateway
      gateway.registerFrontendHandler(
        "teams",
        createTeamsActionHandler(runtime.webhookUrl, gateway),
      );
      const port = await gateway.start(19876);
      log("teams", `Gateway on port ${port}`);

      // Authenticate with Microsoft Graph
      log("teams", "Initializing Microsoft Graph client...");
      const graphClient = await initGraphClient();
      runtime.graphClient = graphClient;

      const me = await graphClient.getMe();
      log("teams", `Authenticated as: ${me.displayName} (${me.id})`);

      const chatId = await resolveChatId(runtime, graphClient, me.id);
      await seedLastSeen(runtime, graphClient, chatId);
    },

    async start() {
      if (!runtime.graphClient) throw new Error("Graph client not initialized");

      const chatId = runtime.graphClient.getStoredChatId()!;

      log("teams", "Teams frontend running");
      log("teams", `Send: Power Automate webhook`);
      log(
        "teams",
        `Receive: Graph API chat polling every ${runtime.pollIntervalMs / 1000}s`,
      );

      // The receive side is a timer on the runtime, not a loop to sit in:
      // once the first poll is done the frontend is listening, and
      // start() is finished.
      await startPolling(runtime, chatId);
    },

    async stop() {
      stopPolling(runtime);
      await gateway.stop();
      log("teams", "Teams frontend stopped");
    },
  };
}
