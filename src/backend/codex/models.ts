/**
 * Codex model catalog.
 *
 * Unlike Kilo / OpenCode (which fetch a live provider catalog from a
 * running server), Codex has two effective sources of model truth:
 *
 *   1. **Discovered models** — what OpenAI's `/v1/models` returns for
 *      the configured api key. Source of truth on `auth-mode: api-key`.
 *      Populated asynchronously by `discovery.ts`.
 *   2. **Curated metadata** — the `CODEX_MODELS` table below. Carries
 *      human-friendly displayName, contextWindow, reasoning flag, and
 *      the all-important `apiKeyOnly` marker used by the handler's
 *      recovery ladder for ChatGPT-OAuth users. Also serves as the
 *      fallback catalog when discovery isn't possible (OAuth mode) or
 *      hasn't yet completed.
 *
 * `getEffectiveModels()` merges these: it returns curated entries for
 * known ids and synthesises minimal entries for discovered ids the
 * curated table doesn't know about (so a future `gpt-6` would show up
 * in the picker as soon as it lands at OpenAI, no Talon release
 * required).
 *
 * Reasoning-effort suffixes (`gpt-5-codex-high`, etc.) go through
 * Codex's `modelReasoningEffort` thread option rather than baked into
 * the model id, so we keep this list short.
 */

import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelButton,
  ModelPickerOptions,
  ModelPickerResult,
} from "../../core/types.js";
import { awaitDiscovery, hasAttemptedDiscovery } from "./discovery.js";
import { getState } from "./state.js";
import { getCodexAuthInfo } from "./init.js";
import { isKnownOAuthIncompat } from "./oauth-incompat.js";
import {
  CODEX_CHATGPT_DEFAULT_MODEL,
  CODEX_CHATGPT_MODEL_ENV,
} from "./constants.js";

/**
 * The model a ChatGPT-OAuth Codex session runs when nothing more specific
 * applies — the target of every pre-emptive OAuth swap and mismatch
 * fallback. Resolution order:
 *
 *   1. `TALON_CODEX_CHATGPT_MODEL` env var (operator override);
 *   2. `codexChatGptDefaultModel` in config;
 *   3. the Codex CLI's own default for the signed-in account (first
 *      listed model in `~/.codex/models_cache.json` by priority), unless
 *      Talon has already learned that id fails on this account;
 *   4. {@link CODEX_CHATGPT_DEFAULT_MODEL}, the bundled floor.
 *
 * Hardcoding a single id is what broke in Sep 2026: OpenAI retired
 * `gpt-5.5` for ChatGPT accounts and every run 404'd until a release.
 */
export function getCodexChatGptDefaultModel(): string {
  const env = process.env[CODEX_CHATGPT_MODEL_ENV]?.trim();
  if (env) return env;
  const state = getState();
  const configured = state.config?.codexChatGptDefaultModel?.trim();
  if (configured) return configured;
  const discovered = state.discoveredDefaultModel;
  if (discovered && !isKnownOAuthIncompat(discovered)) return discovered;
  return CODEX_CHATGPT_DEFAULT_MODEL;
}

/**
 * Codex-specific model metadata extension.
 *
 * The Codex CLI accepts a fixed set of model strings, but which ones
 * actually resolve depends on the auth mode in use. `apiKeyOnly: true`
 * marks models that the OpenAI API rejects with a 400 when called from
 * a ChatGPT-OAuth account (`auth_mode: "chatgpt"` in `~/.codex/auth.json`).
 * The handler's recovery ladder reads this flag.
 */
export interface CodexModelInfo extends UnifiedModelInfo {
  /** True if this model requires API-key billing (not available on ChatGPT OAuth). */
  apiKeyOnly?: boolean;
}

/**
 * Curated metadata for models we recognise.
 *
 * Order matters: `getSettingsPresentation` lists curated models in
 * this order, and the current flagship is intentionally first — the
 * safe default for Talon-on-Codex deployments where the operator hasn't
 * explicitly picked a model. (`gpt-5.5` held that slot until it was
 * retired for ChatGPT accounts in Sep 2026.)
 *
 * Discovered-but-not-curated ids are appended at the end (synthesised
 * with minimal metadata), so the curated entries always render first.
 */
export const CODEX_MODELS: CodexModelInfo[] = [
  {
    // Flagship of the catalog bundled with codex-cli 0.154 and the floor
    // of the ChatGPT default ladder (`getCodexChatGptDefaultModel`).
    // No context window here: the account's models_cache.json supplies it.
    id: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
  },
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 400_000,
  },
  {
    id: "gpt-5",
    displayName: "GPT-5",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 400_000,
  },
  {
    id: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 400_000,
  },
  {
    id: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 400_000,
    apiKeyOnly: true,
  },
  {
    id: "o4-mini",
    displayName: "o4-mini",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 128_000,
  },
];

