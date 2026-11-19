/**
 * The wake-up a finished detached job sends to the chat that started it.
 * Kept apart from bootstrap so tests run this code rather than a copy of it.
 */

import { numericChatIdFor } from "../../frontend-runtime/chat-id.js";
import { logError } from "../../../util/log.js";

type WakeExecute = (params: {
  chatId: string;
  numericChatId: number;
  prompt: string;
  senderName: string;
  isGroup: boolean;
  source: "agent";
}) => Promise<unknown>;

export function makeExecJobWake(
  execute: WakeExecute,
): (chatKey: string, prompt: string) => void {
  return (chatKey, prompt) => {
    void execute({
      chatId: chatKey,
      numericChatId: numericChatIdFor(chatKey),
      prompt,
      senderName: "Device",
      isGroup: false,
      source: "agent",
    }).catch((err: unknown) => {
      logError("mesh", `exec job wake failed for chat ${chatKey}`, err);
    });
  };
}
