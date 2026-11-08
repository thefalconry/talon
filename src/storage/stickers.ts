/**
 * Sticker pack store — reads the workspace sticker library
 * (`~/.talon/workspace/stickers/<set_name>.json`, one file per pack)
 * and renders the compact prompt index that makes the library
 * *discoverable*: a model that can see which packs and emoji it owns
 * actually sends stickers; one that has to go browsing first never
 * does.
 *
 * Writing packs is frontend work (fetching needs a platform API) —
 * see `frontend/telegram/sticker-library.ts`. This module is the
 * read side, shared by prompt assembly and the send-by-emoji
 * resolver.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { logWarn } from "../util/log.js";
import { dirs } from "../util/paths.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** One sticker inside a saved pack (JSON shape on disk). */
export type SavedSticker = { emoji: string; fileId: string };

/** A saved pack — the JSON shape of `stickers/<set_name>.json`. */
export type SavedPack = {
  name: string;
  title: string;
  count: number;
  stickers: SavedSticker[];
  savedAt: string;
};

// ── Tunables ────────────────────────────────────────────────────────────────

/** Max packs listed in the prompt index (newest first). */
const PROMPT_PACK_LIMIT = 12;

/** Max chars of a pack's emoji inventory shown in the prompt index. */
const PROMPT_INVENTORY_MAX_CHARS = 60;

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * All packs currently saved in the workspace, newest first. Unreadable
 * or malformed files are skipped — the library is a cache, not a
 * source of truth (any pack can be re-fetched by name).
 */
export function listSavedPacks(): SavedPack[] {
  const dir = dirs.stickers;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    // No stickers dir yet is the normal empty library; anything else
    // (EACCES, ENOTDIR) hides every saved pack.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logWarn(
        "stickers",
        `Could not list sticker packs dir=${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return [];
  }
  const packs: SavedPack[] = [];
  for (const file of entries) {
    try {
      const raw = JSON.parse(readFileSync(resolve(dir, file), "utf-8")) as {
        name?: unknown;
        title?: unknown;
        stickers?: unknown;
        savedAt?: unknown;
      };
      if (typeof raw.name !== "string" || !Array.isArray(raw.stickers)) {
        continue;
      }
      const stickers = raw.stickers
        .filter(
          (s): s is { emoji?: unknown; fileId?: unknown } =>
            s != null && typeof s === "object",
        )
        .filter((s) => typeof s.fileId === "string")
        .map((s) => ({
          emoji: typeof s.emoji === "string" ? s.emoji : "",
          fileId: s.fileId as string,
        }));
      packs.push({
        name: raw.name,
        title: typeof raw.title === "string" ? raw.title : raw.name,
        count: stickers.length,
        stickers,
        savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
      });
    } catch (err) {
      // Skip the malformed pack file, but name it — it silently drops
      // out of the library otherwise.
      logWarn(
        "stickers",
        `Skipped unreadable sticker pack file=${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return packs.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

// ── Prompt index ────────────────────────────────────────────────────────────

/**
 * The "Sticker library" system-prompt section: one line per pack with
 * its distinct emoji inventory. Empty string when the library is empty
 * (the section simply doesn't appear). Dynamic-part content: it changes
 * as packs are auto-saved mid-session.
 */
export function renderStickerLibraryPrompt(): string {
  // Packs whose stickers carry no emoji metadata can't be sent by
  // emoji, which is what this section teaches — listing them would be
  // a dangling "(N stickers): " line pointing at nothing.
  const usable = listSavedPacks().filter((p) =>
    p.stickers.some((s) => s.emoji),
  );
  const packs = usable.slice(0, PROMPT_PACK_LIMIT);
  if (packs.length === 0) return "";
  const overflow = usable.length - packs.length;
  const lines = packs.map((p) => {
    const distinct = [...new Set(p.stickers.map((s) => s.emoji))].filter(
      Boolean,
    );
    // Truncate on whole-emoji boundaries: a naive string slice counts
    // UTF-16 units and can cut a surrogate pair (or a ZWJ sequence)
    // in half, leaving a mojibake char at the edge of the prompt line.
    let inventory = "";
    for (const e of distinct) {
      if (inventory.length + e.length > PROMPT_INVENTORY_MAX_CHARS) {
        inventory += "…";
        break;
      }
      inventory += e;
    }
    return `- ${p.title} (${p.name}, ${p.count} stickers): ${inventory}`;
  });
  if (overflow > 0) {
    // The index shows the newest packs; make the rest discoverable
    // instead of silently invisible.
    lines.push(
      `- …plus ${overflow} more saved pack${overflow === 1 ? "" : "s"} in workspace/stickers/ (all searched when sending by emoji).`,
    );
  }
  return [
    "## Sticker library",
    "",
    'Saved packs you can send from right now with send(type="sticker", emoji=...) — pick the emoji whose feeling fits (add set_name to pin a pack). Packs from stickers users send are added automatically.',
    "",
    ...lines,
  ].join("\n");
}