/**
 * True when the given model id is in the curated catalog AND flagged
 * as api-key-only. Returns `false` for unknown models — the caller
 * should not over-correct on unrecognised inputs.
 *
 * This is the *static* incompat check — it knows about model ids
 * shipped with the Talon release. The *dynamic* check is
 * `isKnownOAuthIncompat` in `oauth-incompat.ts`, which learns from
 * observed silent-exit failures and persists per-credential.
 *
 * `isCodexOAuthIncompat(id)` below combines both signals.
 */
export function isCodexApiKeyOnlyModel(id: string): boolean {
  return CODEX_MODELS.some((m) => m.id === id && m.apiKeyOnly === true);
}

/**
 * True when `id` is known to fail on a ChatGPT-OAuth credential —
 * either because it's curated as `apiKeyOnly: true` OR because Talon
 * has observed it failing at runtime on the current OAuth account
 * (`oauth-incompat.ts` store).
 *
 * The combined check is what the handler's pre-emptive swap and the
 * picker filter consult. Callers should use this rather than the two
 * underlying predicates to ensure both sources of truth contribute.
 */
export function isCodexOAuthIncompat(id: string): boolean {
  return isCodexApiKeyOnlyModel(id) || isKnownOAuthIncompat(id);
}

/**
 * Return a chatgpt-OAuth-compatible fallback for an OAuth-incompat
 * model id.
 *
 * Returns `undefined` when:
 *   - The id isn't recognised as OAuth-incompat (caller can skip).
 *   - The id IS the resolved ChatGPT default
 *     ({@link getCodexChatGptDefaultModel}) itself — no further fallback
 *     exists; if even the default fails, the credential is the problem,
 *     not the model.
 *
 * For everything else returns the resolved ChatGPT default. (The curated table has only `gpt-5-codex` flagged as
 * `apiKeyOnly: true`; runtime-learned entries cover the rest:
 * `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`, etc.)
 */
export function chatGptFallbackFor(id: string): string | undefined {
  if (!isCodexOAuthIncompat(id)) return undefined;
  const fallback = getCodexChatGptDefaultModel();
  if (id === fallback) return undefined;
  return fallback;
}

/**
 * Synthesize a minimal `CodexModelInfo` for a model id discovered via
 * `/v1/models` or the Codex CLI cache file that isn't in the curated
 * table. Pulls the display name + context window from the discovered
 * metadata map when present (OAuth cache-file path); otherwise
 * derives a sensible display name from the id (api-key /v1/models
 * path is sparse).
 *
 * Pulled out for unit-testability.
 */
export function synthesizeUnknownModel(id: string): CodexModelInfo {
  // Reasoning flag: `o3*` / `o4*` and any `*-codex` are reasoning models.
  // Default to false for anything else (e.g. legacy gpt-4*).
  const reasoning = /^o[3-9]|-codex(\b|$)/i.test(id);
  const meta = getState().discoveredModelMetadata.get(id);
  return {
    id,
    displayName: meta?.displayName || prettifyId(id),
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning,
    ...(meta?.contextWindow ? { contextWindow: meta.contextWindow } : {}),
    ...(meta?.supportedReasoningLevels
      ? { supportedReasoningLevels: meta.supportedReasoningLevels }
      : {}),
    ...(meta?.defaultReasoningLevel
      ? { defaultReasoningLevel: meta.defaultReasoningLevel }
      : {}),
  };
}

function withDiscoveredMetadata(model: CodexModelInfo): CodexModelInfo {
  const meta = getState().discoveredModelMetadata.get(model.id);
  if (!meta) return model;

  return {
    ...model,
    ...(meta.displayName ? { displayName: meta.displayName } : {}),
    ...(meta.contextWindow ? { contextWindow: meta.contextWindow } : {}),
    ...(meta.supportedReasoningLevels
      ? { supportedReasoningLevels: meta.supportedReasoningLevels }
      : {}),
    ...(meta.defaultReasoningLevel
      ? { defaultReasoningLevel: meta.defaultReasoningLevel }
      : {}),
  };
}

function prettifyId(id: string): string {
  // Capitalise `gpt`, leave reasoning prefixes (`o3-`, `o4-`) lowercase
  // (matches OpenAI's house style), preserve everything else verbatim.
  return id.replace(/^gpt-/i, "GPT-").replace(/^chatgpt-/i, "ChatGPT-");
}

