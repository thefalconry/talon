/**
 * One inbound message, from `messages.upsert` to the model's turn:
 * access gates → media saved to the workspace → history recorded →
 * slash commands (../commands.ts; skipped in the catch-up backlog) →
 * catch-up policy → `execute()`.
 */

import { isJidGroup, type WAMessage } from "baileys";
import type { AgentEvent } from "../../../core/agent-runtime/events.js";
import { log, logError } from "../../../util/log.js";
import { execute } from "../../../core/engine/dispatcher.js";
import { toolInputToRecord } from "../../../core/agent-runtime/events.js";
import { appendDailyLog } from "../../../storage/daily-log.js";
import { pushMessage } from "../../../storage/history.js";
import { relayInbound } from "../../../core/engine/cross-chat-relay.js";
import {
  recordMessageProcessed,
  recordMessageReceived,
} from "../../../util/watchdog.js";
import { isAddressedToSelf, isGroupAllowed } from "../access.js";
import { handleWhatsAppCommand, parseWhatsAppCommand } from "../commands.js";
import { sendText } from "../actions/send.js";
import { applyInboundRedaction } from "../../../core/secrets/redact.js";
import {
  bareId,
  canonicalId,
  identityAllowed,
  resolveIdentity,
  type Identity,
} from "../connection/identity.js";
import { saveInboundMedia, type SavedMedia } from "./media-store.js";
import { lookupByWaId, rememberMessage } from "./message-store.js";
import { registerWhatsAppChat, type WhatsAppChatInfo } from "../registry.js";
import type { WhatsAppRuntime } from "../runtime.js";
import { runTurnWithRecovery, shouldReplyToCatchUp } from "./turn-recovery.js";

export type InboundOptions = { catchUp?: boolean };

/** A message that passed the access gates. */
type AdmittedMessage = {
  jid: string;
  isGroup: boolean;
  identity: Identity;
};

/** An admitted message with something to say, recorded in history. */
type RecordedMessage = AdmittedMessage & {
  chat: WhatsAppChatInfo;
  msgId: number;
  text: string;
  media: SavedMedia | undefined;
  senderName: string;
  platformTs: number;
};

/** Plain text of an inbound message, across the wrappers WhatsApp uses. */
function extractText(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    ""
  );
}

/** The text-bearing fields of an inbound message, as [holder, key] pairs. */
function textFields(msg: WAMessage): Array<[Record<string, unknown>, string]> {
  const m = msg.message as Record<string, unknown> | null | undefined;
  if (!m) return [];
  const fields: Array<[Record<string, unknown>, string]> = [];
  const add = (holder: unknown, key: string): void => {
    if (
      holder &&
      typeof (holder as Record<string, unknown>)[key] === "string"
    ) {
      fields.push([holder as Record<string, unknown>, key]);
    }
  };
  add(m, "conversation");
  add(m.extendedTextMessage, "text");
  add(m.imageMessage, "caption");
  add(m.videoMessage, "caption");
  add(m.documentMessage, "caption");
  const wrapped = (
    m.documentWithCaptionMessage as
      { message?: Record<string, unknown> } | undefined
  )?.message;
  add(wrapped?.documentMessage, "caption");
  return fields;
}

/**
 * Rewrite credentials out of the raw message in place (core/secrets/redact.ts),
 * so the message store, history and the prompt only ever hold the redacted
 * form; nudge toward /secret once. WhatsApp offers a bot no way to delete a
 * user's message for both sides, so `deleteOriginal` doesn't apply here.
 */
function redactCredentials(
  runtime: WhatsAppRuntime,
  msg: WAMessage,
  chat: WhatsAppChatInfo,
  isGroup: boolean,
): void {
  let notice: string | undefined;
  for (const [holder, key] of textFields(msg)) {
    const r = applyInboundRedaction(holder[key] as string, {
      chatKey: chat.chatId,
      isDm: !isGroup,
      config: { ...runtime.config.redaction, deleteOriginal: "never" },
    });
    if (!r.redacted) continue;
    holder[key] = r.text;
    notice ??= r.notice;
    log(
      "whatsapp",
      `[${chat.chatId}] Redacted a credential from an inbound message`,
    );
  }
  const sock = runtime.sock;
  if (notice && sock) {
    sendText({ sock, gateway: runtime.gateway }, chat, notice).catch(() => {});
  }
}

