/**
 * Canonical agent event stream — single source of truth for what
 * happens during one backend run.
 *
 * Every backend (Claude SDK, Codex, Kilo, OpenCode, OpenAI Agents)
 * translates its SDK's native event stream into `AgentEvent`s. Core
 * renderers (Telegram dispatch, terminal output, heartbeat log,
 * dream log, `/status`, tests) consume `AgentEvent`s. Backends don't
 * render markdown logs themselves and core never parses
 * backend-specific output.
 *
 * The shared wrapper `backend/runtime/turn/handler-to-events.ts` converts
 * each backend's callback-driven `handleMessage` into the
 * canonical sequence: `run_started → text_delta* →
 * assistant_message* → tool_call* → usage → completed`. Backends
 * with richer SDKs can emit events directly without the wrapper.
 *
 * Design notes
 * ────────────
 *
 *   - Events are **structurally typed** — no class hierarchy, no
 *     `instanceof` checks. A switch on `event.type` is the entire
 *     dispatch surface.
 *
 *   - Events are **append-only and history-free** — consumers
 *     accumulate the parts they care about (assistant text, tool
 *     results, usage) themselves. The stream re-emits enough state
 *     in `completed` that late subscribers can recover the final
 *     answer without replaying.
 *
 *   - Events are **transport-neutral** — `tool_call.input` is
 *     `unknown` and `tool_result.result` is `unknown` rather than
 *     locked to JSON. Each tool's schema lives with the tool.
 *
 *   - Do NOT mirror one SDK's event names. `text_delta` /
 *     `assistant_message` / `reasoning` / `tool_call` / `tool_result`
 *     are the union of what every supported backend produces; no
 *     adapter should leak its native names through.
 */

import type { ReasoningEffortLevel } from "../types.js";
import type { TalonError } from "../errors.js";

/**
 * Token + cache counters for one backend run.
 *
 * `cacheRead` and `cacheWrite` are zero when the backend doesn't
 * support prompt caching (mapped from `Backend.cacheMetrics: "none"`).
 * Tests should assert exact zero, not absence — `JSON.stringify`
 * round-trips drop `undefined` keys.
 */
export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * Resolved model id this turn ran against. Useful when a backend
   * swapped models mid-run (Codex API-key fallback, Anthropic
   * overload retry) — the final usage block should report what
   * actually ran, not what was originally requested.
   */
  modelId?: string;
}

/**
 * Final result of a backend run — text + duration + usage + the
 * runtime model id so downstream consumers can render "Reply via
 * gpt-5-codex (1.2s)" without re-asking the resolver.
 */
export interface AgentResult {
  /** Full assistant text (concatenated from any deltas / blocks). */
  text: string;
  durationMs: number;
  usage: UsageSnapshot;
  modelId?: string;
}

/**
 * Structured error classification. Mirrors the categories
 * `core/errors.ts` already produces — keep the values stable so
 * downstream code can pattern-match deterministically.
 */
type AgentErrorKind =
  | "context_overflow"
  | "rate_limit"
  | "overload"
  | "session_expired"
  | "auth"
  | "model_unsupported"
  | "tool_failure"
  | "subprocess_exit"
  | "timeout"
  | "aborted"
  | "unknown";

export interface AgentError {
  kind: AgentErrorKind;
  message: string;
  /** Whether the dispatcher should retry the same run. */
  retryable: boolean;
  /** Raw SDK error string when one exists — useful for forensic logs. */
  raw?: string;
}

/**
 * The canonical event union. Type-narrowed via `event.type` in a
 * switch — no other discrimination mechanism should be added.
 */
