/**
 * Core interfaces — the contract between modules.
 * Every module depends on these abstractions, never on concrete implementations.
 *
 * Dependency rule: core/ imports nothing from frontend/ or backend/.
 * frontend/ and backend/ depend on core/types, never on each other.
 */

// ── Model abstraction ──────────────────────────────────────────────────────

/** Unified model info returned by any backend. */
export type UnifiedModelInfo = {
  id: string;
  displayName: string;
  provider: string;
  providerName: string;
  selectable: boolean;
  free?: boolean;
  contextWindow?: number;
  reasoning?: boolean;
  /**
   * Reasoning/effort levels this model accepts. Omitted or empty means
   * the backend has not registered a valid effort surface for this model.
   */
  supportedReasoningLevels?: ReasoningEffortLevel[];
  /** Backend-reported default reasoning level, when available. */
  defaultReasoningLevel?: ReasoningEffortLevel;
  /** Why the model can't be selected (login required, env setup, etc.) */
  unavailableReason?: string;
};

export type { ReasoningEffortLevel } from "../types/effort.js";
import type { ReasoningEffortLevel } from "../types/effort.js";

/** Result of resolving a user's model query. */
export type UnifiedModelResolution =
  | { kind: "exact"; model: UnifiedModelInfo; storedValue: string }
  | { kind: "ambiguous"; matches: UnifiedModelInfo[] }
  | { kind: "missing" };

/** A provider with its available models. */
export type UnifiedProviderInfo = {
  id: string;
  name: string;
  connected: boolean;
  modelCount: number;
};

/** Keyboard button for model/settings UIs. */
export type ModelButton = { text: string; callback_data: string };

/**
 * Options for `getSettingsPresentation()`. The picker has two
 * navigational axes — *provider* (when a catalog is large enough to
 * benefit from grouping) and *page within a provider*. Backends with
 * small catalogs may ignore everything except `callbackPrefix`.
 */
export interface ModelPickerOptions {
  /** Callback-data prefix used on each model button. Defaults to `settings:model:`. */
  callbackPrefix?: string;
  /**
   * Callback-data prefix used for navigation buttons (provider drill,
   * pagination, filter toggles). Defaults to `settings:models`. Must
   * match the prefix the frontend's callback router decodes — for
   * example `/model` uses `model:nav` so its router recognises
   * `model:nav:provider:openai` as a drill action.
   */
  navCallbackPrefix?: string;
  /** 1-indexed page within the current provider/filter. Defaults to 1. */
  page?: number;
  /** Buttons per page. Backends may clamp to a sensible range. */
  pageSize?: number;
  /** Filter the catalog before grouping/paginating. `free` keeps only free-tier models. */
  filter?: "all" | "free";
  /**
   * When set, render that provider's models directly. When omitted
   * and the filtered catalog is "large" (backend-defined threshold),
   * the backend returns provider chips instead of model buttons —
   * the frontend drills in by sending this option back.
   */
  provider?: string;
}

/**
 * Result returned by `getSettingsPresentation()`. `view` tells the
 * frontend whether `modelButtons` is a list of providers ("groups")
 * or a list of models ("models"). The frontend reads `page` /
 * `totalPages` / `freeCount` / `provider` to render the appropriate
 * navigation controls.
 */
export interface ModelPickerResult {
  /** Buttons to render. Interpretation depends on `view`. Empty for `menu`. */
  modelButtons: ModelButton[];
  /** Optional supplementary text (backend status, etc.). Plain text. */
  modelDetails: string[];
  /**
   * Which axis the buttons represent:
   *   - `groups`: provider chips (drill by tapping).
   *   - `models`: the model list (paginated).
   */
  view: "groups" | "models";
  /** Current 1-indexed page (always 1 for `groups`). */
  page: number;
  /** Total pages in the current view. */
  totalPages: number;
  /** The filter actually applied (normalised). */
  filter: "all" | "free";
  /** Total free-flagged models in the (unfiltered) catalog. */
  freeCount: number;
  /** Total models in the (unfiltered) catalog. */
  totalCount: number;
  /** When `view === "models"`, the provider the buttons belong to (if any). */
  provider?: string;
}

