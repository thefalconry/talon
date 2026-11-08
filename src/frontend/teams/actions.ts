/**
 * Teams action handler — routes MCP tool calls to Teams via Power Automate webhook.
 */

import type { ActionResult, FrontendActionHandler } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { buildAdaptiveCard, splitTeamsMessage } from "./formatting.js";
import { log, logError } from "../../util/log.js";
import { proxyFetch } from "./proxy-fetch.js";
import { createDeliveryTracker, trackDeliveries } from "../health/delivery.js";

const delivery = createDeliveryTracker("teams", "Teams", "teams");

/**
 * POST an Adaptive Card to the Power Automate workflow webhook URL.
 */
async function postToTeams(webhookUrl: string, text: string): Promise<void> {
  const chunks = splitTeamsMessage(text);
  for (const chunk of chunks) {
    const card = buildAdaptiveCard(chunk);
    const resp = await proxyFetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Teams webhook POST failed: ${resp.status} ${body}`);
    }
  }
}

export function createTeamsActionHandler(
  webhookUrl: string,
  gateway: Gateway,
): FrontendActionHandler {
  const dispatch: FrontendActionHandler = async (
    body,
    chatId,
  ): Promise<ActionResult | null> => {
    const action = body.action as string;

    switch (action) {
      case "send_message": {
        const text = String(body.text ?? "");
        if (!text) return { ok: true, message_id: Date.now() };
        try {
          await postToTeams(webhookUrl, text);
          gateway.incrementMessages(chatId);
          log("teams", `Sent message to chat ${chatId} (${text.length} chars)`);
          return { ok: true, message_id: Date.now() };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError("teams", `send_message failed: ${msg}`);
          return { ok: false, error: msg };
        }
      }

      case "send_message_with_buttons": {
        const text = String(body.text ?? "");
        const rows = body.rows as
          Array<Array<{ text: string; url?: string }>> | undefined;
        const buttons = rows?.flat().map((b) => ({ text: b.text, url: b.url }));
        try {
          const card = buildAdaptiveCard(text, buttons);
          const resp = await proxyFetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(card),
            signal: AbortSignal.timeout(15_000),
          });
          if (!resp.ok) throw new Error(`${resp.status}`);
          gateway.incrementMessages(chatId);
          return { ok: true, message_id: Date.now() };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError("teams", `send_message_with_buttons failed: ${msg}`);
          return { ok: false, error: msg };
        }
      }

      // These actions are not supported on the Teams frontend.
      case "react":
      case "edit_message":
      case "delete_message":
      case "pin_message":
      case "unpin_message":
      case "forward_message":
      case "copy_message":
      case "send_chat_action":
        return {
          ok: false,
          error: `Action "${action}" is not supported on Teams`,
        };

      case "get_chat_info":
        return {
          ok: true,
          id: chatId,
          type: "channel",
          title: "Teams Channel",
        };

      default:
        return null;
    }
  };
  return trackDeliveries(delivery, dispatch);
}

export { postToTeams };
