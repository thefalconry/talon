/**
 * Per-chat commands — `/model`, `/effort`, `/settings`, `/status`,
 * `/pulse`, `/stop`, `/reset`.
 *
 * The listings and pickers are the ones WhatsApp prints
 * (presentation/text-commands.ts). What is native here is the state the
 * bridge keeps beside the shared stores: a backend switch goes through
 * the bridge's own `setBackend` (it also drops turn meta, the cached
 * context readout and the queued follow-up), `/reset` through the same
 * `resetChat` as `POST /chats/reset`, and every change ends with a
 * `chat_updated` so every connected client's header follows.
 */

import {
  disablePulse,
  enablePulse,
} from "../../../core/background/pulse/pulse.js";
import {
  getChatSettings,
  setChatPulseInterval,
} from "../../../storage/chat-settings.js";
import { resetChatBackend } from "../../presentation/model-commands.js";
import { formatDuration, parseInterval } from "../../presentation/format.js";
import {
  effortCommandReply,
  modelCommandReply,
  settingsCommandReply,
  statusCommandReply,
} from "../../presentation/text-commands.js";
import { broadcastChatUpdated } from "../chats/chat-wire.js";
import { resetChat, wipeChatConversation } from "../chats/reset.js";
import { setBackend } from "../surface/models.js";
import { broadcastStatus } from "../surface/status.js";
import { interruptTurn } from "../turn/turn.js";
import type { NativeCommandContext, NativeCommandHandler } from "./types.js";

/** Pulse intervals below this would have the chat check in constantly. */
const MIN_PULSE_INTERVAL_MS = 5 * 60 * 1000;

async function model(ctx: NativeCommandContext): Promise<void> {
  const { runtime, entry, deps } = ctx;
  const text = await modelCommandReply(entry.id, ctx.arg, deps, {
    switchBackend: async (target) => {
      const result = await setBackend(runtime, entry.id, target.id);
      return result.ok
        ? `Backend: ${target.label} (\`${target.id}\`).`
        : `Could not switch to ${target.label}: ${result.error ?? "rebind failed"}`;
    },
    resetBackend: async () => {
      const outcome = await resetChatBackend(entry.id, deps);
      wipeChatConversation(runtime, entry.id);
      broadcastStatus(runtime);
      return outcome.text;
    },
  });
  if (ctx.arg) broadcastChatUpdated(runtime, entry);
  ctx.reply(text);
}

async function effort(ctx: NativeCommandContext): Promise<void> {
  const text = await effortCommandReply(ctx.entry.id, ctx.arg, ctx.deps);
  if (ctx.arg) broadcastChatUpdated(ctx.runtime, ctx.entry);
  ctx.reply(text);
}

async function settings(ctx: NativeCommandContext): Promise<void> {
  ctx.reply(await settingsCommandReply(ctx.entry.id, ctx.deps));
}

async function status(ctx: NativeCommandContext): Promise<void> {
  ctx.reply(await statusCommandReply(ctx.entry.id, ctx.deps));
}

/** The reply for a pulse argument, applying the change it names. */
function applyPulse(chatId: string, arg: string): string {
  const lower = arg.toLowerCase();
  if (!lower || lower === "status") {
    const sets = getChatSettings(chatId);
    return (
      `**🔔 Pulse:** ${sets.pulse === true ? "on" : "off"}` +
      (sets.pulseIntervalMs
        ? ` (every ${formatDuration(sets.pulseIntervalMs)})`
        : "") +
      "\n\nReads along every few minutes and jumps in when there's something to add. " +
      "`/pulse on`, `/pulse off`, `/pulse 30m`."
    );
  }
  if (lower === "on" || lower === "enable") {
    enablePulse(chatId);
    return "🔔 Pulse enabled.";
  }
  if (lower === "off" || lower === "disable") {
    disablePulse(chatId);
    return "🔔 Pulse disabled.";
  }
  const intervalMs = parseInterval(lower);
  if (!intervalMs)
    return "Use: `/pulse on`, `/pulse off`, `/pulse 30m`, `/pulse 2h`";
  if (intervalMs < MIN_PULSE_INTERVAL_MS)
    return "Minimum interval is 5 minutes.";
  setChatPulseInterval(chatId, intervalMs);
  enablePulse(chatId);
  return `🔔 Pulse cooldown set to **${formatDuration(intervalMs)}**`;
}

async function pulse(ctx: NativeCommandContext): Promise<void> {
  const text = applyPulse(ctx.entry.id, ctx.arg);
  if (ctx.arg) broadcastChatUpdated(ctx.runtime, ctx.entry);
  ctx.reply(text);
}

async function stop(ctx: NativeCommandContext): Promise<void> {
  const stopped = await interruptTurn(ctx.runtime, ctx.entry.id);
  ctx.reply(stopped ? "⏹ Stopped." : "Nothing is running.");
}

/** `resetChat` posts its own notice — a second "cleared" would be noise. */
async function reset(ctx: NativeCommandContext): Promise<void> {
  resetChat(ctx.runtime, ctx.entry.id);
}

export const sessionCommands = {
  model,
  effort,
  settings,
  status,
  pulse,
  stop,
  reset,
} satisfies Record<string, NativeCommandHandler>;
