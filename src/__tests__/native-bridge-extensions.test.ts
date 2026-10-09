/**
 * Plugin and skill toggles over the bridge
 * (frontend/native/surface/extensions.ts).
 * The stores own the toggle semantics; what this module adds is the
 * apply-live step — persist, hot-reload, rebuild the prompt — and the
 * error contract around it. Those are what is pinned here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({ log: vi.fn() }));
vi.mock("../core/engine/gateway-actions/plugins.js", () => ({
  performPluginReload: vi.fn(async () => {}),
}));
vi.mock("../core/plugin/index.js", () => ({
  getPluginPromptAdditions: vi.fn(() => "PLUGIN PROMPT"),
}));
vi.mock("../core/plugin/manage.js", () => ({
  listPluginItems: vi.fn(() => [{ name: "github", enabled: true }]),
  setPluginEnabled: vi.fn(),
}));
vi.mock("../core/prompt/invalidation.js", () => ({
  notifyPromptInputsChanged: vi.fn(),
}));
vi.mock("../storage/skills.js", () => ({
  listSkills: vi.fn(() => [
    { name: "deploy", description: "Ship it", enabled: true, path: "/x" },
  ]),
  setSkillEnabled: vi.fn(),
}));
vi.mock("../core/config/index.js", () => ({ rebuildSystemPrompt: vi.fn() }));
vi.mock("../core/config/persist.js", () => ({
  persistConfigPatch: vi.fn(),
}));

const { pluginItems, skillItems, togglePlugin, toggleSkill } =
  await import("../frontend/native/surface/extensions.js");
const { performPluginReload } =
  await import("../core/engine/gateway-actions/plugins.js");
const { setPluginEnabled } = await import("../core/plugin/manage.js");
const { setSkillEnabled } = await import("../storage/skills.js");
const { rebuildSystemPrompt } = await import("../core/config/index.js");
const { persistConfigPatch } = await import("../core/config/persist.js");
const { notifyPromptInputsChanged } =
  await import("../core/prompt/invalidation.js");
import type { TalonConfig } from "../core/config/index.js";
import type { Backend } from "../core/agent-runtime/capabilities.js";

const config = { systemPrompt: "old" } as unknown as TalonConfig;
const updateSystemPrompt = vi.fn();
const backend = {
  control: { updateSystemPrompt },
} as unknown as Backend;

beforeEach(() => vi.clearAllMocks());

describe("listing", () => {
  it("delegates plugins to the manager and projects skills to the wire shape", () => {
    expect(pluginItems(config)).toEqual([{ name: "github", enabled: true }]);
    // `path` is store-internal and must not leak to the client.
    expect(skillItems()).toEqual([
      { name: "deploy", description: "Ship it", enabled: true },
    ]);
  });
});

describe("togglePlugin", () => {
  it("persists the store's patch and hot-reloads on success", async () => {
    vi.mocked(setPluginEnabled).mockReturnValue({
      ok: true,
      name: "github",
      persist: { plugins: { github: { enabled: false } } },
    } as never);
    const result = await togglePlugin(config, backend, "github", false);
    expect(result).toEqual({ ok: true });
    expect(persistConfigPatch).toHaveBeenCalledWith({
      plugins: { github: { enabled: false } },
    });
    expect(performPluginReload).toHaveBeenCalledWith(backend);
  });

  it("passes the store's refusal through without persisting or reloading", async () => {
    vi.mocked(setPluginEnabled).mockReturnValue({
      ok: false,
      error: "No plugin named nope.",
    } as never);
    const result = await togglePlugin(config, backend, "nope", true);
    expect(result).toEqual({ ok: false, error: "No plugin named nope." });
    expect(persistConfigPatch).not.toHaveBeenCalled();
    expect(performPluginReload).not.toHaveBeenCalled();
  });

  it("reports a failed reload as an error so the client knows disk and daemon disagree", async () => {
    vi.mocked(setPluginEnabled).mockReturnValue({
      ok: true,
      name: "github",
      persist: {},
    } as never);
    vi.mocked(performPluginReload).mockRejectedValueOnce(new Error("boom"));
    const result = await togglePlugin(config, backend, "github", true);
    expect(persistConfigPatch).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Saved, but the hot reload failed: boom");
  });
});

describe("toggleSkill", () => {
  it("rebuilds the prompt, pushes it to the backend, and invalidates snapshots", () => {
    vi.mocked(setSkillEnabled).mockReturnValue(true);
    vi.mocked(rebuildSystemPrompt).mockImplementation((cfg) => {
      (cfg as { systemPrompt: string }).systemPrompt = "rebuilt";
    });
    expect(toggleSkill(config, backend, "deploy", false)).toEqual({ ok: true });
    expect(setSkillEnabled).toHaveBeenCalledWith("deploy", false);
    expect(rebuildSystemPrompt).toHaveBeenCalledWith(config, "PLUGIN PROMPT");
    expect(updateSystemPrompt).toHaveBeenCalledWith("rebuilt");
    expect(notifyPromptInputsChanged).toHaveBeenCalledTimes(1);
  });

  it("names the missing skill and changes nothing when the store refuses", () => {
    vi.mocked(setSkillEnabled).mockReturnValue(false);
    expect(toggleSkill(config, null, "ghost", true)).toEqual({
      ok: false,
      error: 'No skill named "ghost".',
    });
    expect(rebuildSystemPrompt).not.toHaveBeenCalled();
  });

  it("tolerates a backend without a control slot", () => {
    vi.mocked(setSkillEnabled).mockReturnValue(true);
    expect(toggleSkill(config, null, "deploy", true)).toEqual({ ok: true });
  });
});
