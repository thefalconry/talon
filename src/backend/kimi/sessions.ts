/**
 * Session lifecycle for the Kimi backend: reset, warm, and tool refresh.
 */

import { log } from "../../util/log.js";
import { getSession } from "../../storage/sessions.js";
import { getState } from "./state.js";
import { killChild } from "./process/child.js";

export function resetChat(chatId: string): void {
  const conversationId = getSession(chatId).sessionId;
  killChild(chatId, "reset");
  getState().lastUsage.delete(chatId);
  if (conversationId) getState().lastUsage.delete(conversationId);
  log("agent", `[${chatId}] kimi session reset`);
}

export async function warmSession(chatId: string): Promise<void> {
  // Best-effort warm-up hint.
  log("agent", `[${chatId}] kimi session warmed`);
}

/**
 * Talon's MCP tools are not wired into kimi (see `kimiSystemPromptSuffix`),
 * so there is nothing to add or remove. kimi re-reads its own `mcp.json`
 * on every spawn; dropping the pooled child is all a refresh needs.
 */
export async function refreshTools(chatId: string): Promise<{
  added: string[];
  removed: string[];
  errors: Record<string, string>;
}> {
  killChild(chatId, "tool-refresh");
  return { added: [], removed: [], errors: {} };
}
