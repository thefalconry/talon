/**
 * Antigravity reasoning-effort vocabulary.
 *
 * agy expresses effort in two places at once, and the precedence
 * between them is the whole content of this module:
 *
 *   1. **Baked into the model id.** Most slugs carry the level as a
 *      suffix — `gemini-3.8-flash-high`, `gemini-4-argon-low`. Picking
 *      such an id IS picking an effort.
 *   2. **The `--effort` flag.** Since agy 1.4 the CLI validates the
 *      pair: `--model gemini-3.8-flash-high --effort medium` exits 1
 *      with `--model gemini-3.8-flash-high conflicts with
 *      --effort=medium`, while the bare stem (`--model gemini-3.8-flash
 *      --effort medium`) and a matching pair are both accepted.
 *
 * Precedence Talon applies ([selectAgyRun] → [composeAgyModelSelection]): a requested
 * level re-points a suffixed id at the sibling slug carrying that
 * suffix (so the picker keeps showing the model actually in use) and
 * then sends NO `--effort` — the id already says it. A suffix-less id
 * (`claude-sonnet-5-5`, `gemini-3.8-flash`) gets `--effort` instead.
 * A suffixed id whose requested sibling the catalog does not list
 * keeps its own baked level with no flag, rather than sending a pair
 * the CLI rejects. Levels agy cannot express (`off`, `minimal`, and
 * `xhigh` / `max`, which no current model offers) fall through to the
 * model's own default — the same "let the model decide" behaviour
 * codex's mapping produces.
 */

import type {
  ReasoningEffortLevel,
  UnifiedModelInfo,
} from "../../core/types.js";

/** The three levels `--effort` accepts. */
export type AgyEffort = "low" | "medium" | "high";

const AGY_EFFORTS: readonly AgyEffort[] = ["low", "medium", "high"];

/** True for one of the three suffixes agy bakes into model ids. */
function isAgyEffort(value: string): value is AgyEffort {
  return (AGY_EFFORTS as readonly string[]).includes(value);
}

/**
 * Map a canonical level onto `--effort`, or undefined when agy has no
 * way to express it (`off` / `minimal` / `xhigh` / `max`, or nothing
 * requested).
 */
export function toAgyEffort(
  level: ReasoningEffortLevel | undefined,
): AgyEffort | undefined {
  if (!level) return undefined;
  return isAgyEffort(level) ? level : undefined;
}

/** The effort suffix baked into a model id, if it has one. */
export function effortSuffixOf(modelId: string): AgyEffort | undefined {
  const tail = modelId.slice(modelId.lastIndexOf("-") + 1);
  return isAgyEffort(tail) ? tail : undefined;
}

/** The model id with any effort suffix stripped. */
export function modelIdStem(modelId: string): string {
  const suffix = effortSuffixOf(modelId);
  return suffix ? modelId.slice(0, -(suffix.length + 1)) : modelId;
}

/**
 * Re-point a model id at the sibling slug carrying `effort`, when such
 * a sibling exists in `catalogIds`. Returns the original id when the
 * model has no effort suffix, when the sibling isn't offered, or when
 * no effort was requested — never invents an id the CLI would reject
 * (headless agy exits non-zero on an unknown `--model`).
 */
export function applyEffortToModelId(
  modelId: string,
  effort: AgyEffort | undefined,
  catalogIds: readonly string[],
): string {
  if (!effort) return modelId;
  if (!effortSuffixOf(modelId)) return modelId;
  const candidate = `${modelIdStem(modelId)}-${effort}`;
  return catalogIds.includes(candidate) ? candidate : modelId;
}

/** The model id and `--effort` value one agy run is spawned with. */
export interface AgyModelSelection {
  model: string;
  effort: AgyEffort | undefined;
  /**
   * The requested level, when it could not be honoured — agy has no
   * equivalent, or honouring it would need a model/effort pair the CLI
   * rejects. Callers log it; the run uses the model's own default.
   */
  dropped?: string;
}

/**
 * Compose the `--model` / `--effort` pair for one run so the CLI never
 * sees a conflicting combination (see the module comment for why).
 *
 *   - no effort requested       → the id as-is, no flag
 *   - suffix-less id            → the id + `--effort <level>`
 *   - suffix already matches    → the id, no flag
 *   - sibling slug in catalog   → the sibling, no flag
 *   - sibling not in catalog    → the id as-is, no flag, `dropped` set
 */
export function composeAgyModelSelection(
  modelId: string,
  effort: AgyEffort | undefined,
  catalogIds: readonly string[],
): AgyModelSelection {
  if (!effort) return { model: modelId, effort: undefined };
  const suffix = effortSuffixOf(modelId);
  if (!suffix) return { model: modelId, effort };
  if (suffix === effort) return { model: modelId, effort: undefined };
  const sibling = applyEffortToModelId(modelId, effort, catalogIds);
  if (sibling !== modelId) return { model: sibling, effort: undefined };
  return { model: modelId, effort: undefined, dropped: effort };
}

/**
 * The `--model` / `--effort` pair one run is spawned with, resolved
 * against the given catalog. Every spawn path — the chat child, the
 * post-reset warm-up and the one-shot runner — goes through here, so
 * none of them can send a combination the CLI rejects.
 *
 * The level is only kept when the model advertises it (its sibling
 * slugs, or low/medium/high for an id the catalog doesn't list). An
 * empty catalog (probe failed, not run yet) degrades to "keep the
 * configured id, drop a conflicting level" rather than a doomed spawn.
 */
export function selectAgyRun(
  model: string,
  requested: ReasoningEffortLevel | undefined,
  catalog: readonly UnifiedModelInfo[],
): AgyModelSelection {
  if (!requested) return { model, effort: undefined };
  const levels = catalog.find((m) => m.id === model)
    ?.supportedReasoningLevels ?? ["low", "medium", "high"];
  const effort = toAgyEffort(requested);
  if (!effort || !levels.includes(effort)) {
    return { model, effort: undefined, dropped: requested };
  }
  return composeAgyModelSelection(
    model,
    effort,
    catalog.map((m) => m.id),
  );
}
