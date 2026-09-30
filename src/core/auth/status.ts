/**
 * Provider login status — what the CLIs know about their own credentials.
 *
 * Talon's Claude and Codex backends borrow the login state of the
 * `claude` and `codex` CLIs (`~/.claude/.credentials.json` and
 * `~/.codex/auth.json`). Both files are plain JSON, so status can be read
 * without spawning anything. Claude's file carries an explicit refresh-token
 * expiry (the "you have N days to log in again" the CLI prints); Codex's
 * carries the last refresh time and
 * only reveals a dead refresh token by failing — so "expired" for Codex
 * means the file is missing, unparsable, or was reported dead by the
 * backend (see {@link markProviderExpired}).
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { logWarn } from "../../util/log.js";
import { userHome } from "../../util/fs-path.js";

export type AuthProvider = "claude" | "codex";

export const AUTH_PROVIDERS: readonly AuthProvider[] = ["claude", "codex"];

export const PROVIDER_LABELS: Record<AuthProvider, string> = {
  claude: "Claude",
  codex: "Codex",
};

export interface ProviderAuthStatus {
  provider: AuthProvider;
  loggedIn: boolean;
  /** Human-readable account descriptor ("max plan", "ChatGPT"), when known. */
  account?: string;
  /** Epoch ms after which a fresh login is required, when the file says. */
  loginExpiresAt?: number;
  /** Epoch ms of the last token refresh, when the file says. */
  lastRefreshAt?: number;
  /** True when the credentials are known to be unusable. */
  expired: boolean;
}

export function claudeCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(
    configDir ? configDir : join(userHome(), ".claude"),
    ".credentials.json",
  );
}

export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim();
  return join(home ? home : join(userHome(), ".codex"), "auth.json");
}

/** Providers the backends reported as dead since boot (cleared on login). */
const reportedExpired = new Set<AuthProvider>();

export function markProviderExpired(provider: AuthProvider): void {
  reportedExpired.add(provider);
}

export function clearProviderExpired(provider: AuthProvider): void {
  reportedExpired.delete(provider);
}

/**
 * A credentials file that exists but isn't JSON reads as "not signed
 * in" — indistinguishable from a missing login unless logged. Nothing
 * from the file goes into the line: JSON.parse's message quotes the
 * input, and the input is a token.
 */
function warnUnparseable(provider: AuthProvider): void {
  logWarn(
    "notify",
    `${provider} credentials file is not valid JSON — reporting not signed in`,
  );
}

export function parseClaudeCredentials(raw: string): ProviderAuthStatus {
  const base: ProviderAuthStatus = {
    provider: "claude",
    loggedIn: false,
    expired: true,
  };
  let parsed: {
    claudeAiOauth?: {
      accessToken?: string;
      expiresAt?: number;
      refreshTokenExpiresAt?: number;
      subscriptionType?: string;
    };
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnUnparseable("claude");
    return base;
  }
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken) return base;
  const loginExpiresAt =
    typeof oauth.refreshTokenExpiresAt === "number"
      ? oauth.refreshTokenExpiresAt
      : undefined;
  return {
    provider: "claude",
    loggedIn: true,
    account: oauth.subscriptionType
      ? `${oauth.subscriptionType} plan`
      : undefined,
    loginExpiresAt,
    expired: loginExpiresAt !== undefined && loginExpiresAt <= Date.now(),
  };
}

export function parseCodexAuth(raw: string): ProviderAuthStatus {
  const base: ProviderAuthStatus = {
    provider: "codex",
    loggedIn: false,
    expired: true,
  };
  let parsed: {
    auth_mode?: string;
    OPENAI_API_KEY?: string | null;
    tokens?: { access_token?: string; refresh_token?: string };
    last_refresh?: string;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnUnparseable("codex");
    return base;
  }
  const apiKey =
    typeof parsed.OPENAI_API_KEY === "string" &&
    parsed.OPENAI_API_KEY.length > 0;
  const chatgpt = Boolean(
    parsed.tokens?.refresh_token || parsed.tokens?.access_token,
  );
  if (!apiKey && !chatgpt) return base;
  const lastRefreshAt = parsed.last_refresh
    ? Date.parse(parsed.last_refresh)
    : NaN;
  return {
    provider: "codex",
    loggedIn: true,
    account: chatgpt ? "ChatGPT" : "API key",
    lastRefreshAt: Number.isFinite(lastRefreshAt) ? lastRefreshAt : undefined,
    expired: false,
  };
}

async function readOrEmpty(
  provider: AuthProvider,
  path: string,
): Promise<string | undefined> {
  try {
    await stat(path);
    return await readFile(path, "utf8");
  } catch (err) {
    // Missing is the normal signed-out case; anything else (EACCES,
    // EISDIR) is a fault that would otherwise read as signed out too.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logWarn(
        "notify",
        `${provider} credentials unreadable code=${code ?? "?"} — reporting not signed in`,
      );
    }
    return undefined;
  }
}

export async function readProviderStatus(
  provider: AuthProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderAuthStatus> {
  const path =
    provider === "claude" ? claudeCredentialsPath(env) : codexAuthPath(env);
  const raw = await readOrEmpty(provider, path);
  const status =
    raw === undefined
      ? { provider, loggedIn: false, expired: true }
      : provider === "claude"
        ? parseClaudeCredentials(raw)
        : parseCodexAuth(raw);
  if (reportedExpired.has(provider)) return { ...status, expired: true };
  return status;
}

export async function readAllProviderStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderAuthStatus[]> {
  return Promise.all(AUTH_PROVIDERS.map((p) => readProviderStatus(p, env)));
}

/** Whole days until `at`; negative when already past. */
export function daysUntil(at: number, now = Date.now()): number {
  return Math.floor((at - now) / 86_400_000);
}

/** One-line human summary used by both the panel and the expiry alerts. */
export function describeProviderStatus(
  s: ProviderAuthStatus,
  now = Date.now(),
): string {
  if (!s.loggedIn) return "not signed in";
  if (s.expired) return "login expired — sign in again";
  const parts: string[] = [`signed in${s.account ? ` (${s.account})` : ""}`];
  if (s.loginExpiresAt !== undefined) {
    const days = daysUntil(s.loginExpiresAt, now);
    parts.push(days <= 0 ? "login expires today" : `login expires in ${days}d`);
  } else if (s.lastRefreshAt !== undefined) {
    parts.push(
      `refreshed ${Math.max(0, -daysUntil(s.lastRefreshAt, now))}d ago`,
    );
  }
  return parts.join(", ");
}
