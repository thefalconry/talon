/**
 * Antigravity model catalog.
 *
 * There is no models API and no cache file to read — the authority is
 * `agy models`, which prints a "Fetching available models..." line
 * followed by one `id<TAB>label` row per model. Talon runs it once at
 * init and re-runs it behind a TTL, so a model Google adds appears
 * without a Talon release.
 *
 * Effort is baked into most ids (`gemini-3.8-flash-high|medium|low`),
 * so the catalog is where `supportedReasoningLevels` comes from too:
 * a model advertises the levels its sibling slugs exist for, plus
 * whatever `--effort` can express. See `effort.ts` for the precedence.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelButton,
  ModelPickerOptions,
  ModelPickerResult,
  ReasoningEffortLevel,
} from "../../core/types.js";
import { logDebug, logWarn } from "../../util/log.js";
import { agyBinary } from "./state.js";
import { AGY_DEFAULT_MODEL } from "./constants.js";
import { effortSuffixOf, modelIdStem } from "./effort.js";

const execFileAsync = promisify(execFile);

/** How long a parsed catalog is reused before `agy models` runs again. */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/** Vendor prefix → Talon provider identity. */
const PROVIDERS: ReadonlyArray<{
  id: string;
  name: string;
  prefixes: readonly string[];
}> = [
  { id: "google", name: "Google", prefixes: ["gemini"] },
  { id: "anthropic", name: "Anthropic", prefixes: ["claude"] },
  { id: "openai", name: "OpenAI", prefixes: ["gpt", "o1", "o3", "o4"] },
];

export type AgyModelInfo = UnifiedModelInfo;

// ── Cache ───────────────────────────────────────────────────────────────────

let catalog: AgyModelInfo[] = [];
let fetchedAt: number | null = null;
let inFlight: Promise<AgyModelInfo[]> | null = null;

/** Drop the cached catalog — test isolation and the cleanup hook. */
export function resetModelCache(): void {
  catalog = [];
  fetchedAt = null;
  inFlight = null;
}

/** The catalog as last parsed, without triggering a probe. */
export function getCachedModels(): AgyModelInfo[] {
  return [...catalog];
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse `agy models` stdout.
 *
 * Tolerates the "Fetching available models..." preamble the CLI prints
 * before the table, blank lines, and any future non-tabbed banner:
 * only lines with a TAB are rows, and an empty id is skipped.
 */
export function parseAgyModels(stdout: string): AgyModelInfo[] {
  const rows: Array<{ id: string; label: string }> = [];
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (!id) continue;
    rows.push({ id, label });
  }
  const byStem = new Map<string, Set<string>>();
  for (const { id } of rows) {
    const suffix = effortSuffixOf(id);
    if (!suffix) continue;
    const stem = modelIdStem(id);
    const set = byStem.get(stem) ?? new Set<string>();
    set.add(suffix);
    byStem.set(stem, set);
  }
  return rows.map(({ id, label }) => toModelInfo(id, label, byStem));
}

function toModelInfo(
  id: string,
  label: string,
  byStem: Map<string, Set<string>>,
): AgyModelInfo {
  const provider = providerFor(id);
  const siblings = byStem.get(modelIdStem(id));
  const suffix = effortSuffixOf(id);
  // Levels this model can actually be run at: the suffixes its sibling
  // slugs exist for, or — for a suffix-less id — the three `--effort`
  // accepts. Ordered low→high so pickers render predictably.
  const levels: ReasoningEffortLevel[] = (
    ["low", "medium", "high"] as const
  ).filter((level) => (siblings ? siblings.has(level) : true));
  return {
    id,
    displayName: label || id,
    provider: provider.id,
    providerName: provider.name,
    selectable: true,
    reasoning: true,
    supportedReasoningLevels: levels,
    ...(suffix ? { defaultReasoningLevel: suffix } : {}),
  };
}

function providerFor(id: string): { id: string; name: string } {
  const lower = id.toLowerCase();
  for (const provider of PROVIDERS) {
    if (provider.prefixes.some((p) => lower.startsWith(p))) {
      return { id: provider.id, name: provider.name };
    }
  }
  return { id: "antigravity", name: "Antigravity" };
}

/**
 * Minimal entry for an id the catalog doesn't list — a model the user
 * pinned by hand, or one that landed between probes. Mirrors codex's
 * `synthesizeUnknownModel`: never hide a configured model from
 * `/status` just because discovery hasn't caught up.
 */
export function synthesizeUnknownModel(id: string): AgyModelInfo {
  const provider = providerFor(id);
  return {
    id,
    displayName: id,
    provider: provider.id,
    providerName: provider.name,
    selectable: true,
    reasoning: true,
    supportedReasoningLevels: ["low", "medium", "high"],
  };
}

// ── Probing ─────────────────────────────────────────────────────────────────

/**
 * Run `agy models` and cache the result. Concurrent callers share one
 * spawn; a failure is logged and leaves the previous catalog in place
 * (an empty one on the very first failure), so a transient network
 * blip degrades the picker rather than breaking a turn.
 */
