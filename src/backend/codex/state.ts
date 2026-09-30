/**
 * Per-process state for the Codex backend.
 *
 * Unlike Kilo/OpenCode (one long-running HTTP server), Codex creates a
 * fresh subprocess on each `thread.run()` call via the SDK. The
 * per-process state Talon owns is therefore narrow: the long-lived
 * `Codex` instance (configured with API key + MCP server config), the
 * config / frontend / gateway-port bindings, and the dynamic model
 * discovery cache.
 */

import type { Codex } from "@openai/codex-sdk";
import type { ReasoningEffortLevel } from "../../core/types.js";
import type { TalonConfig } from "../../core/config/index.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";

/**
 * Optional metadata captured during discovery. The OAuth path
 * (`loadCodexCacheModels`) yields rich entries (display name, context
 * window, description); the api-key path (`/v1/models`) is sparse and
 * leaves these fields undefined.
 */
interface DiscoveredModelMetadata {
  displayName?: string;
  contextWindow?: number;
  description?: string;
  defaultReasoningLevel?: ReasoningEffortLevel;
  supportedReasoningLevels?: ReasoningEffortLevel[];
}

/** Singleton state container for the Codex backend. */
export interface CodexState {
  config: TalonConfig | null;
  codex: Codex | null;
  gatewayPortFn: () => number;
  frontendName: FrontendName;
  /**
   * Set of model ids advertised for the current credential. Sourced
   * from `~/.codex/models_cache.json` on OAuth sessions or OpenAI's
   * `/v1/models` on api-key sessions. Empty when no auth is configured
   * or discovery hasn't yet succeeded. Mutated only by `discovery.ts`.
   */
  discoveredModels: Set<string>;
  /**
   * Optional rich metadata for discovered models, keyed by id. Only
   * populated by the OAuth cache-file path; the api-key /v1/models
   * path leaves this map empty. Consumed by `getEffectiveModels()`
   * when synthesising entries for ids absent from the curated table.
   */
  discoveredModelMetadata: Map<string, DiscoveredModelMetadata>;
  /**
   * The Codex CLI's own default model for the signed-in ChatGPT account:
   * the listed, API-callable entry of `~/.codex/models_cache.json` with
   * the lowest `priority` (the CLI sorts its picker the same way and
   * treats the first entry as the default). `null` until the cache has
   * been read, or when it lists nothing usable. Consumed by
   * `getCodexChatGptDefaultModel()`.
   */
  discoveredDefaultModel: string | null;
  /**
   * In-flight discovery promise. Non-null while a fetch is pending;
   * cleared once the fetch settles (success or failure). Callers that
   * need a populated catalog `await awaitDiscovery()` against this.
   */
  discoveryPromise: Promise<void> | null;
  /**
   * Timestamp of the last discovery attempt (success OR failure).
   * Used to distinguish "still loading" from "finished, found nothing"
   * — the latter lets the picker fall back to curated immediately
   * instead of soft-waiting for a promise that already settled.
   */
  discoveryAt: number | null;
}

const state: CodexState = {
  config: null,
  codex: null,
  gatewayPortFn: () => 19876,
  frontendName: "telegram",
  discoveredModels: new Set<string>(),
  discoveredModelMetadata: new Map<string, DiscoveredModelMetadata>(),
  discoveredDefaultModel: null,
  discoveryPromise: null,
  discoveryAt: null,
};

/** Test-only accessor for the shared state object. */
export function getState(): CodexState {
  return state;
}

/** Reset all state — test isolation helper. */
export function resetState(): void {
  state.config = null;
  state.codex = null;
  state.gatewayPortFn = () => 19876;
  state.frontendName = "telegram";
  state.discoveredModels.clear();
  state.discoveredModelMetadata.clear();
  state.discoveredDefaultModel = null;
  state.discoveryPromise = null;
  state.discoveryAt = null;
}
