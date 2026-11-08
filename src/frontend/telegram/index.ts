/**
 * Telegram frontend factory.
 *
 * Encapsulates everything Telegram-specific: Bot instance, command registration,
 * GramJS userbot, graceful shutdown. Registers its action handler with the
 * core gateway so MCP tool calls route to Telegram API.
 */

import { Bot, GrammyError, InputFile, API_CONSTANTS } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import {
  TELEGRAM_ADMIN_REQUIRED,
  type TalonConfig,
} from "../../core/config/index.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { runUntilStopped } from "../../core/frontend-runtime/run-loop.js";
import { pollDeadline } from "./polling/poll-deadline.js";
import { pollHealth } from "./polling/poll-health.js";
import { createTelegramActionHandler, sendText } from "./actions/index.js";
import { ambientThreadId } from "./topics.js";
import { initUserClient, disconnectUserClient } from "./userbot.js";
import {
  registerCommands,
  setAdminUserId,
  telegramCommandMenu,
} from "./commands/index.js";
import {
  setAccessControl,
  registerCommandAccessGate,
} from "./handlers/index.js";
import { registerMiddleware } from "./middleware.js";
import { setAllowedGroups } from "./handlers/group-access.js";
import { confirmUpdates } from "./polling/update-offset.js";
import { registerCallbacks } from "./callbacks/index.js";
import { log, logError } from "../../util/log.js";

// ── Frontend interface ──────────────────────────────────────────────────────

export type TelegramFrontend = {
  name: "telegram";
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

/** The slice of a grammY BotError's context the error log reads. */
type UpdateContext = {
  update?: { update_id?: number };
  chat?: { id?: number };
};

// ── Access ──────────────────────────────────────────────────────────────────

/**
 * Install the admin id, DM allowlist and group allowlist before anything
 * else starts.
 * Config loading already refuses a Telegram setup without an admin; this
 * covers any other path that hands the frontend a config — without an admin
 * there is no owner, so the bot must not run at all.
 */
function applyAccessControl(config: TalonConfig): void {
  if (!config.adminUserId) throw new Error(TELEGRAM_ADMIN_REQUIRED);
  setAdminUserId(config.adminUserId, config.operatorIds);
  setAccessControl({
    allowedUsers: config.allowedUsers,
    blockedUsers: config.blockedUsers,
    adminUserId: config.adminUserId,
  });
  setAllowedGroups(config.allowedGroups);
}

/**
 * The bot's last-resort middleware error handler: log which update in which
 * chat failed, and exit when Telegram says the token itself is bad.
 */
function onBotError(err: unknown): void {
  const ctx = (err as { ctx?: UpdateContext } | null)?.ctx;
  logError(
    "bot",
    `Unhandled bot error update=${ctx?.update?.update_id ?? "?"} chat=${ctx?.chat?.id ?? "?"}`,
    err,
  );
  // Judge the token by Telegram's error code, never the message text:
  // a handler's ordinary 400 ("message to edit not found", "chat not
  // found") must not take the whole daemon down.
  const cause = (err as { error?: unknown } | null)?.error ?? err;
  if (
    cause instanceof GrammyError &&
    (cause.error_code === 401 || cause.error_code === 404)
  ) {
    logError("bot", "Bot token appears invalid — shutting down");
    process.exit(1);
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createTelegramFrontend(
  config: TalonConfig,
  gateway: Gateway,
): TelegramFrontend {
  const bot = new Bot(config.botToken!);
  // Installed first so it sits innermost: every retry autoRetry makes
  // gets a fresh deadline rather than sharing one.
  bot.api.config.use(pollDeadline());
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  // Outermost: judges each poll by the result grammY finally sees.
  bot.api.config.use(pollHealth());

  const context: ContextManager = {
    acquire: (chatId: number, stringId?: string) =>
      gateway.setContext(chatId, stringId, "telegram"),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  /** The long-poll, from start() until stop() awaits it. */
  let polling: Promise<void> | null = null;

  return {
    name: "telegram",
    context,

    sendTyping: (chatId: number) =>
      bot.api
        .sendChatAction(chatId, "typing", {
          message_thread_id: ambientThreadId(chatId),
        })
        .then(() => {}),

    sendMessage: async (chatId: number, text: string) => {
      await sendText(bot, chatId, text);
    },

    getBridgePort: () => gateway.getPort(),

    async init() {
      applyAccessControl(config);

      // Register Telegram action handler with the core gateway
      gateway.registerFrontendHandler(
        "telegram",
        createTelegramActionHandler(bot, InputFile, config.botToken!, gateway),
      );

      const port = await gateway.start(19876);
      log("bot", `Gateway started on port ${port}`);

      // Gate /commands and button presses behind the DM whitelist and
      // group check BEFORE any command/callback handler is registered.
      registerCommandAccessGate(bot);
      registerCommands(bot, config, gateway);
      registerMiddleware(bot, config);
      registerCallbacks(bot, config, gateway);

      await bot.api.deleteMyCommands();
      await bot.api.setMyCommands(telegramCommandMenu(config));
      log("commands", "Registered bot commands with Telegram");

      const apiId = config.apiId ?? 0;
      const apiHash = config.apiHash ?? "";
      if (apiId && apiHash) {
        initUserClient({ apiId, apiHash })
          .then((ok) => {
            if (ok) log("userbot", "Full Telegram history access enabled.");
            else log("userbot", "Not authorized. Run: npx tsx src/login.ts");
          })
          .catch((err) => logError("userbot", "Init failed", err));
      } else {
        log(
          "userbot",
          "TALON_API_ID/TALON_API_HASH not set -- using in-memory history only.",
        );
      }
    },

    async start() {
      bot.catch(onBotError);
      // Beyond grammY's defaults: `chat_join_request` feeds the moderation
      // tool's pending-join cache (inert unless the bot admins an
      // approval-gated chat).
      const allowedUpdates = [
        ...API_CONSTANTS.DEFAULT_UPDATE_TYPES,
        "chat_join_request" as const,
      ];
      // grammY's bot.start() promise is the long-poll: it resolves when
      // POLLING STOPS, i.e. at shutdown. Readiness is onStart, which
      // fires once getMe() succeeded and the first poll is out — so that
      // is what start() waits for, while the poll itself is kept for
      // stop().
      const run = runUntilStopped(
        (signalReady) =>
          bot.start({
            allowed_updates: allowedUpdates,
            onStart: (info) => {
              log("bot", `Talon running as @${info.username}`);
              signalReady();
            },
          }),
        (err) => logError("bot", "Long-poll ended with an error", err),
      );
      polling = run.stopped;
      await run.ready;
    },

    async stop() {
      try {
        await bot.stop();
        // The long-poll is the promise bot.start() returned — awaiting it
        // here is what makes "stopped" mean stopped, before the offset is
        // confirmed below.
        await polling;
        polling = null;
        // grammY advances the update offset on its NEXT poll, which never
        // comes once we are shutting down — so confirm it explicitly or
        // Telegram redelivers the command that triggered this shutdown.
        await confirmUpdates(bot);
        log("shutdown", "Bot disconnected");
      } catch (err) {
        logError("shutdown", "Bot stop error", err);
      }
      try {
        await disconnectUserClient();
        log("shutdown", "User client disconnected");
      } catch (err) {
        logError("shutdown", "User client disconnect error", err);
      }
      try {
        await gateway.stop();
        log("shutdown", "Gateway stopped");
      } catch (err) {
        logError("shutdown", "Gateway stop error", err);
      }
    },
  };
}
