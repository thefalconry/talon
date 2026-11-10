/**
 * Backend controller — refcounted pool of `Backend` instances
 * keyed by **holder**. A holder is any string the rest of Talon uses
 * to claim a backend reference: `role:chat`, `role:heartbeat`,
 * `role:dream`, or `chat:<chatId>` for per-chat overrides.
 *
 * Why a pool, not a single active backend
 * ───────────────────────────────────────
 *
 * Different roles, and different chats, have different cost/latency/
 * quality needs. Typical post-Anthropic-metering setup: chat default
 * on free-tier OpenAI Agents, heartbeats on Claude Sonnet, dream
 * shared with chat — plus one group chat stays on Claude while DMs use the
 * cheap default. A single-active model can't express that. The pool
 * lets each holder bind independently while deduplicating instances
 * when ids overlap.
 *
 * Module layout
 * ─────────────
 *
 *   - `types`    — public types (roles, holders, snapshot, result).
 *   - `holders`  — holder-string constructors.
 *   - `state`    — shared pool/bindings/listeners + internal helpers.
 *   - `pool`     — init/teardown, role accessors, availability, snapshot,
 *                  listeners.
 *   - `rebind`   — rebind/release holders + per-chat accessors.
 */

export * from "./types.js";
export { roleHolder } from "./holders.js";
export {
  initBackendPool,
  hasBackendPool,
  getBackendForRole,
  getBackendIdForRole,
  getBackendLabelForRole,
  listAvailableBackends,
  isBackendAvailable,
  getAvailableBackends,
  getPoolConfig,
  getPooledBackend,
  acquireBackendInstance,
  isModelValidForBackend,
  getPoolSnapshot,
  onBackendChange,
  cleanupBackendPool,
  resetBackendPoolForTest,
  clearBackendChangeListenersForTest,
} from "./pool.js";
export {
  rebindRole,
  rebindChat,
  releaseChat,
  getBackendForChat,
  getBackendIdForChat,
  hasChatBackendOverride,
  chatsBoundTo,
  resolveChatBackend,
} from "./rebind.js";
