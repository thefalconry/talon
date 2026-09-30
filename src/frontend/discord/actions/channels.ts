/**
 * Resolve a registered Discord chat to a sendable channel (guild channel or
 * the user's DM).
 */

import type { Client, TextBasedChannel } from "discord.js";
import { lookupDiscordChat } from "../handlers/index.js";
import { logWarn } from "../../../util/log.js";

export async function resolveChannel(
  client: Client,
  numericChatId: number,
): Promise<TextBasedChannel | null> {
  const info = lookupDiscordChat(numericChatId);
  if (!info) return null;
  try {
    // A DM rebuilt from its chat key has no channel id — open it by user.
    if (info.channelId) {
      const ch = await client.channels.fetch(info.channelId);
      if (ch && "send" in ch && (ch as TextBasedChannel).isSendable?.()) {
        return ch as TextBasedChannel;
      }
    }
    if (info.userId) {
      const user = await client.users.fetch(info.userId);
      const dm = await user.createDM();
      return dm as TextBasedChannel;
    }
    return null;
  } catch (err) {
    logWarn(
      "discord",
      `resolveChannel failed for chat ${numericChatId}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
