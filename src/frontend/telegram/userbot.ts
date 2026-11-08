/**
 * GramJS user client for accessing Telegram features unavailable to bots:
 * - Full message history search and retrieval
 * - Group member enumeration
 * - Message search across chats
 *
 * Requires a one-time phone login to create a session file.
 * After that, runs headless alongside the bot.
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { outgoingText } from "./actions/outgoing-log.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { log, logError, logWarn } from "../../util/log.js";
import { dirs, files } from "../../util/paths.js";
import { formatSmartTimestamp } from "../../util/time.js";
import { createOutage, errorText } from "../health/outage.js";

const SESSION_FILE = files.userSession;

let client: TelegramClient | null = null;
let reconnectTimer: ReturnType<typeof setInterval> | null = null;
let storedApiId = 0;
let storedApiHash = "";

// ── SECURITY: Chat scope guard ──────────────────────────────────────────────
// The userbot is ONLY allowed to access chats the bot is actively serving.
// It must NEVER access the user's other chats, DMs, or account data.
const allowedChatIds = new Set<number>();
const MAX_ALLOWED_CHATS = 5_000;

/** Allow the userbot to access a specific chat (set when bot receives a message). */
export function allowChat(chatId: number): void {
  if (allowedChatIds.size >= MAX_ALLOWED_CHATS) {
    // Evict oldest entries (first inserted) to prevent unbounded growth
    const iter = allowedChatIds.values();
    for (let i = 0; i < 500; i++) {
      const val = iter.next();
      if (val.done) break;
      allowedChatIds.delete(val.value);
    }
  }
  allowedChatIds.add(chatId);
}

/** Revoke userbot access for a chat (called when bot is removed from group). */
export function revokeChat(chatId: number): void {
  allowedChatIds.delete(chatId);
}

function assertAllowedChat(chatId: number | string): number {
  const numeric = typeof chatId === "string" ? parseInt(chatId, 10) : chatId;
  if (!allowedChatIds.has(numeric)) {
    throw new Error(
      "Access denied: userbot can only access chats where the bot is active.",
    );
  }
  return numeric;
}

export function isUserClientReady(): boolean {
  return client !== null && !!client.connected;
}

export async function initUserClient(params: {
  apiId: number;
  apiHash: string;
}): Promise<boolean> {
  const { apiId, apiHash } = params;
  storedApiId = apiId;
  storedApiHash = apiHash;

  // Load saved session
  let sessionString = "";
  if (existsSync(SESSION_FILE)) {
    sessionString = readFileSync(SESSION_FILE, "utf-8").trim();
  }

  const session = new StringSession(sessionString);
  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.connect();

    if (!(await client.isUserAuthorized())) {
      log("userbot", "Not authorized -- run the login script first.");
      client = null;
      return false;
    }

    // Save session after successful connect
    const newSession = client.session.save() as unknown as string;
    const dir = dirname(SESSION_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileAtomic.sync(SESSION_FILE, newSession);

    log("userbot", "Connected and authorized.");

    // Start periodic connection health check
    startConnectionMonitor();

    return true;
  } catch (err) {
    logError("userbot", "Connection failed", err);
    client = null;
    return false;
  }
}

/** Gracefully disconnect the GramJS user client. */
export async function disconnectUserClient(): Promise<void> {
  stopConnectionMonitor();
  if (client) {
    try {
      await client.disconnect();
      log("userbot", "Disconnected.");
    } catch (err) {
      logError("userbot", "Disconnect error", err);
    }
    client = null;
  }
}

// ── Connection monitoring ────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Upper bound for any single network step in the monitor. GramJS's
 * `connect()` can hang forever on a half-open socket; without a bound the
 * `reconnecting` latch never clears and every later tick bails out, leaving
 * the userbot dead until the daemon restarts.
 */
const RECONNECT_STEP_TIMEOUT_MS = 30_000;

/** Reject if `p` doesn't settle within `ms`. Exported for tests. */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** How long the monitor may fail to reconnect before the operator hears. */
const USERBOT_OUTAGE_MS = 15 * 60 * 1000;

