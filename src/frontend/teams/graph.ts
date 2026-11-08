/**
 * Microsoft Graph API integration — device code auth + chat message polling.
 *
 * Uses the Microsoft Graph PowerShell well-known client ID (no app registration needed).
 * Authenticates via device code flow, then polls a Teams GROUP CHAT for new messages.
 *
 * Key: Chat.Read scope does NOT require admin consent (unlike ChannelMessage.Read.All).
 * Tokens are persisted to disk so re-auth is only needed when refresh tokens expire.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { log, logError, logWarn } from "../../util/log.js";
import { proxyFetch } from "./proxy-fetch.js";
import { dirs } from "../../util/paths.js";
import { stripHtml } from "./formatting.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Microsoft Graph PowerShell — supports arbitrary delegated scopes, no app registration. */
const CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const TENANT = "organizations";
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SCOPES = "Chat.Read Chat.ReadBasic User.Read offline_access";

const TOKEN_FILE = resolve(dirs.data, "teams-tokens.json");

// ── Types ────────────────────────────────────────────────────────────────────

type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  chatId?: string;
  chatTopic?: string;
  userId?: string;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

export type ChatMessage = {
  id: string;
  text: string;
  senderName: string;
  senderId: string;
  chatId: string;
  createdDateTime: string;
  messageType: string;
  edited: boolean;
};

// ── Token storage ────────────────────────────────────────────────────────────

function loadTokens(): StoredTokens | null {
  try {
    if (existsSync(TOKEN_FILE)) {
      return JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
    }
  } catch {
    /* corrupt */
  }
  return null;
}

function saveTokens(tokens: StoredTokens): void {
  if (!existsSync(dirs.data)) mkdirSync(dirs.data, { recursive: true });
  writeFileAtomic.sync(TOKEN_FILE, JSON.stringify(tokens, null, 2) + "\n");
}

// ── OAuth helpers ────────────────────────────────────────────────────────────

async function postForm(
  url: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params).toString();
  const resp = await proxyFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`OAuth request failed: HTTP ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<StoredTokens | null> {
  const data = (await postForm(`${AUTH_BASE}/token`, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    scope: SCOPES,
  })) as TokenResponse;

  if (data.error) {
    logError(
      "teams",
      `Token refresh failed: ${data.error_description || data.error}`,
    );
    return null;
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000 - 60_000, // 1 min buffer
  };
}

// ── Device code flow ─────────────────────────────────────────────────────────

export async function deviceCodeAuth(): Promise<StoredTokens> {
  const dcResp = (await postForm(`${AUTH_BASE}/devicecode`, {
    client_id: CLIENT_ID,
    scope: SCOPES,
  })) as unknown as DeviceCodeResponse;

  // Print instructions for the user
  console.log();
  console.log(`  To sign in, open: ${dcResp.verification_uri}`);
  console.log(`  Enter code: ${dcResp.user_code}`);
  console.log();
  log(
    "teams",
    `Device code auth: go to ${dcResp.verification_uri} and enter ${dcResp.user_code}`,
  );

  // Poll for token
  const pollInterval = (dcResp.interval || 5) * 1000;
  const deadline = Date.now() + dcResp.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const tokenResp = (await postForm(`${AUTH_BASE}/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: CLIENT_ID,
      device_code: dcResp.device_code,
    })) as TokenResponse;

    if (tokenResp.access_token) {
      log("teams", "Device code auth successful");
      const tokens: StoredTokens = {
        accessToken: tokenResp.access_token,
        refreshToken: tokenResp.refresh_token || "",
        expiresAt: Date.now() + tokenResp.expires_in * 1000 - 60_000,
      };
      saveTokens(tokens);
      return tokens;
    }

    if (tokenResp.error === "authorization_pending") continue;
    if (tokenResp.error === "slow_down") {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    throw new Error(
      `Auth failed: ${tokenResp.error_description || tokenResp.error}`,
    );
  }

  throw new Error("Device code auth timed out (15 minutes)");
}

