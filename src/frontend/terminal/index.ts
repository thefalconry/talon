/**
 * Terminal frontend — slim orchestrator wiring renderer, commands, and input.
 *
 * Readline lifecycle:
 *   - rl starts active (prompt shown)
 *   - User presses Enter → rl.pause() immediately → processing begins
 *   - Processing finishes → all output written → rl.resume() + rl.prompt()
 *   - Renderer NEVER touches readline. Only this file does.
 *
 * `start()` returns once that prompt is drawn — the frontend lifecycle
 * contract (core/frontend-runtime/capabilities.ts).
 */

import pc from "picocolors";
import type { TalonConfig } from "../../core/config/index.js";
import type { ContextManager, ActionResult } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { log } from "../../util/log.js";
import {
  deriveNumericChatId,
  generateTerminalChatId,
} from "../../core/frontend-runtime/chat-id.js";
import { resolveModel } from "../../core/models/catalog.js";
import { toolInputToRecord } from "../../core/agent-runtime/events.js";
import { createRenderer } from "./renderer.js";
import { createInput } from "./input.js";
import {
  registerBuiltinCommands,
  tryRunCommand,
  clearCommands,
  type CommandContext,
} from "./commands.js";
import { buildCacheDisplay } from "../presentation/status-context.js";
import { LOCAL_OPERATOR_SENDER } from "../../core/mcp-hub/guest-scope.js";

// ── State ────────────────────────────────────────────────────────────────────

/** The terminal is driven by the operator at the keyboard. */
const TERMINAL_SENDER = {
  senderName: "User",
  senderKeys: [LOCAL_OPERATOR_SENDER],
} as const;

let terminalChatId = "";
let terminalNumericId = 0;

function initNewChat(chatId?: string): void {
  terminalChatId = chatId ?? generateTerminalChatId();
  terminalNumericId = deriveNumericChatId(terminalChatId);
}

// ── Action handler (bridge) ──────────────────────────────────────────────────

function createActionHandler(
  gateway: Gateway,
  renderer: ReturnType<typeof createRenderer>,
): (
  body: Record<string, unknown>,
  chatId: number,
) => Promise<ActionResult | null> {
  return async (body) => {
    const action = body.action as string;
    switch (action) {
      case "send_message": {
        renderer.stopSpinner();
        renderer.renderAssistantMessage(String(body.text ?? ""));
        gateway.incrementMessages(terminalNumericId);
        return { ok: true, message_id: Date.now() };
      }
      case "react": {
        renderer.stopSpinner();
        renderer.writeln(`  ${pc.cyan("▍")}  ${String(body.emoji ?? "👍")}`);
        gateway.incrementMessages(terminalNumericId);
        return { ok: true };
      }
      case "send_message_with_buttons": {
        renderer.stopSpinner();
        renderer.renderAssistantMessage(String(body.text ?? ""));
        const rows = body.rows as Array<Array<{ text: string }>> | undefined;
        if (rows) {
          for (const row of rows) {
            renderer.writeln(
              `  ${pc.cyan("▍")}    ${row.map((b) => pc.dim(`[${b.text}]`)).join("  ")}`,
            );
          }
        }
        gateway.incrementMessages(terminalNumericId);
        return { ok: true, message_id: Date.now() };
      }
      case "edit_message":
      case "delete_message":
      case "pin_message":
      case "unpin_message":
      case "forward_message":
      case "copy_message":
      case "send_chat_action":
        return { ok: true };
      case "get_chat_info":
        return {
          ok: true,
          id: terminalNumericId,
          type: "private",
          title: "Terminal",
        };
      default:
        return null;
    }
  };
}

// ── Frontend interface ───────────────────────────────────────────────────────