const outage = createOutage({
  key: "telegram.userbot",
  thresholdMs: USERBOT_OUTAGE_MS,
  severity: "warn",
  describe: (err, mins) =>
    `The Telegram user client has failed to reconnect for ${mins} min: ${err}. ` +
    "Full history search and member lookups are unavailable.",
  recovered: "The Telegram user client is reconnected.",
});

/** One failed monitor step, logged with its place in the outage. */
function noteFailure(step: string, err: unknown): void {
  const { attempt, downMs } = outage.fail(err);
  logWarn(
    "userbot",
    `userbot.reconnect.fail step=${step} attempt=${attempt} down_ms=${downMs} ` +
      `next_check_ms=${CHECK_INTERVAL_MS} err=${errorText(err)}`,
  );
}

/** A healthy monitor step; logs the end of an outage when there was one. */
function noteHealthy(via: string): void {
  const ended = outage.ok();
  if (!ended) return;
  log(
    "userbot",
    `userbot.reconnect.ok via=${via} failed_attempts=${ended.attempts} down_ms=${ended.downMs}`,
  );
}

let reconnecting = false;
// Bumped by stopConnectionMonitor so a tick whose awaits straddle a shutdown
// can tell that its own client was torn down under it — the liveness probe
// rejecting because *we* disconnected must not trigger a reconnect, or
// shutdown resurrects the client it just closed.
let monitorGeneration = 0;

function startConnectionMonitor(): void {
  if (reconnectTimer) return;
  const gen = monitorGeneration;
  reconnectTimer = setInterval(async () => {
    if (gen !== monitorGeneration) return;
    if (reconnecting) return; // prevent overlapping reconnect attempts
    if (!client) {
      // A failed re-init leaves no client. Retry it every tick; bailing
      // here left the userbot dead until the daemon restarted.
      if (!storedApiId || !storedApiHash) return;
      reconnecting = true;
      try {
        await reinitClient();
      } finally {
        reconnecting = false;
      }
      return;
    }

    // GramJS keeps `client.connected === true` even after the underlying
    // socket has silently died, so a real round-trip is the only reliable
    // liveness signal. Without it the userbot can go stale for hours/days
    // while the monitor believes it is still connected.
    if (client.connected) {
      try {
        // A full API round-trip; throws if the socket is silently dead.
        await withTimeout(
          client.getMe(),
          RECONNECT_STEP_TIMEOUT_MS,
          "liveness probe",
        );
        noteHealthy("probe");
        return; // genuinely alive
      } catch {
        if (gen !== monitorGeneration) return; // monitor stopped mid-probe
        logWarn("userbot", "Liveness check failed — treating socket as dead.");
      }
    }

    if (!client) return; // torn down while the probe was in flight
    reconnecting = true;
    logWarn("userbot", "Connection lost, attempting reconnect...");
    try {
      await withTimeout(
        client.connect(),
        RECONNECT_STEP_TIMEOUT_MS,
        "reconnect",
      );
      if (
        await withTimeout(
          client.isUserAuthorized(),
          RECONNECT_STEP_TIMEOUT_MS,
          "auth check",
        )
      ) {
        log("userbot", "Reconnected successfully.");
        noteHealthy("reconnect");
      } else {
        logWarn("userbot", "Reconnected but not authorized.");
        noteFailure("reconnect", "connected but not authorized");
      }
    } catch (err) {
      if (gen !== monitorGeneration) return; // stopped while reconnecting
      logError("userbot", "Reconnect failed", err);
      if (storedApiId && storedApiHash) await reinitClient();
      else noteFailure("reconnect", err);
    } finally {
      reconnecting = false;
    }
  }, CHECK_INTERVAL_MS);
}

/**
 * Replace the client with a fresh one from the saved session. On failure
 * the slot is left empty (and the failed client closed); the monitor's
 * next tick tries again.
 */
