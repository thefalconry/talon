/**
 * Backend switching — `model:backend:<id>` and `model:backend-default`.
 * Both drop Talon's per-chat stores for the outgoing backend and hand the
 * session over (see `handOffBackendSession`).
 */

import type { Context } from "grammy";
import { setChatBackend } from "../../../../storage/chat-settings.js";
import { resetSession } from "../../../../storage/sessions.js";
import { sharesSessionStore } from "../../../../core/agent-runtime/backend-registry.js";
import {
  getBackendIdForChat,
  listAvailableBackends,
  rebindChat,
  releaseChat,
} from "../../../../core/engine/backend-controller/index.js";
import { resetPulseCheckpoint } from "../../../../core/background/pulse/pulse.js";
import { resolveActiveModelForChat } from "../../../../core/models/active-model.js";
import { logWarn } from "../../../../util/log.js";
import type { ModelCallback } from "../../model-callbacks.js";
import { resolveBackendForChat } from "../../model-menu.js";
import { answerCallbackQuerySafe, type CallbackDeps } from "../query.js";
import type { ModelOutcome } from "./types.js";

/**
 * Run the backend-side half of a chat's session handoff.
 *
 * A backend switch already clears Talon's own stores (session row,
 * history, pulse checkpoint), but those are only half the state.
 * `performSessionReset` also drives the backend capability slots, and
 * the switch path skipped them entirely:
 *
 *   - the OUTGOING backend keeps in-process per-chat state that no
 *     amount of clearing Talon's stores touches. openai-agents holds a
 *     `MemorySession` map keyed by chat id, so switching away and back
 *     resurrected the old conversation the operator meant to drop.
 *   - the INCOMING backend was never warmed, so the first turn after a
 *     switch paid the full cold start — on OpenCode/Kilo that is session
 *     creation plus a per-plugin MCP registration sweep.
 *
 * The warm is deliberately fire-and-forget: it can take seconds, and the
 * callback still has a toast to answer and a menu to redraw. Telegram
 * expires an unanswered callback query, so blocking here would trade a
 * cold first turn for a visibly stuck button.
 */
function handOffBackendSession(
  chatId: string,
  previousBackend: ReturnType<typeof resolveBackendForChat>,
  gateway: CallbackDeps["gateway"],
): void {
  previousBackend?.sessions?.resetChat?.(chatId);
  const nextBackend = resolveBackendForChat(chatId, gateway);
  // Same instance on a no-op switch — warming it again is harmless
  // (every step is idempotent) but pointless, so skip it.
  if (!nextBackend || nextBackend === previousBackend) return;
  void Promise.resolve(nextBackend.sessions?.warmSession?.(chatId)).catch(
    (err) =>
      logWarn(
        "bot",
        `[${chatId}] warm after backend switch failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
  );
}

export async function handleBackendSelect(
  ctx: Context,
  action: Extract<ModelCallback, { kind: "backend-select" }>,
  cid: string,
  { config, gateway }: CallbackDeps,
): Promise<ModelOutcome | undefined> {
  // Rebind chat to the chosen backend. Verify the requested id
  // is on the enabled list to keep the menu and the operation
  // in sync — `config.enabledBackends` is a UX filter and we
  // honour it here too.
  const available = listAvailableBackends(config);
  if (!available.some((b) => b.id === action.backendId)) {
    await answerCallbackQuerySafe(ctx, {
      text: "Backend not available",
    });
    return undefined;
  }
  // Resolve the outgoing backend BEFORE rebinding — afterwards this
  // chat already points at the new one and the old in-process state
  // would be unreachable.
  const previousBackend = resolveBackendForChat(cid, gateway);
  const previousId = getBackendIdForChat(cid);
  const result = await rebindChat(cid, action.backendId, config);
  if (!result.ok) {
    await answerCallbackQuerySafe(ctx, {
      text: result.error?.slice(0, 200) ?? "Rebind failed",
    });
    return undefined;
  }
  setChatBackend(cid, action.backendId);
  // Switching backends drops the previous backend's per-chat
  // session state (it's not portable across backends). We DO
  // NOT clear `modelByBackend` — keeping each backend's prior
  // pick means switching back-and-forth restores each side's
  // last choice automatically (Codex chat keeps gpt-5.5,
  // OpenRouter chat keeps owl-alpha, etc). Chat history is never
  // touched: a switch changes who answers, not what was said. Two logins
  // of one provider that share a transcript store (Claude accounts) keep
  // the session.
  if (!sharesSessionStore(previousId, action.backendId))
    resetSession(cid, "backend-switch");
  resetPulseCheckpoint(cid);
  handOffBackendSession(cid, previousBackend, gateway);
  const label =
    available.find((b) => b.id === action.backendId)?.label ?? action.backendId;
  // Toast names the model the new backend will actually run
  // (per-chat slot if remembered, else canonical / operator
  // default; "no default" if catalog-driven with no config).
  const newBackend = resolveBackendForChat(cid, gateway);
  const { model: resolvedNewModel } = await resolveActiveModelForChat(
    cid,
    newBackend,
    action.backendId,
    config,
  );
  return {
    toast: resolvedNewModel
      ? `Backend: ${label} (model: ${resolvedNewModel})`
      : `Backend: ${label} — no default model, /model to pick one`,
    view: { kind: "menu" },
  };
}

export async function handleBackendDefault(
  _ctx: Context,
  _action: Extract<ModelCallback, { kind: "backend-default" }>,
  cid: string,
  { config, gateway }: CallbackDeps,
): Promise<ModelOutcome> {
  // Drop the per-chat backend override; chat reverts to the
  // global chat-role backend. Per-backend model picks are
  // preserved (modelByBackend stays intact) so reverting and
  // switching back later still restores prior choices.
  const previousBackend = resolveBackendForChat(cid, gateway);
  const previousId = getBackendIdForChat(cid);
  await releaseChat(cid);
  setChatBackend(cid, undefined);
  // History stays — see handleBackendSelect.
  if (!sharesSessionStore(previousId, getBackendIdForChat(cid)))
    resetSession(cid, "backend-switch");
  resetPulseCheckpoint(cid);
  handOffBackendSession(cid, previousBackend, gateway);
  // Resolve the now-default backend's model for the toast.
  const defaultBackend = resolveBackendForChat(cid, gateway);
  const defaultBackendId = getBackendIdForChat(cid);
  const { model: resolvedRoleModel } = await resolveActiveModelForChat(
    cid,
    defaultBackend,
    defaultBackendId,
    config,
  );
  return {
    toast: resolvedRoleModel
      ? `Backend reset to default (model: ${resolvedRoleModel})`
      : `Backend reset to default — no model picked, /model to pick one`,
    view: { kind: "menu" },
  };
}
