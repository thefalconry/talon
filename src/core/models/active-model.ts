/**
 * Active-model resolution for a chat.
 *
 * The single source of truth for "what model is this chat actually
 * running on right now?". Every display path (model menu, status,
 * post-callback toast) and every send-time guard routes through here
 * so display, persisted state, and the model handed to the backend
 * agree.
 *
 * Why this module exists
 * ──────────────────────
 *
 * Pre-refactor, callers read `chatSettings.model ?? config.model` —
 * a single global-default fallback that ignored the per-chat backend.
 * That produced two recurring bug classes:
 *
 *   1. **Reset-on-non-default-backend** (Ada, 2026-05-21): chat on
 *      Codex, user hits Reset, code clears the override, read side
 *      returns `config.model = "claude-opus-4-7"`. Codex chat then
 *      tries to run an Anthropic id.
 *
 *   2. **Cross-backend orphan** (2026-05-19): a chat stores a model
 *      that's only valid on backend X, then gets switched to backend
 *      Y. The stored value is honored without validation; Y rejects
 *      it on every turn.
 *
 * Both are solved by (a) storing model picks per-backend and (b)
 * walking an explicit 5-step resolution chain at every read. This
 * module is the chain.
 *
 * Resolution order
 * ────────────────
 *
 * For a chat C on backend B:
 *
 *   1. `modelByBackend[B]` — per-chat-per-backend pick, if it still
 *      validates against B's catalog. Cross-backend orphans surface
 *      as `kind: "missing"` and fall through.
 *   2. `config.backendDefaults[B]` — operator-configured per-backend
 *      default in `talon.json`.
 *   3. `config.model` — only when B is the global chat-role backend
 *      (`config.backend === B`).
 *      Operator picks (2/3) must validate against B's catalog when B
 *      has a canonical default to fall back to; an unknown pin falls
 *      through to step 4 (what the boot-time model audit warns about).
 *   4. `backend.models?.getDefaultModelId()` — backend's canonical default.
 *      Codex picks auth-aware (`gpt-5-codex` on API key, `gpt-5.5`
 *      on ChatGPT OAuth). Claude SDK returns the `"default"` alias.
 *      Stock OpenAI Agents returns a constant.
 *      Catalog-driven backends without a canonical (Kilo, OpenCode,
 *      OpenAI Agents on OpenRouter / custom OpenAI-compatible) do
 *      NOT implement this.
 *   5. `null` → UI renders "No model selected", send guard refuses
 *      with a "use /model to pick one" reply.
 *
 * Validation step: when step 1 has a candidate, `backend.models?.resolveModelInfo`
 * is called. Only `kind: "exact"` with `selectable: true` honours the
 * stored override. Anything else falls through to step 2.
 *
 * Operator config ranks above the canonical so a pinned `config.model`
 * is actually honoured (it used to lose to Claude's `"default"`, so a
 * claude install pinned to any model silently ran the default).
 *
 * Backends with no `resolveModel` (rare — defensive fallback only)
 * have their stored override returned verbatim — no way to validate.
 */

import { getChatModelForBackend } from "../../storage/chat-settings.js";
import type { Backend } from "../agent-runtime/capabilities.js";
import {
  isBackendId,
  makeBareModelRef,
  type CacheSupport,
  type ModelRef,
  type ModelSource,
} from "../agent-runtime/model-ref.js";
import type { UnifiedModelInfo } from "../types.js";
import type { TalonConfig } from "../config/index.js";
import { logWarn } from "../../util/log.js";

/**
 * Reasons `resolveActiveModelForChat` chose its returned value.
 * Surfaced for tests and toast wording — callers can label "Model: X
 * (default)" vs "Model: X (override)" vs "No model selected" without
 * second-guessing the chain.
 */
type ActiveModelSource =
  | "override-valid"
  | "override-invalid-fallback"
  | "backend-canonical"
  | "config-backend-defaults"
  | "config-legacy-global"
  | "none";

export interface ActiveModelResolution {
  /**
   * Resolved model id from the 5-step chain, or `null` when the
   * chain produced no usable default. The dispatcher / send guard
   * compare against `null` to decide whether the chat has a model
   * to run on.
   */
  model: string | null;
  /**
   * Enriched `ModelRef` for the same model — `null` either when
   * `model === null` OR when the supplied `backendId` is not a
   * known `BackendId` (so a typed ref can't be constructed).
   * `/status`, `/model` chrome, and telemetry read the ref's
   * metadata fields (displayName, contextWindow, cacheSupport).
   */
  ref: ModelRef | null;
  source: ActiveModelSource;
}