async function reinitClient(): Promise<void> {
  // Drop the wedged client without awaiting it — its socket may be the
  // thing that's hung.
  const stale = client;
  client = null;
  void stale?.disconnect().catch(() => {});
  let fresh: TelegramClient | null = null;
  try {
    let sessionString = "";
    if (existsSync(SESSION_FILE)) {
      sessionString = readFileSync(SESSION_FILE, "utf-8").trim();
    }
    const session = new StringSession(sessionString);
    fresh = new TelegramClient(session, storedApiId, storedApiHash, {
      connectionRetries: 5,
    });
    client = fresh;
    await withTimeout(
      fresh.connect(),
      RECONNECT_STEP_TIMEOUT_MS,
      "re-init connect",
    );
    if (
      await withTimeout(
        fresh.isUserAuthorized(),
        RECONNECT_STEP_TIMEOUT_MS,
        "re-init auth check",
      )
    ) {
      log("userbot", "Full re-init reconnect succeeded.");
      noteHealthy("re-init");
    } else {
      noteFailure("re-init", "connected but not authorized");
    }
  } catch (retryErr) {
    logError("userbot", "Full re-init reconnect failed", retryErr);
    noteFailure("re-init", retryErr);
    if (client === fresh) client = null;
    // Its connect may still be retrying in the background.
    void fresh?.disconnect().catch(() => {});
  }
}

function stopConnectionMonitor(): void {
  monitorGeneration++;
  outage.dispose();
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

/** Search messages in a chat by keyword. */
export async function searchMessages(params: {
  chatId: number | string;
  query: string;
  limit?: number;
}): Promise<string> {
  if (!client) return "User client not connected. Run login script first.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const messages = await client.getMessages(chatId, {
      search: params.query,
      limit: params.limit ?? 20,
    });

    if (messages.length === 0) return `No messages matching "${params.query}".`;

    return messages
      .map((m) => {
        const date = formatSmartTimestamp(m.date * 1000);
        const sender =
          m.sender && "firstName" in m.sender
            ? [m.sender.firstName, m.sender.lastName].filter(Boolean).join(" ")
            : "Unknown";
        return `[msg:${m.id} ${date}] ${sender}: ${messageBody(m)}`;
      })
      .join("\n");
  } catch (err) {
    return `Search failed: ${err instanceof Error ? err.message : err}`;
  }
}

/**
 * Render one message's body for the history readers.
 *
 * Rich Messages (Bot API 10.2) reach this client as `messageMediaUnsupported`
 * with no text, because gramjs negotiates an older MTProto layer — so every
 * message the bot itself sent reads back as "(media)" and the agent cannot see
 * its own half of the conversation. When the text is one of ours, splice it
 * back in from the outgoing log; when it is not, say what happened rather than
 * calling it media.
 */
export function messageBody(m: {
  id: number;
  text?: string;
  media?: { className: string };
}): string {
  if (m.text) return m.text;
  if (m.media?.className === "MessageMediaUnsupported") {
    const own = outgoingText(m.id);
    if (own) return own;
    return "(rich message — not renderable by this client)";
  }
  return "(media)";
}

/** Media tag for the history line, suppressed for rich messages we resolved. */
export function mediaTagFor(m: {
  id: number;
  text?: string;
  media?: { className: string };
}): string {
  if (!m.media) return "";
  if (
    m.media.className === "MessageMediaUnsupported" &&
    !m.text &&
    outgoingText(m.id)
  ) {
    return "";
  }
  return ` [${m.media.className}]`;
}

