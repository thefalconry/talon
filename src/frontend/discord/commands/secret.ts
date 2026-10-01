/**
 * /secret name:<name> [purpose:<text>] — a single-use link to paste a
 * password into instead of the channel. Rules and reply live in
 * core/secrets; the reply is ephemeral either way.
 */

import type { ChatInputCommandInteraction } from "discord.js";
import { secretCommandReply } from "../../../core/secrets/index.js";
import { isAdmin } from "../handlers/index.js";
import { reply } from "./interaction.js";

export async function handleSecret(
  i: ChatInputCommandInteraction,
  chatId: string,
): Promise<void> {
  const name = (i.options.getString("name") ?? "").trim();
  const purpose = (i.options.getString("purpose") ?? "").trim();
  const text = secretCommandReply({
    arg: `${name} ${purpose}`,
    chatKey: chatId,
    frontend: "discord",
    isOperator: isAdmin(i.user.id),
    isGroup: i.inGuild(),
  });
  await reply(i, text, true);
}
