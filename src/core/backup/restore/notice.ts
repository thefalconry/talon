/**
 * Reporting a staged restore back to the chat that asked for it.
 *
 * `/backup restore <id>` stages the request and restarts; the restore runs
 * in the next boot before any frontend exists (see `applyStagedRestore` in
 * app.ts). Once the frontends are up, the "♻️ Restored snapshot …" line is
 * delivered here: to the requesting chat, on the frontend it came from,
 * and — when that chat can't be reached (frontend disabled, delivery
 * failing) or the request never said who asked — to the operator's
 * primary chat through the admin notifier, which is where it always went
 * before.
 *
 * Core never imports src/frontend, so delivery goes through the same
 * cross-send broker `send_via` uses: each enabled frontend's action
 * handler, keyed by frontend name.
 */

import { log, logWarn } from "../../../util/log.js";
import {
  isNativeChatId,
  isTelegramChatId,
  numericChatIdFor,
} from "../../frontend-runtime/chat-id.js";
import { crossSendTarget } from "../../engine/gateway-actions/cross-send.js";
import type { RestoreReport } from "../restore.js";

/** Who asked for a staged restore, as recorded in restore-pending.json. */
export type RestoreRequester = {
  /** The requesting chat's key (Telegram id, `d_…`, `discord_…`). */
  requestedBy?: string;
  /** The frontend the request came from. Absent in files staged before it existed. */
  frontend?: string;
};

/**
 * The frontend a requester belongs to: the recorded one when the request
 * carries it, else inferred from the shape of the chat key — Telegram's
 * ids are numeric, native's start `d_`, Discord's `discord_`. Undefined
 * when neither says.
 */
export function requesterFrontend(
  requester: RestoreRequester,
): string | undefined {
  const explicit =
    typeof requester.frontend === "string"
      ? requester.frontend.trim().toLowerCase()
      : "";
  if (explicit) return explicit;
  const key =
    typeof requester.requestedBy === "string" ? requester.requestedBy : "";
  if (!key) return undefined;
  if (isTelegramChatId(key)) return "telegram";
  if (isNativeChatId(key)) return "native";
  if (key.startsWith("discord_")) return "discord";
  return undefined;
}

/** The confirmation line a successful staged restore reports. */
export function formatRestoreNotice(
  report: Pick<RestoreReport, "id" | "checkpointId">,
): string {
  return (
    `♻️ Restored snapshot ${report.id}` +
    (report.checkpointId
      ? ` (previous state saved as checkpoint ${report.checkpointId})`
      : "")
  );
}

/**
 * Send `text` to one chat through its frontend's registered action
 * handler. The chat key rides in `target` so a frontend that has not
 * seen the chat since the restart (a Discord channel nobody has spoken
 * in yet, a native chat the restored database doesn't list) can adopt it.
 * Resolves true only when the frontend reports the message delivered.
 */
async function sendToRequester(
  frontend: string,
  chatKey: string,
  text: string,
): Promise<boolean> {
  const handler = crossSendTarget(frontend);
  if (!handler) return false;
  const result = await handler(
    { action: "send_message", text, target: chatKey },
    numericChatIdFor(chatKey),
  );
  return Boolean(result && result.ok === true);
}

const RESTORE_NOTICE_ATTEMPTS = 6;
const RESTORE_NOTICE_DELAY_MS = 5_000;

export type RestoreNoticeOptions = {
  text: string;
  requester: RestoreRequester;
  /** The operator's primary chat — the fallback. */
  notifyAdmin: (text: string) => Promise<unknown>;
  send?: (frontend: string, chatKey: string, text: string) => Promise<boolean>;
  /** Whether a frontend is enabled at all (no point retrying one that isn't). */
  isEnabled?: (frontend: string) => boolean;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Deliver the restore notice to the requesting chat, falling back to the
 * admin's primary chat. Retries a while when the requester's frontend is
 * enabled but can't deliver yet — the frontends have just started, and a
 * Discord client may still be logging in. Never throws; resolves with
 * where the notice went.
 */
export async function deliverRestoreNotice(
  options: RestoreNoticeOptions,
): Promise<"requester" | "admin"> {
  const {
    text,
    requester,
    notifyAdmin,
    send = sendToRequester,
    isEnabled = (name) => crossSendTarget(name) !== undefined,
    attempts = RESTORE_NOTICE_ATTEMPTS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  } = options;
  const frontend = requesterFrontend(requester);
  const chatKey =
    typeof requester.requestedBy === "string" ? requester.requestedBy : "";

  if (frontend && chatKey && isEnabled(frontend)) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        if (await send(frontend, chatKey, text)) {
          log("backup", `Restore reported to ${frontend} chat ${chatKey}`);
          return "requester";
        }
      } catch (err) {
        logWarn(
          "backup",
          `Restore report to ${frontend} chat ${chatKey} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (attempt < attempts) await sleep(RESTORE_NOTICE_DELAY_MS);
    }
    logWarn(
      "backup",
      `Could not reach ${frontend} chat ${chatKey}; reporting the restore to the admin chat instead`,
    );
  } else if (chatKey || frontend) {
    logWarn(
      "backup",
      `Restore requester ${frontend ?? "?"}:${chatKey || "?"} is not reachable here; reporting to the admin chat`,
    );
  }

  try {
    await notifyAdmin(text);
  } catch (err) {
    logWarn(
      "backup",
      `Admin restore report failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return "admin";
}
