/**
 * Response delivery — runs the agent and delivers each text block as a
 * discrete (chunked) Discord message. Discord has no draft-edit streaming, so
 * blocks are sent as they arrive.
 */

import type { TextBasedChannel } from "discord.js";
import type { TalonConfig } from "../../../core/config/index.js";
import { execute } from "../../../core/engine/dispatcher.js";
import { toolInputToRecord } from "../../../core/agent-runtime/events.js";
import { appendDailyLogResponse } from "../../../storage/daily-log.js";
import { log } from "../../../util/log.js";
import { trackDmUser } from "./access.js";
import { sendChunked } from "./context.js";

export type ProcessAndReplyParams = {
  config: TalonConfig;
  chatId: string;
  numericChatId: number;
  replyToId: string;
  messageId: string;
  numericMessageId: number;
  prompt: string;
  senderName: string;
  isGroup: boolean;
  senderUsername?: string;
  senderId: string;
  /** False when the batch mixes senders — the turn is then guest-scoped. */
  singleSender?: boolean;
  channel: TextBasedChannel;
  chatTitle?: string;
};

export async function processAndReply(p: ProcessAndReplyParams): Promise<void> {
  const sentTextBlock = { value: false };
  let firstChunkReplyTo: string | undefined = p.replyToId;

  // Discord doesn't support draft message edits, so we use onTextBlock to
  // deliver each text block as a discrete message (chunked if necessary).
  const onTextBlock = async (text: string) => {
    if (!text.trim()) return;
    const ids = await sendChunked(p.channel, text, firstChunkReplyTo);
    if (ids.length > 0) sentTextBlock.value = true;
    // Subsequent blocks should not reply to the original — too noisy.
    firstChunkReplyTo = undefined;
  };

  if (!p.isGroup && p.senderId) {
    trackDmUser(p.senderId, p.senderName, p.senderUsername);
  }

  const result = await execute({
    chatId: p.chatId,
    numericChatId: p.numericChatId,
    prompt: p.prompt,
    senderName: p.senderName,
    senderHandle: p.senderUsername,
    senderKeys: p.singleSender === false ? [] : [`discord:${p.senderId}`],
    isGroup: p.isGroup,
    // Use the real Discord snowflake string, not the hashed numeric.
    // The hash collides with Telegram-style 32-bit IDs and Discord's API
    // rejects it as "Unknown Message" when the model tries to react/edit.
    messageId: p.messageId,
    source: "message",
    onEvent: async (event) => {
      switch (event.type) {
        case "assistant_message":
          // Throw on delivery failure — the dispatcher rejects the ack.
          await onTextBlock(event.text);
          break;
        case "tool_call": {
          const input = toolInputToRecord(event.name, event.input);
          if (
            event.name === "send" &&
            input.type === "text" &&
            typeof input.text === "string"
          ) {
            appendDailyLogResponse("Talon", input.text, {
              chatTitle: p.chatTitle,
            });
          }
          break;
        }
      }
    },
  });

  if (
    result.bridgeMessageCount === 0 &&
    !sentTextBlock.value &&
    result.text?.trim()
  ) {
    log(
      "bot",
      `Suppressed fallback text (${result.text.length} chars) — no send tool used`,
    );
  }
}
