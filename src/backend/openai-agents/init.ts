/**
 * OpenAI Agents backend initialisation.
 *
 * No long-running server, no per-chat instance cache — the SDK is
 * stateless from Talon's side. We capture config + frontend +
 * gateway-port resolver at init, wire the SDK's default OpenAI client
 * at the resolved endpoint, surface an auth-mode log line so operators
 * know whether `TALON_AGENTS_KEY` (or a custom-endpoint configuration)
 * actually resolves, then kick off endpoint discovery asynchronously
 * (see `discovery.ts`).
 *
 * Endpoint selection
 * ──────────────────
 *
 * The `@openai/agents` SDK targets OpenAI's API by default but accepts
 * any OpenAI-compatible endpoint via a custom `OpenAI` client. Talon
 * exposes three knobs, each resolvable from a Talon-specific env var
 * or `talon.json` (env wins):
 *
 *   key:      TALON_AGENTS_KEY      > config.openaiApiKey
 *   baseURL:  TALON_AGENTS_URL      > config.openaiBaseUrl
 *   apiMode:  TALON_AGENTS_API_MODE > config.openaiApiMode
 *
 * Talon deliberately ignores the OpenAI-standard `OPENAI_API_KEY` /
 * `OPENAI_BASE_URL` / `OPENAI_API_MODE` env vars: operators frequently
 * have those exported for other tools (e.g. an OpenAI dev key in
 * their shell rc) and pointing Talon at a different endpoint would
 * otherwise conflict silently. Set the `TALON_AGENTS_*` aliases or
 * put the values in `~/.talon/config.json`.
 *
 *   - baseURL — redirects the SDK at any OpenAI-compatible service.
 *   - apiMode — "responses" (OpenAI native) or "chat_completions"
 *       (most third parties). When a custom baseURL is set and mode is
 *       unset, defaults to "chat_completions" because most non-OpenAI
 *       endpoints don't implement Responses.
 *
 * With no key resolved Talon emits a startup warning; first turn
 * fails with an auth error.
 *
 * The SDK's `setDefaultOpenAIClient()` is global — all subsequent
 * `new Agent({...})` instances inherit the redirect.
 */

import OpenAI from "openai";
import { setDefaultOpenAIClient, setOpenAIAPI } from "@openai/agents";
import type { TalonConfig } from "../../core/config/index.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";
import { log, logWarn } from "../../util/log.js";
import { nonTerminalFrontends } from "../runtime/frontends.js";
import { getState } from "./state.js";
import { startDiscovery } from "./discovery.js";
import { errorBodyFetch } from "./guards/endpoint-errors.js";

/**
 * Per-request wait for chat turns. The client default is 10 minutes —
 * far too long for an interactive chat bot. 120s comfortably covers the
 * slowest reasonable model turn (including thinking models) without
 * leaving the user staring at "typing…" for hours when the upstream
 * genuinely wedges. Isolated runs use their own, longer budget (see
 * `OPENAI_AGENTS_ONE_SHOT_REQUEST_TIMEOUT_MS`).
 */