export type TerminalFrontend = {
  name: "terminal";
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createTerminalFrontend(
  config: TalonConfig,
  gateway: Gateway,
): TerminalFrontend {
  const renderer = createRenderer(undefined, config.botDisplayName);
  let currentPhase: "idle" | "thinking" | "tool" | "text" = "idle";
  let toolCallCount = 0;

  const context: ContextManager = {
    acquire: () =>
      gateway.setContext(terminalNumericId, terminalChatId, "terminal"),
    release: () => gateway.clearContext(terminalNumericId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  return {
    name: "terminal",
    context,
    sendTyping: async () => {
      renderer.startSpinner(
        currentPhase === "tool" ? "running tools" : "thinking",
      );
    },
    sendMessage: async (_chatId: number, text: string) => {
      renderer.stopSpinner();
      renderer.renderAssistantMessage(text);
    },
    getBridgePort: () => gateway.getPort(),

    async init() {
      gateway.registerFrontendHandler(
        "terminal",
        createActionHandler(gateway, renderer),
      );
      const port = await gateway.start(19877);
      log("bot", `Terminal gateway on port ${port}`);
    },

    async start() {
      initNewChat();

      const modelDisplay =
        resolveModel(config.model)?.displayName ?? config.model;

      renderer.writeln();
      renderer.writeln(
        `  ${pc.bold(pc.cyan(config.botDisplayName))}  ${pc.dim(modelDisplay)}`,
      );
      renderer.writeln(`  ${pc.dim("─".repeat(renderer.cols - 2))}`);

      const { execute } = await import("../../core/engine/dispatcher.js");
      const { getSessionInfo } = await import("../../storage/sessions.js");
      const input = createInput(`  ${pc.green("❯")} `);

      clearCommands();
      registerBuiltinCommands();

      function pauseInput(): void {
        input.pause();
      }

      function reprompt(): void {
        renderer.writeln(); // blank line before prompt
        input.resume();
        input.prompt();
      }

      const cmdCtx: CommandContext = {
        chatId: () => terminalChatId,
        config,
        renderer,
        reprompt,
        initNewChat,
        waitForInput: () => input.waitForInput(),
        close: () => {
          renderer.writeln();
          renderer.writeln(`  ${pc.dim("Goodbye!")}`);
          renderer.writeln();
          input.close();
          process.exit(0);
        },
        get backend() {
          return gateway.backend;
        },
      };

      input.onLine(async (text) => {
        if (!text) {
          reprompt();
          return;
        }

        // Slash commands — these handle their own reprompt
        if (await tryRunCommand(text, cmdCtx)) {
          return;
        }

        // ── AI query ──
        pauseInput(); // readline off until we're done
        toolCallCount = 0;
        currentPhase = "thinking";
        renderer.startSpinner("thinking");

        try {
          const result = await execute({
            chatId: terminalChatId,
            numericChatId: terminalNumericId,
            prompt: text,
            ...TERMINAL_SENDER,
            isGroup: false,
            source: "message",
            onEvent: async (event) => {
              switch (event.type) {
                case "text_delta":
                  if (currentPhase !== "text") {
                    currentPhase = "text";
                    renderer.updateSpinnerLabel("responding");
                  }
                  break;
                case "reasoning":
                  if (currentPhase !== "thinking") {
                    currentPhase = "thinking";
                    renderer.updateSpinnerLabel("thinking");
                  }
                  break;
                case "tool_call":
                  renderer.stopSpinner();
                  currentPhase = "tool";
                  toolCallCount++;
                  renderer.renderToolCall(
                    event.name,
                    toolInputToRecord(event.name, event.input),
                  );
                  renderer.startSpinner("running tools");
                  break;
                case "assistant_message":
                  renderer.stopSpinner();
                  renderer.renderAssistantMessage(event.text);
                  break;
              }
            },
          });

          renderer.stopSpinner();
          currentPhase = "idle";

          if (result.bridgeMessageCount === 0 && result.text?.trim()) {
            renderer.renderAssistantMessage(result.text);
          }

          const info = getSessionInfo(terminalChatId);
          const u = info.usage;
          const cache = buildCacheDisplay({
            cacheMetrics: gateway.backend?.cacheMetrics,
            inputTokens: u.totalInputTokens,
            cacheRead: u.totalCacheRead,
            cacheWrite: u.totalCacheWrite,
          });
          renderer.renderStatusLine(result.durationMs, toolCallCount, {
            model: modelDisplay,
            sessionName: info.sessionName,
            turns: info.turns,
            inputTokens: u.totalInputTokens,
            outputTokens: u.totalOutputTokens,
            cacheHitPct: cache?.hitPct,
            costUsd: u.estimatedCostUsd,
          });
          reprompt(); // readline back on, show prompt
        } catch (err) {
          renderer.stopSpinner();
          currentPhase = "idle";
          renderer.writeError(err instanceof Error ? err.message : String(err));
          reprompt();
        }
      });

      input.prompt(); // started: turns run from the input callbacks above
    },

    async stop() {
      await gateway.stop();
    },
  };
}
