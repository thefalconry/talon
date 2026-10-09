/**
 * Settings sync over the bridge (frontend/native/surface/settings.ts): the
 * allowlist, per-key validation and coercion, live timer re-arming, and
 * the on-disk patch. The companion writes config through this path, so
 * "an unknown key is ignored" and "a bad value leaves the config alone"
 * are the properties that keep a client bug from corrupting talon.json.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "talon-bridge-settings-"));
const configFile = join(dir, "nested", "talon.json");

vi.mock("../util/paths.js", () => ({ files: { config: configFile } }));
vi.mock("../util/log.js", () => ({ log: vi.fn() }));
vi.mock("../util/time.js", () => ({ setTimezone: vi.fn() }));
vi.mock("../util/watchdog.js", () => ({
  getHealthStatus: () => ({
    healthy: true,
    uptimeMs: 1234,
    totalMessagesProcessed: 7,
  }),
}));
vi.mock("../storage/sessions.js", () => ({ getActiveSessionCount: () => 3 }));
vi.mock("../core/models/catalog.js", () => ({
  resolveModel: (id: string) =>
    id === "known" ? { displayName: "Known Model" } : undefined,
}));
vi.mock("../core/background/pulse/pulse.js", () => ({
  startPulseTimer: vi.fn(),
  stopPulseTimer: vi.fn(),
}));
vi.mock("../core/background/heartbeat/index.js", () => ({
  startHeartbeatTimer: vi.fn(),
  stopHeartbeatTimer: vi.fn(),
}));

const { applyConfigUpdate, configSnapshot, EDITABLE } =
  await import("../frontend/native/surface/settings.js");
const { persistConfigPatch } = await import("../core/config/persist.js");
const { setTimezone } = await import("../util/time.js");
const { startPulseTimer, stopPulseTimer } =
  await import("../core/background/pulse/pulse.js");
const { startHeartbeatTimer, stopHeartbeatTimer } =
  await import("../core/background/heartbeat/index.js");
import type { TalonConfig } from "../core/config/index.js";

function fakeConfig(): TalonConfig {
  return {
    backend: "claude",
    frontend: ["native", "telegram"],
    model: "known",
    botDisplayName: "Talon",
    timezone: "UTC",
    pulse: false,
    pulseIntervalMs: 300_000,
    heartbeat: false,
    heartbeatIntervalMinutes: 60,
    dream: true,
  } as unknown as TalonConfig;
}

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(configFile, "utf-8"));
}

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("configSnapshot", () => {
  it("curates the config, resolves the model display name, and reports health", () => {
    const snap = configSnapshot(fakeConfig());
    expect(snap.frontend).toBe("native"); // first of the list
    expect(snap.modelDisplay).toBe("Known Model");
    expect(snap.editable).toEqual([...EDITABLE]);
    expect(snap.health).toMatchObject({
      healthy: true,
      uptimeMs: 1234,
      sessions: 3,
      messages: 7,
    });
    expect(snap.health.memoryMb).toBeGreaterThan(0);
  });

  it("falls back to the raw model id when the catalog does not know it", () => {
    const config = fakeConfig();
    config.model = "custom/unlisted";
    expect(configSnapshot(config).modelDisplay).toBe("custom/unlisted");
  });
});

describe("applyConfigUpdate", () => {
  it("writes only the keys that changed, trimmed, and mutates the live config", () => {
    const config = fakeConfig();
    applyConfigUpdate(config, {
      model: "  new-model  ",
      botDisplayName: " Bot ",
      dream: false,
      backend: "codex", // not editable
      pulseIntervalMs: "fast", // wrong type
    });
    expect(config.model).toBe("new-model");
    expect(config.botDisplayName).toBe("Bot");
    expect(config.dream).toBe(false);
    expect(config.backend).toBe("claude");
    expect(config.pulseIntervalMs).toBe(300_000);
    expect(onDisk()).toEqual({
      model: "new-model",
      botDisplayName: "Bot",
      dream: false,
    });
  });

  it("does not touch the disk when nothing valid was sent", () => {
    applyConfigUpdate(fakeConfig(), { model: "   ", backend: "codex" });
    expect(() => readFileSync(configFile)).toThrow();
  });

  it("applies the timezone live, and clears it on an empty string", () => {
    const config = fakeConfig();
    applyConfigUpdate(config, { timezone: " Europe/London " });
    expect(config.timezone).toBe("Europe/London");
    expect(setTimezone).toHaveBeenLastCalledWith("Europe/London");
    expect(onDisk().timezone).toBe("Europe/London");

    applyConfigUpdate(config, { timezone: "" });
    expect(config.timezone).toBeUndefined();
    expect(setTimezone).toHaveBeenLastCalledWith(undefined);
    // An undefined value removes the key from disk rather than storing null.
    expect("timezone" in onDisk()).toBe(false);
  });

  it("re-arms the pulse timer on toggle and enforces the interval floor", () => {
    const config = fakeConfig();
    applyConfigUpdate(config, { pulse: true, pulseIntervalMs: 90_000.4 });
    expect(config.pulseIntervalMs).toBe(90_000);
    expect(stopPulseTimer).toHaveBeenCalledTimes(1);
    expect(startPulseTimer).toHaveBeenCalledWith(90_000);

    // Below the 60s floor: ignored, and the timer is not re-armed for it.
    vi.clearAllMocks();
    applyConfigUpdate(config, { pulseIntervalMs: 1_000 });
    expect(config.pulseIntervalMs).toBe(90_000);
    expect(stopPulseTimer).not.toHaveBeenCalled();

    applyConfigUpdate(config, { pulse: false });
    expect(stopPulseTimer).toHaveBeenCalledTimes(1);
    expect(startPulseTimer).not.toHaveBeenCalled();
  });

  it("re-arms the heartbeat timer on toggle and enforces the 5-minute floor", () => {
    const config = fakeConfig();
    applyConfigUpdate(config, { heartbeat: true, heartbeatIntervalMinutes: 2 });
    expect(config.heartbeatIntervalMinutes).toBe(60); // 2 < floor, ignored
    expect(stopHeartbeatTimer).toHaveBeenCalledTimes(1);
    expect(startHeartbeatTimer).toHaveBeenCalledWith(60);

    vi.clearAllMocks();
    applyConfigUpdate(config, { heartbeatIntervalMinutes: 15.6 });
    expect(config.heartbeatIntervalMinutes).toBe(16);
    expect(startHeartbeatTimer).toHaveBeenCalledWith(16);
  });
});

describe("persistConfigPatch", () => {
  it("merges into the existing file, creating the directory on first write", () => {
    persistConfigPatch({ a: 1 });
    persistConfigPatch({ b: "two", a: undefined });
    expect(onDisk()).toEqual({ b: "two" });
    expect(readFileSync(configFile, "utf-8").endsWith("\n")).toBe(true);
  });

  it("refuses to write over a corrupt file, leaving it byte-for-byte intact", () => {
    // A hand-edit typo must not turn the next companion toggle into
    // "config.json is now just { fresh: 1 }" — tokens and all gone.
    persistConfigPatch({ keep: true });
    writeFileSync(configFile, '{"botToken": "secret",');
    expect(() => persistConfigPatch({ fresh: 1 })).toThrow(/left untouched/);
    expect(readFileSync(configFile, "utf-8")).toBe('{"botToken": "secret",');
  });

  it("refuses to write over a file whose top level is not an object", () => {
    persistConfigPatch({ keep: true });
    writeFileSync(configFile, "[1, 2]");
    expect(() => persistConfigPatch({ fresh: 1 })).toThrow(/left untouched/);
    expect(readFileSync(configFile, "utf-8")).toBe("[1, 2]");
  });
});
