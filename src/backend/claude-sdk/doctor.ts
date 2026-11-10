/**
 * `talon doctor` checks for the Claude SDK backend: the CLI binary, and —
 * only for the backend actually serving chats, since it spawns a probe —
 * the models pinned in config against the static catalog.
 */

import type {
  DoctorCheck,
  DoctorConfigSlice,
} from "../../core/doctor/types.js";
import { getModels } from "../../core/models/catalog.js";
import { binaryOnPath } from "../../util/binary-on-path.js";
import { BACKEND_IDS } from "../../core/agent-runtime/model-ref.js";
import {
  claudeAccountConfigIssues,
  isClaudeAccountId,
} from "../../core/config/claude-accounts.js";
import { resolveModel } from "./model-provider.js";
import { registerClaudeModelsStatic } from "./models/discovery.js";
import { CLAUDE_MODELS_STATIC } from "./models/static.js";

export async function claudeDoctorChecks(
  config: DoctorConfigSlice | undefined,
  isActive: boolean,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (config?.claudeBinary) {
    checks.push(
      binaryOnPath(config.claudeBinary)
        ? {
            label: "Claude Code binary",
            status: "ok",
            detail: config.claudeBinary,
          }
        : {
            label: "Claude Code binary not found",
            status: "fail",
            detail: config.claudeBinary,
          },
    );
  } else {
    checks.push(
      binaryOnPath("claude")
        ? { label: "Claude Code installed", status: "ok" }
        : { label: "Claude Code not found", status: "fail" },
    );
  }
  checks.push(...accountConfigChecks(config));
  // Model resolution spawns a probe — worth it for the backend actually
  // serving chats, wasteful for one nobody is using.
  if (isActive) checks.push(...(await checkConfiguredModels(config)));
  return checks;
}

/**
 * `claudeAccounts` problems the CLI's raw config read doesn't catch on its
 * own (duplicate ids or dirs, backend fields naming an undeclared account).
 * The daemon refuses to start on these; doctor says why first.
 */
function accountConfigChecks(
  config: DoctorConfigSlice | undefined,
): DoctorCheck[] {
  if (!config) return [];
  return claudeAccountConfigIssues(config, BACKEND_IDS).map((issue) => ({
    label: "Claude accounts config",
    status: "fail",
    detail: issue,
    issue: true,
  }));
}

/**
 * Validate models pinned in config against the static catalog. A model
 * that has been withdrawn from the catalog (it happens: deprecations,
 * policy pulls) makes every turn silently run the backend default while
 * the config keeps naming the dead id — this check is where that finally
 * becomes visible. Claude-only: this catalog is a static import; other
 * backends need a live server and are audited at boot instead
 * (core/engine/model-audit.ts).
 */
async function checkConfiguredModels(
  config: DoctorConfigSlice | undefined,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const targets: Array<{ key: string; model?: string; backendId?: string }> = [
    { key: "model", model: config?.model, backendId: config?.backend },
    {
      key: "heartbeatModel",
      model: config?.heartbeatModel,
      backendId: config?.heartbeatBackend ?? config?.backend,
    },
  ];
  try {
    // Doctor runs standalone — live SDK model discovery hasn't happened,
    // so the registry may be empty. Seed the static catalog (the same
    // list the setup wizard offers) so alias pins like "opus" resolve.
    // The static list is a snapshot: a model can exist upstream and not
    // here, which is why findings are warn-level, never fail.
    if (getModels("anthropic").length === 0) {
      registerClaudeModelsStatic(CLAUDE_MODELS_STATIC);
    }
    for (const { key, model, backendId } of targets) {
      if (!model || model === "default") continue;
      const id = backendId ?? "claude";
      if (id !== "claude" && !isClaudeAccountId(id)) continue;
      const res = await resolveModel(model);
      if (res.kind === "exact") {
        checks.push({
          label: `Model (${key}): ${model} → ${res.model.displayName}`,
          status: "ok",
        });
      } else if (res.kind === "ambiguous") {
        checks.push({
          label: `Model (${key}): "${model}" is ambiguous`,
          status: "warn",
          detail: res.matches.map((m) => m.displayName).join(", "),
          issue: true,
        });
      } else {
        checks.push({
          label: `Model (${key}): "${model}" not selectable on claude`,
          status: "warn",
          detail: "turns silently run the backend default — update config.json",
          issue: true,
        });
      }
    }
  } catch {
    /* catalog unavailable — skip, never break doctor */
  }
  return checks;
}
