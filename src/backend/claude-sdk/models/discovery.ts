/**
 * Claude model discovery — spawns throwaway SDK subprocesses, calls
 * `supportedModels()`, unions the results, and registers them in the global
 * model registry. Also the static-registration path for tests / CLI setup.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  registerModels,
  clearModelsByProvider,
  registerProviderPrefix,
} from "../../../core/models/catalog.js";
import type { ModelInfo } from "../../../core/models/catalog.js";
import { log, logError } from "../../../util/log.js";
import { describeSdkModel, type SdkModelInfo } from "./parsing.js";
import { convertSdkModels } from "./convert.js";
import { CLAUDE_RETENTION_SETTINGS } from "../constants.js";

type ProbeOptions = {
  cwd?: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  pathToClaudeCodeExecutable?: string;
  env?: Record<string, string | undefined>;
};

const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_DISCOVERY_SEEDS = 8;

/**
 * The `claude` binary returns "Custom model" for a `model` it doesn't
 * recognise — it echoes the requested id straight back as a passthrough entry
 * with no real metadata. We drop those (except the user's own configured
 * model) so seed probing doesn't pollute the registry with junk families.
 */
const CUSTOM_MODEL_DESCRIPTION = "custom model";

/**
 * Spawn a throwaway SDK subprocess seeded with `seedModel` and return its
 * `supportedModels()` list. The binary always echoes the requested model into
 * the list, so the seed controls which models surface beyond the base set.
 */
async function probeSupportedModels(
  seedModel: string,
  probeOptions: ProbeOptions,
): Promise<SdkModelInfo[]> {
  const abort = new AbortController();
  let drainPromise: Promise<void> | undefined;

  try {
    const neverYield = async function* (): AsyncGenerator<never> {
      await new Promise<never>((_, reject) => {
        abort.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
      // Unreachable — the promise above only ever rejects. The yield* both
      // satisfies require-yield and documents that this stream produces
      // nothing by design (streaming-input mode with no user message).
      yield* [] as never[];
    };

    const q = query({
      prompt: neverYield(),
      options: {
        ...probeOptions,
        // Any spawned CLI may run the daily retention sweep.
        settings: { ...CLAUDE_RETENTION_SETTINGS },
        model: seedModel,
        abortController: abort,
      } as Parameters<typeof query>[0]["options"],
    });

    drainPromise = (async () => {
      try {
        for await (const _ of q) {
          /* discard */
        }
      } catch {
        /* expected on abort */
      }
    })();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new Error(
              `model discovery timed out after 15s (seed "${seedModel}")`,
            ),
          ),
        DISCOVERY_TIMEOUT_MS,
      );
    });

    try {
      return await Promise.race([q.supportedModels(), timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      abort.abort();
      await drainPromise.catch(() => {});
    }
  } catch (err) {
    abort.abort();
    if (drainPromise) await drainPromise.catch(() => {});
    throw err;
  }
}

/**
 * Merge probe results into one list, first-occurrence-wins by value, dropping
 * unrecognised "Custom model" passthrough echoes (but always keeping the user's
 * configured model even if the binary treats it as custom).
 */
function unionSdkModels(
  lists: readonly SdkModelInfo[][],
  configuredModel: string,
): SdkModelInfo[] {
  const byValue = new Map<string, SdkModelInfo>();
  for (const list of lists) {
    for (const model of list) {
      if (byValue.has(model.value)) continue;
      const isPassthroughJunk =
        (model.description ?? "").trim().toLowerCase() ===
          CUSTOM_MODEL_DESCRIPTION && model.value !== configuredModel;
      if (isPassthroughJunk) continue;
      byValue.set(model.value, model);
    }
  }
  return [...byValue.values()];
}

/**
 * Discover available models from the Claude Agent SDK and register them.
 *
 * Discovery is a union of probes. The binary only echoes the *requested* model
 * (and a small base set) from `supportedModels()`, so a single probe misses
 * the base-vs-1M counterpart of most families. We therefore probe the
 * configured model first (mandatory), then best-effort re-probe each real
 * family alias it revealed, and union the results. Throws only if the
 * mandatory first probe fails — if the SDK can't provide models, Talon cannot
 * function.
 */
export async function registerClaudeModels(sdkOptions: {
  model: string;
  cwd?: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  pathToClaudeCodeExecutable?: string;
  /** The account's spawn environment (extra Claude accounts only). */
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const { model: configuredModel, ...probeOptions } = sdkOptions;

  try {
    // Pass 1 (mandatory): the configured model is always echoed back.
    const primary = await probeSupportedModels(configuredModel, probeOptions);
    if (primary.length === 0) {
      throw new Error("SDK returned empty model list");
    }

    // Pass 2 (best-effort): re-probe each real family alias from pass 1 to coax
    // out the context variants the first probe didn't echo. Bare family aliases
    // (e.g. "opus") return real metadata; unrecognised ones come back as
    // "Custom model" and are filtered by unionSdkModels.
    const seeds = new Set<string>();
    for (const model of primary) {
      const { family } = describeSdkModel(model);
      if (family && family !== "default") seeds.add(family);
    }
    seeds.delete(configuredModel);

    const seedList = [...seeds].slice(0, MAX_DISCOVERY_SEEDS);
    const secondary = await Promise.allSettled(
      seedList.map((seed) => probeSupportedModels(seed, probeOptions)),
    );
    const extraLists = secondary
      .filter(
        (result): result is PromiseFulfilledResult<SdkModelInfo[]> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);

    const union = unionSdkModels([primary, ...extraLists], configuredModel);
    const models = convertSdkModels(union);
    clearModelsByProvider("anthropic");
    registerProviderPrefix("claude-");
    registerModels(models);
    log(
      "agent",
      `Discovered ${models.length} models from SDK ` +
        `(${1 + extraLists.length}/${1 + seedList.length} probes): ` +
        models.map((m) => m.id).join(", "),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("agent", `Fatal: model discovery failed — ${msg}`);
    throw new Error(
      `Claude SDK model discovery failed: ${msg}. ` +
        `Check that Claude Code is installed and your API key is valid.`,
    );
  }
}

/**
 * Register models from a static list. For use in tests and the CLI setup
 * wizard where the SDK subprocess is not available.
 */
export function registerClaudeModelsStatic(models: ModelInfo[]): void {
  registerProviderPrefix("claude-");
  registerModels(models);
}
