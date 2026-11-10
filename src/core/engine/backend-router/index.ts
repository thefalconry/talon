/**
 * Plan-aware backend router.
 *
 *   - `ledger`   — the local rolling token count that gives budget-only
 *                  backends a headroom signal.
 *   - `headroom` — one comparable "how much is left" per backend, from the
 *                  plan API where there is one and the ledger where there
 *                  is not.
 *   - `router`   — the decision: who runs this background job.
 */

export {
  flushBackendLedger,
  ledgerUsage,
  loadBackendLedger,
  recordBackendRunUsage,
  recordBackendUsage,
  resetBackendLedgerForTest,
  tokensInWindow,
  LEDGER_RETENTION_MS,
  LEDGER_SHORT_WINDOW_MS,
} from "./ledger.js";
export {
  isAuthFailureMessage,
  openBreaker,
  recordBackendRunFailure,
  recordBackendRunSuccess,
  resetBackendBreakersForTest,
  BREAKER_BASE_COOLOFF_MS,
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_MAX_COOLOFF_MS,
  type OpenBreaker,
} from "./breaker.js";
export {
  collectBackendHeadroom,
  formatHeadroom,
  getBackendHeadroom,
  hasBudget,
  headroomFromLedger,
  headroomFromPlan,
  limitingWindowOf,
  resetHeadroomCacheForTest,
  HEADROOM_CACHE_MS,
  type BackendHeadroom,
  type HeadroomSource,
  type LimitingWindow,
} from "./headroom.js";
export {
  collectBackendUsage,
  leadWith,
  type BackendUsageSnapshot,
} from "./usage.js";
export {
  chooseBackend,
  resolveRoutedModel,
  taskClassForEffort,
  DEFAULT_CEILING_PERCENT,
  type RouteDecision,
  type RouteHints,
  type RoutePurpose,
  type RouteRequest,
  type TaskClass,
} from "./router.js";
