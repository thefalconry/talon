/**
 * Kimi Code CLI model catalog.
 *
 * Models are discovered from `kimi provider list --json`, which lists configured
 * providers and models.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelButton,
  ModelPickerOptions,
  ModelPickerResult,
  ReasoningEffortLevel,
} from "../../core/types.js";
import { logWarn } from "../../util/log.js";
import { kimiBinary } from "./state.js";
import { KIMI_DEFAULT_MODEL } from "./constants.js";
import { kimiConfigPath } from "./auth.js";

const execFileAsync = promisify(execFile);

const CATALOG_TTL_MS = 10 * 60 * 1000;

export type KimiModelInfo = UnifiedModelInfo;

let catalog: KimiModelInfo[] = [];
let fetchedAt: number | null = null;
let inFlight: Promise<KimiModelInfo[]> | null = null;

export function resetModelCache(): void {
  catalog = [];
  fetchedAt = null;
  inFlight = null;
}

export function getCachedModels(): KimiModelInfo[] {
  return [...catalog];
}

interface KimiRawModel {
  provider?: string;
  model?: string;
  maxContextSize?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
  capabilities?: string[];
  displayName?: string;
  reasoningKey?: string;
  supportEfforts?: string[];
}

interface KimiProviderListJson {
  providers?: Record<string, { baseUrl?: string; type?: string; apiKey?: string }>;
  models?: Record<string, KimiRawModel>;
}

export function parseKimiModels(jsonText: string): KimiModelInfo[] {
  let parsed: KimiProviderListJson;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !parsed.models) {
    return [];
  }

  const providers = parsed.providers ?? {};
  const models: KimiModelInfo[] = [];

  for (const [id, raw] of Object.entries(parsed.models)) {
    if (!id || typeof raw !== "object" || !raw) continue;
    const providerId = raw.provider || "kimi";
    const providerObj = providers[providerId];
    const providerName = providerObj?.type
      ? providerObj.type.toUpperCase()
      : providerId;
    const isFree = id.includes(":free") || (raw.model?.includes(":free") ?? false);
    const reasoning =
      raw.capabilities?.includes("thinking") ||
      raw.capabilities?.includes("always_thinking") ||
      false;

    const levels: ReasoningEffortLevel[] = (raw.supportEfforts ?? [
      "low",
      "medium",
      "high",
    ]) as ReasoningEffortLevel[];

    models.push({
      id,
      displayName: raw.displayName || id,
      provider: providerId,
      providerName,
      selectable: true,
      free: isFree,
      reasoning,
      contextWindow: raw.maxContextSize,
      supportedReasoningLevels: levels,
    });
  }

  return models;
}

export function synthesizeUnknownModel(id: string): KimiModelInfo {
  const isFree = id.includes(":free");
  return {
    id,
    displayName: id,
    provider: "kimi",
    providerName: "Kimi",
    selectable: true,
    free: isFree,
    reasoning: true,
    supportedReasoningLevels: ["low", "medium", "high"],
  };
}

export async function refreshModels(force = false): Promise<KimiModelInfo[]> {
  const fresh =
    fetchedAt !== null && Date.now() - fetchedAt < CATALOG_TTL_MS && !force;
  if (fresh && catalog.length > 0) return [...catalog];
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const { stdout } = await execFileAsync(
        kimiBinary(),
        ["provider", "list", "--json"],
        {
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      const parsed = parseKimiModels(stdout);
      if (parsed.length > 0) {
        catalog = parsed;
        fetchedAt = Date.now();
      }
    } catch (err) {
      logWarn(
        "agent",
        `kimi provider list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      inFlight = null;
    }
    return [...catalog];
  })();
  return inFlight;
}

async function effectiveModels(): Promise<KimiModelInfo[]> {
  if (catalog.length > 0) return [...catalog];
  return refreshModels();
}

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

export function getDefaultModelId(): string {
  try {
    const raw = readFileSync(kimiConfigPath(), "utf-8");
    const m = /default_model\s*=\s*"([^"]+)"/.exec(raw);
    if (m?.[1]) return m[1].trim();
  } catch {
    /* fallback */
  }
  return KIMI_DEFAULT_MODEL;
}

export async function getModelInfo(
  id: string,
): Promise<UnifiedModelInfo | undefined> {
  if (!id) return undefined;
  const models = await effectiveModels();
  return models.find((m) => m.id === id) ?? synthesizeUnknownModel(id);
}

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
    `Backend: Kimi — ${models.length} models (kimi provider list --json)`,
  ];
  return {
    modelButtons,
    modelDetails,
    view: "models",
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: models.filter((m) => m.free).length,
    totalCount: models.length,
  };
}

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

export function formatModelError(
  query: string,
  resolution: UnifiedModelResolution,
): string {
  if (resolution.kind === "ambiguous") {
    const list = resolution.matches.map((m) => `\`${m.id}\``).join(", ");
    return `Multiple Kimi models match \`${query}\`: ${list}. Pick one.`;
  }
  const ids = catalog.map((m) => m.id).join(", ");
  return (
    `No Kimi model matches \`${query}\`. ` +
    (ids
      ? `Available: ${ids}.`
      : "Run `kimi provider list` to see what models are configured.")
  );
}

export async function listModels(
  filter?: "free" | "all",
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  const models = await refreshModels();
  const filtered =
    filter === "free" ? models.filter((m) => m.free) : models;
  return { models: filtered, total: filtered.length };
}
