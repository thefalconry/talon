/**
 * System-prompt assembly — the single place where Talon's system
 * instructions are composed.
 *
 * ## Section pipeline
 *
 * The prompt is an ordered list of markdown sections joined by
 * `\n\n---\n\n`. Static sections (stable for a session's lifetime)
 * and dynamic sections (volatile between rebuilds) are kept apart so
 * providers can prompt-cache the static prefix — see
 * `SystemPromptParts`.
 *
 *   STATIC                                  source
 *   1. Identity                             ~/.talon/prompts/identity.md
 *                                           + ~/.talon/workspace/identity.md
 *   2. Core behaviour                       ~/.talon/prompts/custom.md,
 *                                           else base.md, else fallback
 *   3. Frontend capabilities                ~/.talon/prompts/<frontend>.md
 *   4. Persistent memory (ranked, capped)   prompts/system/persistent-memory.md
 *                                           wrapping ~/.talon/workspace/memory/memory.md
 *                                           via memory-view.ts
 *                                           — or, with TALON_MEMORY_STORE=1 and a
 *                                           non-empty store, the typed store's core
 *                                           view (memory/core-view.ts) wrapped in
 *                                           prompts/system/memory-core-view.md
 *   4.5 Live state (capped)                 prompts/system/live-state.md
 *                                           wrapping ~/.talon/workspace/memory/state.md
 *                                           (heartbeat-owned, rewritten whole)
 *   5. Memory recall + capability docs      prompts/system/{memory-recall,workspace,...}.md
 *   6. Plugin additions                     plugin.systemPrompt() contributions
 *   (7. Delivery contract — appended by the backend as its suffix,
 *       AFTER plugins, so it is the last thing the model reads.
 *       See backend/runtime/prompt/delivery-contract.ts.)
 *
 *   DYNAMIC
 *   1. Daily-memory pointer                 prompts/system/daily-memory.md
 *                                           (names today's file — changes at midnight)
 *   2. Skill index                          workspace/skills/<name>/SKILL.md
 *   3. Workspace file listing               workspace-listing.ts
 *                                           (file sizes change as logs grow)
 *
 * ## Ownership
 *
 * Files under `~/.talon/prompts/` are seeded once and user-editable —
 * edits win over package updates. Files under the package's
 * `prompts/system/` are read directly from the package and are NOT
 * seeded: they document runtime behaviour versioned with the code
 * (tool names, flow enforcement, trigger limits), where a stale
 * seeded copy would describe a contract the code no longer
 * implements. See prompts/README.md.
 *
 * ## Deliberate omissions
 *
 * No "Current Date & Time" section: every user message already
 * carries a `[YYYY-MM-DD HH:MM:SS]` tag (see backend/runtime/prompt/prompt-format),
 * the daily-memory pointer names today's file, and the `check_time`
 * tool covers timezone queries. A minute-precision timestamp here was
 * the single biggest cache-buster — it guaranteed every rebuild
 * produced a unique prompt.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirs, files as pathFiles } from "../../util/paths.js";
import { todayAndYesterday } from "../../util/time.js";
import { log, logWarn } from "../../util/log.js";
import { loadSystemTemplate } from "./templates.js";
import { renderMemoryView } from "./memory-view.js";
import { renderWorkspaceListing } from "./workspace-listing.js";
import { renderSkillsPrompt } from "../../storage/skills.js";
import { renderStickerLibraryPrompt } from "../../storage/stickers.js";
import { recordHistogram } from "../../storage/metrics.js";
import { renderCoreView } from "../memory/core-view.js";
import { memoryStoreEnabled } from "../memory/flag.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * System prompt split for prompt-cache friendliness.
 *
 * `staticText` holds everything stable for the lifetime of a session
 * (identity, behaviour, frontend docs, memory snapshot, capability
 * docs, plugin additions). `dynamicText` holds volatile context
 * (workspace file listing, daily-memory pointer) that changes between
 * rebuilds.
 *
 * The Claude SDK backend sends these as separate blocks divided by
 * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, so the static prefix is eligible
 * for cross-session prompt caching while volatile content lives after
 * the cache boundary. Other backends join them into a single string —
 * keeping volatile content last still maximises their providers'
 * automatic prefix caching.
 */
export type SystemPromptParts = {
  staticText: string;
  dynamicText: string;
};

