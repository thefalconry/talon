/**
 * Per-process state for the Kimi backend.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";

/** What `getSessionSnapshot` answers with, per chat. */
export interface KimiSessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  contextModelId?: string;
}

export interface KimiState {
  config: TalonConfig | null;
  gatewayPortFn: () => number;
  frontendName: FrontendName;
  systemPromptOverride: string | null;
  lastUsage: Map<string, KimiSessionUsage>;
}

const state: KimiState = {
  config: null,
  gatewayPortFn: () => 19876,
  frontendName: "telegram",
  systemPromptOverride: null,
  lastUsage: new Map<string, KimiSessionUsage>(),
};

/** Accessor for the shared state object. */
export function getState(): KimiState {
  return state;
}

/** The daemon's loopback bridge URL. */
export function bridgeUrl(): string {
  return `http://127.0.0.1:${state.gatewayPortFn()}`;
}

/**
 * Path to the `kimi` executable: config `kimiBinary`, else the
 * `KIMI_BINARY` env var, else bare `kimi` off PATH.
 */
export function kimiBinary(configBinary?: string): string {
  return (
    process.env.KIMI_BINARY ||
    configBinary ||
    (state.config as { kimiBinary?: string } | null)?.kimiBinary ||
    "kimi"
  );
}

/** Reset everything — test isolation helper and `cleanup` hook. */
export function resetState(): void {
  state.config = null;
  state.gatewayPortFn = () => 19876;
  state.frontendName = "telegram";
  state.systemPromptOverride = null;
  state.lastUsage.clear();
}
