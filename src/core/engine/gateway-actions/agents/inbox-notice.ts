/**
 * Sub-agent inbox notice injection.
 *
 * Appends a short reminder notice to tool results while a sub-agent has
 * unread inbox messages, ensuring busy agents do not miss instructions from
 * their parent or peers. Draining the inbox via `check_inbox` clears the notice.
 * Never added to normal chat sessions.
 */

import type { ActionResult } from "../../../types.js";
import { agentIdFromContextLabel } from "../../../agents/context.js";
import { agentRegistry } from "../../../agents/registry.js";
import { buildInboxNotice } from "../../../agents/prompt.js";

/**
 * While a sub-agent has unread inbox messages, append a short reminder
 * notice to its tool result so it does not sit on unread instructions.
 * Chat callers and empty inboxes are returned untouched.
 */
export function attachInboxNotice(
  result: ActionResult,
  chatKey: string,
): ActionResult {
  const agentId = agentIdFromContextLabel(chatKey);
  if (!agentId || !agentRegistry.isLive(agentId)) return result;

  const depth = agentRegistry.inboxDepth(agentId);
  if (depth <= 0) return result;

  const notice = buildInboxNotice(depth);
  if (
    (typeof result.text === "string" && result.text.includes("[inbox:")) ||
    (typeof result.error === "string" && result.error.includes("[inbox:"))
  ) {
    return result;
  }

  if (typeof result.text === "string") {
    const trimmed = result.text.trimEnd();
    return {
      ...result,
      text: trimmed.length > 0 ? `${trimmed}\n\n${notice}` : notice,
    };
  }

  if (typeof result.error === "string") {
    const trimmed = result.error.trimEnd();
    return {
      ...result,
      error: trimmed.length > 0 ? `${trimmed}\n\n${notice}` : notice,
    };
  }

  return {
    ...result,
    text: notice,
  };
}
