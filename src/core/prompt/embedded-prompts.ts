// AUTO-GENERATED FILE — DO NOT EDIT.
// Source of truth: the .md files under prompts/.
// Regenerate with `npm run build:prompts` (drift-guarded by prompts-embed.test.ts).
//
// Each prompt is embedded as a real file asset via the Bun-only
// `with { type: "file" }` import attribute, so `bun build --compile`
// carries the .md bytes inside the binary (read back with readFileSync)
// without stringifying prose into source. Reached ONLY through the `bun`
// condition of the `#prompt-assets` import in package.json — tsx/node/tsc
// load disk-prompts.ts instead.
import { readFileSync } from "node:fs";

import asset0 from "../../../prompts/README.md" with { type: "file" };
import asset1 from "../../../prompts/base.md" with { type: "file" };
import asset2 from "../../../prompts/discord.md" with { type: "file" };
import asset3 from "../../../prompts/dream.md" with { type: "file" };
import asset4 from "../../../prompts/heartbeat.md" with { type: "file" };
import asset5 from "../../../prompts/identity.md" with { type: "file" };
import asset6 from "../../../prompts/mem0.md" with { type: "file" };
import asset7 from "../../../prompts/mempalace.md" with { type: "file" };
import asset8 from "../../../prompts/native.md" with { type: "file" };
import asset9 from "../../../prompts/system/agent-brief.md" with { type: "file" };
import asset10 from "../../../prompts/system/contract-text-only.md" with { type: "file" };
import asset11 from "../../../prompts/system/contract-text-or-tools.md" with { type: "file" };
import asset12 from "../../../prompts/system/contract-text-preferred.md" with { type: "file" };
import asset13 from "../../../prompts/system/contract-tool-only.md" with { type: "file" };
import asset14 from "../../../prompts/system/cron.md" with { type: "file" };
import asset15 from "../../../prompts/system/daily-memory.md" with { type: "file" };
import asset16 from "../../../prompts/system/goals.md" with { type: "file" };
import asset17 from "../../../prompts/system/heartbeat-agent.md" with { type: "file" };
import asset18 from "../../../prompts/system/live-state.md" with { type: "file" };
import asset19 from "../../../prompts/system/memory-core-view.md" with { type: "file" };
import asset20 from "../../../prompts/system/memory-recall.md" with { type: "file" };
import asset21 from "../../../prompts/system/persistent-memory.md" with { type: "file" };
import asset22 from "../../../prompts/system/skills.md" with { type: "file" };
import asset23 from "../../../prompts/system/triggers.md" with { type: "file" };
import asset24 from "../../../prompts/system/workspace.md" with { type: "file" };
import asset25 from "../../../prompts/teams.md" with { type: "file" };
import asset26 from "../../../prompts/telegram.md" with { type: "file" };
import asset27 from "../../../prompts/terminal.md" with { type: "file" };
import asset28 from "../../../prompts/whatsapp.md" with { type: "file" };

/** rel path (posix, under prompts/) → embedded file path (/$bunfs/… when compiled). */
const ASSETS: Record<string, string> = {
  "README.md": asset0,
  "base.md": asset1,
  "discord.md": asset2,
  "dream.md": asset3,
  "heartbeat.md": asset4,
  "identity.md": asset5,
  "mem0.md": asset6,
  "mempalace.md": asset7,
  "native.md": asset8,
  "system/agent-brief.md": asset9,
  "system/contract-text-only.md": asset10,
  "system/contract-text-or-tools.md": asset11,
  "system/contract-text-preferred.md": asset12,
  "system/contract-tool-only.md": asset13,
  "system/cron.md": asset14,
  "system/daily-memory.md": asset15,
  "system/goals.md": asset16,
  "system/heartbeat-agent.md": asset17,
  "system/live-state.md": asset18,
  "system/memory-core-view.md": asset19,
  "system/memory-recall.md": asset20,
  "system/persistent-memory.md": asset21,
  "system/skills.md": asset22,
  "system/triggers.md": asset23,
  "system/workspace.md": asset24,
  "teams.md": asset25,
  "telegram.md": asset26,
  "terminal.md": asset27,
  "whatsapp.md": asset28,
};

/** Read an embedded prompt by its rel path (e.g. "system/cron.md"). */
export function readPromptAsset(rel: string): string {
  const path = ASSETS[rel];
  if (path === undefined) {
    throw new Error(`embedded prompt asset not found: ${rel}`);
  }
  return readFileSync(path, "utf8");
}

/** Whether an embedded prompt exists for `rel`. */
export function promptAssetExists(rel: string): boolean {
  return Object.prototype.hasOwnProperty.call(ASSETS, rel);
}

/**
 * Top-level user-editable prompts to seed into ~/.talon/prompts/
 * (every top-level `*.md` except the architecture README; the system/
 * subdirectory is package-owned and read in place).
 */
export function listSeedPrompts(): string[] {
  return Object.keys(ASSETS).filter(
    (rel) => !rel.includes("/") && rel !== "README.md",
  );
}
