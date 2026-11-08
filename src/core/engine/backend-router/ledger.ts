/**
 * Local rolling token ledger — the headroom signal for backends with no
 * account usage API.
 *
 * Claude, Codex and `agy` report subscription windows; `openai-agents` has
 * no plan at all, and `agy`'s read (a CLI spawn) can fail. Without a second
 * signal the router would treat those as infinitely fresh and pile every
 * background run onto them. So Talon counts what it spends itself: every chat turn,
 * one-shot and sub-agent folds its token total into a per-backend ledger,
 * and `headroom.ts` reads that against the operator's soft budget
 * (`config.backendBudgets`).
 *
 * The ledger is deliberately a *local estimate*, not accounting: it only
 * sees what this daemon ran, and a plan API always takes precedence when
 * one exists. Entries older than the widest window (24h) are pruned on
 * every read and write, which also bounds the file.
 *
 * Persistence is `~/.talon/data/backend-ledger.json`, written atomically so
 * a restart mid-write can't leave a truncated file — a zeroed ledger would
 * silently hand a spent backend a full headroom score.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dirs } from "../../../util/paths.js";
import { logWarn } from "../../../util/log.js";
import { writePrivateJson } from "../../mesh/persist.js";

/** Widest window the ledger answers for; everything older is dropped. */
export const LEDGER_RETENTION_MS = 24 * 60 * 60_000;
/** The short window, as `backendBudgets.tokensPer5h` measures it. */
export const LEDGER_SHORT_WINDOW_MS = 5 * 60 * 60_000;

/** How long a write is coalesced for, so a burst of turns is one fsync. */
const FLUSH_DEBOUNCE_MS = 2_000;

/** One recorded spend: when it happened and how many tokens it cost. */
interface LedgerEntry {
  /** Epoch ms. */
  readonly t: number;
  /** Total tokens (input + output + cache + thinking, as the backend counts). */
  readonly n: number;
}

interface LedgerFile {
  readonly version: 1;
  readonly backends: Record<string, LedgerEntry[]>;
}

interface LedgerState {
  entries: Map<string, LedgerEntry[]>;
  loaded: boolean;
  loading: Promise<void> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
  /** Overridable for tests; resolved lazily so TALON_HOME changes are seen. */
  path: string | null;
}

const state: LedgerState = {
  entries: new Map(),
  loaded: false,
  loading: null,
  flushTimer: null,
  dirty: false,
  path: null,
};

function ledgerPath(): string {
  return state.path ?? resolve(dirs.data, "backend-ledger.json");
}

/** Drop entries that have aged out of the widest window. */
function prune(list: LedgerEntry[], now: number): LedgerEntry[] {
  const floor = now - LEDGER_RETENTION_MS;
  // Entries are appended in time order, so the survivors are a suffix —
  // but a clock step backwards can break that, hence a filter not a slice.
  return list.filter((e) => e.t > floor);
}

function parseLedger(raw: unknown): Map<string, LedgerEntry[]> {
  const out = new Map<string, LedgerEntry[]>();
  if (!raw || typeof raw !== "object") return out;
  const file = raw as Partial<LedgerFile>;
  if (file.version !== 1 || !file.backends) return out;
  const now = Date.now();
  for (const [id, list] of Object.entries(file.backends)) {
    if (!Array.isArray(list)) continue;
    const clean = list.filter(
      (e): e is LedgerEntry =>
        Boolean(e) &&
        typeof (e as LedgerEntry).t === "number" &&
        typeof (e as LedgerEntry).n === "number" &&
        Number.isFinite((e as LedgerEntry).t) &&
        Number.isFinite((e as LedgerEntry).n),
    );
    const pruned = prune(clean, now);
    if (pruned.length > 0) out.set(id, pruned);
  }
  return out;
}

/**
 * Load the persisted ledger once per process. Idempotent and safe to call
 * concurrently — every caller awaits the same read. A missing or corrupt
 * file starts an empty ledger rather than failing a routing decision.
 */
