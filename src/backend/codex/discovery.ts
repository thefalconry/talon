/**
 * OpenAI model discovery for the Codex backend.
 *
 * Why this is a separate module
 * ─────────────────────────────
 *
 * Codex ships with a small set of model strings hardcoded in the CLI,
 * but the actual set the operator can call depends on what their auth
 * credential is allowed to invoke. For api-key billing this is fully
 * dynamic — OpenAI keeps adding (and occasionally removing) models —
 * and the only reliable way to know what works is to ask the API:
 *
 *     GET https://api.openai.com/v1/models
 *
 * For ChatGPT-OAuth users the situation is different: there's no
 * `/v1/models` equivalent for the OAuth credential type, and the Codex
 * CLI silently rejects most model strings on this auth mode. We keep
 * the curated fallback for that path and don't probe at all.
 *
 * Design constraints (mirrors openai-agents/discovery.ts):
 *
 *   1. **First /model after a backend switch must show the catalog.**
 *      The fetch returns in ~200ms over a warm TLS session; we expose
 *      the in-flight promise via `awaitDiscovery(timeoutMs)` so the
 *      picker can soft-wait (3s default) before snapshotting.
 *
 *   2. **Bootstrap must not block on the network.** `initCodexAgent`
 *      calls `startDiscovery()` fire-and-forget; bootstrap proceeds and
 *      the catalog populates in the background.
 *
 *   3. **Tolerant by design.** Network errors, 401s, malformed entries —
 *      all swallowed and logged at debug. The resolver falls back to
 *      the curated catalog and the next manual refresh gets a fresh
 *      chance.
 *
 * Self-contained: talks to the network, mutates only
 * `state.discoveredModels` / `state.discoveryPromise` / `state.discoveryAt`,
 * exposes no side-effects beyond that.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { log, logDebug } from "../../util/log.js";
import { getState } from "./state.js";
import type { CodexAuthInfo } from "./auth.js";
import { normalizeReasoningLevels } from "../../core/models/reasoning-levels.js";
import { userHome } from "../../util/fs-path.js";

/** Shape of one entry returned by OpenAI's `/v1/models`. Sparse — only `id` is reliably present. */
interface OpenAiModelEntry {
  id?: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

/**
 * Shape of one entry in `~/.codex/models_cache.json`. This file is
 * maintained by the Codex CLI itself — populated against
 * `https://chatgpt.com/backend-api/...` on OAuth sessions, against
 * OpenAI's API on api-key sessions. It carries far richer metadata
 * than `/v1/models`: display name, description, reasoning levels,
 * context window, visibility, and an `supported_in_api` flag that
 * tells us which models can actually be invoked from the CLI.
 *
 * We only consume a narrow subset here; the cache may grow new
 * fields over time without breaking us.
 */
interface CodexCacheModelEntry {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: "list" | "hide" | string;
  supported_in_api?: boolean;
  /** Picker order — lower sorts first; the CLI's default is the lowest. */
  priority?: number;
  context_window?: number;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string;
  }>;
}

/** Top-level `~/.codex/models_cache.json` shape. */
interface CodexCacheFile {
  fetched_at?: string;
  etag?: string;
  client_version?: string;
  models?: CodexCacheModelEntry[];
}

/** Where the Codex CLI writes its model cache. Exported for tests. */
export function getCodexCachePath(): string {
  // Honor CODEX_HOME like token-usage.ts and plan-usage.ts do — the CLI
  // itself relocates with it, so a pinned deployment would otherwise
  // read a cache the CLI never writes. (Also what lets tests fake the
  // path under bun, whose os.homedir() ignores $HOME.)
  const home = process.env.CODEX_HOME?.trim();
  return home && home.length > 0
    ? join(home, "models_cache.json")
    : join(userHome(), ".codex", "models_cache.json");
}

/** Default soft timeout when callers await an in-flight discovery. */
const DEFAULT_AWAIT_TIMEOUT_MS = 3_000;

/** Hard timeout for the underlying HTTP fetch. */
const FETCH_TIMEOUT_MS = 10_000;

/** Default OpenAI base URL when not overridden via config. */
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Drop model ids that don't make sense for Codex (a chat-completion
 * agent). The OpenAI `/v1/models` response is a kitchen sink — image
 * generation (`dall-e-*`), audio (`whisper-*`, `tts-*`), embeddings
 * (`text-embedding-*`), moderation, and legacy completions live next
 * to the actual chat models we want.
 *
 * Positive pattern: keep `gpt-3+`, `gpt-4+`, `gpt-5+`, `o3*`, `o4*`,
 * `chatgpt-*` (e.g. `chatgpt-4o-latest`). Everything else is filtered.
 *
 * Returns `true` to KEEP the model, `false` to drop. Exported for tests.
 */
