/**
 * Runtime-learned Codex ChatGPT-OAuth model incompatibility store.
 *
 * The problem
 * ───────────
 *
 * The Codex CLI's ChatGPT-OAuth path silently rejects most model
 * strings: only `gpt-5.5` is known to work end-to-end on a free OAuth
 * account, but `~/.codex/models_cache.json` advertises every visible
 * model with `supported_in_api: true`. The CLI then exits 1 with no
 * structured error event on stdout — just `"Reading prompt from
 * stdin..."` on stderr — making the failure look opaque to the SDK.
 *
 * Talon's recovery ladder (`isChatGptModelMismatchError` in `auth.ts`)
 * can only fall back when the SDK surfaces the explicit
 * `"not supported when using Codex with a ChatGPT account"` text. When
 * Codex exits silently the explicit text never arrives → no recovery
 * fires → the user sees a dead turn.
 *
 * The fix
 * ───────
 *
 * Maintain a per-credential learning set of model ids that have been
 * observed failing on this OAuth account:
 *
 *   1. `markOAuthIncompat(id)` records a failure (writes through to the
 *      `codex.oauth-incompat` kv row keyed by current auth fingerprint).
 *   2. `isKnownOAuthIncompat(id)` answers the pre-emptive swap and the
 *      picker filter.
 *   3. `loadOAuthIncompatStore(fingerprint)` rehydrates the in-memory
 *      set at startup and ignores stale data from a different credential.
 *
 * The store is intentionally additive-only at the credential level: a
 * model that worked once may legitimately fail once (rate limit, server
 * error) — we don't want to mark it incompat. But the *silent exit 1*
 * pattern is a strong signal that the CLI refuses the model on this
 * auth, and that's the only failure shape that triggers a mark.
 *
 * Keyed by auth fingerprint
 * ─────────────────────────
 *
 * If Ada switches OAuth accounts (e.g. work vs personal) the cache
 * file at `~/.codex/auth.json` changes, and what we learned about
 * account A doesn't necessarily apply to account B. To stay correct
 * across credential changes we tag the store with a fingerprint of the
 * auth source (`mode + source + first 32 chars of the token if any`).
 * Mismatched fingerprint on load → start fresh.
 *
 * No stored value, corrupt JSON, missing fields — all treated as
 * "empty set" silently. Persistence is best-effort: kvSet never throws,
 * so a write failure logs internally but the in-memory set still works
 * for the rest of the session.
 *
 * Persistence
 * ───────────
 *
 * Backed by the shared `kv` table (key `codex.oauth-incompat`), which
 * gives transactional writes and TALON_DB_PATH test isolation for free
 * — the reason the old lazy-`storePath()` HOME-override workaround is
 * gone. The stored value is the bare document `{ fingerprint, updatedAt,
 * models }`. On first load the pre-SQLite JSON file (JsonStore envelope
 * `{ schemaVersion, savedAt, data }` OR the even-older bare
 * `{ version, fingerprint, updatedAt, models }`) is folded into kv once
 * so existing learned data isn't lost.
 *
 * API shape:
 *
 *   - `markOAuthIncompat(id)` is async (returns `Promise<boolean>`).
 *     The in-memory mutation is synchronous; the async signature is
 *     retained so callers can keep awaiting it across the storage swap.
 *   - `loadOAuthIncompatStore(fingerprint)` is async for the same
 *     reason — callers already `await` it.
 *   - `isKnownOAuthIncompat`, `listKnownOAuthIncompat`,
 *     `computeAuthFingerprint`, and `resetOAuthIncompatForTests`
 *     stay synchronous (they only touch the in-memory set).
 */

import { scryptSync } from "node:crypto";
import { logDebug } from "../../util/log.js";
import { files } from "../../util/paths.js";
import { kvGet, kvSet } from "../../storage/kv.js";
import { importLegacyJson } from "../../storage/legacy-import.js";
import type { CodexAuthInfo } from "./auth.js";

