/**
 * /auth panel — sign the daemon's Claude and Codex CLIs back in from
 * Telegram, admin only. Each extra Claude account (`claudeAccounts`) gets
 * its own row and its own sign-in button.
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

/** The resting panel: one status line + one sign-in button per provider. */
export function renderAuthPanel(statuses: ProviderAuthStatus[]): AuthPanel {
  const lines = ["<b>🔑 Backend logins</b>", ""];
  const keyboard: AuthKeyboard = [];
  for (const s of statuses) {
    const label = providerLabel(s.provider);
    lines.push(
      `${statusIcon(s)} <b>${label}</b> — ${escapeHtml(describeProviderStatus(s))}`,
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
  }
  keyboard.push([{ text: "↻ Refresh", callback_data: "auth:refresh" }]);
  return { text: lines.join("\n"), keyboard };
}

/** The in-progress panel: the CLI's instructions, an open-link button, cancel. */
export function renderLoginPrompt(
  provider: AuthProvider,
  prompt: LoginPrompt,
): AuthPanel {
  const label = providerLabel(provider);
  const lines = [
    `<b>🔑 Sign in to ${label}</b>`,
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

export async function currentAuthPanel(): Promise<AuthPanel> {
  return renderAuthPanel(await readAllProviderStatus());
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

async function editPanel(
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
    const panel = await currentAuthPanel();
    await editPanel(ctx, chatId, messageId, {
      text: `${panel.text}\n\n❌ Couldn't start ${providerLabel(provider)} sign-in: ${escapeHtml(detail)}`,
      keyboard: panel.keyboard,
    });
    return;
  }
  if (prompt.needsCode)
    awaitingCode.set(String(chatId), { provider, messageId });
  await editPanel(ctx, chatId, messageId, renderLoginPrompt(provider, prompt));

  void flow.done.then(async (outcome) => {
    if (awaitingCode.get(String(chatId))?.messageId === messageId)
      awaitingCode.delete(String(chatId));
    const panel = await currentAuthPanel();
    const label = providerLabel(provider);
    const note = outcome.ok
      ? `✅ ${label} signed in.`
      : outcome.reason === "cancelled"
        ? `✖ ${label} sign-in cancelled.`
        : outcome.reason === "timeout"
          ? `⌛ ${label} sign-in link expired. Tap the button to try again.`
          : `❌ ${label} sign-in failed: ${escapeHtml(outcome.detail ?? "unknown error")}`;
    await editPanel(ctx, chatId, messageId, {
      text: `${panel.text}\n\n${note}`,
      keyboard: panel.keyboard,
    });
  });
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
