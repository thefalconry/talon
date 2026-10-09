/**
 * Settings sync — lets a connected client read and change Talon's own
 * configuration, not just per-chat options. This is what pushes the companion
 * past read-only parity with the chat frontends: the app surfaces the daemon's
 * config and writes an allowlisted, safe subset back to `talon.json`, applying
 * the runtime-meaningful ones live (timezone, pulse/heartbeat timers, default
 * model).
 *
 * Only the keys in {@link EDITABLE} are accepted; anything else in an update is
 * ignored. Credentials and structural choices (tokens, backend, frontend) are
 * deliberately NOT editable here — those belong in a deliberate restart.
 */

import type { TalonConfig } from "../../../core/config/index.js";
import { persistConfigPatch } from "../../../core/config/persist.js";
import { setTimezone } from "../../../util/time.js";
import { resolveModel } from "../../../core/models/catalog.js";
import { getHealthStatus } from "../../../util/watchdog.js";
import { getActiveSessionCount } from "../../../storage/sessions.js";
import {
  startPulseTimer,
  stopPulseTimer,
} from "../../../core/background/pulse/pulse.js";
import {
  startHeartbeatTimer,
  stopHeartbeatTimer,
} from "../../../core/background/heartbeat/index.js";
import { log } from "../../../util/log.js";

/** Config keys a client may change through the bridge. */
export const EDITABLE = [
  "model",
  "botDisplayName",
  "timezone",
  "pulse",
  "pulseIntervalMs",
  "heartbeat",
  "heartbeatIntervalMinutes",
  "dream",
] as const;

export type ConfigSnapshot = {
  backend: string;
  frontend: string;
  model: string;
  modelDisplay: string;
  botDisplayName: string;
  timezone: string;
  pulse: boolean;
  pulseIntervalMs: number;
  heartbeat: boolean;
  heartbeatIntervalMinutes: number;
  dream: boolean;
  editable: string[];
  health: {
    healthy: boolean;
    uptimeMs: number;
    sessions: number;
    messages: number;
    memoryMb: number;
  };
};

export function configSnapshot(config: TalonConfig): ConfigSnapshot {
  const h = getHealthStatus();
  return {
    backend: config.backend,
    frontend: Array.isArray(config.frontend)
      ? config.frontend[0]
      : config.frontend,
    model: config.model,
    modelDisplay: resolveModel(config.model)?.displayName ?? config.model,
    botDisplayName: config.botDisplayName,
    timezone: config.timezone ?? "",
    pulse: config.pulse,
    pulseIntervalMs: config.pulseIntervalMs,
    heartbeat: config.heartbeat,
    heartbeatIntervalMinutes: config.heartbeatIntervalMinutes,
    dream: config.dream,
    editable: [...EDITABLE],
    health: {
      healthy: h.healthy,
      uptimeMs: h.uptimeMs,
      sessions: getActiveSessionCount(),
      messages: h.totalMessagesProcessed,
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  };
}

/**
 * Apply an allowlisted config update: validate, mutate the live config object,
 * persist to talon.json, and re-arm runtime timers as needed. Returns the fresh
 * snapshot. Unknown / non-editable keys are ignored.
 */
export function applyConfigUpdate(
  config: TalonConfig,
  update: Record<string, unknown>,
): ConfigSnapshot {
  const allowed = new Set<string>(EDITABLE);
  const persist: Record<string, unknown> = {};
  let pulseChanged = false;
  let heartbeatChanged = false;

  for (const [key, value] of Object.entries(update)) {
    if (!allowed.has(key)) continue;
    switch (key) {
      case "model":
        if (typeof value === "string" && value.trim()) {
          config.model = value.trim();
          persist.model = config.model;
        }
        break;
      case "botDisplayName":
        if (typeof value === "string" && value.trim()) {
          config.botDisplayName = value.trim();
          persist.botDisplayName = config.botDisplayName;
        }
        break;
      case "timezone":
        if (typeof value === "string") {
          config.timezone = value.trim() || undefined;
          setTimezone(config.timezone);
          persist.timezone = config.timezone;
        }
        break;
      case "pulse":
        if (typeof value === "boolean") {
          config.pulse = value;
          persist.pulse = value;
          pulseChanged = true;
        }
        break;
      case "pulseIntervalMs":
        if (typeof value === "number" && value >= 60_000) {
          config.pulseIntervalMs = Math.round(value);
          persist.pulseIntervalMs = config.pulseIntervalMs;
          pulseChanged = true;
        }
        break;
      case "heartbeat":
        if (typeof value === "boolean") {
          config.heartbeat = value;
          persist.heartbeat = value;
          heartbeatChanged = true;
        }
        break;
      case "heartbeatIntervalMinutes":
        if (typeof value === "number" && value >= 5) {
          config.heartbeatIntervalMinutes = Math.round(value);
          persist.heartbeatIntervalMinutes = config.heartbeatIntervalMinutes;
          heartbeatChanged = true;
        }
        break;
      case "dream":
        if (typeof value === "boolean") {
          config.dream = value;
          persist.dream = value;
        }
        break;
    }
  }

  // Re-arm timers so toggles/intervals take effect now, not just next boot.
  if (pulseChanged) {
    stopPulseTimer();
    if (config.pulse) startPulseTimer(config.pulseIntervalMs);
  }
  if (heartbeatChanged) {
    stopHeartbeatTimer();
    if (config.heartbeat) startHeartbeatTimer(config.heartbeatIntervalMinutes);
  }

  if (Object.keys(persist).length > 0) {
    persistConfigPatch(persist);
    log("native", `Config updated: ${Object.keys(persist).join(", ")}`);
  }

  return configSnapshot(config);
}
