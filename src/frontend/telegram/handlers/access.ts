/**
 * Access control — DM whitelist, group admin-membership checks, unauthorized
 * notifications, and DM-user tracking.
 */

import type { Bot, Context } from "grammy";
import { appendDailyLog } from "../../../storage/daily-log.js";
import { log, logWarn } from "../../../util/log.js";
import { getSenderName } from "./context.js";
import { groupListing, warnLegacyGroup } from "./group-access.js";
import {
  dmUsers,
  accessConfig,
  verifiedGroups,
  MAX_VERIFIED_GROUPS,
  VERIFIED_GROUP_TTL_MS,
  unauthorizedNotices,
} from "./state.js";

export function trackDmUser(
  senderId: number,
  senderName: string,
  senderUsername?: string,
): void {
  dmUsers.track(
    senderId,
    senderName,
    senderUsername ? `@${senderUsername}` : undefined,
  );
}

export function setAccessControl(cfg: {
  allowedUsers?: number[];
  blockedUsers?: number[];
  adminUserId?: number;
}): void {
  accessConfig.allowedUserIds = resolveAllowedUsers(cfg);
  accessConfig.blockedUserIds = cfg.blockedUsers?.length
    ? new Set(cfg.blockedUsers)
    : null;
  accessConfig.adminId = cfg.adminUserId ?? 0;
}

/**
 * The DM allowlist. Never "everyone": an unset `allowedUsers` defaults to the
 * admin alone, and the admin is always on the list so an allowlist that
 * forgot them cannot lock the operator out. No admin and no allowlist is an
 * empty list — nobody.
 */
function resolveAllowedUsers(cfg: {
  allowedUsers?: number[];
  adminUserId?: number;
}): Set<number> {
  const allowed = new Set(cfg.allowedUsers ?? []);
  if (cfg.adminUserId) allowed.add(cfg.adminUserId);
  return allowed;
}

/**
 * Blocked senders are dropped before any other check, in silence.
 *
 * The whitelist already stops an unknown sender being *acted on*, but it still
 * answers them with a warning and pings the admin. For a spammer or a
 * prompt-injection sender that reply is the payoff — it confirms a live bot is
 * reading — and the admin ping is the cost. Blocking removes both.
 */
function isBlocked(senderId: number | undefined): boolean {
  if (!accessConfig.blockedUserIds || senderId === undefined) return false;
  return accessConfig.blockedUserIds.has(senderId);
}

/** Check if a DM user is on the allowlist (see `resolveAllowedUsers`). */
function isDmAllowed(senderId: number | undefined): boolean {
  return senderId !== undefined && accessConfig.allowedUserIds.has(senderId);
}

/**
 * Check if the admin is a member of a group. Caches results for 10 minutes.
 */
export async function isAdminInGroup(
  bot: Bot,
  chatId: number,
): Promise<boolean> {
  // No admin configured: no group can prove the operator is present — deny.
  if (!accessConfig.adminId) return false;
  const cached = verifiedGroups.get(chatId);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.isMember;
  }
  // Expired or missing — delete stale entry
  if (cached) verifiedGroups.delete(chatId);

  // Prevent unbounded growth — evict expired entries first, then clear if still over
  if (verifiedGroups.size >= MAX_VERIFIED_GROUPS) {
    const now = Date.now();
    for (const [k, v] of verifiedGroups) {
      if (v.expiresAt <= now) verifiedGroups.delete(k);
    }
    if (verifiedGroups.size >= MAX_VERIFIED_GROUPS) verifiedGroups.clear();
  }

  try {
    const member = await bot.api.getChatMember(chatId, accessConfig.adminId);
    const isMember = !["left", "kicked"].includes(member.status);
    verifiedGroups.set(chatId, {
      isMember,
      expiresAt: Date.now() + VERIFIED_GROUP_TTL_MS,
    });
    return isMember;
  } catch (err) {
    logWarn(
      "bot",
      `isAdminInGroup check failed for chat ${chatId}: ${err instanceof Error ? err.message : err}`,
    );
    // API error (e.g. bot can't query members) — deny by default
    verifiedGroups.set(chatId, {
      isMember: false,
      expiresAt: Date.now() + VERIFIED_GROUP_TTL_MS,
    });
    return false;
  }
}

