/**
 * Field validation shared by the goal, cron and trigger actions: due-date
 * parsing and per-job model-override validation.
 */

import { resolveExplicitModelRef } from "../../models/active-model.js";
import type { Backend } from "../../agent-runtime/capabilities.js";
import {
  acquireBackendInstance,
  getBackendForChat,
  getBackendIdForChat,
  isModelValidForBackend,
} from "../backend-controller/index.js";

/**
 * Parse a goal due date. Accepts ISO 8601 strings (date-only or full
 * timestamp). Returns unix ms, or undefined when unparseable.
 */
export function parseDueDate(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Validate a per-job model override so create_cron_job / trigger_create can
 * reject a bad override up front — the agent retries or tells the user —
 * instead of storing one that fails at fire time.
 *
 * The override is restricted to the chat's own backend so the wake-up can
 * resume the existing session (a session id is backend-specific). The model
 * must therefore be selectable on the chat's backend; returns an error string
 * when it isn't, or `null` when it's valid.
 */
export async function validateJobModelOverride(
  chatKey: string,
  model: string,
): Promise<string | null> {
  try {
    const ref = await resolveExplicitModelRef(
      model,
      getBackendForChat(chatKey),
      getBackendIdForChat(chatKey),
    );
    if (!ref) {
      return (
        `Model "${model}" is not a selectable model on this chat's backend. ` +
        `Leave model unset to use the chat's model, or pick a valid model id ` +
        `on the same backend (cross-backend models aren't allowed — they'd ` +
        `break session continuity).`
      );
    }
    return null;
  } catch (err) {
    return `Could not validate model override: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Validate the model + optional provider override of an isolated one-shot —
 * a cron `query` job or an isolated-mode trigger. The run has no session to
 * keep, so unlike a chat-mode wake it may target a different provider — the
 * backend just has to exist, support isolated (background) runs, and have the
 * model as a selectable id. Same backend (no provider) validates against the
 * chat backend. Returns an error string, or null when valid.
 */
export async function validateIsolatedJobTarget(
  chatKey: string,
  model?: string,
  provider?: string,
): Promise<string | null> {
  // Checked first, for every provider: the isolated runner resolves the
  // model from the spec whenever a provider is named, even the chat's own,
  // so a provider without a model would pass here and then fail every run.
  if (provider && !model) {
    return `A 'provider' override also requires a 'model'.`;
  }
  const chatBackendId = getBackendIdForChat(chatKey);
  if (!provider || provider === chatBackendId) {
    const capabilityErr = validateBackgroundCapability(
      chatBackendId,
      getBackendForChat(chatKey),
    );
    if (capabilityErr) return capabilityErr;
    if (!model) return null;
    return validateJobModelOverride(chatKey, model);
  }

  let acquired: Awaited<ReturnType<typeof acquireBackendInstance>> | null =
    null;
  try {
    acquired = await acquireBackendInstance(provider);
  } catch {
    return `Unknown or unavailable provider "${provider}".`;
  }

  try {
    const capabilityErr = validateBackgroundCapability(
      provider,
      acquired.backend,
    );
    if (capabilityErr) return capabilityErr;
    if (!model) {
      return `A 'provider' override also requires a 'model'.`;
    }
    if (!(await isModelValidForBackend(acquired.backend, model))) {
      return `Model "${model}" is not a selectable model on provider "${provider}".`;
    }
    return null;
  } catch (err) {
    return `Could not validate provider override: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await acquired.release();
  }
}

function validateBackgroundCapability(
  provider: string,
  backend: Backend,
): string | null {
  if (backend.background) return null;
  return `Provider "${provider}" can't run isolated jobs (no background capability).`;
}
