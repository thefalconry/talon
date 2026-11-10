/**
 * The secret-drop service: mint a link (`/secret <name>`, `request_secret`),
 * serve its form, take the POST, write the file, and tell the chat.
 *
 * Frontends and the gateway call {@link requestSecretDrop}; the native
 * bridge calls {@link openSecretDropForm} and {@link submitSecretDrop}.
 * Core never imports a frontend, so the receipt goes out through the same
 * cross-send broker `send_via` uses.
 *
 * The value path is: request body → {@link parseSubmittedValue} →
 * {@link writeSecret}. It is never logged, returned, persisted elsewhere
 * or put into the receipt.
 */

import { log, logWarn } from "../../util/log.js";
import {
  isDiscordChatId,
  isNativeChatId,
  isTeamsChatId,
  isTelegramChatId,
  isTerminalChatId,
  isWhatsAppChatId,
  numericChatIdFor,
} from "../frontend-runtime/chat-id.js";
import { crossSendTarget } from "../engine/gateway-actions/cross-send.js";
import { getMeshService } from "../mesh/index.js";
import {
  SECRET_GRANT_TTL_MS,
  SecretDropStore,
  secretDropForm,
  secretDropResult,
} from "./drop.js";
import { secretNameProblem, writeSecret } from "./store.js";

export type SecretDropRequest = {
  name: unknown;
  purpose?: unknown;
  /** Canonical key of the chat that asked (receives the receipt). */
  chatKey: string;
  /** Frontend that chat lives on; inferred from the key when absent. */
  frontend?: string;
};

export type SecretDropDeps = {
  store: SecretDropStore;
  /** The bridge's public base URL, or why there isn't one. */
  baseUrl: () => { ok: true; url: string } | { ok: false; text: string };
  write: typeof writeSecret;
  notify: (frontend: string, chatKey: string, text: string) => Promise<void>;
};

/** The frontend a chat key belongs to, from its shape. */
function frontendForChatKey(chatKey: string): string | undefined {
  if (isNativeChatId(chatKey)) return "native";
  if (isDiscordChatId(chatKey)) return "discord";
  if (isWhatsAppChatId(chatKey)) return "whatsapp";
  if (isTeamsChatId(chatKey)) return "teams";
  if (isTerminalChatId(chatKey)) return "terminal";
  if (isTelegramChatId(chatKey)) return "telegram";
  return undefined;
}

async function notifyChat(
  frontend: string,
  chatKey: string,
  text: string,
): Promise<void> {
  const handler = crossSendTarget(frontend);
  if (!handler) return;
  await handler(
    { action: "send_message", text, target: chatKey },
    numericChatIdFor(chatKey),
  );
}

function meshBaseUrl(): ReturnType<SecretDropDeps["baseUrl"]> {
  return getMeshService().bridgeBaseUrl();
}

let deps: SecretDropDeps = {
  store: new SecretDropStore(),
  baseUrl: meshBaseUrl,
  write: writeSecret,
  notify: notifyChat,
};

/** Swap collaborators (tests). Returns the previous set. */
export function setSecretDropDeps(
  next: Partial<SecretDropDeps>,
): SecretDropDeps {
  const prev = deps;
  deps = { ...deps, ...next };
  return prev;
}

/**
 * Mint a link for one secret. The text is what the chat (or the model)
 * gets: the link, the name, the expiry — never a value.
 */
export function requestSecretDrop(
  req: SecretDropRequest,
): { ok: true; text: string; link: string } | { ok: false; text: string } {
  const problem = secretNameProblem(req.name);
  if (problem) return { ok: false, text: `Invalid secret name: ${problem}.` };
  const name = req.name as string;
  const frontend = req.frontend ?? frontendForChatKey(req.chatKey);
  if (!frontend) {
    return { ok: false, text: "Can't tell which chat to confirm the drop in." };
  }
  const base = deps.baseUrl();
  if (!base.ok) return { ok: false, text: base.text };
  if (!base.url.startsWith("https://")) {
    return {
      ok: false,
      text: "The bridge is plain HTTP, and a password must not cross the network unencrypted. Enable native TLS or set native.publicUrl to an https:// address.",
    };
  }
  const purpose =
    typeof req.purpose === "string" && req.purpose.trim()
      ? req.purpose.trim()
      : undefined;
  const grant = deps.store.create({
    name,
    chatKey: req.chatKey,
    frontend,
    ...(purpose ? { purpose } : {}),
  });
  const link = `${base.url}/secret?grant=${grant.token}`;
  const minutes = Math.round(SECRET_GRANT_TTL_MS / 60_000);
  log("secrets", `Secret drop link minted for "${name}" (chat ${req.chatKey})`);
  return {
    ok: true,
    link,
    text: [
      `Open this link to store the secret "${name}":`,
      "",
      `  ${link}`,
      "",
      `Single-use, expires in ${minutes} minutes. The value is written to ~/.talon/secrets/${name} (mode 600); it never goes through the chat or the model. This chat gets a confirmation when it's stored.`,
    ].join("\n"),
  };
}