export function shouldHandleInGroup(ctx: Context): boolean {
  if (!ctx.chat || !ctx.message) return false;
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  if (!isGroup) return true;
  const text = ctx.message.text || ctx.message.caption || "";
  const botUser = ctx.me.username;
  // Word-boundary match — @botname must not be followed by alphanumeric/underscore
  const mentioned =
    botUser && new RegExp(`@${botUser}(?![a-zA-Z0-9_])`, "i").test(text);
  const repliedToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
  return !!(mentioned || repliedToBot);
}

/**
 * Full access check: denylist, then DM whitelist + group admin membership.
 * Returns true if the message should be processed.
 * Warns unauthorized users and notifies the admin — except blocked users,
 * who are dropped silently.
 */
export async function isAccessAllowed(
  ctx: Context,
  bot: Bot,
): Promise<boolean> {
  if (!ctx.chat) return false;

  // Denylist wins over everything, including the group path: a blocked user
  // gets no reply and generates no notification, anywhere.
  if (isBlocked(ctx.from?.id)) {
    log("users", `Dropped message from blocked user [id:${ctx.from?.id}]`);
    return false;
  }

  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";

  if (!isGroup) {
    if (isDmAllowed(ctx.from?.id)) return true;
    await notifyUnauthorized(bot, ctx, "dm");
    return false;
  }

  // No admin configured: no group is trusted, listed or not.
  const listing = accessConfig.adminId ? groupListing(ctx.chat.id) : "unlisted";
  if (listing === "listed") return true;
  if (listing === "legacy" && (await isAdminInGroup(bot, ctx.chat.id))) {
    warnLegacyGroup(ctx.chat.id, (ctx.chat as { title?: string }).title);
    return true;
  }
  await notifyUnauthorized(bot, ctx, "group");
  return false;
}

/**
 * True when the update is a /command or an inline-button press.
 *
 * Both are handled by `bot.command` / `bot.callbackQuery` handlers that
 * run before — and independently of — the message handlers, so the
 * message-path access check never sees them.
 */
export function isCommandOrCallback(ctx: Context): boolean {
  if (ctx.callbackQuery) return true;
  const msg = ctx.message ?? ctx.editedMessage;
  if (!msg) return false;
  const entities = msg.entities ?? msg.caption_entities ?? [];
  return entities.some((e) => e.type === "bot_command" && e.offset === 0);
}

/**
 * Gate every /command and button press behind the same access check as
 * ordinary messages (denylist, DM whitelist, group admin membership).
 *
 * Without this, a sender outside `allowedUsers` who DMs the bot is refused
 * for plain text but can still run /model, /settings, /status, /mesh,
 * /plugins, /memory and press any inline button, because those handlers
 * are registered with grammy directly and never pass through
 * `isAccessAllowed`. Must be installed BEFORE registerCommands and
 * registerCallbacks so it sees the update first.
 */
export function registerCommandAccessGate(bot: Bot): void {
  bot.use(async (ctx, next) => {
    if (!isCommandOrCallback(ctx)) return next();
    if (await isAccessAllowed(ctx, bot)) return next();
    if (ctx.callbackQuery) {
      try {
        await ctx.answerCallbackQuery();
      } catch {
        /* stale query — ignore */
      }
    }
    // Dropped: not passed to any command or callback handler.
  });
}

/**
 * Maximum length of an unauthorized message body to retain in logs.
 * Keeps abusive payloads (large pastes, attachment captions etc.) bounded
 * while still preserving enough context to understand what was sent.
 */
const UNAUTHORIZED_BODY_MAX_LEN = 1024;

/**
 * Best-effort preview of an unauthorized message for forensics.
 *
 * Returns the visible text payload (text or caption), a short tag for
 * media-only messages (`[sticker: 🤖]`, `[photo]`, `[voice 14s]`, etc.),
 * or `undefined` if there's nothing meaningful to capture (e.g. a service
 * message or empty content).
 *
 * Truncated to UNAUTHORIZED_BODY_MAX_LEN to keep log lines bounded.
 */