/**
 * Return the effective Codex model catalog: curated entries plus any
 * discovered-but-not-curated ids.
 *
 * Semantics:
 *   - When discovery has completed AND returned a non-empty set
 *     (typical `auth-mode: api-key`), the union is
 *     `curated ∩ discovered ∪ (discovered − curated)`, i.e. curated
 *     entries hide if the api key can't see them, and brand-new ids
 *     appear with synthesised metadata. The order is curated-first
 *     (in declaration order) then discovered-only (in iteration order).
 *   - When discovery returned an empty set (OAuth mode, or no api key,
 *     or transient failure), the catalog falls back to the full
 *     curated list.
 *   - The `apiKeyOnly` marker is preserved from curated metadata even
 *     when the model is also discovered — the recovery ladder still
 *     needs to know to swap it out on OAuth retries.
 */
export function getEffectiveModels(): CodexModelInfo[] {
  const state = getState();
  const discovered = state.discoveredModels;

  // Empty discovered set → fall back to curated list. This covers
  // OAuth users (where we deliberately never populate `discoveredModels`),
  // pre-discovery first paints, and transient `/v1/models` failures.
  if (discovered.size === 0) return [...CODEX_MODELS];

  const result: CodexModelInfo[] = [];
  const seen = new Set<string>();
  for (const m of CODEX_MODELS) {
    if (!discovered.has(m.id)) continue;
    result.push(withDiscoveredMetadata(m));
    seen.add(m.id);
  }
  for (const id of discovered) {
    if (seen.has(id)) continue;
    result.push(synthesizeUnknownModel(id));
  }
  return result;
}

/**
 * Auth-mode-aware catalog filter.
 *
 * Returns the catalog with OAuth-incompat models removed when the
 * current auth mode is `chatgpt`. Two filter sources, same as the
 * handler's pre-emptive guard (`isCodexOAuthIncompat`):
 *
 *   - Static curated `apiKeyOnly: true` (e.g. `gpt-5-codex`)
 *   - Runtime-learned via `isKnownOAuthIncompat` (persisted store of
 *     models that explicitly mismatched in the past)
 *
 * When auth mode is `api-key` or `none` (or undefined / not yet
 * resolved), the full catalog is returned — `apiKeyOnly` models are
 * the whole point of an API-key setup.
 *
 * Pure: no IO, just iterates the curated array. Safe to call inside
 * tight render paths (the model picker, /status, etc.).
 *
 * Why filter at presentation rather than at handler-time only: the
 * pre-emptive guard in `handler.ts` already prevents an
 * apiKeyOnly-on-OAuth turn from running, but it does so by silently
 * swapping the model. That's correct as a safety net, but the user
 * shouldn't be able to *select* a model from `/model` that they
 * literally can't use — the picker should reflect what the active
 * credentials can actually call.
 */
export function filterCatalogForAuthMode(
  catalog: CodexModelInfo[],
  authMode: "chatgpt" | "api-key" | "none" | undefined,
): CodexModelInfo[] {
  if (authMode !== "chatgpt") return catalog;
  return catalog.filter((m) => {
    if (m.apiKeyOnly === true) return false;
    if (isKnownOAuthIncompat(m.id)) return false;
    return true;
  });
}

/**
 * Resolve a user query string against the Codex model catalog.
 *
 * Matches by exact id first, then case-insensitive prefix on id or
 * display name across the *effective* (merged) catalog. Returns
 * ambiguous when multiple models match. Async so it can `awaitDiscovery`
 * before searching — without that, a `/model gpt-6` query right after
 * backend startup would miss a model the key actually has.
 */
export async function resolveModel(
  query: string,
): Promise<UnifiedModelResolution> {
  const q = query.trim();
  if (!q) return { kind: "missing" };

  // Wait for any in-flight discovery so a brand-new model id can resolve
  // on the first try. Soft timeout keeps slash-command latency tight.
  await awaitDiscovery();
  const catalog = getEffectiveModels();

  const exact = catalog.find((m) => m.id === q);
  if (exact) return { kind: "exact", model: exact, storedValue: exact.id };

  const qLower = q.toLowerCase();
  const matches = catalog.filter(
    (m) =>
      m.id.toLowerCase().startsWith(qLower) ||
      m.displayName.toLowerCase().startsWith(qLower),
  );

  if (matches.length === 0) return { kind: "missing" };
  if (matches.length === 1) {
    return { kind: "exact", model: matches[0], storedValue: matches[0].id };
  }
  return { kind: "ambiguous", matches };
}

/** Look up a model by stored id, consulting the effective catalog. */
export async function getModelInfo(
  id: string,
): Promise<UnifiedModelInfo | undefined> {
  await awaitDiscovery();
  return getEffectiveModels().find((m) => m.id === id);
}

/**
 * Quick-pick buttons for the `/settings` model picker.
 *
 * Awaits in-flight discovery (3s soft timeout via `awaitDiscovery`)
 * so the first picker render after a backend switch gets the dynamic
 * catalog rather than the curated stub. Subsequent calls short-circuit
 * because the promise has already settled.
 */