/**
 * Parameters for one-shot agent runs (heartbeat, dream).
 *
 * Unlike `query()` which is tied to a chat session and history, this is a
 * fire-and-forget agent invocation: spawn an agent with a prompt, let it run
 * tools, log everything to a file, return when it finishes (or when aborted).
 */
/**
 * Token usage a one-shot run reports at settlement, when the backend's SDK
 * surfaces it. Shape-compatible with the task table's `TaskUsage`, so the
 * background callers can hand it straight to `TaskHandle.succeed`.
 */
export type OneShotUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
};

export type OneShotAgentParams = {
  /** The user prompt the agent should execute. */
  prompt: string;
  /** Additional system prompt prepended to the backend's defaults. */
  systemPrompt: string;
  /** Working directory for the agent (cwd for tool execution). */
  workspace: string;
  /** Model id (interpretation is backend-specific). */
  model: string;
  /**
   * Reasoning effort for the run (config `heartbeatEffort` / `dreamEffort`).
   * Undefined = let the backend/model pick its own default, which is what
   * every background run did before the knob existed.
   *
   * Honoured by the backends that expose a reasoning knob (Claude SDK
   * thinking/effort, Codex `modelReasoningEffort`); ignored by the ones
   * that don't (Kilo, OpenCode).
   */
  reasoningEffort?: ReasoningEffortLevel;
  /**
   * Sentinel chat ID for outbound MCP tool calls (e.g. "heartbeat", "dream").
   * Frontend MCP servers use this to enforce explicit `chat_id` on outbound
   * tools when there's no ambient chat.
   */
  contextLabel: string;
  /** Aborts the agent run mid-flight (signal will be delivered to subprocesses). */
  abortController: AbortController;
  /** Append a string to the run log (markdown). */
  appendLog: (text: string) => Promise<void>;
  /**
   * Called with each assistant text segment as the run produces it (final
   * answers, not reasoning/thinking, not tool-call payloads). Optional so
   * heartbeat/dream/cron callers are untouched; a sub-agent runner uses it to
   * capture the run's result without parsing the markdown log.
   *
   * Synchronous and best-effort: every backend invokes it through
   * `emitAssistantText` (backend/runtime/one-shot-hooks.ts), which swallows
   * and logs a throwing callback so a consumer bug can never fail the run.
   */
  onAssistantText?: (text: string) => void;
  /**
   * Resume this backend conversation instead of starting a fresh one — the
   * handle an earlier run reported through `onSessionId`. Honoured only by
   * backends whose `BackgroundRunner.supportsResume` is true (Claude SDK:
   * session id; Codex: thread id); the others ignore it and start fresh,
   * which is why the sub-agent runner checks that flag before relying on it.
   */
  resumeSessionId?: string;
  /**
   * Called once the backend knows the run's conversation handle (Claude SDK
   * session id, Codex thread id) — a sub-agent persists it so a daemon
   * restart can resume the conversation. Best-effort and synchronous, like
   * `onAssistantText`: a throwing callback must never fail the run.
   */
  onSessionId?: (sessionId: string) => void;
};

/** How much cache telemetry a backend can surface in /status. */
export type CacheMetricsSupport = "none" | "read" | "readwrite";

// ── Execution context ───────────────────────────────────────────────────────

/**
 * Manages the tool-execution context for the active chat.
 * The frontend provides an implementation so the AI's tool calls
 * can reach the messaging platform.
 */
export interface ContextManager {
  acquire(chatId: number, stringId?: string, frontendName?: string): void;
  release(chatId: number, stringId?: string): void;
  getMessageCount(chatId: number, stringId?: string): number;
}

