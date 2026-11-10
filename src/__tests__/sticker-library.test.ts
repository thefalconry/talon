/**
 * Sticker library — the workspace pack store (storage/stickers)
 * and the Telegram write/resolve side (frontend/telegram/sticker-library).
 *
 * The behaviours pinned here are what make stickers usable in practice:
 * send-by-emoji resolution (including fetch-on-miss for a named pack),
 * organic auto-save of packs users send from, and the prompt index that
 * makes the library discoverable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_ROOT = join(tmpdir(), `talon-sticker-test-${process.pid}`);
const STICKERS_DIR = join(TEST_ROOT, ".talon", "workspace", "stickers");

beforeEach(() => {
  vi.resetModules();
  // The worker home sets TALON_HOME, which outranks the homedir() mock
  // below; point it at this suite's root too.
  vi.stubEnv("TALON_HOME", join(TEST_ROOT, ".talon"));
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(STICKERS_DIR, { recursive: true });

  vi.doMock("node:os", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, homedir: () => TEST_ROOT };
  });
  vi.doMock("../util/log.js", () => ({
    log: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    logDebug: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

function writePack(
  name: string,
  stickers: Array<{ emoji: string; fileId: string }>,
  savedAt = "2026-01-01T00:00:00.000Z",
): void {
  writeFileSync(
    join(STICKERS_DIR, `${name}.json`),
    JSON.stringify({
      name,
      title: `${name} title`,
      count: stickers.length,
      stickers,
      savedAt,
    }),
  );
}

/** Fake grammY bot slice serving one sticker set. */
function fakeBot(
  sets: Record<string, Array<{ emoji?: string; file_id: string }>>,
) {
  const getStickerSet = vi.fn(async (name: string) => {
    const stickers = sets[name];
    if (!stickers) throw new Error(`STICKERSET_INVALID: ${name}`);
    return { name, title: `${name} title`, stickers };
  });
  return { api: { getStickerSet }, getStickerSet };
}

describe("sticker-store", () => {
  it("lists saved packs newest first and skips malformed files", async () => {
    writePack("old_pack", [{ emoji: "😀", fileId: "A" }], "2025-01-01");
    writePack("new_pack", [{ emoji: "🔥", fileId: "B" }], "2026-06-01");
    writeFileSync(join(STICKERS_DIR, "broken.json"), "{not json");

    const { listSavedPacks } = await import("../storage/stickers.js");
    const packs = listSavedPacks();
    expect(packs.map((p) => p.name)).toEqual(["new_pack", "old_pack"]);
  });

  it("renders a prompt index with emoji inventory, empty when no packs", async () => {
    const { renderStickerLibraryPrompt } =
      await import("../storage/stickers.js");
    expect(renderStickerLibraryPrompt()).toBe("");

    writePack("cats", [
      { emoji: "😀", fileId: "A" },
      { emoji: "😀", fileId: "B" },
      { emoji: "😭", fileId: "C" },
    ]);
    const section = renderStickerLibraryPrompt();
    expect(section).toContain("## Sticker library");
    expect(section).toContain("cats title (cats, 3 stickers)");
    // Distinct inventory: 😀 deduped, 😭 present.
    expect(section).toContain("😀😭");
  });

  it("skips packs with no emoji metadata (not sendable by emoji)", async () => {
    // Some packs carry no per-sticker emoji; a library line for them
    // would dangle ("(2 stickers): ") and teach an unusable path.
    writePack("bare", [
      { emoji: "", fileId: "A" },
      { emoji: "", fileId: "B" },
    ]);
    writePack("cats", [{ emoji: "😀", fileId: "C" }]);
    const { renderStickerLibraryPrompt } =
      await import("../storage/stickers.js");
    const section = renderStickerLibraryPrompt();
    expect(section).toContain("(cats,");
    expect(section).not.toContain("(bare,");
  });

  it("lists the newest 12 packs and summarizes the overflow", async () => {
    for (let i = 0; i < 14; i++) {
      writePack(
        `pack_${String(i).padStart(2, "0")}`,
        [{ emoji: "😀", fileId: `F${i}` }],
        `2026-01-${String(i + 1).padStart(2, "0")}`,
      );
    }
    const { renderStickerLibraryPrompt } =
      await import("../storage/stickers.js");
    const section = renderStickerLibraryPrompt();
    // Newest 12 listed; the 2 oldest summarized, not silently invisible.
    expect(section).toContain("(pack_13,");
    expect(section).toContain("(pack_02,");
    expect(section).not.toContain("(pack_01,");
    expect(section).toContain("plus 2 more saved packs");
  });

  it("truncates the emoji inventory on whole-emoji boundaries", async () => {
    // 40 distinct surrogate-pair emoji (2 UTF-16 units each) = 80 units,
    // over the 60-unit budget. A naive slice(0, 60) would cut the 31st
    // emoji in half; whole-emoji truncation must never emit a lone
    // surrogate.
    const emojis = Array.from({ length: 40 }, (_, i) =>
      String.fromCodePoint(0x1f600 + i),
    );
    writePack(
      "big",
      emojis.map((emoji, i) => ({ emoji, fileId: `F${i}` })),
    );
    const { renderStickerLibraryPrompt } =
      await import("../storage/stickers.js");
    const line = renderStickerLibraryPrompt()
      .split("\n")
      .find((l) => l.includes("(big,"))!;
    expect(line).toContain("…");
    // Well-formed: no unpaired surrogates anywhere in the line
    // (encodeURIComponent throws URIError on a lone surrogate).
    expect(() => encodeURIComponent(line)).not.toThrow();
    // 30 whole emoji fit the 60-unit budget, then the ellipsis.
    const inventory = line.slice(line.indexOf("): ") + 3);
    expect([...inventory].length).toBe(31); // 30 emoji + "…"
  });
});

