/**
 * Backend capability interfaces.
 *
 * Every backend factory builds and returns a `Backend` — a composed
 * object whose capability slots cover the orthogonal pieces a
 * production frontend / dispatcher needs:
 *
 *   - `chat`        — chat-turn surface (`runChatTurn`)
 *   - `background`  — heartbeat / dream / trigger background tasks
 *   - `models`      — catalog (resolve / list / picker / providers)
 *   - `sessions`    — reset / warm
 *   - `tools`       — hot MCP refresh
 *   - `usage`       — `/status` enrichment
 *   - `control`     — system-prompt update
 *
 * Consumers read through slots — `backend.chat?.runChatTurn(...)`,
 * `backend.models?.resolveModelInfo(...)`. Capability presence IS the
 * slot: an absent (`undefined`) slot means the backend doesn't
 * support that capability. There is no separate flag record to keep
 * in sync — the slots are the single source of truth.
 */

import type { AgentEvent } from "./events.js";
import type { ModelRef, BackendId } from "./model-ref.js";
import type {
  CacheMetricsSupport,
  ModelPickerOptions,
  ModelPickerResult,
  OneShotAgentParams,
  OneShotUsage,
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
} from "../types.js";

// ── Run parameters ──────────────────────────────────────────────────────────

/**
 * Parameters for a chat turn. `model` is a resolved `ModelRef`,
 * carrying everything the backend needs to identify the model and
 * render the resulting reply. Streaming callbacks aren't part of
 * this shape — backends emit `AgentEvent`s.
 *
 * Long-term memory is deliberately NOT part of this shape. `memory.md` is
 * loaded once into the cached system prompt (`core/prompt/assemble.ts`);
 * anything deeper the model searches for itself with the MemPalace tools.
 * Nothing is auto-injected into a turn.
 */
export interface ChatRunParams {
  chatId: string;
  model: ModelRef;
  text: string;
  senderName: string;
  /** Sender's platform handle without `@` (Telegram username, Discord username). */
  senderHandle?: string;
  isGroup?: boolean;
  /** Provider message ID. Telegram is numeric; Discord snowflakes are strings. */
  messageId?: number | string;
  /**
   * Memory retrieved for this turn by `core/memory/turn-retrieval.ts`,
   * already ranked, trust-filtered and budgeted. The Weaver resolves it
   * before the call; a backend's only job is to hand it to
   * `formatUserPrompt`, which owns the rendering.
   *
   * Turn-scoped and user-turn-only: it must never reach
   * `prepareSystemPrompt()` or a backend `system` field, or the
   * per-session frozen prompt stops being frozen (plan §3.6).
   */
  retrievedMemory?: string;
}

// ── Catalog types ───────────────────────────────────────────────────────────

// ── Capability interfaces ───────────────────────────────────────────────────

/**
 * The chat-turn surface. `runChatTurn` returns an
 * `AsyncIterable<AgentEvent>` carrying per-token deltas, tool
 * events, usage, and the terminator. Consumers iterate the stream
 * directly — the dispatcher forwards each event to the frontend's
 * `onEvent` sink, and frontends switch on `event.type` to drive
 * their delivery UX.
 */
export interface ChatBackend {
  runChatTurn(params: ChatRunParams): AsyncIterable<AgentEvent>;
  /**
   * Best-effort interrupt of the chat's in-flight turn, if one is running.
   * Optional: backends that can't gracefully stop a running turn simply omit
   * it (the frontend then hides the stop affordance). Resolves `true` when a
   * running turn was found and signalled, `false` otherwise. Implementations
   * must stop the turn *cleanly* — the stream should terminate as a normal
   * completion, not surface as an error or trigger a model-fallback retry.
   */
  interruptChatTurn?(chatId: string): Promise<boolean>;
}

/**
 * The background-task surface. Heartbeat / dream / trigger wake-ups
 * invoke this. Same event protocol as `ChatBackend`.
 *
 *   - `runOneShotAgent(params)` — accepts `OneShotAgentParams`
 *     (with its `appendLog` callback) so the heartbeat / dream /
 *     trigger log-file producers keep their direct write path.
 *     Resolves with the run's token usage when the SDK reports it
 *     (the task table records it at settlement); void otherwise.
 *     Implementations must also honour the optional `onAssistantText`
 *     hook — the run's final answers as data, for callers (the
 *     sub-agent runner) that need a result rather than a markdown log.
 *   - `evictOrphanSubprocesses(label)` — backends that spawn
 *     per-run subprocesses (Claude SDK) implement this so a hung
 *     run can be force-cleaned after the abort grace window.
 */
export interface BackgroundRunner {
  runOneShotAgent(params: OneShotAgentParams): Promise<OneShotUsage | void>;
  /**
   * Whether `runOneShotAgent` honours `resumeSessionId` (and reports the
   * handle through `onSessionId`). A sub-agent interrupted by a daemon
   * restart resumes its conversation on such a backend; on any other it is
   * re-briefed with its previous transcript instead.
   */
  readonly supportsResume?: boolean;
  evictOrphanSubprocesses?(contextLabel: string): Promise<{
    found: number;
    termed: number;
    killed: number;
  }>;
}

