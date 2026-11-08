/**
 * Response delivery — HTML send with plain-text fallback, streaming draft
 * edits, and the agent run + reply pipeline (`processAndReply`).
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../../core/config/index.js";
import { execute } from "../../../core/engine/dispatcher.js";
import { toolInputToRecord } from "../../../core/agent-runtime/events.js";
import { appendDailyLogResponse } from "../../../storage/daily-log.js";
import { stripMcpPrefix } from "../../../core/tools/index.js";
import { logWarn } from "../../../util/log.js";
import { replyParamsFor, sendText, telegramDelivery } from "../actions/send.js";
import { ambientThreadId } from "../topics.js";
import { isAdminInGroup, trackDmUser } from "./access.js";

export async function sendHtml(
  bot: Bot,
  chatId: number,
  html: string,
  replyToId?: number,
): Promise<number> {
  const params = {
    parse_mode: "HTML" as const,
    reply_parameters: replyParamsFor(replyToId),
    message_thread_id: ambientThreadId(chatId),
  };
  try {
    const sent = await bot.api.sendMessage(chatId, html, params);
    return sent.message_id;
  } catch (err) {
    logWarn(
      "bot",
      `HTML send failed, falling back to plain text: ${err instanceof Error ? err.message : err}`,
    );
    let plain = html;
    let prev: string;
    do {
      prev = plain;
      plain = plain.replace(/<[^>]*>/g, "");
    } while (plain !== prev);
    const sent = await bot.api.sendMessage(chatId, plain, {
      reply_parameters: replyParamsFor(replyToId),
      message_thread_id: ambientThreadId(chatId),
    });
    return sent.message_id;
  }
}

/**
 * Run the agent and deliver responses with streaming + multi-message support.
 */
export type ProcessAndReplyParams = {
  bot: Bot;
  config: TalonConfig;
  chatId: string | number;
  numericChatId: number;
  replyToId: number;
  messageId: number;
  prompt: string;
  senderName: string;
  isGroup: boolean;
  senderUsername?: string;
  senderId?: number;
  /**
   * Sender keys for the turn's tool scope. Defaults to `[senderId]`; the
   * queue passes `[]` when a batch mixes senders, which guest-scopes it.
   */
  senderKeys?: readonly string[];
  chatTitle?: string;
};

// ── Streaming state for Telegram message edits ──────────────────────────────

type StreamState = {
  draftId: number;
  lastSentLength: number;
  started: boolean;
  editing: boolean;
  sentTextBlock: boolean;
};

// Probe once at startup whether sendMessageDraft is supported
let draftsSupported: boolean | null = null;

function createStreamCallbacks(
  bot: Bot,
  chatId: number,
  _replyToId: number,
  state: StreamState,
  chatTitle?: string,
) {
  const onStreamDelta = async (accumulated: string) => {
    // Skip if drafts not supported or not ready
    if (draftsSupported === false || !state.started || state.editing) return;
    if (accumulated.length - state.lastSentLength < 40) return;

    state.editing = true;
    try {
      const display =
        accumulated.length > 3900
          ? accumulated.slice(0, 3900) + "…"
          : accumulated;

      await bot.api.sendMessageDraft(chatId, state.draftId, display, {
        message_thread_id: ambientThreadId(chatId),
      });
      if (draftsSupported === null) draftsSupported = true;
      state.lastSentLength = accumulated.length;
    } catch {
      // If first attempt fails, disable drafts entirely
      if (draftsSupported === null) {
        draftsSupported = false;
        logWarn("bot", "sendMessageDraft not supported — streaming disabled");
      }
    } finally {
      state.editing = false;
    }
  };

  const onTextBlock = async (text: string) => {
    try {
      await sendText(bot, chatId, text, _replyToId);
    } catch (err) {
      telegramDelivery.failed(chatId, err);
      throw err;
    }
    telegramDelivery.delivered(chatId);
    appendDailyLogResponse("Talon", text, { chatTitle });
    state.lastSentLength = 0;
    state.sentTextBlock = true;
  };

  return { onStreamDelta, onTextBlock };
}