describe("resolveStickerByEmoji", () => {
  it("resolves across all saved packs, normalizing variation selectors", async () => {
    // Pack stores "❤" (no U+FE0F); the model sends "❤️" (with U+FE0F).
    writePack("hearts", [{ emoji: "❤", fileId: "HEART_ID" }]);
    const { resolveStickerByEmoji } =
      await import("../frontend/telegram/sticker-library.js");
    const hit = await resolveStickerByEmoji(fakeBot({}), "❤️");
    expect(hit).toEqual({ fileId: "HEART_ID", pack: "hearts" });
  });

  it("normalizes skin-tone modifiers in both directions", async () => {
    // Pack stores a toned thumbs-up; the model sends the base emoji —
    // and vice versa. Both must land on the same sticker.
    writePack("hands", [{ emoji: "👍🏽", fileId: "THUMB_ID" }]);
    const { resolveStickerByEmoji } =
      await import("../frontend/telegram/sticker-library.js");
    expect(await resolveStickerByEmoji(fakeBot({}), "👍")).toEqual({
      fileId: "THUMB_ID",
      pack: "hands",
    });
    expect(await resolveStickerByEmoji(fakeBot({}), "👍🏻")).toEqual({
      fileId: "THUMB_ID",
      pack: "hands",
    });
  });

  it("never matches a blank query against emoji-less stickers", async () => {
    // Stickers without emoji metadata normalize to "" — a whitespace
    // query must not resolve to one of them at random.
    writePack("bare", [{ emoji: "", fileId: "A" }]);
    const { resolveStickerByEmoji } =
      await import("../frontend/telegram/sticker-library.js");
    expect(await resolveStickerByEmoji(fakeBot({}), " ")).toBeNull();
    expect(await resolveStickerByEmoji(fakeBot({}), "")).toBeNull();
  });

  it("fetches and saves an unsaved pack when set_name is given", async () => {
    const bot = fakeBot({
      doge: [{ emoji: "🐶", file_id: "DOGE_ID" }],
    });
    const { resolveStickerByEmoji } =
      await import("../frontend/telegram/sticker-library.js");
    const hit = await resolveStickerByEmoji(bot, "🐶", "doge");
    expect(hit).toEqual({ fileId: "DOGE_ID", pack: "doge" });
    // The fetched pack landed in the library for next time.
    expect(existsSync(join(STICKERS_DIR, "doge.json"))).toBe(true);
  });

  it("refreshes a stale named pack once when the emoji misses", async () => {
    // Library has an old copy of the pack; upstream it gained a 🚀
    // sticker. An explicit set_name miss must refetch and find it.
    writePack("doge", [{ emoji: "🐶", fileId: "OLD" }]);
    const bot = fakeBot({
      doge: [
        { emoji: "🐶", file_id: "OLD" },
        { emoji: "🚀", file_id: "NEW" },
      ],
    });
    const { resolveStickerByEmoji } =
      await import("../frontend/telegram/sticker-library.js");
    expect(await resolveStickerByEmoji(bot, "🚀", "doge")).toEqual({
      fileId: "NEW",
      pack: "doge",
    });
    expect(bot.getStickerSet).toHaveBeenCalledTimes(1);
    // A genuine miss refreshes once and stays a miss (never retries
    // within one resolution).
    expect(await resolveStickerByEmoji(bot, "🍕", "doge")).toBeNull();
    expect(bot.getStickerSet).toHaveBeenCalledTimes(2);
  });

  it("does not refresh from the network on all-pack searches", async () => {
    writePack("cats", [{ emoji: "😀", fileId: "A" }]);
    const bot = fakeBot({});
    const { resolveStickerByEmoji } =
      await import("../frontend/telegram/sticker-library.js");
    expect(await resolveStickerByEmoji(bot, "🚀")).toBeNull();
    expect(bot.getStickerSet).not.toHaveBeenCalled();
  });

  it("returns null when nothing matches or the pack fetch fails", async () => {
    writePack("cats", [{ emoji: "😀", fileId: "A" }]);
    const { resolveStickerByEmoji } =
      await import("../frontend/telegram/sticker-library.js");
    expect(await resolveStickerByEmoji(fakeBot({}), "🚀")).toBeNull();
    expect(
      await resolveStickerByEmoji(fakeBot({}), "😀", "no_such"),
    ).toBeNull();
  });
});

