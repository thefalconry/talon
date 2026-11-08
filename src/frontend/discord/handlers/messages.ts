/**
 * Public message handler — the messageCreate entry point. Filters bots/self,
 * applies access + rate limits, downloads attachments, builds the prompt, and
 * enqueues for debounced processing.
 */

import type { Client, Message } from "discord.js";
import { ChannelType } from "discord.js";
import type { TalonConfig } from "../../../core/config/index.js";
import { setMessageFilePath } from "../../../storage/history.js";
import { addMedia } from "../../../storage/media-index.js";
import { deriveNumericChatId } from "../../../core/frontend-runtime/chat-id.js";
import { logError } from "../../../util/log.js";
import {
  shouldHandleInGuild,
  isAccessAllowed,
  isUserRateLimited,
} from "./access.js";
import {
  getSenderName,
  buildReplyContext,
  downloadAttachment,
  classifyAttachment,
} from "./context.js";
import { registerDiscordChat } from "./registry.js";
import { enqueueMessage } from "./queue.js";

export async function handleMessage(
  client: Client,
  msg: Message,
  config: TalonConfig,
): Promise<void> {
  // Ignore bots, system messages, and our own messages
  if (msg.author.bot || msg.system) return;
  if (msg.author.id === client.user?.id) return;

  if (!shouldHandleInGuild(client, msg)) return;
  if (!(await isAccessAllowed(client, msg))) return;
  if (isUserRateLimited(msg.author.id)) return;

  const isGroup = msg.channel.type !== ChannelType.DM;
  const chatId = isGroup
    ? `discord_guild_${msg.guildId}_${msg.channelId}`
    : `discord_dm_${msg.author.id}`;
  const numericChatId = deriveNumericChatId(chatId);
  const numericMessageId = deriveNumericChatId(msg.id);
  const sender = getSenderName(msg);
  const senderUsername = msg.author.username;
  const channel = msg.channel;
  const chatTitle = isGroup
    ? `${msg.guild?.name ?? msg.guildId} #${(msg.channel as { name?: string }).name ?? msg.channelId}`
    : undefined;

  // Strip the leading bot mention from the text — common when users invoke the bot.
  const botId = client.user?.id;
  const mentionPattern = botId ? new RegExp(`<@!?${botId}>`, "g") : null;
  const cleanedContent = mentionPattern
    ? msg.content.replace(mentionPattern, "").trim()
    : msg.content.trim();

  // Build prompt parts
  const replyCtx = buildReplyContext(msg, botId);
  const promptParts: string[] = [replyCtx];

  // Handle attachments — download each, register in media index/history, add to prompt.
  if (msg.attachments.size > 0) {
    for (const att of msg.attachments.values()) {
      try {
        const downloadedPath = await downloadAttachment(att, config.workspace);
        const cls = classifyAttachment(att);
        setMessageFilePath(chatId, numericMessageId, downloadedPath);
        // addMedia may dedupe onto an existing identical file and delete
        // the fresh download — prompt with the path it resolves to.
        const savedPath = await addMedia({
          chatId,
          msgId: numericMessageId,
          senderName: sender,
          type: cls.type,
          filePath: downloadedPath,
          caption: cleanedContent || undefined,
          timestamp: Date.now(),
        });
        promptParts.push(...cls.promptLines(savedPath));
      } catch (err) {
        logError(
          "bot",
          `[${chatId}] attachment "${att.name}" download failed: ${err instanceof Error ? err.message : err}`,
        );
        promptParts.push(
          `[Attachment "${att.name ?? "file"}" failed to download: ${err instanceof Error ? err.message : err}]`,
        );
      }
    }
    if (cleanedContent) promptParts.push(`Caption: ${cleanedContent}`);
  } else if (cleanedContent) {
    promptParts.push(cleanedContent);
  }

  const prompt = promptParts.filter(Boolean).join("\n");
  if (!prompt.trim()) return;

  registerDiscordChat({
    channelId: msg.channelId,
    guildId: msg.guildId,
    userId: isGroup ? null : msg.author.id,
    numericChatId,
    chatId,
  });

  enqueueMessage(config, chatId, numericChatId, {
    prompt,
    replyToId: msg.id,
    messageId: msg.id,
    numericMessageId,
    senderName: sender,
    senderUsername,
    senderId: msg.author.id,
    isGroup,
    channel,
    chatTitle,
  });
}