export function extractUnauthorizedPreview(
  message:
    | {
        text?: string;
        caption?: string;
        sticker?: { emoji?: string; set_name?: string };
        photo?: unknown;
        voice?: { duration?: number };
        video?: unknown;
        video_note?: unknown;
        audio?: unknown;
        animation?: unknown;
        document?: { file_name?: string };
        contact?: unknown;
        location?: unknown;
        poll?: { question?: string };
        dice?: { emoji?: string };
      }
    | undefined,
): string | undefined {
  if (!message) return undefined;

  const text = message.text ?? message.caption;
  if (typeof text === "string" && text.trim().length > 0) {
    return text.length > UNAUTHORIZED_BODY_MAX_LEN
      ? `${text.slice(0, UNAUTHORIZED_BODY_MAX_LEN)}… [truncated]`
      : text;
  }

  if (message.sticker) {
    const emoji = message.sticker.emoji ?? "?";
    const set = message.sticker.set_name
      ? ` from ${message.sticker.set_name}`
      : "";
    return `[sticker: ${emoji}${set}]`;
  }
  if (message.photo) return "[photo]";
  if (message.voice) {
    const dur = message.voice.duration;
    return dur ? `[voice ${dur}s]` : "[voice]";
  }
  if (message.video_note) return "[video note]";
  if (message.video) return "[video]";
  if (message.audio) return "[audio]";
  if (message.animation) return "[animation]";
  if (message.document) {
    return message.document.file_name
      ? `[document: ${message.document.file_name}]`
      : "[document]";
  }
  if (message.contact) return "[contact]";
  if (message.location) return "[location]";
  if (message.poll) {
    return message.poll.question
      ? `[poll: ${message.poll.question}]`
      : "[poll]";
  }
  if (message.dice) return `[dice: ${message.dice.emoji ?? "🎲"}]`;

  return undefined;
}

async function notifyUnauthorized(
  bot: Bot,
  ctx: Context,
  type: "dm" | "group",
): Promise<void> {
  const sender = getSenderName(ctx.from);
  const username = ctx.from?.username ? ` (@${ctx.from.username})` : "";
  const userId = ctx.from?.id ?? "unknown";

  // Capture message body BEFORE the cooldown check — every unauthorized
  // attempt should be recorded for forensics, even if the user-facing
  // warning + admin notification are suppressed by cooldown. Without
  // this, follow-up DMs from a known social-engineering account vanish
  // entirely from logs.
  const body = extractUnauthorizedPreview(
    ctx.message as Parameters<typeof extractUnauthorizedPreview>[0],
  );
  if (body) {
    try {
      appendDailyLog(
        `⚠️ UNAUTHORIZED ${sender}${username} [id:${userId}]`,
        body,
      );
    } catch {
      /* daily log unavailable — fall through to talon.log */
    }
    logWarn(
      "access",
      `Unauthorized ${type} body from ${sender}${username} [id:${userId}]: ${body.slice(0, 200)}`,
    );
  }

  const key = type === "dm" ? `dm:${ctx.from?.id}` : `group:${ctx.chat?.id}`;
  if (!unauthorizedNotices.shouldNotify(key)) return;

  // Warn the user
  try {
    await bot.api.sendMessage(
      ctx.chat!.id,
      "⚠️ Unauthorized access. This bot is private. This attempt has been reported to the bot owner.",
    );
  } catch {
    /* can't send — ignore */
  }

  // Notify admin
  if (accessConfig.adminId) {
    const detail =
      type === "dm"
        ? `🚨 Unauthorized DM from ${sender}${username} [id:${userId}]`
        : `🚨 Unauthorized group access: "${(ctx.chat as { title?: string })?.title ?? ctx.chat!.id}" [id:${ctx.chat!.id}] by ${sender}${username}`;
    const detailWithBody = body ? `${detail}\n\n${body.slice(0, 400)}` : detail;
    try {
      await bot.api.sendMessage(accessConfig.adminId, detailWithBody);
    } catch {
      /* admin unreachable — ignore */
    }
  }

  logWarn(
    "access",
    `Unauthorized ${type}: ${sender}${username} [id:${userId}] in chat ${ctx.chat!.id}`,
  );
}
