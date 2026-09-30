/**
 * Codex authentication detection.
 *
 * The Codex CLI supports two distinct authentication modes, with
 * materially different capabilities:
 *
 *   - **API key** (`CODEX_API_KEY` / `TALON_CODEX_KEY` env var,
 *     `codexApiKey` passed to the SDK's `Codex` constructor, or
 *     `OPENAI_API_KEY` stored in `~/.codex/auth.json`). Full model
 *     catalog access, billed via the configured OpenAI-compatible API.
 *     `gpt-5-codex` is the flagship on OpenAI's native endpoint.
 *
 *   - **ChatGPT OAuth** (`~/.codex/auth.json` `auth_mode: "chatgpt"`
 *     after running `codex login`). Restricted to a subset of models —
 *     `gpt-5-codex` is explicitly rejected with a 400
 *     "invalid_request_error" telling the user the model isn't
 *     supported on a ChatGPT account. `gpt-5.5` is the flagship under
 *     this auth mode.
 *
 * Talon needs to know which mode is active at startup so it can pick a
 * sensible default model and surface useful errors. This module owns
 * the detection logic.
 *
 * Detection order (each step short-circuits if it succeeds):
 *
 *   1. `CODEX_API_KEY` env var → `"api-key"` (Codex CLI convention).
 *   2. `TALON_CODEX_KEY` env var → `"api-key"` (Talon-scoped alias).
 *   3. `codexApiKey` in Talon config → `"api-key"`.
 *      Any Codex-specific API key is paired with `openaiBaseUrl` when
 *      configured; the SDK maps that to Codex's `openai_base_url`
 *      override.
 *   4. `~/.codex/auth.json` exists + `auth_mode` field is read → returns
 *      that value (`"chatgpt"` for OAuth, `"api-key"` if the JSON also
 *      has a non-null `OPENAI_API_KEY`).
 *   5. `OPENAI_API_KEY` env var → `"api-key"` as a generic fallback.
 *   6. `openaiApiKey` in Talon config → `"api-key"` as a legacy fallback.
 *      These shared OpenAI credentials are deliberately after the Codex
 *      auth file so other Talon backends can keep their credentials
 *      without hijacking a logged-in Codex CLI.
 *   7. Nothing → `"none"`. First turn will fail with an auth error;
 *      caller emits a startup warning pointing to `codex login`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TalonError } from "../../core/errors.js";

/** Detected auth mode. */
type CodexAuthMode = "api-key" | "chatgpt" | "none";

export type CodexApiKeySource =
  | "env:CODEX_API_KEY"
  | "env:TALON_CODEX_KEY"
  | "config:codexApiKey"
  | "env:OPENAI_API_KEY"
  | "config:openaiApiKey";

/** Resolved auth state plus diagnostics for the startup log. */
export interface CodexAuthInfo {
  mode: CodexAuthMode;
  /** Where the credential was found, for logging. */
  source: CodexApiKeySource | "file:~/.codex/auth.json" | "missing";
  /** API key to pass into the Codex SDK, when auth is explicit. */
  apiKey?: string;
  /** Base URL to pass into the Codex SDK alongside explicit API-key auth. */
  baseUrl?: string;
  /** Path to the auth file when present (for diagnostics). */
  authFilePath?: string;
  /** Whether the auth file (if present) parsed correctly. */
  authFileParsed: boolean;
  /** Raw parse error when the file existed but couldn't be parsed. */
  parseError?: string;
  /** Diagnostics about credential resolution. */
  diagnostics: string[];
}

