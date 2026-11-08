/**
 * Codex backend initialisation.
 *
 * Spins up a long-lived `Codex` instance configured with:
 *
 *   - The MCP server map for the active chat, supplied as TOML config
 *     overrides via Codex's `--config` mechanism.
 *   - The OpenAI API key (from Codex-specific auth first, then the
 *     Codex CLI's standard OpenAI auth sources).
 *   - The working directory (defaults to the user's home so Codex's
 *     `skipGitRepoCheck` covers operation outside a git repo).
 *
 * Codex's MCP servers are configured ONCE at thread-creation time. To
 * keep per-chat MCP isolation working with this constraint, Talon
 * re-creates the underlying `Codex` instance the first time it sees a
 * different chat id. Subsequent runs in the same chat reuse the cached
 * instance.
 *
 * Why not re-create per turn: spawning a fresh Codex subprocess per
 * message would cost ~1-2s of CLI startup overhead. The chat-id-keyed
 * cache amortises that to one spawn per chat lifetime.
 */

import { Codex } from "@openai/codex-sdk";
import type { TalonConfig } from "../../core/config/index.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";
import { log, logWarn } from "../../util/log.js";
import { nonTerminalFrontends } from "../runtime/frontends.js";
import { getState } from "./state.js";
import { asCodexConfig, buildCodexMcpServers } from "./mcp-config.js";
import { detectCodexAuth, type CodexAuthInfo } from "./auth.js";
import { startDiscovery } from "./discovery.js";
import { gatewayToken } from "../../core/engine/gateway-auth.js";
import {
  computeAuthFingerprint,
  loadOAuthIncompatStore,
} from "./oauth-incompat.js";

/** Cached auth-mode detection result — updated on every `initCodexAgent`. */
let cachedAuthInfo: CodexAuthInfo | null = null;

/**
 * Return the auth-mode detection result captured at the last
 * `initCodexAgent` call. Used by the handler to pick the right default
 * model and by tests to assert init-time behaviour.
 */
export function getCodexAuthInfo(): CodexAuthInfo | null {
  return cachedAuthInfo;
}

/**
 * Initialise the Codex backend.
 *
 * Stores config + gateway-port resolver + frontend label. Spawning the
 * Codex CLI is deferred until the first message arrives (lazy
 * initialisation). Auth-mode detection runs synchronously here so the
 * startup log surfaces the result before any turn fires.
 */
export function initCodexAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: FrontendName,
): void {
  const state = getState();
  state.config = cfg;
  if (getGatewayPort) state.gatewayPortFn = getGatewayPort;
  if (frontend) state.frontendName = frontend;
  // Invalidate any cached Codex instance — the new config may carry
  // different MCP servers / API key / frontend wiring. The next
  // `ensureCodex(chatId)` call will rebuild from scratch.
  state.codex = null;

  // Detect auth mode synchronously so the startup line carries it.
  // Knowing whether we're on api-key vs chatgpt vs nothing drives both
  // the default-model pick and the handler's recovery decisions.
  const authInfo = detectCodexAuth({
    codexApiKey: cfg.codexApiKey,
    openaiApiKey: cfg.openaiApiKey,
    openaiBaseUrl: cfg.openaiBaseUrl,
  });
  cachedAuthInfo = authInfo;
  logAuthInfo(authInfo);

  // Rehydrate the OAuth-incompat learning store (or reset it if the
  // credential fingerprint has changed since last load). The store is
  // a no-op for non-OAuth credentials but the loader is cheap, so we
  // call it for all modes uniformly.
  // Fire-and-forget: `initCodexAgent` is sync. The store is best-effort —
  // a turn that races the first load runs without the runtime-learned
  // filter (the curated list still applies). The loader swallows its own
  // errors; the .catch() only guards a throw in its body.
  loadOAuthIncompatStore(computeAuthFingerprint(authInfo)).catch(() => {
    /* logged inside loadOAuthIncompatStore */
  });

  // Kick off model discovery as fire-and-forget. Branches on auth
  // mode internally:
  //   - chatgpt OAuth → reads `~/.codex/models_cache.json` (Codex CLI
  //     populates this from ChatGPT's backend API, including rich
  //     metadata we don't have to maintain ourselves).
  //   - api-key → hits OpenAI's `/v1/models` with the bearer key.
  //   - none → no-op (resolves immediately, picker falls back to
  //     curated).
  void startDiscovery(authInfo);
}

