/**
 * Native action handler — the gateway-side bridge for the agent's delivery
 * tools. When the model calls `end_turn` / `send_message` / `react` / edit /
 * delete, the MCP tool POSTs an action to the gateway, which routes it here
 * by the active chat's numeric id. We translate each action into a Bridge
 * event the connected clients render, persist assistant messages to history,
 * and count deliveries on the gateway (so the dispatcher's trailing-prose
 * fallback knows the turn already produced output).
 */

import type {
  FrontendActionHandler,
  ActionResult,
} from "../../../core/types.js";
import type { Gateway } from "../../../core/engine/gateway.js";
import type { NativeChats, ChatEntry } from "../chats/chats.js";
import type { BridgeEvent, ClientButton } from "../protocol.js";
import {
  deriveNumericChatId,
  isNativeChatId,
} from "../../../core/frontend-runtime/chat-id.js";

export type NativeActionDeps = {
  chats: NativeChats;
  gateway: Gateway;
  /** Persist + broadcast an assistant message; returns its numeric id. */
  emitAssistant: (
    entry: ChatEntry,
    text: string,
    buttons?: ClientButton[][],
  ) => number;
  /** Persist + broadcast an assistant photo message; returns its numeric id. */
  emitPhoto: (entry: ChatEntry, filePath: string, caption?: string) => number;
  broadcast: (event: BridgeEvent) => void;
};

/** Coerce gateway button rows (`[[{text,url,callback_data}]]`) to wire buttons. */
function toButtons(rows: unknown): ClientButton[][] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const mapped: ClientButton[][] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const cells: ClientButton[] = [];
    for (const cell of row) {
      if (cell && typeof cell === "object") {
        const c = cell as Record<string, unknown>;
        const text = typeof c.text === "string" ? c.text : "";
        if (!text) continue;
        cells.push({
          text,
          url: typeof c.url === "string" ? c.url : undefined,
          data:
            typeof c.callback_data === "string" ? c.callback_data : undefined,
        });
      }
    }
    if (cells.length) mapped.push(cells);
  }
  return mapped.length ? mapped : undefined;
}

/** Actions this handler owns. Everything else must return null so the
 *  gateway can try plugin + shared actions (history, web, cron, mesh…) —
 *  failing early here would swallow actions that aren't native's to answer. */
const NATIVE_ACTIONS = new Set([
  "send_message",
  "send_message_with_buttons",
  "send_photo",
  "react",
  "edit_message",
  "delete_message",
  "get_chat_info",
  "send_chat_action",
]);

/**
 * A plain send addressed to a native chat this daemon doesn't list — the
 * chat that asked for a staged restore, say, when the restored database
 * predates it. The sender names the chat by key in `body.target`; the
 * chat is adopted (as a deep link would) so the message lands in its
 * history and the app shows it. Only when the key really is the chat the
 * numeric id was derived from, and only for send_message: edits,
 * reactions and deletes address messages, which an unknown chat has none of.
 */
function adoptAddressedChat(
  chats: NativeChats,
  action: string,
  body: Record<string, unknown>,
  chatId: number,
): ChatEntry | undefined {
  if (action !== "send_message") return undefined;
  const key = typeof body.target === "string" ? body.target : "";
  if (!key || !isNativeChatId(key) || deriveNumericChatId(key) !== chatId)
    return undefined;
  return chats.ensure(key);
}

export function createNativeActionHandler(
  deps: NativeActionDeps,
): FrontendActionHandler {
  const { chats, gateway, emitAssistant, emitPhoto, broadcast } = deps;

  return async (body, chatId): Promise<ActionResult | null> => {
    const action = typeof body.action === "string" ? body.action : "";
    if (!NATIVE_ACTIONS.has(action)) return null;
    const entry =
      chats.byNumeric(chatId) ??
      adoptAddressedChat(chats, action, body, chatId);
    if (!entry) return { ok: false, error: "No active native chat" };

    switch (action) {
      case "send_message": {
        const text = String(body.text ?? "");
        const id = emitAssistant(entry, text);
        gateway.incrementMessages(chatId);
        return { ok: true, message_id: id };
      }

      case "send_message_with_buttons": {
        const text = String(body.text ?? "");
        const id = emitAssistant(entry, text, toButtons(body.rows));
        gateway.incrementMessages(chatId);
        return { ok: true, message_id: id };
      }

      case "send_photo": {
        const filePath = String(body.file_path ?? "");
        if (!filePath) return { ok: false, error: "file_path required" };
        const caption =
          typeof body.caption === "string" ? body.caption : undefined;
        const id = emitPhoto(entry, filePath, caption);
        gateway.incrementMessages(chatId);
        return { ok: true, message_id: id };
      }

      case "react": {
        const messageId = String(body.message_id ?? "");
        const emoji = String(body.emoji ?? "👍");
        broadcast({ kind: "reaction", chatId: entry.id, messageId, emoji });
        gateway.incrementMessages(chatId);
        return { ok: true };
      }

      case "edit_message": {
        const messageId = String(body.message_id ?? "");
        const text = String(body.text ?? "");
        broadcast({
          kind: "message_edited",
          chatId: entry.id,
          messageId,
          text,
        });
        return { ok: true };
      }

      case "delete_message": {
        const messageId = String(body.message_id ?? "");
        broadcast({ kind: "message_deleted", chatId: entry.id, messageId });
        return { ok: true };
      }

      case "get_chat_info":
        return {
          ok: true,
          id: entry.numericId,
          type: "private",
          title: entry.title,
        };

      // Typing is driven by the dispatcher via sendTyping → no-op ack here.
      case "send_chat_action":
        return { ok: true };

      default:
        // Unreachable — NATIVE_ACTIONS gates the switch — but keeps the
        // contract explicit if the set and the cases ever drift.
        return null;
    }
  };
}
