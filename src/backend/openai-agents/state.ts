/**
 * Per-process state for the OpenAI Agents backend.
 *
 * The Agents SDK is stateless from Talon's perspective — there's no
 * long-running server. The state we own here is the saved config +
 * gateway-port resolver + frontend label captured at init time, plus
 * the endpoint-model catalog populated by discovery (`discovery.ts`)
 * so the resolver, picker, and UIs can read it synchronously.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";
import { TalonSession } from "./session.js";
import type { ReasoningEffortLevel } from "../../core/types.js";

/**
 * Capabilities advertised by the remote endpoint for one model id.
 * Populated lazily by `startDiscovery()` after `init.ts` kicks off
 * `GET /models`, then consulted by the passthrough-model code path in
 * `models.ts`. An empty `EndpointModelCapabilities` ({}) means "the
 * endpoint mentioned this id but advertised no metadata" — callers
 * should treat that as a known passthrough.
 */
export interface EndpointModelCapabilities {
  contextWindow?: number;
  displayName?: string;
  /** Whether the model is free (e.g. OpenRouter `pricing.prompt === "0"`). */
  free?: boolean;
  /** Reasoning/effort levels explicitly advertised by the endpoint. */
  supportedReasoningLevels?: ReasoningEffortLevel[];
  /** Endpoint-advertised default reasoning level, when available. */
  defaultReasoningLevel?: ReasoningEffortLevel;
}

/** Singleton state container for the backend. */
export interface OpenAIAgentsState {
  config: TalonConfig | null;
  gatewayPortFn: () => number;
  frontendName: FrontendName;
  /** Resolved endpoint baseURL the SDK is currently aimed at (or undefined for the OpenAI default). */
  baseURL: string | undefined;
  /** Resolved API key the SDK is currently using (or undefined for unauthenticated). */
  apiKey: string | undefined;
  /**
   * Resolved API surface the default client speaks. Recorded at init so
   * an isolated run can build its own client + provider on the same
   * endpoint (see `one-shot.ts`).
   */
  apiMode: "responses" | "chat_completions";
  /**
   * Endpoint-advertised model metadata, keyed by model id. Populated
   * asynchronously after `init()` so /status, /settings, and the model
   * picker can show real context windows for OpenRouter / Ollama /
   * LiteLLM / vLLM / any other OpenAI-compatible endpoint that
   * implements `GET /models`.
   */
  endpointModels: Map<string, EndpointModelCapabilities>;
  /**
   * In-flight discovery promise, if any. The picker awaits this with
   * a short timeout on first render after a backend switch so the
   * catalog isn't empty just because the HTTP fetch hasn't returned.
   * Cleared once the fetch settles (success or failure).
   */
  discoveryPromise: Promise<void> | null;
  /** Wall-clock time (`Date.now()`) when discovery last succeeded, or `null`. */
  discoveryAt: number | null;
  /**
   * Per-chat conversation memory. The Agents SDK manages the full
   * turn history (model outputs, tool calls, tool results, reasoning)
   * when we pass a `TalonSession` into `run()`, so we just hand it
   * the same instance every turn for the same chat. `/reset` calls
   * `clearSession()` on the entry; chat eviction is bounded by the
   * map cap so long-lived bots don't leak memory.
   */
  sessions: Map<string, TalonSession>;
}

const state: OpenAIAgentsState = {
  config: null,
  gatewayPortFn: () => 19876,
  frontendName: "telegram",
  baseURL: undefined,
  apiKey: undefined,
  apiMode: "responses",
  endpointModels: new Map(),
  discoveryPromise: null,
  discoveryAt: null,
  sessions: new Map(),
};

const MAX_SESSIONS = 1000;

/**
 * Get or lazily create the `TalonSession` for a chat. Sessions
 * persist for the lifetime of the bot process; the LRU-style cap
 * keeps memory bounded if a long-running bot accumulates many chats.
 */
export function getOrCreateSession(chatId: string): TalonSession {
  const existing = state.sessions.get(chatId);
  if (existing) {
    // Refresh insertion-order so cap eviction is least-recently-used.
    state.sessions.delete(chatId);
    state.sessions.set(chatId, existing);
    return existing;
  }
  if (state.sessions.size >= MAX_SESSIONS) {
    const oldest = state.sessions.keys().next().value;
    if (oldest !== undefined) state.sessions.delete(oldest);
  }
  const session = new TalonSession({ sessionId: chatId });
  state.sessions.set(chatId, session);
  return session;
}

/**
 * Drop a chat's conversation memory. Called from the dispatcher's
 * reset path so `/reset` produces a clean turn-zero session.
 */
export function clearChatSession(chatId: string): void {
  state.sessions.delete(chatId);
}

/** Test-only accessor for the shared state object. */
export function getState(): OpenAIAgentsState {
  return state;
}

/** Reset all state — test isolation helper. */
export function resetState(): void {
  state.config = null;
  state.gatewayPortFn = () => 19876;
  state.frontendName = "telegram";
  state.baseURL = undefined;
  state.apiKey = undefined;
  state.apiMode = "responses";
  state.endpointModels.clear();
  state.discoveryPromise = null;
  state.discoveryAt = null;
  state.sessions.clear();
}