async function admitInbound(
  runtime: WhatsAppRuntime,
  msg: WAMessage,
): Promise<AdmittedMessage | null> {
  const jid = msg.key.remoteJid;
  // `fromMe` covers our own sends echoing back; status@broadcast is the
  // Stories feed, which is not a conversation.
  if (!jid || jid === "status@broadcast" || msg.key.fromMe) return null;

  const isGroup = Boolean(isJidGroup(jid));
  // The sender may be addressed by phone number or by LID depending on
  // their privacy settings; resolve both before matching an allowlist
  // that is written in phone numbers.
  const senderJid = msg.key.participant || jid;
  const identity = await resolveIdentity(
    runtime.sock,
    senderJid,
    msg.key.participantAlt ?? msg.key.remoteJidAlt,
  );

  // ── Access gates: the allowlists are the entire permission model ──
  if (isGroup) {
    if (!(await isGroupAllowed(runtime, jid))) return null;
    if (
      runtime.settings.respondMode === "mention" &&
      !isAddressedToSelf(runtime.selfIds, msg)
    ) {
      // Not for us to answer, but still part of the conversation: the
      // history store is the model's only record of the group, and a
      // turn that reads it must see the messages around the mention.
      await recordPassively(runtime, msg, { jid, isGroup, identity });
      return null;
    }
  } else if (!identityAllowed(identity, runtime.allowedDms)) {
    log(
      "whatsapp",
      `Ignoring DM from unlisted ${identity.ids.join("/") || bareId(jid)}`,
    );
    return null;
  }
  return { jid, isGroup, identity };
}

/** Record a message that gets no turn — group chatter the bot only reads. */
async function recordPassively(
  runtime: WhatsAppRuntime,
  msg: WAMessage,
  admitted: AdmittedMessage,
): Promise<void> {
  const recorded = await recordInbound(runtime, msg, admitted);
  if (!recorded) return;
  log(
    "whatsapp",
    `[${recorded.chat.chatId}] Recorded group message from ${recorded.senderName} (history only)`,
  );
  recordMessageProcessed();
}

async function recordInbound(
  runtime: WhatsAppRuntime,
  msg: WAMessage,
  admitted: AdmittedMessage,
): Promise<RecordedMessage | null> {
  const { jid, isGroup, identity } = admitted;
  // Group chats key on the group JID; DMs key on the person, so the
  // thread survives WhatsApp switching addressing form.
  const chat = registerWhatsAppChat(
    jid,
    undefined,
    isGroup ? undefined : canonicalId(identity),
  );
  // Before the raw message is stored or its text read anywhere else.
  redactCredentials(runtime, msg, chat, isGroup);
  const text = extractText(msg).trim();
  const senderName = msg.pushName || canonicalId(identity) || "user";
  const msgId = rememberMessage({
    key: msg.key,
    chatId: chat.chatId,
    message: msg,
    text,
    senderName,
  });

  // Media is saved before the turn so the model can open the file by
  // path in the same turn it's told about it.
  const media = await saveInboundMedia(msg, chat.chatId, msgId, senderName);
  if (!text && !media) return null; // reaction, receipt, or an unsupported type

  recordMessageReceived();
  if (runtime.settings.sendReadReceipts) {
    runtime.sock?.readMessages([msg.key]).catch(() => {});
  }

  // Recorded for read_chat_history / search_chat_history, which the core
  // serves from this store for frontends without a platform history API.
  const replyToWaId =
    msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined;
  const replyTo = replyToWaId ? lookupByWaId(replyToWaId) : undefined;
  const platformTs = Number(msg.messageTimestamp) * 1000;
  pushMessage(chat.chatId, {
    msgId,
    senderId: Number(BigInt(canonicalId(identity) ?? "0") % 2147483647n),
    senderName,
    senderHandle: canonicalId(identity),
    text,
    // The platform timestamp, so a catch-up message recorded late still
    // reads in true order; Date.now() only when Baileys omits it.
    timestamp:
      Number.isFinite(platformTs) && platformTs > 0 ? platformTs : Date.now(),
    ...(replyTo ? { replyToMsgId: replyTo.msgId } : {}),
    ...(media ? { mediaType: media.type, filePath: media.filePath } : {}),
  });

  // If another chat's session messaged this one via send_via, it is
  // waiting to hear back — hand it the reply for its next turn. A no-op
  // (and one Map miss) for every chat nobody cross-sent into.
  relayInbound(chat.chatId, senderName, text || `[${media?.type ?? "media"}]`);

  return { ...admitted, chat, msgId, text, media, senderName, platformTs };
}

/**
 * Catch-up messages (queued while the daemon was down) get a reply
 * turn only while fresh; stale ones are already recorded and the next
 * live turn reads them from history.
 */
