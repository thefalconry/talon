/**
 * WhatsApp account management — the server side of the
 * `whatsapp_account` tool.
 *
 * A chat-free shared action, for the same reason `send_via` is one: the
 * account surface belongs to the WhatsApp *connection*, not to any
 * conversation, and the session driving it usually lives somewhere else
 * (Ada's Telegram DM, or a heartbeat run with no ambient chat at
 * all). Routing it through the normal chat_id path would demand a
 * WhatsApp chat that need not exist.
 *
 * Dispatch reuses the cross-send broker — core never imports
 * src/frontend, so the WhatsApp handler arrives by registration — and
 * deliberately sends no `target`, because the frontend's dispatcher
 * treats `body.target` as a chat-routing key and these ops address the
 * logged-in identity instead.
 */

import type { SharedActionHandlers } from "./types.js";
import { crossSendTarget, crossSendTargetNames } from "./cross-send.js";

export const whatsappAccountHandlers: SharedActionHandlers = {
  whatsapp_account: async (body) => {
    const op = String(body.op ?? "").trim();
    if (!op) {
      return { ok: false, error: "whatsapp_account: op is required" };
    }
    const handler = crossSendTarget("whatsapp");
    if (!handler) {
      const enabled = crossSendTargetNames().join(", ") || "none";
      return {
        ok: false,
        error: `whatsapp_account: the whatsapp frontend is not enabled (enabled: ${enabled})`,
      };
    }
    // 0 is the chat-free dispatch's own "no chat" sentinel; the frontend
    // lists whatsapp_account as chatless, so it never resolves one.
    const result = await handler({ ...body, action: "whatsapp_account" }, 0);
    if (!result) {
      return {
        ok: false,
        error:
          "whatsapp_account: the whatsapp frontend does not implement " +
          "whatsapp_account (is it running an older build?)",
      };
    }
    return result;
  },
};

/** Chat-free by design — see the module note. */
export const whatsappAccountChatFreeActions: ReadonlySet<string> = new Set([
  "whatsapp_account",
]);