export async function loadBackendLedger(): Promise<void> {
  if (state.loaded) return;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    try {
      const raw = await readFile(ledgerPath(), "utf8");
      const parsed = parseLedger(JSON.parse(raw));
      // In-process records taken while the read was in flight win: merge
      // rather than replace, so a turn that landed during boot isn't lost.
      for (const [id, list] of parsed) {
        state.entries.set(id, [...list, ...(state.entries.get(id) ?? [])]);
      }
    } catch {
      /* no ledger yet, or unreadable — start empty */
    }
    state.loaded = true;
    state.loading = null;
  })();
  return state.loading;
}

function scheduleFlush(): void {
  state.dirty = true;
  if (state.flushTimer) return;
  const timer = setTimeout(() => {
    state.flushTimer = null;
    void flushBackendLedger();
  }, FLUSH_DEBOUNCE_MS);
  timer.unref?.();
  state.flushTimer = timer;
}

/** Write the ledger out now. Exported so shutdown and tests can force it. */
export async function flushBackendLedger(): Promise<void> {
  if (!state.dirty) return;
  state.dirty = false;
  const now = Date.now();
  const backends: Record<string, LedgerEntry[]> = {};
  for (const [id, list] of state.entries) {
    const pruned = prune(list, now);
    state.entries.set(id, pruned);
    if (pruned.length > 0) backends[id] = pruned;
  }
  try {
    await writePrivateJson(ledgerPath(), {
      version: 1,
      backends,
    } satisfies LedgerFile);
  } catch (err) {
    logWarn(
      "router",
      `Could not persist the backend ledger: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Fold one run's token spend into a backend's ledger.
 *
 * Called from the shared turn accounting and from every one-shot completion
 * path, so *all* backends accumulate a ledger — the plan API simply wins over
 * it where one exists. Cheap and synchronous: the disk write is debounced.
 */
export function recordBackendUsage(
  backendId: string,
  tokens: number,
  at = Date.now(),
): void {
  if (!backendId) return;
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  // A first record before the file has been read would be overwritten by the
  // load; kick the read off here so the merge in loadBackendLedger keeps it.
  if (!state.loaded && !state.loading) void loadBackendLedger();
  const list = state.entries.get(backendId) ?? [];
  list.push({ t: at, n: Math.round(tokens) });
  state.entries.set(backendId, prune(list, at));
  scheduleFlush();
}

/**
 * Fold a completed run's usage into the ledger. The same four fields every
 * background path reports (`OneShotUsage`, `TaskUsage`), summed — cache
 * reads included, because they still count against a subscription window.
 */
export function recordBackendRunUsage(
  backendId: string,
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
      }
    | undefined
    | null,
  at = Date.now(),
): void {
  if (!usage) return;
  const total =
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheRead ?? 0) +
    (usage.cacheWrite ?? 0);
  recordBackendUsage(backendId, total, at);
}

/** Tokens a backend spent inside a window ending now. */
export function tokensInWindow(
  backendId: string,
  windowMs: number,
  now = Date.now(),
): number {
  const list = state.entries.get(backendId);
  if (!list || list.length === 0) return 0;
  const floor = now - windowMs;
  let total = 0;
  for (const entry of list) if (entry.t > floor) total += entry.n;
  return total;
}

/** Both windows the budget schema knows about, for one backend. */
export function ledgerUsage(
  backendId: string,
  now = Date.now(),
): { tokens5h: number; tokensDay: number } {
  return {
    tokens5h: tokensInWindow(backendId, LEDGER_SHORT_WINDOW_MS, now),
    tokensDay: tokensInWindow(backendId, LEDGER_RETENTION_MS, now),
  };
}

/** Test seam — point the ledger at a temp file and start from empty. */
export function resetBackendLedgerForTest(path?: string): void {
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.entries = new Map();
  state.loaded = false;
  state.loading = null;
  state.flushTimer = null;
  state.dirty = false;
  state.path = path ?? null;
}