/**
 * Resolve the model a chat should use on the given backend, validating
 * against the backend's catalog.
 *
 *   - `backend` is the per-chat backend from `resolveChatBackend()`.
 *     Pass `null` when no backend is bound — the resolver falls back
 *     to `config.model` (with source `config-legacy-global`) if set,
 *     else returns `null`.
 *
 *   - `backendId` is the id of the backend (`"codex"`, `"claude"`,
 *     etc) — needed for the `modelByBackend` slot lookup and for
 *     `config.backendDefaults[backendId]`. Pass `null` to skip the
 *     per-backend lookup entirely.
 */
export async function resolveActiveModelForChat(
  chatId: string,
  backend: Backend | null,
  backendId: string | null,
  config: TalonConfig,
): Promise<ActiveModelResolution> {
  const stringPart = await runChain(chatId, backend, backendId, config);
  return {
    ...stringPart,
    ref: await materialiseRef(stringPart.model, backend, backendId),
  };
}

async function runChain(
  chatId: string,
  backend: Backend | null,
  backendId: string | null,
  config: TalonConfig,
): Promise<{ model: string | null; source: ActiveModelSource }> {
  // ── Step 1: per-chat-per-backend override ────────────────────────
  if (backendId) {
    const override = getChatModelForBackend(chatId, backendId);
    if (override) {
      const validated = await validateModelOnBackend(backend, override);
      if (validated) {
        return { model: override, source: "override-valid" };
      }
      warnInvalidOverrideOnce(chatId, backendId, override);
      return stepsTwoThroughFive(
        backend,
        backendId,
        config,
        "override-invalid-fallback",
      );
    }
  }

  // ── Steps 2-5: backendDefaults → config.model (chat-role only) →
  //              backend canonical → null
  return stepsTwoThroughFive(backend, backendId, config, null);
}

/**
 * chat id → the invalid override it was last warned about. A single turn
 * resolves the active model several times (status line, send guard,
 * menu), so an unchanged bad override warns once; picking a different
 * value re-arms the warning for that chat.
 */
const warnedInvalidOverrides = new Map<string, string>();

/** Test seam. */
export function resetInvalidOverrideWarnings(): void {
  warnedInvalidOverrides.clear();
}

function warnInvalidOverrideOnce(
  chatId: string,
  backendId: string,
  override: string,
): void {
  if (warnedInvalidOverrides.get(chatId) === override) return;
  warnedInvalidOverrides.set(chatId, override);
  logWarn(
    "settings",
    `chat=${chatId} backend=${backendId}: per-chat override ` +
      `"${override}" is not a selectable model on this backend. ` +
      `Falling through to backend default.`,
  );
}

async function stepsTwoThroughFive(
  backend: Backend | null,
  backendId: string | null,
  config: TalonConfig,
  fallbackSourceOverride: "override-invalid-fallback" | null,
): Promise<{ model: string | null; source: ActiveModelSource }> {
  const withSource = (model: string, source: ActiveModelSource) => ({
    model,
    source: fallbackSourceOverride ?? source,
  });

  const operatorPick = pickOperatorDefault(backendId, config);
  const canonical = backend?.models ? await safeBackendDefault(backend) : null;

  // Operator config (steps 2/3) beats the backend canonical (step 4): a
  // pinned `config.model` is an explicit choice, and letting the canonical
  // win meant a claude install pinned to e.g. "opus[1m]" silently ran
  // "default" on every turn. The pin must still validate — a withdrawn id
  // falls back to the canonical, exactly what the boot-time model audit
  // warns about. Without a canonical to fall back to, the pin is returned
  // unvalidated (catalog-driven backends with no default, unchanged).
  if (operatorPick) {
    if (!canonical) return withSource(operatorPick.model, operatorPick.source);
    if (await validateModelOnBackend(backend, operatorPick.model)) {
      return withSource(operatorPick.model, operatorPick.source);
    }
  }

  // Step 4: backend.models.getDefaultModelId()
  if (canonical) return withSource(canonical, "backend-canonical");

  // Step 5: null. Callers must render "No model selected" / refuse send.
  return { model: null, source: "none" };
}

/**
 * The operator-configured default for a backend, if any:
 *   - `config.backendDefaults[B]`;
 *   - else `config.model` — only when B is the global chat-role backend
 *     (`config.backend === B`), or when no backend id is known at all
 *     (pre-bootstrap callers passing null).
 */
function pickOperatorDefault(
  backendId: string | null,
  config: TalonConfig,
): { model: string; source: ActiveModelSource } | null {
  if (backendId && config.backendDefaults) {
    const operatorDefault = config.backendDefaults[backendId];
    if (operatorDefault && operatorDefault.length > 0) {
      return { model: operatorDefault, source: "config-backend-defaults" };
    }
  }
  const modelAppliesHere = !backendId || backendId === config.backend;
  if (
    modelAppliesHere &&
    typeof config.model === "string" &&
    config.model.length > 0
  ) {
    return { model: config.model, source: "config-legacy-global" };
  }
  return null;
}

