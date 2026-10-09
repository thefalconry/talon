/**
 * /auth panel — sign the daemon's Claude and Codex CLIs back in from
 * Telegram, admin only. Each extra Claude account (`claudeAccounts`) gets
 * its own row and its own sign-in button.
 *
 * The panel also manages the accounts themselves: add one (and go straight
 * into its sign-in), remove one behind a confirmation, and pin the chat
 * the panel is in to any Claude account. Pinning is the same switch as
 * `/model` → backend; it only ever moves this chat.
 *
 * The panel lists each provider's login state with a sign-in button. A
 * tap starts the core login flow and rewrites the same message into the
 * instructions the CLI printed: an "Open sign-in page" URL button plus,
 * for Codex, the one-time device code, or, for Claude, a request to reply
 * with the code the browser shows. The message is edited again when the
 * CLI finishes, so the whole exchange lives in one bubble.
 */

import type { Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import {
  activeLoginFlow,
  startLogin,
  type LoginBinaries,
  type LoginFlow,
  type LoginPrompt,
} from "../../core/auth/login-flow.js";
import {
  addClaudeAccount,
  type RemovalPlan,
  type RemovedAccount,
} from "../../core/auth/claude-accounts-admin.js";
import { getBackend } from "../../core/agent-runtime/backend-registry.js";
import {
  isClaudeAccountId,
  listClaudeAccounts,
  MAX_CLAUDE_ACCOUNTS,
} from "../../core/config/claude-accounts.js";
import {
  getBackendIdForChat,
  getPoolConfig,
  hasBackendPool,
  listAvailableBackends,
} from "../../core/engine/backend-controller/index.js";
import {
  isKnownAuthProvider,
  describeProviderStatus,
  providerLabel,
  readAllProviderStatus,
  type AuthProvider,
  type ProviderAuthStatus,
} from "../../core/auth/status.js";
import { logWarn } from "../../util/log.js";
import { escapeHtml } from "./formatting.js";

type AuthKeyboard = InlineKeyboardButton[][];

export interface AuthPanel {
  text: string;
  keyboard: AuthKeyboard;
}

/** A provider the panel can act on: Claude, each Claude account, Codex. */
export function isAuthProvider(value: string): value is AuthProvider {
  return isKnownAuthProvider(value);
}

function statusIcon(s: ProviderAuthStatus): string {
  if (!s.loggedIn || s.expired) return "🔴";
  if (
    s.loginExpiresAt !== undefined &&
    s.loginExpiresAt - Date.now() < 7 * 86_400_000
  )
    return "🟡";
  return "🟢";
}

/** What the panel knows about the chat it is shown in. */
export interface AuthPanelChat {
  /** The backend serving the chat right now. */
  backendId: string;
  /** Backends the chat may be switched to (`enabledBackends`). */
  selectable: readonly string[];
}

function isClaudeProvider(provider: AuthProvider): boolean {
  return provider === "claude" || isClaudeAccountId(provider);
}

/** Pin-to-chat and remove, for a Claude row. Empty for anything else. */
function accountButtons(
  provider: AuthProvider,
  chat: AuthPanelChat | undefined,
): InlineKeyboardButton[] {
  if (!isClaudeProvider(provider)) return [];
  const row: InlineKeyboardButton[] = [];
  if (chat && chat.backendId !== provider && chat.selectable.includes(provider))
    row.push({
      text: "💬 Use in this chat",
      callback_data: `auth:use:${provider}`,
    });
  if (isClaudeAccountId(provider))
    row.push({ text: "🗑 Remove", callback_data: `auth:rm:${provider}` });
  return row;
}

/**
 * The resting panel: a status line and a sign-in button per provider;
 * Claude rows add pin and remove. With `chat`, the row serving it is
 * marked.
 */
export function renderAuthPanel(
  statuses: ProviderAuthStatus[],
  chat?: AuthPanelChat,
): AuthPanel {
  const lines = ["<b>🔑 Backend logins</b>", ""];
  const keyboard: AuthKeyboard = [];
  for (const s of statuses) {
    const label = providerLabel(s.provider);
    const here = chat?.backendId === s.provider ? " · this chat" : "";
    lines.push(
      `${statusIcon(s)} <b>${escapeHtml(label)}</b> — ${escapeHtml(describeProviderStatus(s))}${here}`,
    );
    const pending = activeLoginFlow(s.provider);
    keyboard.push([
      pending
        ? {
            text: `⏳ ${label} sign-in in progress…`,
            callback_data: `auth:resume:${s.provider}`,
          }
        : {
            text: `${s.loggedIn && !s.expired ? "🔄 Re-sign in to" : "🔑 Sign in to"} ${label}`,
            callback_data: `auth:login:${s.provider}`,
          },
    ]);
    const extra = accountButtons(s.provider, chat);
    if (extra.length > 0) keyboard.push(extra);
  }
  if (listClaudeAccounts().length < MAX_CLAUDE_ACCOUNTS)
    keyboard.push([
      { text: "➕ Add Claude account", callback_data: "auth:add" },
    ]);
  keyboard.push([{ text: "↻ Refresh", callback_data: "auth:refresh" }]);
  return { text: lines.join("\n"), keyboard };
}

/** A backend's display name: its login label, else the registry's. */
function backendName(id: string): string {
  return isKnownAuthProvider(id)
    ? providerLabel(id)
    : (getBackend(id)?.label ?? id);
}

function chatCount(n: number): string {
  return `${n} chat${n === 1 ? "" : "s"}`;
}

/** The confirmation before an account is removed: what moves, what goes. */
export function renderRemoveConfirm(plan: RemovalPlan): AuthPanel {
  const { account, chats } = plan;
  const dir = `<code>${escapeHtml(account.configDir)}</code>`;
  const lines = [
    `<b>🗑 Remove ${escapeHtml(account.label)}?</b>`,
    "",
    chats.length === 0
      ? "• No chat is pinned to it."
      : `• ${chatCount(chats.length)} on it move to the default backend, ` +
        `${escapeHtml(backendName(plan.defaultBackendId))} ` +
        `(${plan.sessionKept ? "session kept" : "sessions start fresh"}).`,
    plan.managedDir
      ? `• Its sign-in is deleted along with ${dir}.`
      : `• Its sign-in is left at ${dir}.`,
  ];
  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: "🗑 Remove", callback_data: `auth:rmok:${account.id}` },
        { text: "Back", callback_data: "auth:refresh" },
      ],
    ],
  };
}