export type AgentEvent =
  | { type: "run_started"; runId?: string; sessionId?: string }
  | { type: "text_delta"; text: string }
  | {
      type: "assistant_message";
      text: string;
      /**
       * Optional delivery acknowledgement for callback-shaped backend
       * adapters. When present, the event bridge resolves it after the
       * frontend's async `onTextBlock` callback succeeds, or rejects it
       * when delivery fails. That preserves the old `await onTextBlock`
       * semantics for backends whose retry logic depends on delivery
       * failures (notably Codex oversized-message retries).
       */
      deliveryAck?: {
        resolve(): void;
        reject(error: unknown): void;
      };
    }
  | {
      type: "reasoning";
      text: string;
      signature?: string;
      effort?: ReasoningEffortLevel;
    }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      result?: unknown;
      error?: string;
    }
  | { type: "usage"; usage: UsageSnapshot }
  | { type: "model_swapped"; from: string; to: string; reason: string }
  | { type: "warning"; message: string }
  | { type: "error"; error: AgentError }
  | { type: "completed"; result?: AgentResult };

/**
 * Error thrown when an `AgentEvent` stream terminates with an `error`
 * event. The dispatcher consumes the canonical event stream directly
 * (no callback bridge) and rethrows the `error` terminator as this so
 * callers' `try/catch` paths keep working — it carries the canonical
 * `AgentError` so downstream code can read `kind` / `retryable`
 * without re-classifying.
 */
export class AgentRunError extends Error {
  readonly kind: AgentError["kind"];
  readonly retryable: boolean;
  readonly raw?: string;

  constructor(error: AgentError) {
    super(error.message);
    this.name = "AgentRunError";
    this.kind = error.kind;
    this.retryable = error.retryable;
    this.raw = error.raw;
  }
}

/**
 * Coerce a `tool_call.input` (typed `unknown` — backends may emit
 * arrays or primitives) into the `Record<string, unknown>` shape that
 * frontend tool-echo renderers expect. Non-plain-objects collapse to
 * `{}` with a warning so operators can diagnose a tool that receives
 * empty args when it shouldn't. Event-native consumers that can render
 * the real shape may read `event.input` directly instead.
 */
export function toolInputToRecord(
  name: string,
  input: unknown,
): Record<string, unknown> {
  if (isPlainObject(input)) return input;
  if (input !== undefined && input !== null) {
    const typeLabel = Array.isArray(input) ? "array" : typeof input;
    console.warn(
      `[agent-event] tool_call "${name}": input is ${typeLabel}, ` +
        `not a plain object — coercing to {} for the legacy Record<string, unknown> tool-echo shape.`,
    );
  }
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Zero usage. Use as the seed for accumulation, or as the value when
 * a backend reports nothing.
 */
export function emptyUsage(): UsageSnapshot {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

/**
 * The `core/errors.ts` reasons that map to a specific `AgentErrorKind`.
 * Anything not listed collapses to `unknown`. `ErrorReason` is
 * HTTP/transport-oriented (`network`, `bad_request`, `forbidden`) and
 * `AgentErrorKind` is agent-run-oriented (`aborted`, `timeout`,
 * `tool_failure`), so the two only partially overlap — adding a row
 * here is the whole cost of teaching the boundary a new mapping.
 */
const REASON_TO_KIND: Partial<Record<TalonError["reason"], AgentErrorKind>> = {
  rate_limit: "rate_limit",
  // Subscription usage limits share the rate_limit kind — same family for
  // event consumers; `retryable: false` (carried through) is what
  // distinguishes them from a transient 429.
  usage_limit: "rate_limit",
  overloaded: "overload",
  context_length: "context_overflow",
  session_expired: "session_expired",
  auth: "auth",
};

/**
 * Map a classified `TalonError` (from `core/errors.ts:classify`) onto
 * the canonical `AgentError` every backend emits on its error path.
 * `retryable` is ALWAYS carried through, because that — not `kind` — is
 * what the dispatcher's retry path and the frontends' error handlers
 * switch on.
 *
 * This is the single error→`AgentError` boundary: both the native
 * Claude SDK handler and the callback wrapper (`handler-to-events.ts`)
 * route through it, so every backend classifies identically instead of
 * each re-implementing a message-substring guess.
 */
export function classifiedToAgentError(classified: TalonError): AgentError {
  return {
    kind: REASON_TO_KIND[classified.reason] ?? "unknown",
    message: classified.message,
    retryable: classified.retryable,
    raw: classified.stack,
  };
}