/** Get message history from a chat. Supports going back in time via offsetDate or offsetId. */
export async function getHistory(params: {
  chatId: number | string;
  limit?: number;
  offsetId?: number;
  /** ISO date string or unix timestamp to start fetching from (goes backward from this point). */
  before?: string | number;
}): Promise<string> {
  if (!client) return "User client not connected. Run login script first.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const opts: Record<string, unknown> = {
      limit: params.limit ?? 30,
    };
    if (params.offsetId) {
      opts.offsetId = params.offsetId;
    }
    if (params.before) {
      const ts =
        typeof params.before === "string"
          ? Math.floor(new Date(params.before).getTime() / 1000)
          : params.before;
      if (ts > 0) opts.offsetDate = ts;
    }
    const messages = await client.getMessages(chatId, opts);

    if (messages.length === 0) return "No messages found.";

    return [...messages]
      .reverse()
      .map((m) => {
        const date = formatSmartTimestamp(m.date * 1000);
        const sender =
          m.sender && "firstName" in m.sender
            ? [m.sender.firstName, m.sender.lastName].filter(Boolean).join(" ")
            : "Unknown";
        const replyTag = m.replyTo?.replyToMsgId
          ? ` (reply to msg:${m.replyTo.replyToMsgId})`
          : "";
        const mediaTag = mediaTagFor(m);
        return `[msg:${m.id} ${date}] ${sender}${replyTag}${mediaTag}: ${messageBody(m)}`;
      })
      .join("\n");
  } catch (err) {
    return `History failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Get detailed participant info including admin status, join date, etc. */
export async function getParticipantDetails(params: {
  chatId: number | string;
  limit?: number;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const participants = await client.getParticipants(chatId, {
      limit: params.limit ?? 50,
    });

    if (participants.length === 0) return "No participants found.";

    return participants
      .map((p) => {
        const name =
          [p.firstName, p.lastName].filter(Boolean).join(" ") || "(no name)";
        const username = p.username ? `@${p.username}` : "";
        const bot = p.bot ? " [BOT]" : "";
        const verified = p.verified ? " [verified]" : "";
        const premium = p.premium ? " [premium]" : "";
        const status = (() => {
          const s = p.status;
          if (!s) return "unknown";
          const cn = s.className;
          if (cn === "UserStatusOnline") return "online";
          if (cn === "UserStatusOffline") {
            const off = s as { wasOnline?: number };
            if (off.wasOnline) {
              return `last seen ${formatSmartTimestamp(off.wasOnline * 1000)}`;
            }
            return "offline";
          }
          if (cn === "UserStatusRecently") return "recently";
          if (cn === "UserStatusLastWeek") return "last week";
          if (cn === "UserStatusLastMonth") return "last month";
          return cn;
        })();

        return `${name}${verified}${premium}${bot} ${username}\n  ID: ${p.id} | Status: ${status}`;
      })
      .join("\n\n");
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Get info about a specific user by ID -- only works if they're in an allowed chat. */
export async function getUserInfo(params: {
  chatId: number | string;
  userId: number;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    // Fetch participants so GramJS caches the user entities for getEntity below
    await client.getParticipants(chatId, { limit: 1, search: "" });
    // getEntity only works for users the client has seen
    const entity = await client.getEntity(params.userId).catch(() => null);
    if (!entity || !("firstName" in entity)) {
      return `User ${params.userId} not found or not accessible.`;
    }

    const u = entity;
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
    const username = u.username ? `@${u.username}` : "(no username)";
    const bot = u.bot ? "Yes" : "No";
    const verified = u.verified ? "Yes" : "No";
    const premium = u.premium ? "Yes" : "No";
    const phone = u.phone ? "(has phone)" : "(no phone visible)";
    const status = (() => {
      const s = u.status;
      if (!s) return "unknown";
      const cn = s.className;
      if (cn === "UserStatusOnline") return "Online";
      if (cn === "UserStatusOffline") {
        const off = s as { wasOnline?: number };
        if (off.wasOnline)
          return `Last seen ${formatSmartTimestamp(off.wasOnline * 1000)}`;
        return "Offline";
      }
      if (cn === "UserStatusRecently") return "Recently";
      if (cn === "UserStatusLastWeek") return "Last week";
      if (cn === "UserStatusLastMonth") return "Last month";
      return cn;
    })();

    return [
      `Name: ${name}`,
      `Username: ${username}`,
      `ID: ${u.id}`,
      `Status: ${status}`,
      `Bot: ${bot}`,
      `Verified: ${verified}`,
      `Premium: ${premium}`,
      `Phone: ${phone}`,
    ].join("\n");
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Get a specific message by ID. */
export async function getMessage(params: {
  chatId: number | string;
  messageId: number;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const messages = await client.getMessages(chatId, {
      ids: [params.messageId],
    });
    const m = messages[0];
    if (!m) return `Message ${params.messageId} not found.`;

    const date = formatSmartTimestamp(m.date * 1000);
    const sender =
      m.sender && "firstName" in m.sender
        ? [m.sender.firstName, m.sender.lastName].filter(Boolean).join(" ")
        : "Unknown";
    const replyTag = m.replyTo?.replyToMsgId
      ? `\nReply to: msg:${m.replyTo.replyToMsgId}`
      : "";
    const mediaTag = mediaTagFor(m) ? `\nMedia: ${m.media?.className}` : "";
    return `[msg:${m.id} ${date}] ${sender}${replyTag}${mediaTag}\n${messageBody(m)}`;
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Download media from a message and save to workspace/uploads/. */
export async function downloadMessageMedia(params: {
  chatId: number | string;
  messageId: number;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const messages = await client.getMessages(chatId, {
      ids: [params.messageId],
    });
    const m = messages[0];
    if (!m) return `Message ${params.messageId} not found.`;
    if (!m.media) return `Message ${params.messageId} has no media.`;

    // Download the media using GramJS
    const buffer = (await client.downloadMedia(m.media, {})) as Buffer;
    if (!buffer || buffer.length === 0) return "Download returned empty data.";

    // Use the original filename if available, otherwise generate one
    const doc = (
      m.media as { document?: { attributes?: Array<{ fileName?: string }> } }
    ).document;
    const originalName = doc?.attributes?.find((a) => a.fileName)?.fileName;
    const filename = originalName
      ? `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, "_")}`
      : `${Date.now()}-msg${params.messageId}`;

    // Save to .talon/workspace/uploads/
    const uploadsDir = dirs.uploads;
    if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

    const filePath = resolve(uploadsDir, filename);
    writeFileSync(filePath, buffer);

    log(
      "userbot",
      `Downloaded media from msg:${params.messageId} → ${filename} (${buffer.length} bytes)`,
    );
    return `Downloaded to: ${filePath} (${buffer.length} bytes). Use the Read tool on this path to view the content.`;
  } catch (err) {
    return `Download failed: ${err instanceof Error ? err.message : err}`;
  }
}

// ── Chat statistics & utility ────────────────────────────────────────────────

/** Get detailed chat/group statistics — message counts, top posters, activity. */
/** Get the pinned message(s) in a chat. */
export async function getPinnedMessages(params: {
  chatId: number | string;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const result = await client.invoke(
      new Api.messages.Search({
        peer: chatId,
        q: "",
        filter: new Api.InputMessagesFilterPinned(),
        minDate: 0,
        maxDate: 0,
        offsetId: 0,
        addOffset: 0,
        limit: 10,
        maxId: 0,
        minId: 0,
        hash: BigInt(0) as unknown as import("big-integer").BigInteger,
      }),
    );

    if (!("messages" in result) || result.messages.length === 0) {
      return "No pinned messages.";
    }

    const lines = result.messages.map((m) => {
      if (!("message" in m)) return `[msg:${m.id}] (no text)`;
      const date = formatSmartTimestamp(m.date * 1000);
      const text = m.message?.slice(0, 200) ?? "(media only)";
      return `[msg:${m.id} ${date}] ${text}`;
    });

    return `Pinned messages (${lines.length}):\n${lines.join("\n")}`;
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Get online/recently-active member count for a chat. */
export async function getOnlineCount(params: {
  chatId: number | string;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const participants = await client.getParticipants(chatId, { limit: 200 });

    let online = 0;
    let recently = 0;
    let total = participants.length;

    for (const p of participants) {
      if (p.bot) continue;
      const status = p.status?.className;
      if (status === "UserStatusOnline") online++;
      else if (status === "UserStatusRecently") recently++;
    }

    return `Members: ${total} total, ${online} online, ${recently} recently active`;
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : err}`;
  }
}