/**
 * Catalog operations, split into a small REQUIRED core (resolution:
 * `resolveModelInfo` / `getDefaultModelId` / `getRawModelInfo`, which
 * the dispatcher and `core/models/active-model.ts` depend on) and an OPTIONAL
 * picker / catalog-browse surface. A fixed-model backend (Claude SDK
 * on a model alias) can implement only the core and let the `/model`
 * picker degrade gracefully; catalog-driven backends (Kilo, OpenCode,
 * OpenAI Agents on OpenRouter) implement the full surface.
 *
 * The catalog speaks `UnifiedModelInfo` — the rich shape every
 * backend's `models.ts` produces internally. `ModelRef` is only
 * the resolver's output, an enriched routing identity.
 * `core/models/active-model.ts` wraps catalog calls into refs for
 * `/status` and `/model` display.
 */
export interface ModelCatalog {
  // ── Required core: resolution ───────────────────────────────────
  /**
   * Backend-native resolve. Used by `core/models/active-model.ts` for the
   * per-chat override validation and by the frontend's
   * resolution-error formatter.
   */
  resolveModelInfo(query: string): Promise<UnifiedModelResolution>;
  /**
   * Canonical default returning the raw model id (or `null` /
   * `undefined` for catalog-driven backends with no canonical).
   */
  getDefaultModelId():
    Promise<string | null | undefined> | string | null | undefined;
  /** Backend-native model lookup by id. */
  getRawModelInfo(id: string): Promise<UnifiedModelInfo | undefined>;

  // ── Optional picker / catalog-browse surface ────────────────────
  // A fixed-model backend (no real catalog) omits these; the `/model`
  // and `/settings` frontends degrade gracefully — no quick-pick, no
  // provider browse — when a method is absent.
  /** Quick-pick presentation for `/model` and `/settings`. */
  getSettingsPresentation?(
    activeModel: string,
    options?: ModelPickerOptions,
  ): Promise<ModelPickerResult>;
  /** List of providers exposed by the backend's catalog. */
  getProviders?(): Promise<UnifiedProviderInfo[]>;
  /** Paginated model list scoped to one provider. `page` is 1-based. */
  getProviderModels?(
    providerId: string,
    page?: number,
    pageSize?: number,
  ): Promise<{ models: UnifiedModelInfo[]; total: number }>;
  /** Format an error for an unresolvable / unavailable model. */
  formatModelError?(query: string, resolution: UnifiedModelResolution): string;
  /** Free-tier-or-all model list. */
  listModels?(filter?: "free" | "all"): Promise<{
    models: UnifiedModelInfo[];
    total: number;
  }>;
}

/**
 * Session lifecycle. Both methods optional:
 *
 *   - `resetChat` — drop any in-process conversation memory the
 *     backend holds for a chat. Required only for backends that
 *     keep their own session abstraction in memory (OpenAI Agents
 *     `MemorySession`); stateless backends omit it.
 *   - `warmSession` — cold-start optimisation hint.
 *
 * The dispatcher / `/reset` flow always also calls
 * `storage/sessions.ts:resetSession(chatId)` so the chat's stored
 * session id is cleared regardless of which slot variant the backend
 * provides.
 */
export interface SessionBackend {
  resetChat?(chatId: string): void | Promise<void>;
  warmSession?(chatId: string): Promise<void>;
}

/**
 * Hot-reloadable tool surface. Used when a plugin is added or
 * removed at runtime — the backend re-derives its MCP config from
 * the live registry. Returns the diff so the dispatcher can log
 * what changed.
 */
interface ToolRefreshResult {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
}

export interface ToolRuntime {
  refreshTools(chatId: string): Promise<ToolRefreshResult | null>;
}

/**
 * `/status` enrichment. Both members are optional — a backend
 * implements whichever it can answer. Backends that track per-session
 * usage (Codex, OpenAI Agents) supply `getSessionSnapshot`; a backend
 * with no per-session model (Claude SDK on a fresh subprocess per
 * turn) omits it and may still report plan limits.
 *
 * The snapshot's `contextModelId` carries the resolved-this-turn
 * model id when the SDK can surface it. Frontend `/status` reads
 * it to disambiguate the displayed model from the configured one
 * (e.g. when Codex falls back from `gpt-5-codex` to `gpt-5.5` on
 * ChatGPT-OAuth).
 */
