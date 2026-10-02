/**
 * Backend registry — decouples bootstrap from concrete backend imports.
 *
 * Each concrete backend (`claude-sdk`, `kilo`, `opencode`) exposes a
 * `factory.ts` module that registers itself by calling `registerBackend`.
 * Bootstrap looks up the requested backend by id, calls `init`, and
 * receives a fully-wired `Backend` plus an optional cleanup hook.
 *
 * Why a registry instead of `if/else` in bootstrap:
 *
 *   1. **Modularity.** Adding a fourth backend means writing one new
 *      `factory.ts` and importing it — no churn to `bootstrap.ts`.
 *   2. **Testability.** Tests can register a stub backend
 *      (`registerBackend({ id: "test-stub", ... })`) and route through
 *      the same code path the real backends use.
 *   3. **Plugin doors.** Future external backend plugins can call
 *      `registerBackend` from a path-style plugin module, the same way
 *      MCP plugins do today.
 *
 * The registry is module-scoped — every Talon process has its own map.
 * `clearBackends()` is exposed for test isolation.
 *
 * Layering: this lives in `core/` (not `backend/`) on purpose. It is
 * generic infrastructure — a typed `id → factory` map that depends only
 * on the core `Backend` contract and `TalonConfig`, never on a concrete
 * backend. Keeping it here lets `core/engine/backend-controller` resolve
 * backends without `core` importing `backend/` (the dependency arrow runs
 * backend → core: each backend's `factory.ts` imports `registerBackend`
 * from here to self-register). Do not move it back under `backend/`.
 */

import type { Backend } from "./capabilities.js";
import type { DoctorCheck, DoctorConfigSlice } from "../doctor/types.js";
import type { TalonConfig } from "../config/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Frontend identifier passed to a backend's init step. An open set:
 * ids come from the frontend registry (`core/frontend-runtime`), where
 * the built-ins (telegram, terminal, teams, discord, native) register
 * their descriptors and plugin frontends can add more.
 */
export type FrontendName = string;

/** Per-init context — runtime dependencies the backend may need at startup. */
export interface BackendInitContext {
  /**
   * Returns the gateway HTTP port — late-bound so backends pick up the
   * actual listening port (the gateway picks 0 → ephemeral in tests).
   */
  getBridgePort: () => number;
  /**
   * Primary frontend driving this Talon process. Backends use this to
   * label MCP servers, scope tool environments, and pick the right
   * default suffix wording.
   */
  frontendName: FrontendName;
}

/** Result returned by a backend factory's `init` step. */
interface BackendInstance {
  /** The fully-wired `Backend` the dispatcher will route to. */
  backend: Backend;
  /**
   * Optional teardown hook invoked when Talon shuts down or hot-swaps
   * backends (future use). Idempotent: backends should tolerate multiple
   * calls.
   */
  cleanup?: () => Promise<void> | void;
}

/** A registered backend implementation. */
export interface BackendFactory {
  /** Stable identifier — matches `config.backend` in `talon.json`. */
  id: string;
  /** Display label used in `/status` and agent logs (e.g. "Kilo"). */
  label: string;
  /**
   * Can this backend run a guest-scoped turn (a non-operator sender) with
   * nothing but the hub's conversation-only tools? `"enforced"` means its
   * own built-ins (shell, file tools) are dropped for guest turns;
   * `"refused"` means they can't be, so the weaver refuses guest turns on
   * it. Absent is treated as `"refused"` — fail closed.
   */
  guestToolScope?: "enforced" | "refused";
  /**
   * Backends that are the same provider under different logins (the
   * default `claude` backend and every `claudeAccounts` entry) share an
   * account group. The headroom router never moves work between members
   * of a group: spreading load across one provider's subscriptions is the
   * operator's explicit choice, never Talon's (docs/claude-accounts.md).
   * Absent = a group of one.
   */
  accountGroup?: string;
  /**
   * Only ever used when chosen explicitly (config, `/backend`, a tool's
   * `backend` argument): the router never picks it as an alternate for
   * work defaulting to some other backend. Set on every extra Claude
   * account, so headroom routing from, say, Codex can land on the default
   * Claude account but never shops between Claude subscriptions.
   */
  explicitOnly?: boolean;
  /**
   * Backends that resume sessions from the same transcript store. A chat
   * switched between two of them keeps its session instead of starting a
   * fresh one. Absent = sessions don't port to any other backend.
   */
  sessionStore?: string;
  /** Initialise the backend; called exactly once per Talon process. */
  init(config: TalonConfig, ctx: BackendInitContext): Promise<BackendInstance>;
  /**
   * `talon doctor` checks for this backend — binary, auth, catalog probes.
   * `isActive` is true for the backend serving chats; probes that cost a
   * process spawn (model resolution) should run only then. Doctor composes
   * whatever is registered, so a backend without this slot is reported as
   * having nothing to check rather than silently skipped.
   */
  doctor?(
    config: DoctorConfigSlice | undefined,
    isActive: boolean,
  ): Promise<DoctorCheck[]>;
}

// ── State ───────────────────────────────────────────────────────────────────

const backends = new Map<string, BackendFactory>();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Register a backend implementation.
 *
 * Throws on duplicate id — we'd rather fail at startup than silently
 * pick the wrong implementation.
 */
export function registerBackend(factory: BackendFactory): void {
  if (backends.has(factory.id)) {
    throw new Error(
      `Backend "${factory.id}" already registered — duplicate registration`,
    );
  }
  backends.set(factory.id, factory);
}

/** Look up a backend by id. Returns `undefined` if not registered. */
export function getBackend(id: string): BackendFactory | undefined {
  return backends.get(id);
}

/**
 * List all registered backends, sorted by id for deterministic output.
 *
 * Useful for `/status`, error messages ("known backends: a, b, c"), and
 * config validation. Returns a fresh array each call — caller can mutate
 * without affecting the registry.
 */
export function listBackends(): BackendFactory[] {
  return [...backends.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Clear the registry. Test-only utility — production code should never
 * call this.
 */
export function clearBackends(): void {
  backends.clear();
}

/**
 * Whether guest-scoped turns may run on this backend. Unknown ids and
 * factories that don't declare `guestToolScope` fail closed.
 */
export function backendEnforcesGuestScope(id: string): boolean {
  return backends.get(id)?.guestToolScope === "enforced";
}

/**
 * Whether `a` and `b` are two different logins of one provider — the pair
 * the router must never choose between on its own. False for the same id
 * and for any unregistered id.
 */
export function inSameAccountGroup(a: string, b: string): boolean {
  if (a === b) return false;
  const group = backends.get(a)?.accountGroup;
  return group !== undefined && backends.get(b)?.accountGroup === group;
}

/**
 * May the router send work defaulting to `callerId` to `id` on its own?
 * Never to another login of the caller's provider, never to an
 * explicit-only backend. (The caller's own backend is always allowed.)
 */
export function isRoutingAlternate(id: string, callerId: string): boolean {
  if (id === callerId) return true;
  if (inSameAccountGroup(id, callerId)) return false;
  return backends.get(id)?.explicitOnly !== true;
}

/**
 * Whether a chat's session id stays valid when it moves from backend `a`
 * to backend `b`. True for the same id; otherwise only when both declare
 * the same `sessionStore`.
 */
export function sharesSessionStore(a: string, b: string): boolean {
  if (a === b) return true;
  const store = backends.get(a)?.sessionStore;
  return store !== undefined && backends.get(b)?.sessionStore === store;
}

/** Whether a backend with this id is currently registered. */
export function hasBackend(id: string): boolean {
  return backends.has(id);
}