export async function processAndReply(
  params: ProcessAndReplyParams,
): Promise<void> {
  const {
    bot,
    chatId,
    numericChatId,
    replyToId,
    messageId,
    prompt,
    senderName,
    isGroup,
    senderUsername,
    senderId,
    chatTitle,
  } = params;

  const stream: StreamState = {
    draftId: crypto.getRandomValues(new Uint32Array(1))[0] || 1,
    lastSentLength: 0,
    started: false,
    editing: false,
    sentTextBlock: false,
  };
  // Wait 1s before starting streaming — avoids flickering on fast responses
  const streamTimer = setTimeout(() => {
    stream.started = true;
  }, 1000);

  try {
    const { onStreamDelta, onTextBlock } = createStreamCallbacks(
      bot,
      numericChatId,
      replyToId,
      stream,
      chatTitle,
    );

    // Track first-time DM users for logging (no prompt mutation).
    if (!isGroup && senderName && senderId) {
      trackDmUser(senderId, senderName, senderUsername);
    }

    // Re-accumulate the running text / thinking totals from the
    // canonical delta stream — Telegram's draft-edit UI wants the full
    // text-so-far, while `AgentEvent.text_delta` carries only the new
    // slice.
    let textAccum = "";
    let thinkingAccum = "";

    const onToolUse = (toolName: string, input: Record<string, unknown>) => {
      // Tool names arrive MCP-prefixed (e.g. `mcp__telegram-tools__end_turn`)
      // when routed through MCP — strip the prefix so equality checks
      // match the registry's bare names. Both `end_turn(text=...)` and
      // `send(type="text")` are user-facing text deliveries; capture
      // both so the daily log records bot responses regardless of which
      // delivery tool the model used.
      const bareName = stripMcpPrefix(toolName);
      if (bareName === "end_turn" && typeof input.text === "string") {
        appendDailyLogResponse("Talon", input.text, { chatTitle });
      } else if (
        bareName === "send" &&
        input.type === "text" &&
        typeof input.text === "string"
      ) {
        appendDailyLogResponse("Talon", input.text, { chatTitle });
      }
    };

    await execute({
      chatId: String(chatId),
      numericChatId,
      prompt,
      senderName,
      senderHandle: senderUsername,
      senderKeys:
        params.senderKeys ?? (senderId ? [String(senderId)] : undefined),
      // Only asked when the install opts in — it costs a (cached)
      // getChatMember call per group turn.
      operatorInChat:
        isGroup && params.config.guestDmScope?.operatorGroups
          ? await isAdminInGroup(bot, numericChatId)
          : undefined,
      isGroup,
      messageId,
      source: "message",
      onEvent: async (event) => {
        switch (event.type) {
          case "text_delta":
            textAccum += event.text;
            // Fire-and-forget: draft edits are throttled + self-mutexed
            // (`state.editing`), so we must NOT block stream consumption
            // on them.
            void onStreamDelta(textAccum);
            break;
          case "reasoning":
            thinkingAccum += event.text;
            void onStreamDelta(thinkingAccum);
            break;
          case "assistant_message":
            // Keep the running total monotonic so a following
            // `text_delta` continues where the block left off.
            textAccum += event.text;
            // Throw on delivery failure — the dispatcher rejects the
            // ack and the backend decides whether to retry.
            await onTextBlock(event.text);
            break;
          case "tool_call":
            onToolUse(event.name, toolInputToRecord(event.name, event.input));
            break;
        }
      },
    });

    // No fallback delivery — turns that don't call `end_turn` / `send` are
    // intentional silent ends. Trailing prose written without a tool call is
    // scratchpad and dropped (the SDK handler logs a `scratchpad.trailing_
    // text_dropped` metric so missed end_turn calls show up in counters).
  } finally {
    clearTimeout(streamTimer);
  }
}