async function validateModelOnBackend(
  backend: Backend | null,
  modelId: string,
): Promise<boolean> {
  if (!backend?.models?.resolveModelInfo) {
    // No catalog to validate against — trust the stored value.
    return true;
  }
  try {
    const resolution = await backend.models.resolveModelInfo(modelId);
    return resolution.kind === "exact" && resolution.model.selectable;
  } catch (err) {
    logWarn(
      "settings",
      `models.resolveModelInfo threw while validating "${modelId}": ` +
        `${err instanceof Error ? err.message : String(err)}. Treating as ` +
        `invalid and falling through.`,
    );
    return false;
  }
}

/**
 * Validate + materialise an *explicit* model id against a backend, bypassing the
 * per-chat resolution chain. Returns the `ModelRef` when the id is a selectable
 * model on the backend, or `null` when it isn't (unknown / not selectable).
 *
 * Used for per-job (trigger/cron) model overrides, which are restricted to the
 * chat's own backend so the wake-up can resume the existing session: at
 * create-time to reject a bad id with a clear error, and at fire-time to fall
 * back gracefully if the catalog changed after the job was created.
 */
export async function resolveExplicitModelRef(
  modelId: string,
  backend: Backend | null,
  backendId: string | null,
): Promise<ModelRef | null> {
  if (!modelId) return null;
  if (!(await validateModelOnBackend(backend, modelId))) return null;
  return materialiseRef(modelId, backend, backendId);
}

async function safeBackendDefault(backend: Backend): Promise<string | null> {
  if (!backend.models?.getDefaultModelId) return null;
  try {
    const v = await backend.models.getDefaultModelId();
    if (typeof v === "string" && v.length > 0) return v;
    return null;
  } catch (err) {
    logWarn(
      "settings",
      `backend.models.getDefaultModelId threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

// ── ref enrichment ──────────────────────────────────────────────────────────

/**
 * Enrich the resolved model id into a `ModelRef`. Returns `null`
 * either when there's no model OR when the backendId isn't a known
 * `BackendId` (e.g. legacy config pointed at an unrecognised
 * backend). Tries the catalog's `getRawModelInfo` first, falls
 * through to `resolveModelInfo`, finally falls back to a bare ref.
 */
async function materialiseRef(
  modelId: string | null,
  backend: Backend | null,
  backendId: string | null,
): Promise<ModelRef | null> {
  if (!modelId) return null;
  if (!backendId || !isBackendId(backendId)) return null;
  const cacheSupport: CacheSupport = mapCacheSupport(backend);

  const catalog = backend?.models;
  if (catalog) {
    try {
      const info = await catalog.getRawModelInfo(modelId);
      if (info) return unifiedToModelRef(info, backendId, cacheSupport);
    } catch (err) {
      logWarn(
        "settings",
        `materialiseRef: getRawModelInfo("${modelId}") threw: ` +
          `${err instanceof Error ? err.message : String(err)}. Falling ` +
          `through to resolveModelInfo.`,
      );
    }
    try {
      const resolution = await catalog.resolveModelInfo(modelId);
      if (resolution.kind === "exact") {
        return unifiedToModelRef(resolution.model, backendId, cacheSupport);
      }
    } catch (err) {
      logWarn(
        "settings",
        `materialiseRef: resolveModelInfo("${modelId}") threw: ` +
          `${err instanceof Error ? err.message : String(err)}. Falling ` +
          `through to bare ref.`,
      );
    }
  }

  const bare = makeBareModelRef(backendId, modelId, "unknown");
  return { ...bare, cacheSupport };
}

function unifiedToModelRef(
  info: UnifiedModelInfo,
  backend: import("../agent-runtime/model-ref.js").BackendId,
  cache: CacheSupport,
): ModelRef {
  return {
    backend,
    id: info.id,
    displayName: info.displayName ?? info.id,
    provider: info.provider,
    source: "discovered" satisfies ModelSource,
    contextWindow: info.contextWindow,
    effortLevels: info.supportedReasoningLevels,
    defaultEffort: info.defaultReasoningLevel,
    cacheSupport: cache,
    selectable: info.selectable,
    free: info.free,
    unavailableReason: info.unavailableReason,
  };
}

function mapCacheSupport(backend: Backend | null): CacheSupport {
  switch (backend?.cacheMetrics) {
    case "read":
      return "read";
    case "readwrite":
      return "readwrite";
    case "none":
    case undefined:
      return "none";
  }
}