const CHAT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Build an `OpenAI` client for the resolved endpoint. Shared by the
 * chat path (installed as the SDK's global default at init) and the
 * isolated one-shot path, which needs the same endpoint but a longer
 * per-request timeout.
 */
export function createOpenAIClient(opts: {
  apiKey: string | undefined;
  baseURL: string | undefined;
  timeoutMs: number;
}): OpenAI {
  return new OpenAI({
    // OpenAI client requires *some* apiKey, even for endpoints that
    // ignore auth (some local Ollama setups). Placeholder if missing.
    apiKey: opts.apiKey ?? "missing-key",
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    // Disable the SDK's built-in 429 retry-after wait. Some
    // free-tier proxies (e.g. opencode.ai's Zen) return
    // `retry-after: 15000+` seconds on quota exhaustion, and the
    // SDK literally sleeps for that long — which manifests as the
    // bot hanging silently for hours. With `maxRetries: 0` the 429
    // surfaces immediately as a RateLimitError that our handler
    // classifies and reports to the user.
    maxRetries: 0,
    // Wait for the response headers (the openai client clears this
    // timer once they arrive; a streamed body is not bounded by it).
    timeout: opts.timeoutMs,
    // Surface a 2xx bare `{"error": …}` body (some local routers answer
    // rejected requests that way, even streamed ones) as the HTTP error
    // it stands for, instead of an empty turn the run loop retries.
    fetch: errorBodyFetch(),
  });
}

/**
 * Initialise the OpenAI Agents backend.
 *
 * Records config + frontend, wires the SDK's default client and API
 * surface based on resolved endpoint/key/mode, then kicks off model
 * discovery in the background. No turns fire here; the actual agent
 * loop runs in `handler.ts`.
 */
export function initOpenAIAgentsAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: FrontendName,
): void {
  const state = getState();
  state.config = cfg;
  if (getGatewayPort) state.gatewayPortFn = getGatewayPort;
  if (frontend) state.frontendName = frontend;

  // Resolve endpoint configuration. Talon-specific env vars only, so
  // an unrelated `OPENAI_API_KEY` (or `OPENAI_BASE_URL`) exported in
  // the operator's shell — common when they also use OpenAI directly
  // for other tools — can't silently override what's in `talon.json`.
  //   key:      TALON_AGENTS_KEY      > config.openaiApiKey
  //   baseURL:  TALON_AGENTS_URL      > config.openaiBaseUrl
  //   apiMode:  TALON_AGENTS_API_MODE > config.openaiApiMode
  const keyEnv = process.env.TALON_AGENTS_KEY
    ? { value: process.env.TALON_AGENTS_KEY, source: "env:TALON_AGENTS_KEY" }
    : cfg.openaiApiKey
      ? { value: cfg.openaiApiKey, source: "config:openaiApiKey" }
      : { value: undefined, source: "none" };
  const apiKey = keyEnv.value;

  const urlEnv = process.env.TALON_AGENTS_URL
    ? { value: process.env.TALON_AGENTS_URL, source: "env:TALON_AGENTS_URL" }
    : cfg.openaiBaseUrl
      ? { value: cfg.openaiBaseUrl, source: "config:openaiBaseUrl" }
      : { value: undefined, source: "default (api.openai.com)" };
  const baseURL = urlEnv.value;

  const envMode = process.env.TALON_AGENTS_API_MODE;
  const resolvedApiMode: "responses" | "chat_completions" =
    envMode === "chat_completions" || envMode === "responses"
      ? envMode
      : (cfg.openaiApiMode ??
        // When a custom baseURL is set, default to chat_completions —
        // most third-party endpoints (OpenRouter, Ollama, LiteLLM, most
        // Azure deployments) only implement Chat Completions. Operators
        // can opt back into Responses explicitly if their proxy
        // supports it.
        (baseURL ? "chat_completions" : "responses"));

  // Apply API-surface toggle. Cheap; safe to call unconditionally so
  // the log line below accurately reflects what subsequent `run()`
  // calls will use.
  setOpenAIAPI(resolvedApiMode);

  // Inject a custom OpenAI client when we have a key, a baseURL, or
  // both. Without either we leave the SDK's default in place (so a
  // bare `OPENAI_API_KEY` set later still works) — the warning below
  // covers the empty case.
  if (apiKey || baseURL) {
    const client = createOpenAIClient({
      apiKey,
      baseURL,
      timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
    });
    setDefaultOpenAIClient(client);

    const urlSourceWithValue = baseURL
      ? `${urlEnv.source} (${baseURL})`
      : urlEnv.source;

    log(
      "agent",
      `OpenAI Agents auth: key=${keyEnv.source} baseURL=${urlSourceWithValue} api=${resolvedApiMode}`,
    );

    if (!apiKey) {
      logWarn(
        "agent",
        "OpenAI Agents: custom baseURL is set but no API key was provided. " +
          "If your endpoint requires auth, first turn will fail. Set " +
          "TALON_AGENTS_KEY or openaiApiKey in talon.json.",
      );
    }
  } else {
    logWarn(
      "agent",
      "OpenAI Agents: no TALON_AGENTS_KEY env and no openaiApiKey in talon.json — " +
        "first turn will fail. Set one of these to enable the backend.",
    );
  }

  // Cache the resolved endpoint on state so discovery can be retried
  // via `triggerDiscoveryRefresh()` without re-reading config.
  const effectiveBaseURL = baseURL ?? "https://api.openai.com/v1";
  state.baseURL = effectiveBaseURL;
  state.apiKey = apiKey;
  state.apiMode = resolvedApiMode;

  // Fire-and-forget: populate the in-memory model catalog from
  // whatever the active endpoint advertises via `GET /models`. The
  // backend is fully provider-agnostic — there's no hardcoded model
  // list — so /status, /settings, and the model picker all read from
  // this map. Runs against the default OpenAI endpoint too; OpenAI's
  // /models response is sparse (no context_length) but at least lets
  // us list discovered ids. Operators can still target any model id
  // their endpoint accepts even if /models doesn't mention it —
  // unknown ids fall through to a bare passthrough.
  //
  // The picker awaits this promise with a short timeout on first
  // render so the user doesn't see "0 models" just because the HTTP
  // call hasn't returned yet — see `discovery.ts#awaitDiscovery`.
  void startDiscovery(effectiveBaseURL, apiKey);
}

/**
 * Get the OpenAI API key Talon should use for the Agents SDK.
 *
 * Priority: `TALON_AGENTS_KEY` env > `openaiApiKey` in Talon config >
 * `undefined`. Talon ignores the generic `OPENAI_API_KEY` env var to
 * avoid silent conflicts with operators who export it for other tools.
 */
export function getOpenAIApiKey(): string | undefined {
  const state = getState();
  return (
    process.env.TALON_AGENTS_KEY ?? state.config?.openaiApiKey ?? undefined
  );
}

/**
 * Get the configured OpenAI-compatible base URL, if any. Returns
 * `undefined` when targeting OpenAI's production API directly.
 *
 * Priority: `TALON_AGENTS_URL` env > `openaiBaseUrl` in Talon config >
 * `undefined`. Talon ignores `OPENAI_BASE_URL` for the same reason it
 * ignores `OPENAI_API_KEY`.
 */
export function getOpenAIBaseUrl(): string | undefined {
  const state = getState();
  return (
    process.env.TALON_AGENTS_URL ?? state.config?.openaiBaseUrl ?? undefined
  );
}

/**
 * Return the list of frontends that need an MCP tool server spawned.
 * `terminal` is excluded — there's no outbound messaging surface for
 * the terminal frontend.
 */
export function getActiveFrontends(): readonly string[] {
  return nonTerminalFrontends(getState().config?.frontend);
}