/** Join the two prompt parts into the single-string form. */
export function joinSystemPromptParts(parts: SystemPromptParts): string {
  if (!parts.dynamicText) return parts.staticText;
  if (!parts.staticText) return parts.dynamicText;
  return `${parts.staticText}\n\n---\n\n${parts.dynamicText}`;
}

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Cap on the injected `state.md` block. Deliberately much tighter than the
 * memory cap: this is a status snapshot the heartbeat rewrites every run, so
 * anything past a couple of thousand chars means the heartbeat is
 * accumulating history in a file that is supposed to be replaced — the
 * failure the memory/state split exists to prevent. Truncating loudly is the
 * signal that it is happening.
 */
export const STATE_INJECT_MAX_CHARS = 2_000;

/**
 * Size of the injected memory block, recorded on every build from both
 * tiers. The whole point of the flag being default-off is that these two
 * populations can be compared before the store becomes the default path
 * (rollout Decision 4).
 */
const MEMORY_CHARS_METRIC = "prompt.memory_chars";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Unreadable prompt files already reported (path + error code). */
const reportedUnreadable = new Set<string>();

function readOptionalFile(path: string): string {
  try {
    if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  } catch (err) {
    // Absent is fine (existsSync above); present-but-unreadable silently
    // drops a prompt section, so say which — once, not every assembly.
    const key = `${path}\0${(err as NodeJS.ErrnoException).code ?? ""}`;
    if (!reportedUnreadable.has(key)) {
      reportedUnreadable.add(key);
      logWarn(
        "workspace",
        `Prompt file unreadable, section omitted path=${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return "";
}

let lastLoggedPromptKey = "";

/** A memory block ready for the static prompt, with the label it logs under. */
type MemorySection = { section: string; label: string };

/**
 * The store's core view, when `TALON_MEMORY_STORE` is on and the store
 * has something to say. Budgeted (not truncated) and computed once per
 * build — this is the session-frozen tier of plan §3.4, so it belongs in
 * `staticText` and nowhere else.
 *
 * An empty store falls through to the file, which is what makes the flag
 * safe to turn on before the import has ever run.
 */
function coreViewSection(): MemorySection | undefined {
  if (!memoryStoreEnabled()) return undefined;
  const view = renderCoreView();
  if (view.rows === 0) return undefined;
  recordHistogram(MEMORY_CHARS_METRIC, view.chars);
  return {
    section: loadSystemTemplate("memory-core-view", { content: view.text }),
    label: "memory(store)",
  };
}

/**
 * The rendered `memory.md` file, ranked and capped. The path every
 * deployment is on until the flag flips: over the cap the view ranks
 * sections rather than head-slicing, so durable knowledge isn't evicted
 * by whatever happens to sit at the top of the file (memory-view.ts).
 */
function memoryFileSection(): MemorySection | undefined {
  const memory = readOptionalFile(pathFiles.memory);
  if (!memory) return undefined;
  const { text, truncated, omitted } = renderMemoryView(memory);
  recordHistogram(MEMORY_CHARS_METRIC, text.length);
  return {
    section: loadSystemTemplate("persistent-memory", {
      content: text,
      truncated: truncated ? "yes" : undefined,
      omitted: omitted || undefined,
    }),
    label: truncated ? "memory(ranked)" : "memory",
  };
}

// ── Assembly ────────────────────────────────────────────────────────────────

/** Inputs for `assembleSystemPrompt`. */
export type AssemblePromptInputs = {
  /** Primary frontend whose prompt file to load (default: telegram). */
  frontend?: string;
  /** Plugin system-prompt contributions (static; change on plugin reload). */
  pluginPromptAdditions?: string[];
};

/**
 * Assemble the system prompt. See the module docstring for the
 * section pipeline, ownership rules, and the static/dynamic split.
 */
export function assembleSystemPrompt(
  inputs: AssemblePromptInputs,
): SystemPromptParts {
  const promptDir = dirs.prompts;
  const staticParts: string[] = [];
  const dynamicParts: string[] = [];
  const loaded: string[] = [];

  // 1. Identity — static personality from prompts/identity.md plus the
  //    bot's own evolving identity file in the workspace.
  const identityPrompt = readOptionalFile(resolve(promptDir, "identity.md"));
  const identityUser = readOptionalFile(pathFiles.identity);
  if (identityPrompt || identityUser) {
    const identityParts = [identityPrompt, identityUser].filter(Boolean);
    staticParts.push(`## Identity\n\n${identityParts.join("\n\n")}`);
    loaded.push("identity");
  }

  // 2. Core behaviour — custom.md replaces base.md wholesale when present.
  const custom = readOptionalFile(resolve(promptDir, "custom.md"));
  const basePrompt = readOptionalFile(resolve(promptDir, "base.md"));
  if (custom) {
    staticParts.push(custom);
    loaded.push("custom");
  } else if (basePrompt) {
    staticParts.push(basePrompt);
    loaded.push("base");
  } else staticParts.push("You are a sharp and helpful AI assistant.");

  // 3. Frontend capabilities (telegram.md / discord.md / teams.md / …).
  const frontendFile = `${inputs.frontend ?? "telegram"}.md`;
  const frontendPrompt = readOptionalFile(resolve(promptDir, frontendFile));
  if (frontendPrompt) {
    staticParts.push(frontendPrompt);
    loaded.push(frontendFile.replace(".md", ""));
  }

  // 4. Persistent memory — the store's core view when the flag is on and
  //    the store has rows, else the ranked, size-capped `memory.md` file,
  //    so a memory file that has grown for months can't bloat every
  //    session from turn 0. Static either way: both tiers are frozen for
  //    the session's lifetime (plan §3.4/§3.6). Anything learned
  //    mid-session reaches the model through turn retrieval instead.
  const memorySection = coreViewSection() ?? memoryFileSection();
  if (memorySection) {
    staticParts.push(memorySection.section);
    loaded.push(memorySection.label);
  }

  // 4.5. Live state — the heartbeat's rewritten-whole status snapshot, kept
  //      OUT of memory.md so "as of Run #N" sections can't accrete in the
  //      durable store and push real knowledge past the cap. Capped hard:
  //      this is the most volatile content in the static prompt, and a
  //      status file that grows is the exact failure this split exists to
  //      prevent.
  const state = readOptionalFile(pathFiles.state);
  if (state) {
    const truncated = state.length > STATE_INJECT_MAX_CHARS;
    staticParts.push(
      loadSystemTemplate("live-state", {
        content: truncated
          ? state.slice(0, STATE_INJECT_MAX_CHARS).trimEnd()
          : state,
        truncated: truncated ? "yes" : undefined,
      }),
    );
    loaded.push(truncated ? "state(capped)" : "state");
  }

  // 5. Package-owned behavioural and capability docs. The memory policy
  //    is deliberately package-owned so custom identity/base prompts cannot
  //    remove recall-before-asking or adaptive persistence behaviour.
  //    Provider-specific additions follow in step 6 and become canonical
  //    when their tools are available; otherwise the policy falls back to
  //    memory.md + daily notes.
  staticParts.push(
    loadSystemTemplate("memory-recall"),
    loadSystemTemplate("workspace"),
    loadSystemTemplate("cron"),
    loadSystemTemplate("triggers"),
    loadSystemTemplate("goals"),
    loadSystemTemplate("skills"),
  );

  // 6. Plugin contributions. Static: they only change on plugin
  //    reload, which triggers a full rebuild.
  if (inputs.pluginPromptAdditions) {
    for (const addition of inputs.pluginPromptAdditions) {
      staticParts.push(addition);
    }
  }

  // Dynamic 1: daily-memory pointer (names today's file — read on
  // demand, not injected; changes at midnight).
  const { today } = todayAndYesterday();
  dynamicParts.push(
    loadSystemTemplate("daily-memory", {
      daily_dir: dirs.dailyMemory,
      today,
    }),
  );

  // Dynamic 2: skill index. Names/descriptions are enough for
  // discovery; full markdown bodies stay on disk until loaded.
  const skills = renderSkillsPrompt();
  if (skills) dynamicParts.push(skills);

  // Dynamic 2.5: sticker library index (Telegram only — the one
  // frontend with a sticker send surface). Strict check on purpose:
  // config always resolves a concrete frontend, so an absent value
  // means a caller outside the normal chat path (no sticker tools) —
  // don't inject the index there. Dynamic because packs are
  // auto-saved mid-session as users send stickers.
  if (inputs.frontend === "telegram") {
    const stickerLibrary = renderStickerLibraryPrompt();
    if (stickerLibrary) dynamicParts.push(stickerLibrary);
  }

  // Dynamic 3: workspace file listing (sizes change as logs grow).
  const workspaceFiles = renderWorkspaceListing(dirs.workspace);
  if (workspaceFiles) dynamicParts.push(workspaceFiles);

  const loadedKey = loaded.join(" + ");
  if (loadedKey && loadedKey !== lastLoggedPromptKey) {
    log("config", `System prompt: ${loadedKey}`);
    lastLoggedPromptKey = loadedKey;
  }

  return {
    staticText: staticParts.join("\n\n---\n\n"),
    dynamicText: dynamicParts.join("\n\n---\n\n"),
  };
}
