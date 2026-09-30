/**
 * Slash commands on WhatsApp — `/model`, `/effort`, `/settings`,
 * `/reset`, `/status`, `/help`.
 *
 * WhatsApp has no inline buttons, so everything Telegram does with a
 * picker is done here with typed arguments: `/model` prints a numbered
 * catalog, `/model 3` (or `/model <id>`, `/model <backend>`) picks from
 * it. The replies are shared with the native bridge
 * (frontend/presentation/text-commands.ts); this module only parses,
 * authorises, and delivers.
 *
 * Replies are written in Markdown — `sendText` translates them into
 * WhatsApp's dialect and splits long listings into bubbles.
 */

import { log } from "../../util/log.js";
import { recordMessageProcessed } from "../../util/watchdog.js";
import { performSessionReset } from "../presentation/session-status.js";
import {
  resolveChatBackendPair,
  type ModelCommandDeps,
} from "../presentation/model-commands.js";
import {
  effortCommandReply,
  modelCommandReply,
  settingsCommandReply,
  statusCommandReply,
} from "../presentation/text-commands.js";
import { sendText } from "./actions/send.js";
import { identityAllowed, type Identity } from "./connection/identity.js";
import type { WhatsAppChatInfo } from "./registry.js";
import type { WhatsAppRuntime } from "./runtime.js";

const COMMAND_NAMES = [
  "model",
  "effort",
  "settings",
  "reset",
  "status",
  "help",
] as const;

type WhatsAppCommandName = (typeof COMMAND_NAMES)[number];

export type WhatsAppCommand = { name: WhatsAppCommandName; arg: string };

/** The inbound message fields the command layer needs. */
export type CommandInbound = {
  chat: WhatsAppChatInfo;
  text: string;
  senderName: string;
  identity: Identity;
  isGroup: boolean;
};

/**
 * Parse a slash command out of message text. Group messages in mention
 * mode arrive as "@<number> /model", so leading @mentions are skipped.
 * Returns null for anything that is not one of ours, including bare
 * text that merely starts with a slash (a path, a fraction).
 */
export function parseWhatsAppCommand(text: string): WhatsAppCommand | null {
  const body = text.replace(/^(?:@\S+\s*)+/, "").trim();
  const match = /^\/([a-zA-Z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!(COMMAND_NAMES as readonly string[]).includes(name)) return null;
  return { name: name as WhatsAppCommandName, arg: (match[2] ?? "").trim() };
}

/** Commands that change chat state, as opposed to showing it. */
function isMutating(cmd: WhatsAppCommand): boolean {
  if (cmd.name === "reset") return true;
  return (cmd.name === "model" || cmd.name === "effort") && cmd.arg !== "";
}

/**
 * May this sender change the chat's settings? A DM sender already passed
 * the allowlist. In a group, the same allowlist is the admin rule — the
 * people in `allowedJids` are the operator's, everyone else may read
 * settings but not change them. With no allowlist at all nobody in a group
 * may change them: an empty list never means everyone.
 */
export function canChangeSettings(
  runtime: WhatsAppRuntime,
  inbound: Pick<CommandInbound, "isGroup" | "identity">,
): boolean {
  if (!inbound.isGroup) return true;
  return identityAllowed(inbound.identity, runtime.allowedDms);
}

const HELP_TEXT = [
  "**Commands**",
  "/model — list backends and models; `/model <n|id>` picks, `/model <backend>` switches",
  "/effort — show or set thinking effort: `/effort high`, `/effort adaptive`",
  "/settings — this chat's model, backend, effort and pulse",
  "/status — session info, context usage and stats",
  "/reset — start a fresh session (chat log kept)",
  "/help — this message",
].join("\n");

// ── Handlers ────────────────────────────────────────────────────────────────

async function runResetCommand(
  chatId: string,
  senderName: string,
  deps: ModelCommandDeps,
): Promise<string> {
  // The local history store is WhatsApp's only chat record — a reset
  // clears the model's session, not the conversation log.
  await performSessionReset(
    chatId,
    resolveChatBackendPair(chatId, deps).backend,
    {
      keepHistory: true,
    },
  );
  log("whatsapp", `Session reset by ${senderName}`);
  return "Session cleared.";
}

/** The reply text for one parsed command. */
export async function executeWhatsAppCommand(
  runtime: WhatsAppRuntime,
  cmd: WhatsAppCommand,
  inbound: CommandInbound,
): Promise<string> {
  const chatId = inbound.chat.chatId;
  const deps: ModelCommandDeps = {
    config: runtime.config,
    gateway: runtime.gateway,
  };
  if (isMutating(cmd) && !canChangeSettings(runtime, inbound)) {
    return "Only allowlisted users can change settings in a group.";
  }
  switch (cmd.name) {
    case "model":
      // `/reset` keeps history on WhatsApp because the local store is the
      // only chat record; a backend switch keeps it for the same reason.
      return modelCommandReply(chatId, cmd.arg, deps, { keepHistory: true });
    case "effort":
      return effortCommandReply(chatId, cmd.arg, deps);
    case "settings":
      return settingsCommandReply(chatId, deps);
    case "status":
      return statusCommandReply(chatId, deps);
    case "reset":
      return runResetCommand(chatId, inbound.senderName, deps);
    case "help":
      return HELP_TEXT;
  }
}

/**
 * Handle a slash command if the message is one. True when it was — the
 * caller then skips the agent turn. Delivery failures are swallowed:
 * the state change already happened and is visible on the next
 * `/settings`; a dead socket is the connection loop's problem.
 */
export async function handleWhatsAppCommand(
  runtime: WhatsAppRuntime,
  inbound: CommandInbound,
): Promise<boolean> {
  const cmd = parseWhatsAppCommand(inbound.text);
  if (!cmd) return false;
  const reply = await executeWhatsAppCommand(runtime, cmd, inbound);
  const sock = runtime.sock;
  if (sock) {
    await sendText(
      { sock, gateway: runtime.gateway },
      inbound.chat,
      reply,
    ).catch(() => {});
  }
  recordMessageProcessed();
  return true;
}
