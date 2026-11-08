/**
 * WhatsApp-specific action handlers.
 *
 * Handles the MCP tool actions that need the WhatsApp socket.
 * Platform-agnostic actions (cron, fetch_url, in-memory history) are
 * served by core/engine/gateway-actions before this is reached, and any
 * action this module doesn't claim returns null so that fallback still
 * applies — which is how `read_history` and friends work here without a
 * WhatsApp-specific implementation.
 *
 * Split by responsibility (mirrors the telegram/discord actions/ layout):
 *   - account    — the bot's own profile, privacy, blocklist, presence
 *   - shared     — tryAction, media/quote resolution, send helpers
 *   - messaging  — text, replies, reactions, edits, deletes, pins, presence
 *   - media      — images, video, audio, documents, polls, locations, …
 *   - chat-info  — group metadata, members, titles
 *   - history    — get_message_by_id, download_media (re-upload aware)
 *   - moderation — the `moderate` op switch
 */

import type { WASocket } from "baileys";
import type { Gateway } from "../../../core/engine/gateway.js";
import type { ActionResult } from "../../../core/types.js";
import {
  lookupWhatsAppChat,
  resolveWhatsAppTarget,
  type WhatsAppChatInfo,
} from "../registry.js";
import { accountHandlers } from "./account.js";
import { chatInfoHandlers } from "./chat-info.js";
import { historyHandlers } from "./history.js";
import { mediaHandlers } from "./media.js";
import { messagingHandlers } from "./messaging.js";
import { moderationHandlers } from "./moderation.js";
import type { WhatsAppActionContext, WhatsAppActionHandlers } from "./types.js";
import {
  createDeliveryTracker,
  trackDeliveries,
} from "../../health/delivery.js";

const delivery = createDeliveryTracker("whatsapp", "WhatsApp", "whatsapp");

/** A cross-send names its destination; everything else goes to `chatId`. */
const destination = (body: Record<string, unknown>, chatId: number) =>
  body.target !== undefined ? String(body.target) : chatId;

// Null-prototype so a request `action` of "toString" / "constructor" can't
// resolve an inherited Object.prototype method via `handlers[action]`.
const handlers: WhatsAppActionHandlers = Object.assign(Object.create(null), {
  ...accountHandlers,
  ...messagingHandlers,
  ...mediaHandlers,
  ...chatInfoHandlers,
  ...historyHandlers,
  ...moderationHandlers,
});

/**
 * Actions that need no resolved chat: the store-only scheduling pair,
 * and the account surface, which addresses the logged-in identity
 * rather than any conversation.
 */
const CHATLESS_ACTIONS = new Set([
  "cancel_scheduled",
  "list_scheduled",
  "whatsapp_account",
]);

export function createWhatsAppActionHandler(
  getSock: () => WASocket | null,
  gateway: Gateway,
) {
  const scheduledMessages = new Map<string, ReturnType<typeof setTimeout>>();

  const dispatch = async (
    body: Record<string, unknown>,
    chatId: number,
  ): Promise<ActionResult | null> => {
    const action = body.action as string;
    const handler = handlers[action];
    if (!handler) return null; // not a WhatsApp action — let the core try

    const sock = getSock();
    if (!sock) {
      return { ok: false, error: "WhatsApp socket is not connected" };
    }

    // An explicit cross-send target (send_via) names the destination
    // itself — phone number, wa_* id, or JID — and may be a chat this
    // process has never seen; resolveWhatsAppTarget registers it so the
    // usual numeric-id routing works from then on. Without a target,
    // the gateway's numeric chatId (an active chat) is the destination.
    let chat: WhatsAppChatInfo | null;
    if (body.target !== undefined) {
      chat = resolveWhatsAppTarget(body.target) ?? null;
      if (!chat) {
        return {
          ok: false,
          error:
            `Unresolvable WhatsApp target "${String(body.target)}" — use a ` +
            `phone number with country code, a wa_dm_/wa_group_ id, or a ` +
            `known chat id.`,
        };
      }
    } else {
      chat = lookupWhatsAppChat(chatId) ?? null;
    }
    if (!chat && !CHATLESS_ACTIONS.has(action)) {
      return {
        ok: false,
        error:
          `No WhatsApp chat known for id ${chatId} — Talon learns a chat's ` +
          `JID from its first message.`,
      };
    }

    const ctx: WhatsAppActionContext = {
      sock,
      gateway,
      chat,
      scheduledMessages,
    };
    const result = await handler(body, chatId, ctx);
    // An explicitly targeted action resolved a chat the caller could not
    // name itself (a phone number is not a chat id). Report where the
    // message landed so cross-frontend callers can follow the thread.
    return result && chat && body.target !== undefined
      ? { ...result, chat_id: chat.chatId }
      : result;
  };
  return trackDeliveries(delivery, dispatch, destination);
}
