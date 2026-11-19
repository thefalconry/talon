/**
 * Session lifecycle for the Antigravity backend: reset, warm, and the
 * hot MCP refresh.
 *
 * All three are variations on the same two facts: the child reads its
 * MCP servers once at spawn, and the conversation lives in agy's own
 * store keyed by `conversation_id`. So "change the tools" and "start
 * fresh" both come down to rewriting the config file and respawning.
 */

import { log } from "../../util/log.js";
import { dirs } from "../../util/paths.js";
import { getSession } from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { getState, agyBinary } from "./state.js";
import { registerMcpForChat, unregisterMcpForChat } from "./mcp/register.js";
import { ensureChild, killChild } from "./process/child.js";
import { selectAgyRun } from "./effort.js";
import { catalogForSelection, getDefaultModelId } from "./models.js";

/**
 * Drop everything this chat holds: kill the child, remove its MCP
 * entries (and their schema snapshots), and forget the cached usage.
 * The stored conversation id is cleared by the dispatcher's own
 * `storage/sessions.ts: resetSession` call.
 */
export function resetChat(chatId: string): void {
  const conversationId = getSession(chatId).sessionId;
  killChild(chatId, "reset");
  unregisterMcpForChat(chatId);
  // The snapshot is filed under both ids (see `settleUsage`).
  getState().lastUsage.delete(chatId);
  if (conversationId) getState().lastUsage.delete(conversationId);
  log("agent", `[${chatId}] agy session reset`);
}

/**
 * Pre-spawn the child and register its MCP servers so the first reply
 * after a `/reset` doesn't serially pay CLI startup plus tool
 * registration. Best-effort: a warm-up that throws must not surface
 * as a failed reset.
 */
export async function warmSession(chatId: string): Promise<void> {
  const config = getState().config;
  if (!config) return;
  try {
    registerMcpForChat(chatId);
    const workspace = config.workspace || dirs.workspace;
    const settings = getChatSettings(chatId);
    const session = getSession(chatId);
    // Same resolution as the turn itself, so the warm child's spec
    // matches and is reused instead of respawned on the first message.
    const { model, effort } = selectAgyRun(
      settings.model ?? config.model ?? getDefaultModelId(),
      settings.effort,
      settings.effort ? await catalogForSelection() : [],
    );
    ensureChild(chatId, {
      binary: agyBinary(config.agyBinary),
      cwd: workspace,
      model,
      effort,
      addDirs: [workspace],
      ...(session.sessionId ? { conversationId: session.sessionId } : {}),
    });
    log("agent", `[${chatId}] agy session warmed`);
  } catch (err) {
    log(
      "agent",
      `[${chatId}] agy warm-up skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Re-derive the chat's MCP entries from the live plugin registry and
 * respawn the child so it picks them up. agy snapshots each server's
 * tool schemas at registration time and reads the server list once at
 * process start, so a running child cannot learn a new tool — the
 * respawn is the refresh.
 */
export async function refreshTools(chatId: string): Promise<{
  added: string[];
  removed: string[];
  errors: Record<string, string>;
}> {
  const { added, removed } = registerMcpForChat(chatId);
  const respawned = killChild(chatId, "tool-refresh");
  log(
    "agent",
    `[${chatId}] agy tools refreshed: +${added.length} -${removed.length}` +
      `${respawned ? " (child respawns on next turn)" : ""}`,
  );
  return { added, removed, errors: {} };
}