/** kv key owning the persisted OAuth-incompat learning set. */
const STORE_KEY = "codex.oauth-incompat";

/**
 * Shape persisted in the kv row — the bare document callers reason
 * about. (The old JsonStore wrapped this in a `{ schemaVersion, savedAt,
 * data }` envelope; kv holds the payload directly.)
 */
interface OAuthIncompatData {
  /** Fingerprint of the credential the store was learned against. */
  fingerprint: string;
  /** When the store was last mutated (ISO 8601). */
  updatedAt: string;
  /** Model ids known to fail on this credential, sorted. */
  models: string[];
}

/**
 * In-memory state for the active credential. Held in a module-
 * scoped variable rather than re-read from kv per call so reads
 * (`isKnownOAuthIncompat`, `listKnownOAuthIncompat`) stay synchronous —
 * the hot path doesn't need to touch storage.
 */
interface InMemoryStore {
  fingerprint: string;
  models: Set<string>;
}

let memoryStore: InMemoryStore | null = null;

/**
 * Compute a stable fingerprint for the active auth credential. Used as
 * the store's identity tag so a credential change discards the learned
 * set without polluting a different account.
 *
 * Fingerprint shape:
 *   - `mode:source` for ChatGPT OAuth (no token to hash)
 *   - `mode:source:<scrypt(key), 16 hex>` for api-key billing
 *   - `mode:source` for missing/empty
 *
 * Constant-folded by `mode === "none"` — no learning happens without
 * authentication, so we only really care about the OAuth shape.
 */
export function computeAuthFingerprint(info: CodexAuthInfo): string {
  const base = `${info.mode}:${info.source}`;
  if (info.mode === "api-key" && info.apiKey) {
    // A digest, never key material: the fingerprint is persisted in kv
    // and appears in debug logs.
    // scrypt, not a bare hash: the input is a credential. Computed once
    // per codex init.
    const digest = scryptSync(info.apiKey, "talon.codex.fingerprint", 8);
    return `${base}:${digest.toString("hex")}`;
  }
  return base;
}

/**
 * Load the persisted store for the given credential fingerprint, OR
 * reset the in-memory state to empty if the fingerprint doesn't match
 * (different account → don't trust the old data).
 *
 * Idempotent — safe to call from `initCodexAgent` on every (re)init.
 * Tolerates a missing/corrupt kv value and fingerprint drift by
 * starting with an empty set.
 */
export async function loadOAuthIncompatStore(
  fingerprint: string,
): Promise<void> {
  // Idempotent fast path: if we already have a memoryStore for the
  // same fingerprint, the existing in-memory set is authoritative for
  // this credential. Re-reading kv would be harmless now that writes
  // are synchronous, but skipping it keeps the historical guarantee
  // that runtime-learned entries survive a redundant reload.
  if (memoryStore && memoryStore.fingerprint === fingerprint) return;

  // One-shot fold of the pre-SQLite JSON file into kv. No-op after the
  // first successful import (file renamed `.imported`) and whenever
  // TALON_DISABLE_LEGACY_IMPORT gates it.
  importLegacyStore();

  const fresh: InMemoryStore = { fingerprint, models: new Set<string>() };
  const data = kvGet<OAuthIncompatData>(STORE_KEY);

  if (!data || data.fingerprint !== fingerprint) {
    // Missing value or a different credential → start fresh. The stale
    // kv row is left untouched until the next `markOAuthIncompat`
    // rewrites it under the new fingerprint.
    if (data && data.fingerprint !== fingerprint) {
      logDebug(
        "agent",
        `Codex OAuth-incompat store: fingerprint mismatch (was ${data.fingerprint}, now ${fingerprint}), starting empty`,
      );
    }
    memoryStore = fresh;
    return;
  }

  for (const id of data.models ?? []) {
    if (typeof id === "string" && id) fresh.models.add(id);
  }
  memoryStore = fresh;
  logDebug(
    "agent",
    `Codex OAuth-incompat store: loaded ${fresh.models.size} entries`,
  );
}