export async function refreshModels(force = false): Promise<AgyModelInfo[]> {
  const fresh =
    fetchedAt !== null && Date.now() - fetchedAt < CATALOG_TTL_MS && !force;
  if (fresh && catalog.length > 0) return [...catalog];
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const { stdout } = await execFileAsync(agyBinary(), ["models"], {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const parsed = parseAgyModels(stdout);
      if (parsed.length > 0) {
        catalog = parsed;
        fetchedAt = Date.now();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // No `agy` on this host is a configuration fact, not a fault —
      // every Talon install probes at init whether or not agy is used.
      if (isMissingBinary(err)) logDebug("agent", `agy models skipped: ${msg}`);
      else logWarn("agent", `agy models failed: ${msg}`);
    } finally {
      inFlight = null;
    }
    return [...catalog];
  })();
  return inFlight;
}

/** True when the error means the `agy` executable is not installed. */
export function isMissingBinary(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ENOENT|executable not found|command not found/i.test(msg);
}

/**
 * The catalog a model/effort selection resolves against: cached when
 * warm, probed when cold. Callers that must not wait on a spawn (the
 * one-shot runner) read [getCachedModels] directly instead.
 */
export async function catalogForSelection(): Promise<AgyModelInfo[]> {
  return effectiveModels();
}

/** Catalog for read paths: cached when warm, probed when cold. */
async function effectiveModels(): Promise<AgyModelInfo[]> {
  if (catalog.length > 0) return [...catalog];
  return refreshModels();
}

// ── Catalog surface ─────────────────────────────────────────────────────────

/**
 * Resolve a query: exact id, then case-insensitive id, then a prefix
 * match on id or display name. Ambiguity is reported rather than
 * guessed — headless agy exits non-zero on an unknown `--model`, so a
 * wrong guess costs a failed turn.
 */
export async function resolveModel(
  query: string,
): Promise<UnifiedModelResolution> {
  const q = query.trim();
  if (!q) return { kind: "missing" };
  const models = await effectiveModels();

  const exact = models.find((m) => m.id === q);
  if (exact) return { kind: "exact", model: exact, storedValue: exact.id };

  const lower = q.toLowerCase();
  const insensitive = models.find((m) => m.id.toLowerCase() === lower);
  if (insensitive) {
    return { kind: "exact", model: insensitive, storedValue: insensitive.id };
  }

  const matches = models.filter(
    (m) =>
      m.id.toLowerCase().startsWith(lower) ||
      m.displayName.toLowerCase().startsWith(lower),
  );
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length === 1) {
    return { kind: "exact", model: matches[0], storedValue: matches[0].id };
  }
  return { kind: "ambiguous", matches };
}

/** Default model id. */
export function getDefaultModelId(): string {
  return AGY_DEFAULT_MODEL;
}

/** Look up one model, synthesising an entry for an unlisted id. */
export async function getModelInfo(
  id: string,
): Promise<UnifiedModelInfo | undefined> {
  if (!id) return undefined;
  const models = await effectiveModels();
  return models.find((m) => m.id === id) ?? synthesizeUnknownModel(id);
}

/** Quick-pick buttons for `/model` and `/settings`. */
export async function getSettingsPresentation(
  activeModel: string,
  options: ModelPickerOptions = {},
): Promise<ModelPickerResult> {
  const models = await effectiveModels();
  const callbackPrefix = options.callbackPrefix ?? "settings:model:";
  const modelButtons: ModelButton[] = models.map((m) => ({
    text: `${m.id === activeModel ? "● " : ""}${m.displayName}`,
    callback_data: `${callbackPrefix}${m.id}`,
  }));
  const active = models.find((m) => m.id === activeModel);
  const modelDetails = [
    ...(active ? [`Active: ${active.displayName} (${active.id})`] : []),
    `Backend: Antigravity — ${models.length} models (agy models)`,
  ];
  return {
    modelButtons,
    modelDetails,
    view: "models",
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 0,
    totalCount: models.length,
  };
}

/** Providers, grouped by the vendor prefix of each model id. */
export async function getProviders(): Promise<UnifiedProviderInfo[]> {
  const models = await effectiveModels();
  const counts = new Map<string, number>();
  for (const m of models) {
    counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  }
  return [...counts.entries()].map(([id, modelCount]) => ({
    id,
    name: models.find((m) => m.provider === id)?.providerName ?? id,
    connected: true,
    modelCount,
  }));
}

/** Models for one provider (paginated). */
export async function getProviderModels(
  providerId: string,
  page = 1,
  pageSize = 50,
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  const models = (await effectiveModels()).filter(
    (m) => m.provider === providerId,
  );
  const start = (page - 1) * pageSize;
  return {
    models: models.slice(start, start + pageSize),
    total: models.length,
  };
}

/** Human-readable error for an unresolvable model query. */
export function formatModelError(
  query: string,
  resolution: UnifiedModelResolution,
): string {
  if (resolution.kind === "ambiguous") {
    const list = resolution.matches.map((m) => `\`${m.id}\``).join(", ");
    return `Multiple Antigravity models match \`${query}\`: ${list}. Pick one.`;
  }
  const ids = catalog.map((m) => m.id).join(", ");
  return (
    `No Antigravity model matches \`${query}\`. ` +
    (ids
      ? `Available: ${ids}.`
      : "Run `agy models` to see what your account offers.")
  );
}

/**
 * Catalog listing. Antigravity is subscription-backed with no free
 * tier, so `free` is honestly empty rather than aliased to `all`.
 */
export async function listModels(
  filter?: "free" | "all",
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  if (filter === "free") return { models: [], total: 0 };
  const models = await refreshModels();
  return { models, total: models.length };
}
