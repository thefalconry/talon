/**
 * The /auth panel's account buttons — the part that changes which Claude
 * accounts exist and which one this chat runs on.
 *
 *   auth:add          add the next `claude-N` and start its sign-in
 *   auth:rm:<id>      confirmation: what moves, what is deleted
 *   auth:rmok:<id>    remove the account, redraw with the outcome
 *   auth:use:<id>     pin the panel's chat to that Claude account
 *
 * Pinning goes through the same switch `/model` uses
 * (presentation/model-commands.ts), so the session hand-off is identical.
 */

import type { Context } from "grammy";
import {
  planClaudeAccountRemoval,
  removeClaudeAccount,
} from "../../../core/auth/claude-accounts-admin.js";
import { providerLabel } from "../../../core/auth/status.js";
import { isClaudeAccountId } from "../../../core/config/claude-accounts.js";
import {
  getBackendIdForChat,
  getBackendIdForRole,
  hasChatBackendOverride,
  isBackendAvailable,
} from "../../../core/engine/backend-controller/index.js";
import {
  resetChatBackend,
  switchChatBackend,
} from "../../presentation/model-commands.js";
import {
  addAccountAndSignIn,
  editPanel,
  isAuthProvider,
  notedAuthPanel,
  removedNote,
  renderRemoveConfirm,
} from "../auth-panel.js";
import { loginBinariesFrom } from "../commands/auth.js";
import { escapeHtml } from "../formatting.js";
import { answerCallbackQuerySafe, type CallbackDeps } from "./query.js";

/** Where the panel lives. */
type PanelAt = { chatId: number; messageId: number };

type AccountAction = (
  ctx: Context,
  id: string,
  at: PanelAt,
  deps: CallbackDeps,
) => Promise<void>;

async function addAccount(
  ctx: Context,
  _id: string,
  at: PanelAt,
  { config }: CallbackDeps,
): Promise<void> {
  await answerCallbackQuerySafe(ctx, { text: "Adding account…" });
  await addAccountAndSignIn(
    ctx,
    at.chatId,
    at.messageId,
    {},
    loginBinariesFrom(config),
  );
}

async function confirmRemove(
  ctx: Context,
  id: string,
  at: PanelAt,
): Promise<void> {
  const plan = planClaudeAccountRemoval(id);
  if (!plan.ok) {
    await answerCallbackQuerySafe(ctx, { text: plan.error.slice(0, 200) });
    return;
  }
  await answerCallbackQuerySafe(ctx);
  await editPanel(ctx, at.chatId, at.messageId, renderRemoveConfirm(plan));
}

async function removeAccount(
  ctx: Context,
  id: string,
  at: PanelAt,
): Promise<void> {
  await answerCallbackQuerySafe(ctx, { text: "Removing…" });
  const removed = await removeClaudeAccount(id, { deleteCredentials: true });
  const note = removed.ok
    ? removedNote(removed)
    : `❌ ${escapeHtml(removed.error)}`;
  await editPanel(
    ctx,
    at.chatId,
    at.messageId,
    await notedAuthPanel(at.chatId, note),
  );
}

/**
 * Pin the chat to a Claude account. Picking the backend the chat role
 * already defaults to drops the override instead of pinning it twice.
 */
async function useAccount(
  ctx: Context,
  id: string,
  at: PanelAt,
  deps: CallbackDeps,
): Promise<void> {
  const cid = String(at.chatId);
  const claude =
    id === "claude" || (isClaudeAccountId(id) && isAuthProvider(id));
  if (!claude || !isBackendAvailable(id, deps.config)) {
    await answerCallbackQuerySafe(ctx, { text: "Not available here" });
    return;
  }
  await answerCallbackQuerySafe(ctx);
  const label = providerLabel(id);
  let text: string;
  if (getBackendIdForChat(cid) === id) {
    text = `This chat already uses ${label}.`;
  } else if (
    id === getBackendIdForRole("chat") &&
    hasChatBackendOverride(cid)
  ) {
    text = (await resetChatBackend(cid, deps)).text;
  } else {
    text = (await switchChatBackend(cid, { id, label }, deps)).text;
  }
  await editPanel(
    ctx,
    at.chatId,
    at.messageId,
    await notedAuthPanel(at.chatId, `💬 ${escapeHtml(text)}`),
  );
}

// Null-prototype: a crafted action name can't reach Object.prototype.
const ACCOUNT_ACTIONS: Record<string, AccountAction> = Object.assign(
  Object.create(null),
  {
    add: addAccount,
    rm: confirmRemove,
    rmok: removeAccount,
    use: useAccount,
  } satisfies Record<string, AccountAction>,
);

/** Handle an account button. False when `action` isn't one of them. */
export async function handleAccountAction(
  ctx: Context,
  action: string,
  id: string,
  at: PanelAt,
  deps: CallbackDeps,
): Promise<boolean> {
  const run = ACCOUNT_ACTIONS[action];
  if (!run) return false;
  await run(ctx, id, at, deps);
  return true;
}