/**
 * Event-native streaming sink. The frontend supplies one `onEvent`
 * consumer and the dispatcher forwards the backend's canonical
 * `AgentEvent` stream into it verbatim — no callback bridge, no
 * back-translation. Frontends switch on `event.type` and drive their
 * own delivery UX (Telegram draft edits, Discord/Teams messages,
 * terminal print).
 *
 * Ordering + back-pressure: the dispatcher `await`s each `onEvent`
 * call in stream order, so a consumer that needs serial delivery
 * (e.g. Telegram's typing-indicator + send ordering for
 * `assistant_message` blocks) gets it by awaiting inside `onEvent`.
 * A consumer that wants fire-and-forget throttling (e.g. draft edits
 * on `text_delta`) simply returns without awaiting its own work.
 *
 * Delivery acknowledgement: the dispatcher (not the consumer) owns
 * `assistant_message.deliveryAck` settlement — it resolves the ack
 * when `onEvent` returns and rejects it when `onEvent` throws. So a
 * consumer signals a failed `assistant_message` delivery by *throwing*
 * (which lets callback-shaped backends retry, notably Codex
 * oversized-message), and a successful one by returning. This keeps
 * the ack settled even when no `onEvent` is supplied at all.
 */
type StreamEventSink = {
  onEvent?: (
    event: import("./agent-runtime/events.js").AgentEvent,
  ) => void | Promise<void>;
};

/** Parameters for the dispatcher. */
export type ExecuteParams = {
  chatId: string;
  numericChatId: number;
  prompt: string;
  senderName: string;
  /** Sender's platform handle without `@` (Telegram username, Discord username). */
  senderHandle?: string;
  /**
   * Every key the ONE person behind this turn is known by, in operator-id
   * form (Telegram user id, `wa_dm_<number>`, `discord:<id>`,
   * `teams:<id>`, or `LOCAL_OPERATOR_SENDER`). Decides the turn's tool
   * scope (core/mcp-hub/guest-scope.ts). Omit when the sender is unknown
   * or the turn batches several senders — the turn is then guest-scoped.
   */
  senderKeys?: readonly string[];
  /**
   * Frontend-attested: the operator is a member of this group chat. With
   * `guestDmScope.operatorGroups` on, such a turn keeps the full surface.
   */
  operatorInChat?: boolean;
  isGroup: boolean;
  /** Provider message ID. Numeric for Telegram, string snowflake for Discord. */
  messageId?: number | string;
  source: "message" | "pulse" | "cron" | "trigger" | "agent";
  /**
   * Optional per-run model override (a model id valid on the chat's backend).
   * When set and resolvable, the turn runs on this model instead of the chat's
   * resolved model — used by triggers/cron to run a cheaper model while still
   * resuming the chat session. Restricted to the chat's own backend so session
   * continuity is preserved. If it can't be resolved at fire time (e.g. the
   * catalog changed), the dispatcher falls back to the chat model rather than
   * failing the run.
   */
  modelOverride?: string;
} & StreamEventSink;

/** What the dispatcher returns after execution. */
export type ExecuteResult = {
  text: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  bridgeMessageCount: number;
};

// ── Gateway types ───────────────────────────────────────────────────────────

/** Result from an action handler. */
export type ActionResult = {
  ok: boolean;
  text?: string;
  error?: string;
  /**
   * Provider message ID. Telegram uses numeric IDs; Discord (and other
   * snowflake-based platforms) emit string IDs. The dispatcher treats it
   * opaquely — it's surfaced back to the LLM as-is for use in subsequent
   * tool calls (react/edit/delete) that target this message.
   */
  message_id?: number | string;
  /**
   * The canonical Talon chat id the action actually addressed. Set when
   * a frontend resolved an explicit `target` (a phone number, a JID) to
   * one of its chats, so the caller learns where its message landed —
   * the cross-chat relay needs it to subscribe to the replies.
   */
  chat_id?: string;
  /**
   * Set by tools that return a viewable image (e.g. `read` on a photo). The
   * MCP layer turns this into an image content block so the model sees the
   * picture instead of base64 text.
   */
  image?: { data: string; mimeType: string };
  [key: string]: unknown;
};

/** Frontend-specific action handler. Return null if action not recognized. */
export type FrontendActionHandler = (
  body: Record<string, unknown>,
  chatId: number,
) => Promise<ActionResult | null>;