export function isCodexCompatibleModel(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  const lower = id.toLowerCase();
  // Hard-exclude obviously non-chat families even if they accidentally
  // match the positive prefixes (e.g. `gpt-4o-audio-preview`).
  if (
    /(embedding|moderation|whisper|tts|dall-e|audio|realtime|search|babbage|davinci|ada|curie)/.test(
      lower,
    )
  ) {
    return false;
  }
  // Positive prefixes for chat-capable / reasoning models.
  // `o[1-9]` covers o1, o1-mini, o1-preview, o2, o3, o4...
  if (/^(gpt-[3-9]|o[1-9]|chatgpt-)/.test(lower)) return true;
  return false;
}

/**
 * Kick off model discovery as a fire-and-forget background fetch.
 *
 * Three paths depending on auth mode:
 *   - `chatgpt` (OAuth): read `~/.codex/models_cache.json`. The Codex
 *     CLI itself maintains this file from ChatGPT's backend API and
 *     refreshes it on each invocation. We get rich metadata for free
 *     (display name, context window, visibility, supported_in_api)
 *     and don't need to handle JWT refresh ourselves.
 *   - `api-key`: hit OpenAI's `GET /v1/models` directly. Sparse
 *     response (just ids), but always available with a bearer key.
 *   - `none`: no-op — resolve immediately so the picker can fall
 *     through to the curated catalog.
 *
 * Stashes the in-flight Promise on `state.discoveryPromise` so callers
 * that need a populated catalog can `await awaitDiscovery()` instead
 * of racing IO. Idempotent: a second call while one is in flight
 * returns the existing promise.
 *
 * Failures are logged at debug and never throw — the resolver falls
 * back to the curated catalog, and the next `refreshDiscovery` (or
 * subsequent `initCodexAgent`) gets a fresh chance.
 */
