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
  loadBackendLedger,
  recordBackendRunUsage,
} from "./ledger.js";
export { recordBackendRunFailure, recordBackendRunSuccess } from "./breaker.js";
export {
  formatHeadroom,
  getBackendHeadroom,
  type BackendHeadroom,
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
} from "./router.js";
