/**
 * Model provider methods for the Claude SDK backend.
 *
 * Implements the optional model methods from Backend by delegating
 * to the core model registry. The Claude SDK exposes a single provider
 * ("anthropic") with models discovered from the SDK at startup.
 */

import {
  getModel,
  getModels,
  resolveModel as coreResolveModel,
  resolveModelId,
} from "../../core/models/catalog.js";
import type { ModelInfo } from "../../core/models/catalog.js";
import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelButton,
  ModelPickerOptions,
  ModelPickerResult,
} from "../../core/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const PROVIDER_ID = "anthropic";
const PROVIDER_NAME = "Anthropic";

function toUnified(model: ModelInfo): UnifiedModelInfo {
  return {
    id: model.id,
    displayName: model.displayName,
    provider: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    selectable: true,
    supportedReasoningLevels: model.supportedReasoningLevels,
    defaultReasoningLevel: model.defaultReasoningLevel,
  };
}

/**
 * De-duplicate models by displayName. Base and 1M variants carry distinct
 * labels ("Sonnet 4.6" vs "Sonnet 4.6 (1M context)"), so both survive here;
 * this only guards against accidental collisions.
 */
function getUniqueModels(): ModelInfo[] {
  const options: ModelInfo[] = [];
  const seenKeys = new Set<string>();

  for (const model of getModels(PROVIDER_ID)) {
    const key = model.displayName.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    options.push(model);
  }

  return options;
}

function isSelectedModel(currentModel: string, candidateId: string): boolean {
  const current = coreResolveModel(currentModel);
  const candidate = coreResolveModel(candidateId);
  if (current && candidate) {
    return (
      current.displayName.toLowerCase() === candidate.displayName.toLowerCase()
    );
  }
  return resolveModelId(currentModel) === candidateId;
}

// ── Public API ─────────────────────────────────────────────────────────────

const ONE_MILLION_SUFFIX = "[1m]";

/**
 * Split a `[1m]` context-variant suffix off a query ("opus[1m]" →
 * { stem: "opus", oneMillion: true }). Claude Code accepts the suffix on
 * any alias or id; the SDK's `supportedModels()` list does not enumerate
 * the suffixed forms, so the catalog can't match them directly.
 */
function splitOneMillion(query: string): { stem: string; oneMillion: boolean } {
  const trimmed = query.trim();
  if (trimmed.toLowerCase().endsWith(ONE_MILLION_SUFFIX)) {
    return {
      stem: trimmed.slice(0, -ONE_MILLION_SUFFIX.length).trim(),
      oneMillion: true,
    };
  }
  return { stem: trimmed, oneMillion: false };
}

/**
 * Exact-match a query against the registry: its id/alias directly, or —
 * for a `[1m]` query the registry doesn't list — the base model, returned
 * as a 1M variant whose id keeps the suffix so the SDK actually selects
 * the 1M context window.
 *
 * The SDK reports no context-window metadata per model, so there's no
 * evidence to reject a `[1m]` request on; the binary is the authority.
 * The one form refused is `default[1m]`: "default" is a moving target,
 * not an alias Claude Code suffixes.
 */
function resolveExactUnified(query: string): UnifiedModelInfo | undefined {
  const direct = getModel(resolveModelId(query));
  if (direct) return toUnified(direct);

  const { stem, oneMillion } = splitOneMillion(query);
  if (!oneMillion || !stem) return undefined;
  const baseId = resolveModelId(stem);
  const base = getModel(baseId);
  if (!base || stem.toLowerCase() === "default") return undefined;

  // Pass the SDK a form it knows: the canonical id when it's concrete, the
  // user's own stem when the canonical is the "default" alias (e.g. "opus"
  // folds into "default" when default currently serves Opus).
  const sdkStem = baseId === "default" ? stem : baseId;
  const displayName = /\(1m context\)/i.test(base.displayName)
    ? base.displayName
    : `${base.displayName} (1M context)`;
  return {
    ...toUnified(base),
    id: `${sdkStem}${ONE_MILLION_SUFFIX}`,
    displayName,
    contextWindow: 1_000_000,
  };
}

export async function resolveModel(
  query: string,
): Promise<UnifiedModelResolution> {
  const exact = resolveExactUnified(query);
  if (exact) {
    return { kind: "exact", model: exact, storedValue: exact.id };
  }

  // No exact match -- try a substring search across display names and aliases
  const allModels = getModels(PROVIDER_ID);
  const lower = query.toLowerCase();
  const matches = allModels.filter(
    (m) =>
      m.displayName.toLowerCase().includes(lower) ||
      m.aliases.some((a) => a.toLowerCase().includes(lower)),
  );

  if (matches.length === 1) {
    return {
      kind: "exact",
      model: toUnified(matches[0]),
      storedValue: matches[0].id,
    };
  }

  if (matches.length > 1) {
    return { kind: "ambiguous", matches: matches.map(toUnified) };
  }

  return { kind: "missing" };
}

export async function getModelInfo(
  id: string,
): Promise<UnifiedModelInfo | undefined> {
  return resolveExactUnified(id);
}

export async function getSettingsPresentation(
  activeModel: string,
  options: ModelPickerOptions = {},
): Promise<ModelPickerResult> {
  const callbackPrefix = options.callbackPrefix ?? "settings:model:";
  const models = getUniqueModels();

  const modelButtons: ModelButton[] = models.map((m) => {
    const selected = isSelectedModel(activeModel, m.id);
    return {
      text: selected ? `\u2713 ${m.displayName}` : m.displayName,
      callback_data: `${callbackPrefix}${m.id}`,
    };
  });

  // Claude SDK ships a small, curated set \u2014 pagination and the
  // free-tier filter aren't meaningful here. We honour the contract
  // by returning fixed metadata; the frontend won't render Prev/Next
  // when totalPages === 1.
  return {
    modelButtons,
    modelDetails: [],
    view: "models",
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 0,
    totalCount: models.length,
  };
}

export async function getProviders(): Promise<UnifiedProviderInfo[]> {
  const models = getModels(PROVIDER_ID);
  return [
    {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      connected: true,
      modelCount: models.length,
    },
  ];
}

export async function getProviderModels(
  providerId: string,
  page = 1,
  pageSize = 20,
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  if (providerId !== PROVIDER_ID) {
    return { models: [], total: 0 };
  }

  const all = getModels(PROVIDER_ID).map(toUnified);
  const start = (page - 1) * pageSize;
  return {
    models: all.slice(start, start + pageSize),
    total: all.length,
  };
}

export async function listModels(
  filter?: "free" | "all",
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  // Claude SDK models are all paid — the "free" filter returns nothing.
  if (filter === "free") return { models: [], total: 0 };
  const all = getModels(PROVIDER_ID).map(toUnified);
  return { models: all, total: all.length };
}

export function formatModelError(
  query: string,
  resolution: UnifiedModelResolution,
): string {
  if (resolution.kind === "ambiguous") {
    const names = resolution.matches.map((m) => m.displayName).join(", ");
    return `Ambiguous model "${query}" -- did you mean one of: ${names}?`;
  }

  if (resolution.kind === "missing") {
    const available = getModels(PROVIDER_ID)
      .map((m) => m.displayName)
      .join(", ");
    return `Unknown model "${query}". Available models: ${available}`;
  }

  return `Could not resolve model "${query}".`;
}
