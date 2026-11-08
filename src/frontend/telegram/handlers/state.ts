/**
 * Shared module-level state for the Telegram message-handling pipeline.
 *
 * Each Map/Set is created once here and imported by the handler submodules
 * so refcounts, caches, and queues stay coherent across files. Values that
 * are reassigned (the access-control config) live on a holder object so other
 * modules can mutate them through the import.
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../../core/config/index.js";
import {
  createDmUserTracker,
  createNoticeCooldown,
  createRateLimiter,
} from "../../presentation/access.js";

// ── First-time DM user tracking ──────────────────────────────────────────────

export const dmUsers = createDmUserTracker<number>(10_000);

// ── Access control ──────────────────────────────────────────────────────────

/** Reassignable access config — holder object so setAccessControl can mutate. */
export const accessConfig: {
  allowedUserIds: Set<number>; // DM allowlist — empty means nobody
  blockedUserIds: Set<number> | null; // null = no denylist
  adminId: number;
} = {
  allowedUserIds: new Set(),
  blockedUserIds: null,
  adminId: 0,
};

// chatId → { isMember, expiresAt } — timestamp-based expiry, no timers
export const verifiedGroups = new Map<
  number,
  { isMember: boolean; expiresAt: number }
>();
export const MAX_VERIFIED_GROUPS = 1000;
export const VERIFIED_GROUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Rate-limit unauthorized access warnings (one per user/group per 10 minutes)
export const unauthorizedNotices = createNoticeCooldown({
  ttlMs: 10 * 60 * 1000,
  cap: 5000,
});

// ── Message queue (debounce rapid-fire messages per chat) ─────────────────────

export type QueuedMessage = {
  prompt: string;
  replyToId: number;
  messageId: number;
  senderName: string;
  senderUsername?: string;
  senderId?: number;
  isGroup: boolean;
  chatTitle?: string;
};

export const messageQueues = new Map<
  string,
  {
    messages: QueuedMessage[];
    timer: ReturnType<typeof setTimeout>;
    bot: Bot;
    config: TalonConfig;
    numericChatId: number;
    queuedReactionMsgIds: number[];
  }
>();

export const DEBOUNCE_MS = 500;
export const MAX_QUEUED_PER_CHAT = 20;
export const lastHandledMessageIdByChat = new Map<string, number>();

// ── Per-user rate limiting ──────────────────────────────────────────────────

/** 15 messages per minute per user. */
export const rateLimiter = createRateLimiter<number>({
  windowMs: 60_000,
  maxMessages: 15,
});
