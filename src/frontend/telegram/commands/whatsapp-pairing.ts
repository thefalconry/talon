/**
 * /whatsapp — drive WhatsApp device pairing from Telegram.
 *
 * Bare `/whatsapp` draws a status panel with a button per sub-command;
 * `/whatsapp pair` runs ONE bounded pairing attempt via the core pairing
 * broker and replies with the QR as a photo (plus the phone-number code
 * when the account has one configured). The human runs it when they are
 * holding the phone — pairing is never automatic, because automatic
 * retries are how the account got rate-limited into "couldn't connect
 * device".
 */

import { InputFile, type Bot, type Context } from "grammy";
import { getPairingProvider } from "../../../core/frontend-runtime/pairing-broker.js";
import { log } from "../../../util/log.js";
import { isAuthorizedAdmin } from "./state.js";

const WHATSAPP_NOT_ENABLED =
  'WhatsApp isn\'t enabled on this daemon — add "whatsapp" to the ' +
  "frontend list and configure the whatsapp block, then restart.";

export type WhatsAppPanel = {
  text: string;
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

/**
 * The bare-`/whatsapp` panel: link state plus one button per
 * sub-command, so the commands are discoverable instead of folklore.
 */
export function whatsAppPanel(): WhatsAppPanel {
  const provider = getPairingProvider();
  if (!provider) {
    return { text: WHATSAPP_NOT_ENABLED, keyboard: [] };
  }
  const refresh = { text: "🔄 Refresh", callback_data: "whatsapp:refresh" };
  // No pair button while linked: pairing refuses on a linked account, and
  // unlinking from here would drop a working link. When the phone unlinks
  // this device the connection loop parks, isLinked() turns false, and
  // the button comes back on the next refresh.
  if (provider.isLinked()) {
    return {
      text:
        "<b>WhatsApp</b>\n✅ Linked and connected.\n\n" +
        "To link a different phone, unlink this device on the phone " +
        "first, then pair here.",
      keyboard: [[refresh]],
    };
  }
  return {
    text:
      "<b>WhatsApp</b>\n📴 Not linked.\n\n" +
      "Tap <b>Pair device</b> when you're holding the phone — I'll reply " +
      "with a QR to scan (WhatsApp → ⋮ → Linked devices → Link a device).",
    keyboard: [
      [{ text: "🔗 Pair device", callback_data: "whatsapp:pair" }, refresh],
    ],
  };
}

/**
 * One bounded pairing attempt, shared by `/whatsapp pair` and the panel
 * button so both paths behave identically.
 */
export async function runWhatsAppPairing(ctx: Context): Promise<void> {
  const provider = getPairingProvider();
  if (!provider) {
    await ctx.reply(WHATSAPP_NOT_ENABLED);
    return;
  }

  if (provider.isLinked()) {
    await ctx.reply(
      "WhatsApp is already linked. Unlink it on the phone first if you " +
        "want to re-pair.",
    );
    return;
  }

  let attempt;
  try {
    attempt = await provider.begin();
  } catch (err) {
    await ctx.reply(
      `Couldn't start pairing: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  if (attempt.qrPng) {
    const codeLine = attempt.code
      ? `\nOr enter code: ${attempt.code} (Link with phone number instead)`
      : "";
    await ctx.replyWithPhoto(new InputFile(attempt.qrPng, "whatsapp-qr.png"), {
      caption:
        "Scan within ~2 minutes:\n" +
        "WhatsApp → ⋮ → Linked devices → Link a device" +
        codeLine,
    });
  } else {
    await ctx.reply(
      "No QR came back — WhatsApp may still be rate-limiting. Try later.",
    );
  }

  const outcome = await attempt.result;
  if (outcome.ok) {
    log("bot", `WhatsApp paired via /whatsapp pair (${outcome.identity})`);
    await ctx.reply(
      `✅ Linked as ${outcome.identity}. WhatsApp is connecting now.`,
    );
  } else if (outcome.reason === "expired") {
    await ctx.reply(
      "⌛ That window expired without a successful scan. Run " +
        "/whatsapp pair again when you're ready — if the phone says " +
        '"couldn\'t connect device", WhatsApp is still rate-limiting; ' +
        "wait an hour and try once more.",
    );
  } else if (outcome.reason !== "cancelled") {
    await ctx.reply(
      `❌ Pairing failed${outcome.detail ? `: ${outcome.detail}` : ""}. ` +
        "Run /whatsapp pair to try again.",
    );
  }
}

export function registerWhatsAppPairingCommand(bot: Bot): void {
  bot.command("whatsapp", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }

    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (arg !== "pair") {
      const panel = whatsAppPanel();
      await ctx.reply(panel.text, {
        parse_mode: "HTML",
        ...(panel.keyboard.length
          ? { reply_markup: { inline_keyboard: panel.keyboard } }
          : {}),
      });
      return;
    }

    await runWhatsAppPairing(ctx);
  });
}