// ── Graph API client ─────────────────────────────────────────────────────────

export class GraphClient {
  private tokens: StoredTokens;

  constructor(tokens: StoredTokens) {
    this.tokens = tokens;
  }

  private async ensureValidToken(): Promise<string> {
    if (Date.now() < this.tokens.expiresAt) {
      return this.tokens.accessToken;
    }

    log("teams", "Refreshing access token...");
    const refreshed = await refreshAccessToken(this.tokens.refreshToken);
    if (!refreshed)
      throw new Error("Token refresh failed — re-authentication needed");

    this.tokens = { ...this.tokens, ...refreshed };
    saveTokens(this.tokens);
    return this.tokens.accessToken;
  }

  private async graphGet(path: string): Promise<Record<string, unknown>> {
    const token = await this.ensureValidToken();
    const resp = await proxyFetch(`${GRAPH_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Graph API ${path} failed: ${resp.status} ${body}`);
    }

    return (await resp.json()) as Record<string, unknown>;
  }

  // ── User info ──────────────────────────────────────────────────────────

  async getMe(): Promise<{ id: string; displayName: string }> {
    const data = await this.graphGet("/me?$select=id,displayName");
    return { id: data.id as string, displayName: data.displayName as string };
  }

  // ── Chat discovery ─────────────────────────────────────────────────────

  async listChats(): Promise<
    Array<{ id: string; topic: string | null; chatType: string }>
  > {
    const data = await this.graphGet("/me/chats?$top=50");
    const chats = data.value as Array<Record<string, unknown>>;
    return chats.map((c) => ({
      id: c.id as string,
      topic: (c.topic as string) || null,
      chatType: c.chatType as string,
    }));
  }

  // ── Message reading ────────────────────────────────────────────────────

  async getChatMessages(chatId: string, top = 20): Promise<ChatMessage[]> {
    const data = await this.graphGet(
      `/me/chats/${encodeURIComponent(chatId)}/messages?$top=${top}`,
    );

    const raw = data.value as Array<Record<string, unknown>>;
    return raw
      .filter((m) => (m.messageType as string) === "message")
      .map((m) => {
        const from = m.from as Record<string, unknown> | null;
        const user = from?.user as Record<string, unknown> | null;
        const body = m.body as { contentType: string; content: string } | null;

        let text = body?.content || "";
        if (body?.contentType === "html") {
          text = stripHtml(text);
        }

        return {
          id: m.id as string,
          text,
          senderName: (user?.displayName as string) || "Unknown",
          senderId: (user?.id as string) || "",
          chatId,
          createdDateTime: m.createdDateTime as string,
          messageType: m.messageType as string,
          edited: m.lastEditedDateTime != null,
        };
      });
  }

  // ── Stored config ──────────────────────────────────────────────────────

  getStoredChatId(): string | undefined {
    return this.tokens.chatId;
  }
  getStoredChatTopic(): string | undefined {
    return this.tokens.chatTopic;
  }
  getStoredUserId(): string | undefined {
    return this.tokens.userId;
  }

  saveChatConfig(chatId: string, chatTopic: string, userId: string): void {
    this.tokens.chatId = chatId;
    this.tokens.chatTopic = chatTopic;
    this.tokens.userId = userId;
    saveTokens(this.tokens);
  }
}

// ── Init helper ──────────────────────────────────────────────────────────────

/**
 * Initialize the Graph client — loads stored tokens or runs device code flow.
 */
export async function initGraphClient(): Promise<GraphClient> {
  const stored = loadTokens();

  if (stored && stored.refreshToken) {
    log("teams", "Found stored tokens, validating...");
    const refreshed = await refreshAccessToken(stored.refreshToken);
    if (refreshed) {
      const tokens = { ...stored, ...refreshed };
      saveTokens(tokens);
      log("teams", "Tokens refreshed successfully");
      return new GraphClient(tokens);
    }
    logWarn("teams", "Stored tokens expired, re-authenticating...");
  }

  const tokens = await deviceCodeAuth();
  return new GraphClient(tokens);
}