/** The note under the panel once an account is gone. */
export function removedNote(removed: RemovedAccount): string {
  const moved =
    removed.chatsMoved === 0
      ? ""
      : ` ${chatCount(removed.chatsMoved)} moved to the default backend` +
        `${removed.sessionKept ? " (session kept)" : ""}.`;
  const creds = removed.credentialsDeleted
    ? " Sign-in deleted."
    : ` Sign-in left at <code>${escapeHtml(removed.account.configDir)}</code>.`;
  return `🗑 ${escapeHtml(removed.account.label)} removed.${moved}${creds}`;
}

/** The in-progress panel: the CLI's instructions, an open-link button, cancel. */
export function renderLoginPrompt(
  provider: AuthProvider,
  prompt: LoginPrompt,
): AuthPanel {
  const label = providerLabel(provider);
  const lines = [
    `<b>🔑 Sign in to ${escapeHtml(label)}</b>`,
    "",
    "1. Open the sign-in page (button below) and log in.",
  ];
  if (prompt.code) {
    lines.push(
      `2. Enter this one-time code: <code>${escapeHtml(prompt.code)}</code>`,
    );
  }
  if (prompt.needsCode) {
    lines.push(
      `${prompt.code ? 3 : 2}. Copy the code the page shows and <b>reply to this message</b> with it.`,
    );
  }
  lines.push("", "<i>This link expires in 15 minutes.</i>");
  return {
    text: lines.join("\n"),
    keyboard: [
      [{ text: "🌐 Open sign-in page", url: prompt.url }],
      [{ text: "✖ Cancel", callback_data: `auth:cancel:${provider}` }],
    ],
  };
}

/** The chat's backend and choices, once the pool is up. */
function chatContext(chatId: number | string): AuthPanelChat | undefined {
  if (!hasBackendPool()) return undefined;
  return {
    backendId: getBackendIdForChat(String(chatId)),
    selectable: listAvailableBackends(getPoolConfig() ?? undefined).map(
      (b) => b.id,
    ),
  };
}