function catchUpDeservesReply(inbound: RecordedMessage): boolean {
  const { chat, senderName } = inbound;
  if (!shouldReplyToCatchUp(inbound.platformTs)) {
    log(
      "whatsapp",
      `[${chat.chatId}] Recorded offline message from ${senderName} (history only — too old for a reply turn)`,
    );
    recordMessageProcessed();
    return false;
  }
  log(
    "whatsapp",
    `[${chat.chatId}] Catch-up: replying to offline message from ${senderName}`,
  );
  return true;
}

/**
 * A slash command in the catch-up backlog was issued against an earlier
 * state of the chat — replaying `/reset` or `/model x` after a restart
 * would silently undo whatever happened since. It stays recorded but does
 * not run; while fresh, the sender is told so they can resend it.
 */
async function skipCatchUpCommand(
  runtime: WhatsAppRuntime,
  inbound: RecordedMessage,
  name: string,
): Promise<void> {
  const { chat, senderName } = inbound;
  log(
    "whatsapp",
    `[${chat.chatId}] Skipped /${name} from ${senderName} (sent while offline)`,
  );
  recordMessageProcessed();
  const sock = runtime.sock;
  if (!sock || !shouldReplyToCatchUp(inbound.platformTs)) return;
  await sendText(
    { sock, gateway: runtime.gateway },
    chat,
    `Not run: /${name} was sent while offline. Send it again to run it.`,
  ).catch(() => {});
}

async function onTurnEvent(
  runtime: WhatsAppRuntime,
  chat: WhatsAppChatInfo,
  event: AgentEvent,
): Promise<void> {
  switch (event.type) {
    case "tool_call": {
      const input = toolInputToRecord(event.name, event.input);
      const detail = (input.description ??
        input.command ??
        input.action ??
        input.query ??
        "") as string;
      log(
        "whatsapp",
        `  tool: ${event.name}${detail ? ` — ${String(detail).slice(0, 100)}` : ""}`,
      );
      break;
    }
    // Progress prose and the end-of-turn trailing-text fallback.
    // Without this, prose-only turns are silently dropped.
    case "assistant_message": {
      const sock = runtime.sock;
      if (!event.text.trim() || !sock) break;
      try {
        await sendText({ sock, gateway: runtime.gateway }, chat, event.text);
      } catch (err) {
        logError(
          "whatsapp",
          `onEvent delivery failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      break;
    }
  }
}

async function runInboundTurn(
  runtime: WhatsAppRuntime,
  inbound: RecordedMessage,
): Promise<void> {
  const { chat, text, media, msgId, senderName, identity, isGroup, jid } =
    inbound;
  const preview = text || `(${media?.type ?? "media"})`;
  log(
    "whatsapp",
    `[${chat.chatId}] [${senderName}]: ${preview.slice(0, 80)}${preview.length > 80 ? "..." : ""}`,
  );
  appendDailyLog(senderName, preview, {
    chatTitle: chat.title,
    username: canonicalId(identity) ?? bareId(jid),
  });

  // The model addresses messages by numeric id (react/reply/edit), so the
  // id travels with the text the same way the other frontends do it.
  const mediaNote = media
    ? `\n[attached ${media.type}: ${media.filePath}]`
    : "";
  const prompt = `[${senderName}] msg_id:${msgId}: ${text}${mediaNote}`;

  const runTurn = () =>
    execute({
      chatId: chat.chatId,
      numericChatId: chat.numericChatId,
      prompt,
      senderName,
      senderKeys: identity.ids.map((id) => `wa_dm_${id}`),
      isGroup,
      source: "message",
      onEvent: (event) => onTurnEvent(runtime, chat, event),
    });

  await runTurnWithRecovery({
    chatId: chat.chatId,
    senderName,
    runTurn,
    sendErrorText: async (text) => {
      const sock = runtime.sock;
      if (!sock) return;
      try {
        await sendText({ sock, gateway: runtime.gateway }, chat, text);
      } catch (sendErr) {
        logError(
          "whatsapp",
          `error delivery failed: ${sendErr instanceof Error ? sendErr.message : sendErr}`,
        );
      }
    },
  });
}

export async function handleInbound(
  runtime: WhatsAppRuntime,
  msg: WAMessage,
  options: InboundOptions = {},
): Promise<void> {
  const admitted = await admitInbound(runtime, msg);
  if (!admitted) return;
  const inbound = await recordInbound(runtime, msg, admitted);
  if (!inbound) return;
  if (options.catchUp) {
    const cmd = parseWhatsAppCommand(inbound.text);
    if (cmd) return skipCatchUpCommand(runtime, inbound, cmd.name);
  }
  if (await handleWhatsAppCommand(runtime, inbound)) return;
  if (options.catchUp && !catchUpDeservesReply(inbound)) return;
  await runInboundTurn(runtime, inbound);
}
