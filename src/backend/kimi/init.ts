/**
 * Kimi backend initialisation.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";
import { log, logWarn } from "../../util/log.js";
import { getState } from "./state.js";
import { detectKimiAuth } from "./auth.js";
import { refreshModels, resetModelCache } from "./models.js";

export function initKimiAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: FrontendName,
): void {
  const state = getState();
  state.config = cfg;
  if (getGatewayPort) state.gatewayPortFn = getGatewayPort;
  if (frontend) state.frontendName = frontend;
  state.systemPromptOverride = null;

  logAuth();
  resetModelCache();
  void refreshModels(true);
}

function logAuth(): void {
  const auth = detectKimiAuth();
  if (!auth.present) {
    logWarn(
      "agent",
      "Kimi: no config file found at " +
        `${auth.path} — run \`kimi provider add\` or \`kimi login\` to configure.`,
    );
    return;
  }
  log(
    "agent",
    `Kimi auth: providers configured (${auth.providers.join(", ")})`,
  );
}