export function startDiscovery(
  authInfo: CodexAuthInfo | null | undefined,
): Promise<void> {
  const state = getState();
  if (state.discoveryPromise) return state.discoveryPromise;

  const mode = authInfo?.mode ?? "none";

  // No auth → mark "attempted with empty result" so awaitDiscovery
  // returns immediately and the picker falls through to curated.
  if (mode === "none") {
    state.discoveryAt = Date.now();
    return Promise.resolve();
  }

  const work =
    mode === "chatgpt"
      ? loadCodexCacheModels()
      : fetchOpenAiModels(authInfo!.apiKey!, authInfo?.baseUrl);

  const promise = work
    .catch((err) => {
      logDebug(
        "agent",
        `Codex model discovery skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    })
    .finally(() => {
      // Mark discovery attempted regardless of outcome — the picker
      // uses `discoveryAt` to distinguish "still loading" from
      // "finished, found nothing", and a transient failure should
      // fall through to curated immediately rather than wait again.
      state.discoveryAt = Date.now();
      if (state.discoveryPromise === promise) {
        state.discoveryPromise = null;
      }
    });

  state.discoveryPromise = promise;
  return promise;
}

/**
 * Wait for an in-flight discovery to complete, with a soft timeout.
 *
 * Returns immediately when no discovery is pending (either because it
 * finished or none was ever started). Used by the model picker before
 * snapshotting — keeps the first render honest without blocking the
 * UI for slow / unreachable endpoints.
 */
export async function awaitDiscovery(
  timeoutMs: number = DEFAULT_AWAIT_TIMEOUT_MS,
): Promise<void> {
  const state = getState();
  const inFlight = state.discoveryPromise;
  if (!inFlight) return;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, timeoutMs));
  });
  try {
    await Promise.race([inFlight, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Force a fresh discovery even when one was attempted before.
 *
 * Useful when the operator changes the auth credentials at runtime
 * or wants to retry after a transient failure. Returns the new
 * promise so callers can await; safe to fire-and-forget.
 */
export function refreshDiscovery(
  authInfo: CodexAuthInfo | null | undefined,
): Promise<void> {
  const state = getState();
  state.discoveryPromise = null;
  state.discoveryAt = null;
  return startDiscovery(authInfo);
}

/**
 * Whether the catalog has at least one discovered entry. Used by the
 * picker to decide whether awaiting in-flight discovery is worthwhile.
 */
export function hasDiscoveredCatalog(): boolean {
  return getState().discoveredModels.size > 0;
}

/**
 * Whether discovery has been attempted (regardless of result). Used by
 * the picker to distinguish "still loading" from "finished, found
 * nothing" — the latter falls back to curated immediately.
 */
export function hasAttemptedDiscovery(): boolean {
  return getState().discoveryAt !== null;
}

/**
 * Query OpenAI's `/v1/models` endpoint and populate
 * `state.discoveredModels` with the chat-compatible ids.
 *
 * The response is sparse — only `id` and `owned_by` are reliably
 * present. We don't try to enrich here; capability metadata
 * (contextWindow, displayName, reasoning, apiKeyOnly) lives in the
 * curated `CODEX_MODELS` table in `models.ts` and gets merged at
 * presentation time. Discovery only answers "which ids can this key
 * call?" — that's enough to drive the picker.
 *
 * Non-2xx responses throw so the caller can decide whether to
 * log-and-forget or retry.
 */
export async function fetchOpenAiModels(
  apiKey: string,
  baseUrl?: string,
): Promise<void> {
  const base = (baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/models`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`/v1/models returned ${res.status}`);
  }
  const json = (await res.json()) as { data?: OpenAiModelEntry[] };
  const data = Array.isArray(json?.data) ? json.data : [];

  const state = getState();
  // Clear so a refresh fully replaces the set (no stale ids surviving
  // a model deprecation on OpenAI's side).
  state.discoveredModels.clear();
  let kept = 0;
  let dropped = 0;
  for (const entry of data) {
    if (!entry || typeof entry.id !== "string") continue;
    if (!isCodexCompatibleModel(entry.id)) {
      dropped += 1;
      continue;
    }
    state.discoveredModels.add(entry.id);
    kept += 1;
  }

  log(
    "agent",
    `Codex: discovered ${kept} chat-compatible models from ${url} (filtered ${dropped} non-chat entries)`,
  );
}

/**
 * Read the Codex CLI's local model cache (`~/.codex/models_cache.json`).
 *
 * Codex CLI populates this file on each invocation by hitting
 * `https://chatgpt.com/backend-api/...` (OAuth) or OpenAI's API
 * (api-key) and refreshes it via an ETag-conditioned request. The
 * file persists across CLI runs and Talon restarts, which means even
 * if the operator hasn't run `codex` in a while we still get the
 * last-known catalog instead of falling all the way back to curated.
 *
 * We populate `state.discoveredModels` AND `state.discoveredModelMetadata`
 * — the latter carries display names + context windows the curated
 * table doesn't have for newer models (e.g. gpt-5.4-mini).
 *
 * Filter rules:
 *   - Drop entries with `visibility: "hide"` (the CLI uses this for
 *     internal/system models like `codex-auto-review` that shouldn't
 *     appear in a user-facing picker).
 *   - Drop entries with `supported_in_api: false` (models that show
 *     in ChatGPT's UI but aren't callable via the API surface that
 *     codex-sdk uses).
 *
 * Non-existent cache file throws so the caller's catch path logs it
 * at debug level and the picker falls back to curated.
 */
/**
 * The Codex CLI's own default for the account: the listed, API-callable
 * entry with the lowest `priority`. First entry wins ties, matching the
 * CLI's stable sort. `null` when nothing qualifies.
 */
function cliDefaultModel(
  data: ReadonlyArray<CodexCacheModelEntry | null | undefined>,
): string | null {
  let best: string | null = null;
  let bestPriority = Number.POSITIVE_INFINITY;
  for (const entry of data) {
    if (!entry || typeof entry.slug !== "string" || !entry.slug) continue;
    if (entry.visibility === "hide" || entry.supported_in_api === false) {
      continue;
    }
    const priority =
      typeof entry.priority === "number" && Number.isFinite(entry.priority)
        ? entry.priority
        : Number.MAX_SAFE_INTEGER;
    if (priority < bestPriority) {
      bestPriority = priority;
      best = entry.slug;
    }
  }
  return best;
}

export async function loadCodexCacheModels(): Promise<void> {
  const path = getCodexCachePath();
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `${path} not found — run \`codex login\` to populate the cache`,
      );
    }
    throw err;
  }

  let json: CodexCacheFile;
  try {
    json = JSON.parse(raw) as CodexCacheFile;
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const data = Array.isArray(json.models) ? json.models : [];

  const state = getState();
  state.discoveredModels.clear();
  state.discoveredModelMetadata.clear();
  state.discoveredDefaultModel = cliDefaultModel(data);
  let kept = 0;
  let dropped = 0;
  for (const entry of data) {
    if (!entry || typeof entry.slug !== "string" || !entry.slug) {
      dropped += 1;
      continue;
    }
    if (entry.visibility === "hide") {
      dropped += 1;
      continue;
    }
    if (entry.supported_in_api === false) {
      dropped += 1;
      continue;
    }
    state.discoveredModels.add(entry.slug);
    const supportedReasoningLevels = normalizeReasoningLevels(
      entry.supported_reasoning_levels
        ?.map((level) => level.effort)
        .filter((level): level is string => typeof level === "string"),
    );
    const defaultReasoningLevel = normalizeReasoningLevels(
      typeof entry.default_reasoning_level === "string"
        ? [entry.default_reasoning_level]
        : undefined,
    )[0];
    state.discoveredModelMetadata.set(entry.slug, {
      displayName:
        typeof entry.display_name === "string" && entry.display_name
          ? entry.display_name
          : undefined,
      contextWindow:
        typeof entry.context_window === "number" && entry.context_window > 0
          ? entry.context_window
          : undefined,
      description:
        typeof entry.description === "string" && entry.description
          ? entry.description
          : undefined,
      ...(supportedReasoningLevels.length ? { supportedReasoningLevels } : {}),
      ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
    });
    kept += 1;
  }

  const fetchedAt = json.fetched_at ?? "unknown";
  log(
    "agent",
    `Codex: loaded ${kept} models from ${path} (fetched_at=${fetchedAt}, filtered ${dropped} hidden/api-disabled entries` +
      `${state.discoveredDefaultModel ? `, CLI default ${state.discoveredDefaultModel}` : ""})`,
  );
}