describe("ensurePackSaved", () => {
  it("saves unseen packs and skips (no fetch) already-saved ones", async () => {
    const bot = fakeBot({ pepe: [{ emoji: "🐸", file_id: "P1" }] });
    const { ensurePackSaved } =
      await import("../frontend/telegram/sticker-library.js");

    await ensurePackSaved(bot, "pepe");
    const saved = JSON.parse(
      readFileSync(join(STICKERS_DIR, "pepe.json"), "utf-8"),
    );
    expect(saved.stickers).toEqual([{ emoji: "🐸", fileId: "P1" }]);

    await ensurePackSaved(bot, "pepe");
    expect(bot.getStickerSet).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent saves of the same pack into one fetch", async () => {
    // A user posting a burst of stickers from one unseen pack fires
    // several ensurePackSaved calls before the first write lands.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const getStickerSet = vi.fn(async (name: string) => {
      await gate;
      return {
        name,
        title: `${name} title`,
        stickers: [{ emoji: "🐸", file_id: "P1" }],
      };
    });
    const bot = { api: { getStickerSet } };
    const { ensurePackSaved } =
      await import("../frontend/telegram/sticker-library.js");

    const calls = Promise.all([
      ensurePackSaved(bot, "pepe"),
      ensurePackSaved(bot, "pepe"),
      ensurePackSaved(bot, "pepe"),
    ]);
    release();
    await calls;
    expect(getStickerSet).toHaveBeenCalledTimes(1);
    expect(existsSync(join(STICKERS_DIR, "pepe.json"))).toBe(true);
  });

  it("never throws when the fetch fails (fire-and-forget safe)", async () => {
    const { ensurePackSaved } =
      await import("../frontend/telegram/sticker-library.js");
    await expect(
      ensurePackSaved(fakeBot({}), "ghost"),
    ).resolves.toBeUndefined();
  });
});
