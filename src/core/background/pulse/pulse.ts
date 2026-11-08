/**
 * Pulse — conversation-aware engagement.
 *
 * Every N minutes, checks for new messages in registered chats.
 * If there are new messages, feeds them to the dispatcher so Claude
 * can decide whether to respond. Same session, same cache.
 *
 * Knows nothing about the backend or frontend — uses the dispatcher.
 */

import { execute, getActiveCount } from "../../engine/dispatcher.js";
import {
  setChatPulse,
  getRegisteredPulseChats,
  getChatSettings,
  setPulseLastCheckMsgId,
} from "../../../storage/chat-settings.js";
import {
  getRecentHistory,
  getLatestMessageId,
} from "../../../storage/history.js";
import { log, logError } from "../../../util/log.js";
import { formatSmartTimestamp } from "../../../util/time.js";

// ── State ────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
const registeredChats = new Set<string>();
const lastCheckMessageId = new Map<string, number>();
/** Chats whose pulse turn is still queued or running. */
const inFlight = new Set<string>();

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let activeIntervalMs = DEFAULT_INTERVAL_MS;

// ── Public API ───────────────────────────────────────────────────────────────

export function initPulse(): void {
  for (const chatId of getRegisteredPulseChats()) {
    registeredChats.add(chatId);
    // Restore persisted last-check message ID to avoid reprocessing on restart
    const settings = getChatSettings(chatId);
    if (settings.pulseLastCheckMsgId !== undefined) {
      lastCheckMessageId.set(chatId, settings.pulseLastCheckMsgId);
    }
  }
  if (registeredChats.size > 0) {
    log("pulse", `Loaded ${registeredChats.size} registered chat(s)`);
  }
}

export function registerChat(chatId: string): void {
  registeredChats.add(chatId);
}

export function enablePulse(chatId: string): void {
  setChatPulse(chatId, true);
  registeredChats.add(chatId);
}

export function disablePulse(chatId: string): void {
  setChatPulse(chatId, false);
  registeredChats.delete(chatId);
}

/** Clear pulse checkpoint for a chat (call on /reset to avoid stale state). */
export function resetPulseCheckpoint(chatId: string): void {
  lastCheckMessageId.delete(chatId);
  setPulseLastCheckMsgId(chatId, undefined);
}

export function isPulseEnabled(chatId: string): boolean {
  return getChatSettings(chatId).pulse === true;
}

export function startPulseTimer(intervalMs?: number): void {
  if (timer) return;
  const envMs = parseInt(process.env.TALON_PULSE_INTERVAL_MS ?? "", 10);
  const ms = intervalMs ?? (envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  if (ms <= 0) return;

  activeIntervalMs = ms;
  log("pulse", `Started: checking every ${Math.round(ms / 60000)}m`);
  timer = setInterval(() => {
    runPulse().catch((err) => logError("pulse", "Check failed", err));
  }, ms);
}

/** Reset the pulse timer — call when bot sends a message to avoid
 *  redundant check-ins during active conversation. */
export function resetPulseTimer(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = setInterval(() => {
    runPulse().catch((err) => logError("pulse", "Check failed", err));
  }, activeIntervalMs);
}

export function stopPulseTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Get pulse status for admin visibility. */
export function getPulseStatus(): Array<{
  chatId: string;
  enabled: boolean;
  lastChecked: number | undefined;
}> {
  return [...registeredChats].map((chatId) => ({
    chatId,
    enabled: isPulseEnabled(chatId),
    lastChecked: lastCheckMessageId.get(chatId),
  }));
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function runPulse(): Promise<void> {
  if (getActiveCount() > 10) return; // safety valve — don't pile on if heavily loaded

  for (const chatId of registeredChats) {
    if (!isPulseEnabled(chatId)) continue;
    await pulseChat(chatId);
  }
}

async function pulseChat(chatId: string): Promise<void> {
  // The pulse turn queues behind the chat's other turns, so it can outlast
  // the interval. Until it settles the checkpoint hasn't moved, and the next
  // tick would dispatch the same unread messages a second time.
  if (inFlight.has(chatId)) return;
  const numericChatId = parseInt(chatId, 10);
  if (isNaN(numericChatId)) {
    logError("pulse", `Invalid chatId: ${chatId}`);
    return;
  }

  // Any new messages since last check?
  const latestMsgId = getLatestMessageId(chatId);
  const lastChecked = lastCheckMessageId.get(chatId);
  if (latestMsgId === undefined) return;
  if (lastChecked !== undefined && latestMsgId <= lastChecked) return;

  // Get unread messages
  const recent = getRecentHistory(chatId, 15);
  const unread =
    lastChecked !== undefined
      ? recent.filter((m) => m.msgId > lastChecked)
      : recent;
  if (unread.length === 0) return;

  const summary = unread
    .map((m) => {
      const time = formatSmartTimestamp(m.timestamp);
      const media = m.mediaType ? ` [${m.mediaType}]` : "";
      const who = m.senderHandle
        ? `${m.senderName} (@${m.senderHandle})`
        : m.senderName;
      return `[msg:${m.msgId} ${time}] ${who}${media}: ${m.text.slice(0, 200)}`;
    })
    .join("\n");

  inFlight.add(chatId);
  try {
    const prompt =
      `[System: Pulse check — ${unread.length} new message(s) since last check. ` +
      `Read them and decide: respond, react with an emoji, or stay silent. ` +
      `Don't announce yourself. Reactions are great for simple acknowledgements.]\n\n${summary}`;

    await execute({
      chatId,
      numericChatId,
      prompt,
      senderName: "System",
      isGroup: true,
      source: "pulse",
    });

    // Mark as checked AFTER successful execution — if it failed, retry next tick
    lastCheckMessageId.set(chatId, latestMsgId);
    setPulseLastCheckMsgId(chatId, latestMsgId);
    log("pulse", `Checked ${chatId} (${unread.length} new msgs)`);
  } catch (err) {
    logError("pulse", `Chat ${chatId} failed`, err);
    // Don't update lastCheckMessageId — messages will be retried next pulse
  } finally {
    inFlight.delete(chatId);
  }
}