/** The resting panel as of now, for the chat it is shown in. */
export async function currentAuthPanel(
  chatId?: number | string,
): Promise<AuthPanel> {
  return renderAuthPanel(
    await readAllProviderStatus(),
    chatId === undefined ? undefined : chatContext(chatId),
  );
}

/** The resting panel with a note under it. */
export async function notedAuthPanel(
  chatId: number | string,
  note: string,
): Promise<AuthPanel> {
  const panel = await currentAuthPanel(chatId);
  return { text: `${panel.text}\n\n${note}`, keyboard: panel.keyboard };
}

/** Messages awaiting a pasted code, keyed by chat → prompt message id. */
const awaitingCode = new Map<
  string,
  { provider: AuthProvider; messageId: number }
>();

export function pendingCodePrompt(
  chatId: string,
): { provider: AuthProvider; messageId: number } | undefined {
  return awaitingCode.get(chatId);
}

export async function editPanel(
  ctx: Context,
  chatId: number,
  messageId: number,
  panel: AuthPanel,
): Promise<void> {
  try {
    await ctx.api.editMessageText(chatId, messageId, panel.text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: panel.keyboard },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/message is not modified/i.test(msg))
      logWarn("bot", `auth panel edit failed: ${msg}`);
  }
}

/**
 * Start (or attach to) a login for `provider` and drive the panel message
 * through prompt → outcome. Returns once the prompt is on screen; the
 * outcome edit happens when the CLI exits.
 */
export async function driveLogin(
  ctx: Context,
  chatId: number,
  messageId: number,
  provider: AuthProvider,
  bins: LoginBinaries,
): Promise<void> {
  const flow: LoginFlow =
    activeLoginFlow(provider) ?? startLogin(provider, bins);
  let prompt: LoginPrompt;
  try {
    prompt = await flow.prompt;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await editPanel(
      ctx,
      chatId,
      messageId,
      await notedAuthPanel(
        chatId,
        `❌ Couldn't start ${escapeHtml(providerLabel(provider))} sign-in: ${escapeHtml(detail)}`,
      ),
    );
    return;
  }
  if (prompt.needsCode)
    awaitingCode.set(String(chatId), { provider, messageId });
  await editPanel(ctx, chatId, messageId, renderLoginPrompt(provider, prompt));

  void flow.done.then(async (outcome) => {
    if (awaitingCode.get(String(chatId))?.messageId === messageId)
      awaitingCode.delete(String(chatId));
    const label = escapeHtml(providerLabel(provider));
    const note = outcome.ok
      ? `✅ ${label} signed in.`
      : outcome.reason === "cancelled"
        ? `✖ ${label} sign-in cancelled.`
        : outcome.reason === "timeout"
          ? `⌛ ${label} sign-in link expired. Tap the button to try again.`
          : `❌ ${label} sign-in failed: ${escapeHtml(outcome.detail ?? "unknown error")}`;
    await editPanel(ctx, chatId, messageId, await notedAuthPanel(chatId, note));
  });
}

/**
 * Add a Claude account and go straight into its sign-in, in the panel
 * message `messageId`. A refused add redraws the panel saying why.
 */
export async function addAccountAndSignIn(
  ctx: Context,
  chatId: number,
  messageId: number,
  request: { name?: string },
  bins: LoginBinaries,
): Promise<void> {
  const added = await addClaudeAccount(request);
  if (!added.ok) {
    await editPanel(
      ctx,
      chatId,
      messageId,
      await notedAuthPanel(
        chatId,
        `❌ Couldn't add a Claude account: ${escapeHtml(added.error)}`,
      ),
    );
    return;
  }
  await driveLogin(ctx, chatId, messageId, added.account.id, bins);
}

/** Feed a pasted code to the pending flow for this chat. True when consumed. */
export function submitPendingCode(chatId: string, text: string): boolean {
  const pending = awaitingCode.get(chatId);
  if (!pending) return false;
  const flow = activeLoginFlow(pending.provider);
  if (!flow) {
    awaitingCode.delete(chatId);
    return false;
  }
  flow.submitCode(text);
  return true;
}
