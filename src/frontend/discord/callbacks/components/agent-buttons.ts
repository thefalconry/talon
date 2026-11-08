/**
 * `ai:*` — AI-generated buttons (send_message_with_buttons), forwarded to
 * the agent verbatim with the routing prefix stripped.
 */

import { execute } from "../../../../core/engine/dispatcher.js";
import { appendDailyLog } from "../../../../storage/daily-log.js";
import { logError } from "../../../../util/log.js";
import {
  suppressMentions,
  splitMessage,
  DISCORD_MAX_TEXT,
} from "../../formatting.js";
import type { ComponentContext, ComponentInteraction } from "./types.js";

export async function forwardToAgent(
  interaction: ComponentInteraction,
  { chatId, numericChatId }: ComponentContext,
): Promise<boolean> {
  // Acknowledge so Discord doesn't show "interaction failed"
  try {
    await interaction.deferUpdate();
  } catch {
    /* might already be acked */
  }

  const sender =
    interaction.member?.user?.username ?? interaction.user.username ?? "User";
  const isGroup = interaction.guildId !== null;
  // Strip the `ai:` prefix so the agent sees the original callback_data it
  // emitted in send_message_with_buttons, not our routing namespace.
  const rawId = interaction.customId.startsWith("ai:")
    ? interaction.customId.slice(3)
    : interaction.customId;
  const prompt = `[Button pressed] User clicked component with custom_id: "${rawId}"`;
  const chatTitle = isGroup
    ? `${interaction.guild?.name ?? interaction.guildId} #${(interaction.channel as { name?: string } | null)?.name ?? interaction.channelId}`
    : undefined;

  appendDailyLog(sender, `Button: ${rawId}`, { chatTitle });

  const onTextBlock = async (text: string) => {
    if (!text.trim()) return;
    if (!interaction.channel?.isSendable()) return;
    const chunks = splitMessage(suppressMentions(text), DISCORD_MAX_TEXT);
    for (const c of chunks) {
      try {
        await interaction.channel.send({
          content: c,
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        logError(
          "discord",
          `forwardToAgent send failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  };

  try {
    await execute({
      chatId,
      numericChatId,
      prompt,
      senderName: sender,
      senderKeys: [`discord:${interaction.user.id}`],
      isGroup,
      source: "message",
      onEvent: async (event) => {
        if (event.type === "assistant_message") {
          await onTextBlock(event.text);
        }
      },
    });
  } catch (err) {
    logError(
      "discord",
      `Component → agent forward failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  return true;
}