export interface UsageTelemetry {
  getSessionSnapshot?(sessionId: string): Promise<
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
        contextModelId?: string;
      }
    | undefined
  >;
  /**
   * Subscription rate-limit windows. Account-level rather than
   * per-chat: `/status` renders whichever backend can answer, even
   * when another one is serving the chat. Absent on backends with no
   * plan concept; resolves `undefined` when the data can't be read.
   */
  getPlanUsage?(): Promise<PlanUsage | undefined>;
  /**
   * Banked one-shot limit resets, where the plan has them. Spending one is
   * irreversible, so this is reachable only from a human-pressed confirm
   * button — never exposed as an agent tool.
   */
  bankedResets?: BankedResetControl;
}

/** One banked reset grant, as the plan reports it. */
export interface BankedResetGrant {
  id: string;
  label: string;
  resetsLeft: number;
  /** ISO deadline, when the grant has one. */
  endsAt?: string;
  /** Plan windows the reset clears (`five_hour`, `seven_day`, …). */
  clears: string[];
  /** Current utilisation per cleared window, 0-100. */
  percentUsed: Record<string, number>;
  /** The reset can only be spent while the account is at a limit. */
  useRequiresLimit: boolean;
}

/** The grant a claim would spend, plus the account state around it. */
export interface BankedResetOffer {
  grant: BankedResetGrant;
  atLimit: boolean;
  /** ISO end of a post-claim cooldown, while one is running. */
  cooldownUntil?: string;
  /** Resets left across every usable grant. */
  totalResetsLeft: number;
}

export type BankedResetResult =
  | "reset"
  | "already_used"
  | "not_limited"
  | "cooldown"
  | "ineligible"
  | "unavailable"
  | "rate_limited"
  | "auth_error"
  | "error";

export interface BankedResetClaim {
  result: BankedResetResult;
  /** Server-side reason code, when it gave one. */
  reason?: string;
  resetsLeft?: number;
  cleared: string[];
  weeklyResetsAt?: string;
  cooldownUntil?: string;
}

export interface BankedResetControl {
  getOffer(): Promise<BankedResetOffer | undefined>;
  /**
   * Spend one reset from `grantId`. `requestId` is the idempotency key:
   * reuse it when retrying the same user action so a retry can't spend twice.
   */
  claim(grantId: string, requestId: string): Promise<BankedResetClaim>;
}

/** One subscription rate-limit window, as `/status` renders it. */
export interface PlanWindow {
  /** Short label — `5h`, `7d`, or the scoped model's display name. */
  label: string;
  /** Window utilisation, 0-100. */
  percent: number;
  /** ISO timestamp of the next reset, when the plan reports one. */
  resetsAt?: string;
}

export interface PlanUsage {
  /** Subscription tier (`max`, `pro`, …) when known. */
  plan?: string;
  windows: PlanWindow[];
  /** How many one-shot rate-limit resets are still banked, when the plan has them. */
  resetsAvailable?: number;
  /** ISO time the soonest-expiring banked reset must be used by, when the plan says. */
  resetsExpireAt?: string;
  /** Epoch ms of the read, so renderers can flag figures as aged. */
  fetchedAt: number;
}

/**
 * Process-level control surface. Plugin hot-reload pokes the
 * system prompt through here; nothing else mutates backend state
 * out-of-band of `runChatTurn`.
 */
export interface SystemControl {
  /** Update the system prompt on the live backend config. */
  updateSystemPrompt(prompt: string): void;
}

// ── Composed backend ────────────────────────────────────────────────────────

/**
 * Composed backend object. Missing capabilities are explicit
 * `undefined` slots, not optional methods on a fat interface.
 *
 * `cacheMetrics` lives at the top because every consumer reads it
 * (status, dispatcher logging, telemetry); pushing it under
 * `usage` would force `/status` to traverse a slot for one piece
 * of metadata.
 */
export interface Backend {
  id: BackendId;
  label: string;
  cacheMetrics: CacheMetricsSupport;
  chat?: ChatBackend;
  background?: BackgroundRunner;
  models?: ModelCatalog;
  sessions?: SessionBackend;
  tools?: ToolRuntime;
  usage?: UsageTelemetry;
  control?: SystemControl;
}

/**
 * Build a `Backend` from its slot components. A slot left out is a
 * capability the backend doesn't support — consumers read presence
 * directly (`backend.chat?.…`). The slot set is the single source of
 * truth for what a backend can do; there's no derived flag record to
 * keep in lockstep.
 */
export function composeBackend(input: {
  id: BackendId;
  label: string;
  cacheMetrics?: CacheMetricsSupport;
  chat?: ChatBackend;
  background?: BackgroundRunner;
  models?: ModelCatalog;
  sessions?: SessionBackend;
  tools?: ToolRuntime;
  usage?: UsageTelemetry;
  control?: SystemControl;
}): Backend {
  return {
    id: input.id,
    label: input.label,
    cacheMetrics: input.cacheMetrics ?? "none",
    chat: input.chat,
    background: input.background,
    models: input.models,
    sessions: input.sessions,
    tools: input.tools,
    usage: input.usage,
    control: input.control,
  };
}