export interface DetectCodexAuthInput {
  codexApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

function normalizeCodexBaseUrl(
  baseUrl: string | undefined,
): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function normalizeSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function resolveCodexApiKey(input: DetectCodexAuthInput): {
  apiKey?: string;
  baseUrl?: string;
  source?: CodexApiKeySource;
  diagnostics: string[];
} {
  const env = input.env ?? process.env;
  const baseUrl = normalizeCodexBaseUrl(input.openaiBaseUrl);
  const diagnostics: string[] = [];

  const codexApiKeyEnv = normalizeSecret(env.CODEX_API_KEY);
  if (codexApiKeyEnv) {
    return {
      apiKey: codexApiKeyEnv,
      baseUrl,
      source: "env:CODEX_API_KEY",
      diagnostics,
    };
  }

  const talonCodexKeyEnv = normalizeSecret(env.TALON_CODEX_KEY);
  if (talonCodexKeyEnv) {
    return {
      apiKey: talonCodexKeyEnv,
      baseUrl,
      source: "env:TALON_CODEX_KEY",
      diagnostics,
    };
  }

  const configCodexApiKey = normalizeSecret(input.codexApiKey);
  if (configCodexApiKey) {
    return {
      apiKey: configCodexApiKey,
      baseUrl,
      source: "config:codexApiKey",
      diagnostics,
    };
  }

  return { diagnostics };
}

function resolveGenericOpenAiApiKey(input: DetectCodexAuthInput): {
  apiKey?: string;
  baseUrl?: string;
  source?: Extract<
    CodexApiKeySource,
    "env:OPENAI_API_KEY" | "config:openaiApiKey"
  >;
  diagnostics: string[];
} {
  const env = input.env ?? process.env;
  const baseUrl = normalizeCodexBaseUrl(input.openaiBaseUrl);
  const diagnostics: string[] = [];

  const openAiApiKeyEnv = normalizeSecret(env.OPENAI_API_KEY);
  if (openAiApiKeyEnv) {
    return {
      apiKey: openAiApiKeyEnv,
      baseUrl,
      source: "env:OPENAI_API_KEY",
      diagnostics,
    };
  }

  const configOpenAiApiKey = normalizeSecret(input.openaiApiKey);
  if (configOpenAiApiKey) {
    return {
      apiKey: configOpenAiApiKey,
      baseUrl,
      source: "config:openaiApiKey",
      diagnostics,
    };
  }

  return { diagnostics };
}

/**
 * Detect the active Codex auth mode.
 *
 * All config values are passed in by the caller so this module doesn't
 * depend on the config module.
 */
export function detectCodexAuth(
  input: DetectCodexAuthInput = {},
): CodexAuthInfo {
  const env = input.env ?? process.env;
  const explicitKey = resolveCodexApiKey(input);
  if (explicitKey.apiKey && explicitKey.source) {
    return {
      mode: "api-key",
      source: explicitKey.source,
      apiKey: explicitKey.apiKey,
      baseUrl: explicitKey.baseUrl,
      authFileParsed: false,
      diagnostics: explicitKey.diagnostics,
    };
  }

  let authFileResult: CodexAuthInfo | null = null;
  // Codex CLI auth file (created by `codex login`).
  const home = env.HOME ?? env.USERPROFILE;
  if (home) {
    const authFilePath = join(home, ".codex", "auth.json");
    if (existsSync(authFilePath)) {
      try {
        const raw = readFileSync(authFilePath, "utf8");
        const parsed = JSON.parse(raw) as {
          auth_mode?: string;
          OPENAI_API_KEY?: string | null;
        };
        // The auth.json schema includes `OPENAI_API_KEY` as a top-level
        // field even on ChatGPT-mode installs; when it's non-null it
        // takes precedence (mirrors what the CLI itself does).
        const fileApiKey =
          typeof parsed.OPENAI_API_KEY === "string"
            ? normalizeSecret(parsed.OPENAI_API_KEY)
            : undefined;
        if (fileApiKey) {
          return {
            mode: "api-key",
            source: "file:~/.codex/auth.json",
            apiKey: fileApiKey,
            authFilePath,
            authFileParsed: true,
            diagnostics: explicitKey.diagnostics,
          };
        }
        if (parsed.auth_mode === "chatgpt") {
          return {
            mode: "chatgpt",
            source: "file:~/.codex/auth.json",
            authFilePath,
            authFileParsed: true,
            diagnostics: explicitKey.diagnostics,
          };
        }
        // File parsed but doesn't carry a recognised mode — treat as
        // missing for now; generic OpenAI fallback may still be usable.
        authFileResult = {
          mode: "none",
          source: "missing",
          authFilePath,
          authFileParsed: true,
          diagnostics: explicitKey.diagnostics,
        };
      } catch (err) {
        authFileResult = {
          mode: "none",
          source: "missing",
          authFilePath,
          authFileParsed: false,
          parseError: err instanceof Error ? err.message : String(err),
          diagnostics: explicitKey.diagnostics,
        };
      }
    }
  }

  const genericKey = resolveGenericOpenAiApiKey(input);
  if (genericKey.apiKey && genericKey.source) {
    return {
      mode: "api-key",
      source: genericKey.source,
      apiKey: genericKey.apiKey,
      baseUrl: genericKey.baseUrl,
      authFileParsed: authFileResult?.authFileParsed ?? false,
      authFilePath: authFileResult?.authFilePath,
      parseError: authFileResult?.parseError,
      diagnostics: [...explicitKey.diagnostics, ...genericKey.diagnostics],
    };
  }

  if (authFileResult) return authFileResult;

  // Nothing.
  return {
    mode: "none",
    source: "missing",
    authFileParsed: false,
    diagnostics: explicitKey.diagnostics,
  };
}

/**
 * Detect whether an error from `runStreamed` is the
 * "model-not-supported-on-ChatGPT-account" 400. Used by the handler's
 * recovery ladder to auto-fall-back to a ChatGPT-compatible model when
 * the configured one is API-key-only.
 *
 * Codex surfaces this in two places — the JSON error payload nested
 * inside an `error` event, AND the textual `turn.failed.error.message`
 * the SDK wraps around it. Both contain the substring
 * `"not supported when using Codex with a ChatGPT account"`. Match on
 * that substring (case-insensitive, generous on whitespace) so a
 * future wording shift still trips a soft-match.
 *
 * Also matches the 404 "model … does not exist or you do not have
 * access" shape ({@link isCodexModelNotFoundError}): a model retired for
 * the account is the same situation from the caller's point of view.
 */
export function isChatGptModelMismatchError(message: string): boolean {
  if (
    /not\s+supported\s+when\s+using\s+codex\s+with\s+a\s+chatgpt\s+account/i.test(
      message,
    )
  ) {
    return true;
  }
  return isCodexModelNotFoundError(message);
}

/**
 * Detect the "model retired / not granted" 404 the ChatGPT Codex endpoint
 * returns once a model is withdrawn from an account:
 *
 *   `unexpected status 404 Not Found: The model \`gpt-5.5\` does not exist
 *    or you do not have access to it.`
 *
 * Every Codex cron run hit exactly this from 2026-09-24 onward. It is as
 * definitive as the 400 mismatch — the server names the model and says
 * the account can't use it — so it takes the same fallback/learning path.
 * Requires both the 404 status and the "model … does not exist" wording
 * so an unrelated 404 (a missing MCP resource, a bad URL) can't trip it.
 */
export function isCodexModelNotFoundError(message: string): boolean {
  return (
    /\b404\b/.test(message) &&
    /\bmodel\b[^\n]{0,120}?\bdoes\s+not\s+exist\b/i.test(message)
  );
}

/**
 * Detect the *silent* OAuth-incompat exit shape — the one that hit
 * a group chat on 2026-05-20 at 23:13Z.
 *
 * On a free ChatGPT-OAuth credential the Codex CLI silently rejects
 * most model strings (only `gpt-5.5` is verified working). Crucially,
 * for some rejected models the CLI exits 1 *without* emitting a
 * structured `error` or `turn.failed` event over the JSON stream, AND
 * without writing the canonical
 * `"not supported when using Codex with a ChatGPT account"` text to
 * stderr. The only signal the SDK surfaces is:
 *
 *   `Codex Exec exited with code 1: Reading prompt from stdin...\n`
 *
 * (`"Reading prompt from stdin..."` is the CLI's startup banner — it
 * always prints that and then exits before the prompt even reaches
 * the model.)
 *
 * The detector heuristic:
 *   - Error text contains `"Codex Exec exited"` (SDK's wrapper);
 *   - Error text contains `"Reading prompt from stdin"` (CLI banner);
 *   - Error text does NOT contain the explicit mismatch phrase (the
 *     other detector handles that case);
 *   - Error text does NOT carry the OAuth refresh failure (an expired
 *     login exits with the same banner — `isCodexRefreshTokenError`).
 *
 * Callers MUST additionally check `authInfo.mode === "chatgpt"` and
 * that the model isn't already the OAuth default before falling back —
 * a silent exit-1 on api-key auth is a different bug class (network,
 * config error, etc.) and shouldn't be misclassified.
 *
 * Case-insensitive; whitespace-tolerant. Matches both `code 1` and
 * `code 2` (the CLI has been observed using both).
 */
export function isSilentOAuthExitError(message: string): boolean {
  if (!message) return false;
  if (isChatGptModelMismatchError(message)) return false;
  if (isCodexRefreshTokenError(message)) return false;
  return (
    /Codex\s+Exec\s+exited\s+with\s+code\s+\d+/i.test(message) &&
    /Reading\s+prompt\s+from\s+stdin/i.test(message)
  );
}

/**
 * Detect an expired ChatGPT OAuth login.
 *
 * When the stored refresh token has been invalidated (the user logged
 * out elsewhere, or the session was ended server-side) the Codex CLI
 * prints its startup banner, logs
 *
 *   `ERROR codex_login::auth::manager: Failed to refresh token: 401
 *    Unauthorized: {"error": {"code": "refresh_token_invalidated", …}}`
 *
 * to stderr, and exits 1 before the prompt reaches the model. The SDK
 * folds that stderr into the same `Codex Exec exited with code 1:
 * Reading prompt from stdin...` wrapper the silent OAuth-incompat exit
 * uses, so without this check it is misread as a model mismatch —
 * resetting the thread and retrying on a fallback model that fails the
 * same way. Nothing but `codex login` fixes it.
 */
export function isCodexRefreshTokenError(message: string): boolean {
  return /Failed\s+to\s+refresh\s+token|refresh_token_invalidated/i.test(
    message,
  );
}

/**
 * The error surfaced to the user for an expired Codex login. Typed
 * `auth` so the shared retry ladder propagates it untouched — no thread
 * reset, no fallback model — and `friendlyMessage` keeps the detail.
 */
export function codexLoginExpiredError(cause: unknown): TalonError {
  return new TalonError(
    "Codex login expired — run `codex login` to re-authenticate.",
    { reason: "auth", retryable: false, status: 401, cause },
  );
}
