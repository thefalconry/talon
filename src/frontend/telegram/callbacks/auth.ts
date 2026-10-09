/**
 * `auth:*` callbacks — the /auth panel's buttons.
 *
 *   auth:login:<provider>   start a sign-in and show its instructions
 *   auth:resume:<provider>  re-show the instructions of a running sign-in
 *   auth:cancel:<provider>  abort a running sign-in
 *   auth:refresh            re-read credential files and redraw
 *
 * Adding, removing and pinning accounts: auth-accounts.ts.
 */

import type { Context } from "grammy";
import { activeLoginFlow } from "../../../core/auth/login-flow.js";
import { currentAuthPanel, driveLogin, isAuthProvider } from "../auth-panel.js";
import { loginBinariesFrom } from "../commands/auth.js";
import { isAuthorizedAdmin } from "../commands/state.js";
import { handleAccountAction } from "./auth-accounts.js";
import { answerCallbackQuerySafe, type CallbackDeps } from "./query.js";

export async function handleAuthCallback(
  ctx: Context,
  data: string,
  deps: CallbackDeps,
): Promise<void> {
  if (!isAuthorizedAdmin(ctx)) {
    await answerCallbackQuerySafe(ctx, { text: "Not authorized." });
    return;
  }
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (chatId === undefined || messageId === undefined) {
    await answerCallbackQuerySafe(ctx);
    return;
  }
  const [, action, provider = ""] = data.split(":");

  if (action === "refresh") {
    await answerCallbackQuerySafe(ctx);
    const panel = await currentAuthPanel(chatId);
    await ctx.api
      .editMessageText(chatId, messageId, panel.text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: panel.keyboard },
      })
      .catch(() => {});
    return;
  }

  if (
    await handleAccountAction(
      ctx,
      action ?? "",
      provider,
      { chatId, messageId },
      deps,
    )
  )
    return;

  if (!isAuthProvider(provider)) {
    await answerCallbackQuerySafe(ctx, { text: "Unknown provider" });
    return;
  }

  if (action === "cancel") {
    activeLoginFlow(provider)?.cancel();
    await answerCallbackQuerySafe(ctx, { text: "Cancelled" });
    return;
  }

  if (action === "login" || action === "resume") {
    await answerCallbackQuerySafe(ctx, { text: "Starting sign-in…" });
    await driveLogin(
      ctx,
      chatId,
      messageId,
      provider,
      loginBinariesFrom(deps.config),
    );
    return;
  }

  await answerCallbackQuerySafe(ctx, { text: "Invalid callback data" });
}
