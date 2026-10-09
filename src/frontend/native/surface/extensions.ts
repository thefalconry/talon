/**
 * Extensions over the bridge — plugins and skills, list + toggle.
 *
 * This is what backs the companion app's Plugins and Skills settings
 * sub-menus. Listing is a pure read (core/plugin/manage.ts for plugins,
 * the skill store for skills); a toggle mutates the live state, persists
 * it, and hot-applies so the change is real on the very next turn:
 *
 *   - plugin toggle → merge into talon.json + full plugin reload (same
 *     path as `POST /plugins/reload`), so tools appear/disappear live;
 *   - skill toggle → `.disabled` marker via the skill store + system
 *     prompt rebuild (skills render into the prompt; no plugin reload
 *     needed).
 *
 * Toggles hide capability from the model's default view — they never
 * restrict it. That contract lives in the stores; nothing here adds
 * gating on top.
 */

import type { Backend } from "../../../core/agent-runtime/capabilities.js";
import { performPluginReload } from "../../../core/engine/gateway-actions/plugins.js";
import { getPluginPromptAdditions } from "../../../core/plugin/index.js";
import {
  listPluginItems,
  setPluginEnabled,
} from "../../../core/plugin/manage.js";
import { notifyPromptInputsChanged } from "../../../core/prompt/invalidation.js";
import { listSkills, setSkillEnabled } from "../../../storage/skills.js";
import {
  rebuildSystemPrompt,
  type TalonConfig,
} from "../../../core/config/index.js";
import { persistConfigPatch } from "../../../core/config/persist.js";
import { log } from "../../../util/log.js";
import type { PluginItem, SkillItem, ToggleResult } from "../protocol.js";

export function pluginItems(config: TalonConfig): PluginItem[] {
  return listPluginItems(config);
}

export function skillItems(): SkillItem[] {
  return listSkills().map(({ name, description, enabled }) => ({
    name,
    description,
    enabled,
  }));
}

/**
 * Toggle a plugin: mutate the live config, persist the change, then
 * hot-reload plugins (rebuilds the system prompt and drops per-session
 * prompt snapshots on the way). A reload failure after a successful save
 * is reported as an error — the state is on disk, but the caller must
 * know the daemon hasn't applied it.
 */
export async function togglePlugin(
  config: TalonConfig,
  backend: Backend | null,
  name: string,
  enabled: boolean,
): Promise<ToggleResult> {
  const outcome = setPluginEnabled(config, name, enabled);
  if (!outcome.ok) return { ok: false, error: outcome.error };
  persistConfigPatch(outcome.persist);
  log(
    "native",
    `Plugin ${outcome.name} ${enabled ? "enabled" : "disabled"} via bridge`,
  );
  try {
    await performPluginReload(backend);
  } catch (err) {
    return {
      ok: false,
      error: `Saved, but the hot reload failed: ${err instanceof Error ? err.message : String(err)} — restart Talon to apply.`,
    };
  }
  return { ok: true };
}

/**
 * Toggle a skill: the store drops/creates the `.disabled` marker, then the
 * system prompt is rebuilt so the skill index reflects the change on every
 * chat's next turn. No plugin reload — skills don't carry tools.
 */
export function toggleSkill(
  config: TalonConfig,
  backend: Backend | null,
  name: string,
  enabled: boolean,
): ToggleResult {
  if (!setSkillEnabled(name, enabled)) {
    return { ok: false, error: `No skill named "${name}".` };
  }
  log("native", `Skill ${name} ${enabled ? "enabled" : "disabled"} via bridge`);
  rebuildSystemPrompt(config, getPluginPromptAdditions());
  backend?.control?.updateSystemPrompt?.(config.systemPrompt);
  notifyPromptInputsChanged();
  return { ok: true };
}
