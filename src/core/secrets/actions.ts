/**
 * Gateway action for `request_secret`. Needs the chat (the receipt goes
 * back to it), so it is not chat-free.
 */

import type { SharedActionHandlers } from "../engine/gateway-actions/types.js";
import { requestSecretDrop } from "./service.js";

export const secretHandlers: SharedActionHandlers = {
  request_secret: (body, _chatId, _backend, chatKey) => {
    const minted = requestSecretDrop({
      name: body.name,
      purpose: body.purpose,
      chatKey,
    });
    return { ok: minted.ok, text: minted.text };
  },
};