/** GET /secret — the form for a live grant (not spent), or null. */
export function openSecretDropForm(token: string): string | null {
  const grant = token ? deps.store.peek(token) : null;
  return grant ? secretDropForm(grant) : null;
}

/** Whether a POST for `token` is worth reading the body of. */
export function isLiveSecretDrop(token: string): boolean {
  return Boolean(token && deps.store.peek(token));
}

/**
 * The value out of a form POST (`application/x-www-form-urlencoded`) or a
 * plain-text body. Null when there is none.
 */
function parseSubmittedValue(
  body: string,
  contentType: string | undefined,
): string | null {
  if ((contentType ?? "").includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(body).get("value");
  }
  return body || null;
}

/**
 * POST /secret — spend the grant, write the value, send the receipt.
 * Returns the page the browser sees. The grant is spent even when the
 * write fails, so a failure means "ask again", never "retry this link".
 */
export async function submitSecretDrop(
  token: string,
  body: string,
  contentType: string | undefined,
): Promise<{ status: number; html: string }> {
  const grant = token ? deps.store.consume(token) : null;
  if (!grant) return { status: 404, html: secretDropResult(false, null) };
  const value = parseSubmittedValue(body, contentType);
  if (!value) {
    return {
      status: 400,
      html: secretDropResult(false, null, "No value was submitted."),
    };
  }
  const written = await deps.write(grant.name, value);
  if (!written.ok) {
    logWarn(
      "secrets",
      `Secret drop for "${grant.name}" failed: ${written.error}`,
    );
    return { status: 500, html: secretDropResult(false, null, written.error) };
  }
  log("secrets", `Secret "${grant.name}" stored via drop link`);
  try {
    await deps.notify(
      grant.frontend,
      grant.chatKey,
      `stored ✓ as ${grant.name}`,
    );
  } catch (err) {
    logWarn(
      "secrets",
      `Secret drop receipt to ${grant.frontend} chat ${grant.chatKey} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { status: 200, html: secretDropResult(true, grant.name) };
}

export type SecretCommandContext = {
  /** Everything after `/secret`. */
  arg: string;
  chatKey: string;
  frontend: string;
  /** Whether the sender may write into the operator's secrets folder. */
  isOperator: boolean;
  /** Whether this chat has more than one human in it. */
  isGroup: boolean;
};

/**
 * `/secret <name> [purpose]` — the reply every frontend sends. One
 * implementation, so the rules (operator only, DMs only, the usage line)
 * are the same on Telegram, Discord, WhatsApp and the native app.
 */
export function secretCommandReply(ctx: SecretCommandContext): string {
  if (!ctx.isOperator) return "Only the operator can store secrets.";
  if (ctx.isGroup) {
    return "Run /secret in a private chat with me: a drop link writes to the secrets folder for whoever opens it, so it doesn't belong in a group.";
  }
  const [name = "", ...rest] = ctx.arg.trim().split(/\s+/);
  if (!name) {
    return [
      "Usage: /secret <name> [what it's for]",
      "",
      "Sends a single-use link to a paste form. The value is saved to ~/.talon/secrets/<name> and never goes through the chat. Don't paste passwords here.",
    ].join("\n");
  }
  const minted = requestSecretDrop({
    name,
    purpose: rest.join(" "),
    chatKey: ctx.chatKey,
    frontend: ctx.frontend,
  });
  return minted.text;
}