function logAuthInfo(info: CodexAuthInfo): void {
  for (const diagnostic of info.diagnostics) {
    logWarn("agent", `Codex auth: ${diagnostic}`);
  }
  switch (info.mode) {
    case "api-key":
      log(
        "agent",
        `Codex auth: api-key (source: ${info.source}${
          info.baseUrl ? `, baseUrl=${info.baseUrl}` : ""
        })`,
      );
      return;
    case "chatgpt":
      log(
        "agent",
        `Codex auth: chatgpt OAuth (source: ${info.source}). ` +
          `Note: gpt-5-codex is unavailable on this auth mode — ` +
          `gpt-5.5 will be used as the default.`,
      );
      return;
    case "none":
      logWarn(
        "agent",
        "Codex: no CODEX_API_KEY env, no TALON_CODEX_KEY env, no OPENAI_API_KEY env, " +
          "no usable Codex API key in talon.json, and no usable " +
          "~/.codex/auth.json — first turn will fail. Run `codex login` " +
          "(for ChatGPT OAuth) or set CODEX_API_KEY / TALON_CODEX_KEY / codexApiKey " +
          "(for API-key billing).",
      );
      if (info.authFilePath && !info.authFileParsed && info.parseError) {
        logWarn(
          "agent",
          `Codex: ~/.codex/auth.json exists but failed to parse: ${info.parseError}`,
        );
      }
      return;
  }
}

/**
 * Lazily build (or rebuild) the `Codex` instance for the active chat.
 *
 * Called by the handler at the top of each turn. Cheap when the active
 * chat hasn't changed (returns the cached instance); expensive on
 * first call or chat switch (rebuilds with the new MCP config).
 */
export function ensureCodex(chatId: string): Codex {
  const state = getState();
  if (!state.config) {
    throw new Error("Codex agent not initialized — call initCodexAgent first");
  }

  // Build the MCP server map for THIS chat. The map is baked into the
  // CLI config that the Codex instance ships with — i.e. it's
  // chat-specific from the moment the instance is constructed.
  const bridgeUrl = `http://127.0.0.1:${state.gatewayPortFn()}`;
  const frontends = getActiveFrontends(state.config.frontend);
  const mcpServers = buildCodexMcpServers({
    chatId,
    bridgeUrl,
    frontends,
    braveApiKey: state.config.braveApiKey,
    toolExclusions: state.config,
  });

  // The Codex CLI's `--config` flag flattens dotted JSON paths into
  // TOML. We provide `mcp_servers.<name>.{command,args,env}` and the
  // SDK serialises it for us. The type narrowing (SDK's
  // `CodexConfigObject` vs our `CodexMcpServer` shape) is centralised
  // in `asCodexConfig`.
  const codexConfig = asCodexConfig(mcpServers);

  // Cache key: the chat id. When it changes, we rebuild.
  const cached = state.codex;
  if (
    cached &&
    (cached as Codex & { __talonChatId?: string }).__talonChatId === chatId
  ) {
    return cached;
  }

  const apiKey = getCodexAuthInfo()?.apiKey;
  const baseUrl = getCodexAuthInfo()?.baseUrl;

  // Optional executable override (mirrors `claudeBinary`). Env var wins so
  // a test harness can point Codex at a stub binary without mutating the
  // persisted config. When unset, the codex-sdk resolves `codex` itself.
  const codexPathOverride =
    process.env.TALON_CODEX_BINARY || state.config.codexBinary || undefined;

  // Export TALON_GATEWAY_TOKEN before snapshotting the env: the MCP entries
  // name it via `bearer_token_env_var`.
  gatewayToken();
  const codex = new Codex({
    apiKey,
    baseUrl,
    config: codexConfig,
    ...(codexPathOverride ? { codexPathOverride } : {}),
    env: codexSubprocessEnv(),
  });
  // Stash chat id on the instance for cache-key matching above.
  (codex as Codex & { __talonChatId?: string }).__talonChatId = chatId;

  state.codex = codex;
  log("agent", `Codex instance built for chat ${chatId}`);

  return codex;
}

/**
 * Codex's SDK inherits process.env by default. Talon resolves the
 * credential profile itself, then lets the SDK inject CODEX_API_KEY
 * from `apiKey`; remove broad auth env vars so a stale shell variable
 * cannot shadow the selected profile inside the CLI.
 */
export function codexSubprocessEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      key === "CODEX_API_KEY" ||
      key === "OPENAI_API_KEY" ||
      key === "OPENAI_BASE_URL" ||
      key === "TALON_CODEX_KEY"
    ) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function getActiveFrontends(
  frontend: TalonConfig["frontend"],
): readonly string[] {
  return nonTerminalFrontends(frontend);
}