export async function getSettingsPresentation(
  activeModel: string,
  options: ModelPickerOptions = {},
): Promise<ModelPickerResult> {
  // Soft-wait for discovery so the catalog is populated before render.
  // If discovery already finished (success or failure), this returns
  // immediately — no extra latency on the steady-state path.
  if (!hasAttemptedDiscovery()) {
    await awaitDiscovery();
  }

  const callbackPrefix = options.callbackPrefix ?? "settings:model:";
  const authMode = getCodexAuthInfo()?.mode;
  const fullCatalog = getEffectiveModels();
  const catalog = filterCatalogForAuthMode(fullCatalog, authMode);
  const hiddenCount = fullCatalog.length - catalog.length;

  const modelButtons: ModelButton[] = catalog.map((m) => ({
    text: `${m.id === activeModel ? "● " : ""}${m.displayName}`,
    callback_data: `${callbackPrefix}${m.id}`,
  }));

  // `active` resolves against the FULL catalog so a chat with a stored
  // OAuth-incompat model id (e.g. someone manually set `gpt-5-codex`
  // before swapping to OAuth) still shows the active-model line in the
  // header — the picker just won't offer that model as a selectable
  // option. The pre-emptive guard in `handler.ts` handles the runtime
  // swap if a turn fires before the user picks something else.
  const active = fullCatalog.find((m) => m.id === activeModel);
  const modelDetails: string[] = [];
  if (active) {
    const ctx = active.contextWindow
      ? ` — ${Math.round(active.contextWindow / 1000)}k ctx`
      : "";
    const oauthNote =
      authMode === "chatgpt" && !catalog.find((m) => m.id === active.id)
        ? " — not selectable on current ChatGPT OAuth credentials"
        : "";
    modelDetails.push(
      `Active: ${active.displayName} (${active.id})${ctx}${oauthNote}`,
    );
  }
  const state = getState();
  const sourceLabel =
    state.discoveredModels.size > 0
      ? `${catalog.length} models (${state.discoveredModels.size} discovered)`
      : `${catalog.length} models (curated)`;
  const hiddenLabel =
    hiddenCount > 0 && authMode === "chatgpt"
      ? `, ${hiddenCount} hidden on OAuth`
      : "";
  modelDetails.push(`Backend: Codex — ${sourceLabel}${hiddenLabel}`);

  return {
    modelButtons,
    modelDetails,
    view: "models",
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 0,
    totalCount: catalog.length,
  };
}

/** List Codex's providers (one — OpenAI). */
export async function getProviders(): Promise<UnifiedProviderInfo[]> {
  await awaitDiscovery();
  const catalog = filterCatalogForAuthMode(
    getEffectiveModels(),
    getCodexAuthInfo()?.mode,
  );
  return [
    {
      id: "openai",
      name: "OpenAI",
      connected: true,
      modelCount: catalog.length,
    },
  ];
}

/** List models for a provider (paginated). */
export async function getProviderModels(
  providerId: string,
  page = 1,
  pageSize = 50,
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  if (providerId !== "openai") return { models: [], total: 0 };
  await awaitDiscovery();
  const catalog = filterCatalogForAuthMode(
    getEffectiveModels(),
    getCodexAuthInfo()?.mode,
  );
  const start = (page - 1) * pageSize;
  return {
    models: catalog.slice(start, start + pageSize),
    total: catalog.length,
  };
}

/** Format a human-readable error for an unresolvable model query. */
export function formatModelError(
  query: string,
  resolution: UnifiedModelResolution,
): string {
  if (resolution.kind === "ambiguous") {
    const list = resolution.matches.map((m) => `\`${m.id}\``).join(", ");
    return `Multiple Codex models match \`${query}\`: ${list}. Pick one.`;
  }
  // Show the auth-mode-aware effective catalog so the hint reflects
  // what the operator's active credentials can actually call.
  const catalog = filterCatalogForAuthMode(
    getEffectiveModels(),
    getCodexAuthInfo()?.mode,
  );
  return (
    `No Codex model matches \`${query}\`. ` +
    `Available: ${catalog.map((m) => m.id).join(", ")}.`
  );
}

/** Filter the catalog by a coarse-grained tag. */
export async function listModels(
  filter?: "free" | "all",
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  // None of Codex's official models are free; the `free` filter
  // returns an empty list so the `/model free` slash-command produces
  // an honest "(no free models)" message.
  if (filter === "free") {
    return { models: [], total: 0 };
  }
  await awaitDiscovery();
  const catalog = filterCatalogForAuthMode(
    getEffectiveModels(),
    getCodexAuthInfo()?.mode,
  );
  return { models: catalog, total: catalog.length };
}
