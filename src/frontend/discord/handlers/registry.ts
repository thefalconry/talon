/**
 * Chat-registry accessors — map between numeric/string chat ids and the
 * Discord channel info the action handler needs to post back.
 */

import { deriveNumericChatId } from "../../../core/frontend-runtime/chat-id.js";
import {
  chatRegistry,
  chatRegistryByString,
  type DiscordChatInfo,
} from "./state.js";

export type { DiscordChatInfo } from "./state.js";

export function registerDiscordChat(info: DiscordChatInfo): void {
  chatRegistry.set(info.numericChatId, info);
  chatRegistryByString.set(info.chatId, info);
}

export function lookupDiscordChat(
  numericChatId: number,
): DiscordChatInfo | undefined {
  return chatRegistry.get(numericChatId);
}

/**
 * Rebuild a chat's registry entry from its string key alone
 * (`discord_guild_<guild>_<channel>` or `discord_dm_<user>`), for a chat
 * this process hasn't seen a message from yet — the registry is in-memory,
 * so after a restart only the allowed users' DMs are known until someone
 * speaks. A DM entry carries no channel id; resolveChannel opens the DM
 * from the user id. Undefined for anything that isn't a Discord chat key.
 */
export function parseDiscordChatKey(
  chatKey: string,
): DiscordChatInfo | undefined {
  const guild = /^discord_guild_(\d+)_(\d+)$/.exec(chatKey);
  if (guild) {
    return {
      channelId: guild[2]!,
      guildId: guild[1]!,
      userId: null,
      numericChatId: deriveNumericChatId(chatKey),
      chatId: chatKey,
    };
  }
  const dm = /^discord_dm_(\d+)$/.exec(chatKey);
  if (dm) {
    return {
      channelId: "",
      guildId: null,
      userId: dm[1]!,
      numericChatId: deriveNumericChatId(chatKey),
      chatId: chatKey,
    };
  }
  return undefined;
}
