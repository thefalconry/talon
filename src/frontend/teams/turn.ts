/**
 * Teams model turn — one inbound chat message becomes one `execute()` call.
 * Progress is logged; assistant text is delivered through the webhook.
 */

import { log, logError } from "../../util/log.js";
import { deriveNumericChatId } from "../../core/frontend-runtime/chat-id.js";
import {
  toolInputToRecord,
  type AgentEvent,
} from "../../core/agent-runtime/events.js";
import { execute } from "../../core/engine/dispatcher.js";
import { postToTeams } from "./actions.js";
import type { ChatMessage } from "./graph.js";
import type { TeamsRuntime } from "./runtime.js";

function logToolCall(event: Extract<AgentEvent, { type: "tool_call" }>): void {
  const input = toolInputToRecord(event.name, event.input);
  const detail = (input.description ??
    input.command ??
    input.action ??
    input.query ??
    input.url ??
    input.name ??
    "") as string;
  log(
    "teams",
    `  tool: ${event.name}${detail ? ` — ${String(detail).slice(0, 100)}` : ""}`,
  );
}

// Deliver assistant text (progress text before tool calls AND the
// end-of-turn trailing-text fallback) to the Teams chat. Without this,
// prose-only assistant turns would be silently dropped — same scratchpad
// bug Telegram hit.
async function deliverAssistantText(
  runtime: TeamsRuntime,
  numericChatId: number,
  text: string,
): Promise<void> {
  if (!text.trim()) return;
  try {
    await postToTeams(runtime.webhookUrl, text);
    runtime.gateway.incrementMessages(numericChatId);
  } catch (err) {
    // Post failures are swallowed (logged, not rethrown) — preserves the old
    // `onTextBlock` semantics where Teams never propagated delivery errors
    // back to the backend. Returning normally lets the dispatcher resolve
    // the ack.
    logError(
      "teams",
      `onEvent postToTeams failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export function runTurn(
  runtime: TeamsRuntime,
  msg: ChatMessage,
  talonChatId: string,
): void {
  const numericChatId = deriveNumericChatId(msg.chatId);
  execute({
    chatId: talonChatId,
    numericChatId,
    prompt: `[${msg.senderName}]: ${msg.text}`,
    senderName: msg.senderName,
    senderKeys: msg.senderId ? [`teams:${msg.senderId}`] : undefined,
    isGroup: true,
    source: "message",
    onEvent: async (event) => {
      switch (event.type) {
        case "text_delta":
          log("teams", `  phase: text`);
          break;
        case "reasoning":
          log("teams", `  phase: thinking`);
          break;
        case "tool_call":
          logToolCall(event);
          break;
        case "assistant_message":
          await deliverAssistantText(runtime, numericChatId, event.text);
          break;
      }
    },
  })
    // No fallback delivery — turns without end_turn / send_message are
    // intentional silent ends. Trailing prose without a tool call is
    // scratchpad and dropped; the SDK handler emits a
    // `scratchpad.trailing_text_dropped` metric on those.
    .catch((err) => {
      logError(
        "teams",
        `execute failed: ${err instanceof Error ? err.message : err}`,
      );
    });
}