/**
 * True when the given model id has been observed failing on the
 * currently-loaded credential.
 *
 * Defensive: returns `false` when no store is loaded (e.g. backend
 * never initialised, or auth mode is api-key where we don't learn).
 */
export function isKnownOAuthIncompat(modelId: string): boolean {
  return memoryStore?.models.has(modelId) ?? false;
}

/**
 * Record `modelId` as OAuth-incompat on the current credential.
 * Best-effort persistence; the in-memory mutation is always effective
 * even if the kv write fails (kvSet swallows and logs).
 *
 * Returns `true` if the set changed (callers can log the new entry),
 * `false` if the id was already known.
 *
 * The in-memory mutation is synchronous so subsequent
 * `isKnownOAuthIncompat` calls see the update immediately; the async
 * signature is kept purely for call-site compatibility.
 */
export async function markOAuthIncompat(modelId: string): Promise<boolean> {
  if (!memoryStore) {
    logDebug(
      "agent",
      `Codex OAuth-incompat: markOAuthIncompat(${modelId}) called with no store loaded — ignored`,
    );
    return false;
  }
  if (memoryStore.models.has(modelId)) return false;

  memoryStore.models.add(modelId);
  kvSet(STORE_KEY, {
    fingerprint: memoryStore.fingerprint,
    updatedAt: new Date().toISOString(),
    models: Array.from(memoryStore.models).sort(),
  } satisfies OAuthIncompatData);
  return true;
}

/**
 * Snapshot of the currently-learned set. Returns an array (not the
 * underlying Set) so callers can't mutate state directly. Empty array
 * when no store is loaded.
 */
export function listKnownOAuthIncompat(): string[] {
  if (!memoryStore) return [];
  return Array.from(memoryStore.models).sort();
}

/**
 * Drop the in-memory state. Used in tests to isolate scenarios.
 * Production callers should call `loadOAuthIncompatStore` instead.
 */
export function resetOAuthIncompatForTests(): void {
  memoryStore = null;
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Fold the legacy JSON file into kv exactly once. Accepts both the
 * JsonStore envelope (unwrapped to its inner `data` by importLegacyJson)
 * and the even-older bare `{ version, fingerprint, updatedAt, models }`
 * document — both reduce to a `{ fingerprint, updatedAt, models }`
 * payload. A malformed payload imports nothing (the file is still
 * renamed so the attempt doesn't repeat).
 */
function importLegacyStore(): void {
  importLegacyJson({
    path: files.codexOauthIncompat,
    category: "agent",
    what: "OAuth-incompat model(s)",
    ingest: (data) => {
      // A bare legacy document carries a `version`; only v1 is
      // migratable — an unknown version starts empty, exactly as the
      // old JsonStore migrate hook did. The envelope shape's inner
      // `data` has no version field and falls straight through.
      if (
        data &&
        typeof data === "object" &&
        "version" in data &&
        (data as Record<string, unknown>).version !== 1
      ) {
        return 0;
      }
      const normalized = normalizeStoreData(data);
      if (!normalized) return 0;
      kvSet(STORE_KEY, normalized);
      return normalized.models.length;
    },
  });
}

/**
 * Coerce an arbitrary parsed value into the persisted shape, dropping
 * non-string / empty model ids. Returns `null` for anything missing the
 * required `fingerprint` / `updatedAt` / `models` fields.
 */
function normalizeStoreData(raw: unknown): OAuthIncompatData | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.fingerprint !== "string") return null;
  if (typeof obj.updatedAt !== "string") return null;
  if (!Array.isArray(obj.models)) return null;
  return {
    fingerprint: obj.fingerprint,
    updatedAt: obj.updatedAt,
    models: obj.models.filter(
      (m): m is string => typeof m === "string" && m.length > 0,
    ),
  };
}
