/**
 * Media index tests — SQLite-backed persistence.
 *
 * Uses real temp directories rather than mocking `node:fs`: the legacy
 * media-index.json path resolves against `process.env.HOME` (overridden
 * per test) and the SQLite database lives in the same temp dir via a
 * per-test TALON_DB_PATH, so every test gets a fresh database and
 * close/reopen durability is observable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// download_media regression: the userbot is offline, so any answer must
// come from the media index.
vi.mock("../frontend/telegram/userbot.js", () => ({
  isUserClientReady: () => false,
  searchMessages: vi.fn(),
  getHistory: vi.fn(),
  getParticipantDetails: vi.fn(),
  getUserInfo: vi.fn(),
  getMessage: vi.fn(),
  getPinnedMessages: vi.fn(),
  getOnlineCount: vi.fn(),
  downloadMessageMedia: vi.fn(async () => "Message 43455 not found."),
}));
vi.mock("../frontend/telegram/sticker-library.js", () => ({
  savePackToLibrary: vi.fn(),
}));

let originalHome: string | undefined;
let originalTalonHome: string | undefined;
let originalUserProfile: string | undefined;
const envBackup = process.env.TALON_DB_PATH;
let tempHome: string;
let closeDb: (() => void) | null = null;

function storePath(): string {
  return resolve(tempHome, ".talon", "data", "media-index.json");
}

function seedStore(entries: unknown): void {
  const p = storePath();
  mkdirSync(dirname(p), { recursive: true });
  // Mirror the legacy bare-array on-disk shape so the one-time import
  // exercises pre-envelope behaviour.
  writeFileSync(p, JSON.stringify(entries));
}

async function freshImport() {
  // Re-import storage modules per test so the module-scoped database
  // handle picks up the per-test TALON_DB_PATH.
  vi.resetModules();
  const db = await import("../storage/db.js");
  closeDb = db.closeDatabase;
  return await import("../storage/media-index.js");
}

beforeEach(() => {
  delete process.env.TALON_DISABLE_LEGACY_IMPORT;
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalTalonHome = process.env.TALON_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "talon-media-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  // Bun's os.homedir() ignores $HOME, so pin the Talon root explicitly
  // via the first-class override paths.ts already honors.
  process.env.TALON_HOME = join(tempHome, ".talon");
  process.env.TALON_DB_PATH = join(tempHome, "talon.db");
});

afterEach(() => {
  closeDb?.();
  closeDb = null;
  if (envBackup === undefined) delete process.env.TALON_DB_PATH;
  else process.env.TALON_DB_PATH = envBackup;
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalTalonHome !== undefined)
    process.env.TALON_HOME = originalTalonHome;
  else delete process.env.TALON_HOME;
  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile;
  } else {
    delete process.env.USERPROFILE;
  }
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("media-index", () => {
  it("adds and retrieves media", async () => {
    const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
    loadMediaIndex();
    const cid = `add-${Date.now()}`;
    addMedia({
      chatId: cid,
      msgId: 1,
      senderName: "Alice",
      type: "photo",
      filePath: "/tmp/photo.jpg",
      timestamp: Date.now(),
    });
    const media = getRecentMedia(cid);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("photo");
    expect(media[0].filePath).toBe("/tmp/photo.jpg");
  });

  it("returns empty for unknown chat", async () => {
    const { getRecentMedia, loadMediaIndex } = await freshImport();
    loadMediaIndex();
    expect(getRecentMedia(`unknown-${Date.now()}`)).toHaveLength(0);
  });

  it("filters by type", async () => {
    const { addMedia, getMediaByType, loadMediaIndex } = await freshImport();
    loadMediaIndex();
    const cid = `type-${Date.now()}`;
    addMedia({
      chatId: cid,
      msgId: 1,
      senderName: "A",
      type: "photo",
      filePath: "/a.jpg",
      timestamp: Date.now(),
    });
    addMedia({
      chatId: cid,
      msgId: 2,
      senderName: "A",
      type: "document",
      filePath: "/b.pdf",
      timestamp: Date.now(),
    });
    addMedia({
      chatId: cid,
      msgId: 3,
      senderName: "A",
      type: "photo",
      filePath: "/c.jpg",
      timestamp: Date.now(),
    });

    expect(getMediaByType(cid, "photo")).toHaveLength(2);
    expect(getMediaByType(cid, "document")).toHaveLength(1);
  });

  it("deduplicates by chatId:msgId", async () => {
    const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
    loadMediaIndex();
    const chatId = `dedup-${Date.now()}`;
    addMedia({
      chatId,
      msgId: 1,
      senderName: "A",
      type: "photo",
      filePath: "/a.jpg",
      timestamp: 1000,
    });
    addMedia({
      chatId,
      msgId: 1,
      senderName: "A",
      type: "photo",
      filePath: "/b.jpg",
      timestamp: 2000,
    });

    const media = getRecentMedia(chatId);
    expect(media).toHaveLength(1);
    expect(media[0].filePath).toBe("/b.jpg");
  });

  it("formats index as text", async () => {
    const { addMedia, formatMediaIndex, loadMediaIndex } = await freshImport();
    loadMediaIndex();
    addMedia({
      chatId: "456",
      msgId: 10,
      senderName: "Bob",
      type: "photo",
      filePath: "/photo.jpg",
      caption: "sunset",
      timestamp: Date.now(),
    });
    const text = formatMediaIndex("456");
    expect(text).toContain("photo");
    expect(text).toContain("Bob");
    expect(text).toContain("/photo.jpg");
    expect(text).toContain("sunset");
  });

  it("returns 'no recent media' for empty chat", async () => {
    const { formatMediaIndex, loadMediaIndex } = await freshImport();
    loadMediaIndex();
    expect(formatMediaIndex("empty")).toContain("No recent media");
  });

  it("limits results", async () => {
    const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
    loadMediaIndex();
    for (let i = 0; i < 15; i++) {
      addMedia({
        chatId: "789",
        msgId: i,
        senderName: "C",
        type: "photo",
        filePath: `/p${i}.jpg`,
        timestamp: Date.now() + i,
      });
    }
    expect(getRecentMedia("789", 5)).toHaveLength(5);
  });

  it("returns newest first", async () => {
    const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
    loadMediaIndex();
    addMedia({
      chatId: "100",
      msgId: 1,
      senderName: "A",
      type: "photo",
      filePath: "/old.jpg",
      timestamp: 1000,
    });
    addMedia({
      chatId: "100",
      msgId: 2,
      senderName: "A",
      type: "photo",
      filePath: "/new.jpg",
      timestamp: 2000,
    });

    const media = getRecentMedia("100");
    expect(media[0].filePath).toBe("/new.jpg");
  });

  describe("addMedia with all media types", () => {
    it("supports all media type variants", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = `types-${Date.now()}`;
      const types = [
        "photo",
        "document",
        "voice",
        "video",
        "animation",
        "audio",
        "sticker",
      ] as const;
      types.forEach((type, i) => {
        addMedia({
          chatId: cid,
          msgId: i + 1,
          senderName: "User",
          type,
          filePath: `/tmp/${type}.bin`,
          timestamp: Date.now() + i,
        });
      });
      const media = getRecentMedia(cid, 20);
      expect(media).toHaveLength(7);
      const returnedTypes = media.map((m) => m.type).sort();
      expect(returnedTypes).toEqual([...types].sort());
    });

    it("supports caption field", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = `cap-${Date.now()}`;
      addMedia({
        chatId: cid,
        msgId: 1,
        senderName: "User",
        type: "photo",
        filePath: "/a.jpg",
        caption: "My caption",
        timestamp: Date.now(),
      });
      const media = getRecentMedia(cid);
      expect(media[0].caption).toBe("My caption");
    });

    it("generates correct id from chatId:msgId", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = `id-${Date.now()}`;
      addMedia({
        chatId: cid,
        msgId: 42,
        senderName: "User",
        type: "photo",
        filePath: "/a.jpg",
        timestamp: Date.now(),
      });
      const media = getRecentMedia(cid);
      expect(media[0].id).toBe(`${cid}:42`);
    });
  });

  describe("formatMediaIndex output format", () => {
    it("includes timestamp in readable format", async () => {
      const { addMedia, formatMediaIndex, loadMediaIndex } =
        await freshImport();
      loadMediaIndex();
      const ts = new Date("2025-03-15T14:30:00Z").getTime();
      addMedia({
        chatId: "fmt-1",
        msgId: 1,
        senderName: "Alice",
        type: "document",
        filePath: "/doc.pdf",
        timestamp: ts,
      });
      const text = formatMediaIndex("fmt-1");
      expect(text).toContain("2025-03-15 14:30");
      expect(text).toContain("[document]");
      expect(text).toContain("msg:1");
      expect(text).toContain("by Alice");
      expect(text).toContain("file: /doc.pdf");
    });

    it("truncates long captions at 50 characters", async () => {
      const { addMedia, formatMediaIndex, loadMediaIndex } =
        await freshImport();
      loadMediaIndex();
      const longCaption = "A".repeat(100);
      addMedia({
        chatId: "fmt-2",
        msgId: 1,
        senderName: "Bob",
        type: "photo",
        filePath: "/p.jpg",
        caption: longCaption,
        timestamp: Date.now(),
      });
      const text = formatMediaIndex("fmt-2");
      expect(text).toContain(`"${"A".repeat(50)}"`);
      expect(text).not.toContain(`"${"A".repeat(51)}"`);
    });

    it("omits caption when not provided", async () => {
      const { addMedia, formatMediaIndex, loadMediaIndex } =
        await freshImport();
      loadMediaIndex();
      addMedia({
        chatId: "fmt-3",
        msgId: 1,
        senderName: "Bob",
        type: "photo",
        filePath: "/p.jpg",
        timestamp: Date.now(),
      });
      const text = formatMediaIndex("fmt-3");
      expect(text).not.toContain('""');
    });

    it("respects limit parameter", async () => {
      const { addMedia, formatMediaIndex, loadMediaIndex } =
        await freshImport();
      loadMediaIndex();
      for (let i = 0; i < 20; i++) {
        addMedia({
          chatId: "fmt-4",
          msgId: i,
          senderName: "C",
          type: "photo",
          filePath: `/p${i}.jpg`,
          timestamp: Date.now() + i,
        });
      }
      const text = formatMediaIndex("fmt-4", 3);
      const entryCount = (text.match(/\[photo\]/g) || []).length;
      expect(entryCount).toBe(3);
    });
  });

  describe("getMediaByType", () => {
    it("returns empty array when no entries match type", async () => {
      const { addMedia, getMediaByType, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = `type-none-${Date.now()}`;
      addMedia({
        chatId: cid,
        msgId: 1,
        senderName: "A",
        type: "photo",
        filePath: "/a.jpg",
        timestamp: Date.now(),
      });
      expect(getMediaByType(cid, "voice")).toHaveLength(0);
    });

    it("respects limit parameter", async () => {
      const { addMedia, getMediaByType, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = `type-limit-${Date.now()}`;
      for (let i = 0; i < 15; i++) {
        addMedia({
          chatId: cid,
          msgId: i,
          senderName: "A",
          type: "photo",
          filePath: `/p${i}.jpg`,
          timestamp: Date.now() + i,
        });
      }
      expect(getMediaByType(cid, "photo", 5)).toHaveLength(5);
    });

    it("returns newest first", async () => {
      const { addMedia, getMediaByType, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = `type-order-${Date.now()}`;
      addMedia({
        chatId: cid,
        msgId: 1,
        senderName: "A",
        type: "voice",
        filePath: "/old.ogg",
        timestamp: 1000,
      });
      addMedia({
        chatId: cid,
        msgId: 2,
        senderName: "A",
        type: "voice",
        filePath: "/new.ogg",
        timestamp: 2000,
      });
      const result = getMediaByType(cid, "voice");
      expect(result[0].filePath).toBe("/new.ogg");
    });
  });

  describe("loadMediaIndex", () => {
    it("loads entries from existing legacy bare-array file", async () => {
      const now = Date.now();
      seedStore([
        {
          id: "load-1:1",
          chatId: "load-1",
          msgId: 1,
          senderName: "Alice",
          type: "photo",
          filePath: "/a.jpg",
          timestamp: now,
        },
        {
          id: "load-1:2",
          chatId: "load-1",
          msgId: 2,
          senderName: "Bob",
          type: "document",
          filePath: "/b.pdf",
          timestamp: now,
        },
      ]);
      const { getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const media = getRecentMedia("load-1");
      expect(media).toHaveLength(2);
    });

    it("loads entries from JsonStore envelope file", async () => {
      const now = Date.now();
      const p = storePath();
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(
        p,
        JSON.stringify({
          schemaVersion: 1,
          savedAt: now,
          data: [
            {
              id: "env:1",
              chatId: "env",
              msgId: 1,
              senderName: "Alice",
              type: "photo",
              filePath: "/x.jpg",
              timestamp: now,
            },
          ],
        }),
      );
      const { getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      expect(getRecentMedia("env")).toHaveLength(1);
    });

    it("handles JSON parse errors gracefully", async () => {
      const p = storePath();
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "not valid json{{{");
      const { loadMediaIndex } = await freshImport();
      expect(() => loadMediaIndex()).not.toThrow();
    });

    it("purges expired entries on load", async () => {
      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const recentTimestamp = Date.now() - 1000;
      seedStore([
        {
          id: "purge:1",
          chatId: "purge",
          msgId: 1,
          senderName: "A",
          type: "photo",
          filePath: "/old.jpg",
          timestamp: oldTimestamp,
        },
        {
          id: "purge:2",
          chatId: "purge",
          msgId: 2,
          senderName: "A",
          type: "photo",
          filePath: "/new.jpg",
          timestamp: recentTimestamp,
        },
      ]);
      const { getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const media = getRecentMedia("purge");
      expect(media).toHaveLength(1);
      expect(media[0].filePath).toBe("/new.jpg");
    });

    it("deletes expired media files from disk during purge", async () => {
      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const targetFile = join(tempHome, "expired.jpg");
      writeFileSync(targetFile, "stale");
      seedStore([
        {
          id: "del:1",
          chatId: "del",
          msgId: 1,
          senderName: "A",
          type: "photo",
          filePath: targetFile,
          timestamp: oldTimestamp,
        },
      ]);
      const { loadMediaIndex } = await freshImport();
      loadMediaIndex();
      expect(existsSync(targetFile)).toBe(false);
    });
  });

  // flushMediaIndex was removed with the per-store JSON flush timers —
  // SQLite commits on every write now, and the single WAL checkpoint
  // lives in storage/db.ts's flushDatabase(). Durability across
  // close/reopen no longer needs an explicit flush first.
  describe("close/reopen durability", () => {
    it("entries survive close/reopen, with no JSON file written", async () => {
      const { addMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      addMedia({
        chatId: "flush-1",
        msgId: 1,
        senderName: "A",
        type: "photo",
        filePath: "/a.jpg",
        timestamp: Date.now(),
      });
      expect(existsSync(storePath())).toBe(false);

      // Close the database and re-import against the same path: the
      // entry must come back from disk, not from module state.
      closeDb?.();
      const reopened = await freshImport();
      reopened.loadMediaIndex();
      const media = reopened.getRecentMedia("flush-1");
      expect(media).toHaveLength(1);
      expect(media[0].filePath).toBe("/a.jpg");
    });
  });

  describe("legacy import lifecycle", () => {
    it("renames the legacy file to .imported and does not re-import", async () => {
      const now = Date.now();
      seedStore([
        {
          id: "legacy-once:1",
          chatId: "legacy-once",
          msgId: 1,
          senderName: "Alice",
          type: "photo",
          filePath: "/a.jpg",
          timestamp: now,
        },
      ]);
      const { getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      expect(existsSync(storePath())).toBe(false);
      expect(existsSync(`${storePath()}.imported`)).toBe(true);

      loadMediaIndex();
      expect(getRecentMedia("legacy-once")).toHaveLength(1);
    });
  });

  describe("content hashing and dedupe (native/blake3-wasm)", () => {
    it("records the BLAKE3 content hash in the background", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = `hash-${Date.now()}`;
      const file = join(tempHome, "cat.jpg");
      writeFileSync(file, "pretend jpeg bytes");
      addMedia({
        chatId: cid,
        msgId: 1,
        senderName: "Alice",
        type: "photo",
        filePath: file,
        timestamp: Date.now(),
      });
      await vi.waitFor(() => {
        expect(getRecentMedia(cid)[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
      });
    });

    it("dedupes identical content onto one file on disk", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = `dedupe-${Date.now()}`;
      const original = join(tempHome, "first.jpg");
      const duplicate = join(tempHome, "second.jpg");
      writeFileSync(original, "same bytes either way");
      writeFileSync(duplicate, "same bytes either way");

      addMedia({
        chatId: cid,
        msgId: 1,
        senderName: "Alice",
        type: "photo",
        filePath: original,
        timestamp: Date.now() - 1000,
      });
      await vi.waitFor(() => {
        expect(getRecentMedia(cid)[0].contentHash).toBeDefined();
      });

      addMedia({
        chatId: cid,
        msgId: 2,
        senderName: "Bob",
        type: "photo",
        filePath: duplicate,
        timestamp: Date.now(),
      });
      await vi.waitFor(() => {
        const [second] = getRecentMedia(cid);
        expect(second.msgId).toBe(2);
        expect(second.filePath).toBe(original);
      });
      expect(existsSync(duplicate)).toBe(false);
      expect(existsSync(original)).toBe(true);
    });

    it("keeps distinct content on distinct files", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = `distinct-${Date.now()}`;
      const a = join(tempHome, "a.jpg");
      const b = join(tempHome, "b.jpg");
      writeFileSync(a, "content A");
      writeFileSync(b, "content B");
      addMedia({
        chatId: cid,
        msgId: 1,
        senderName: "Alice",
        type: "photo",
        filePath: a,
        timestamp: Date.now() - 1000,
      });
      addMedia({
        chatId: cid,
        msgId: 2,
        senderName: "Bob",
        type: "photo",
        filePath: b,
        timestamp: Date.now(),
      });
      await vi.waitFor(() => {
        for (const entry of getRecentMedia(cid)) {
          expect(entry.contentHash).toBeDefined();
        }
      });
      expect(existsSync(a)).toBe(true);
      expect(existsSync(b)).toBe(true);
      const paths = getRecentMedia(cid).map((e) => e.filePath);
      expect(new Set(paths).size).toBe(2);
    });

    it("expiry keeps a deduped file that live entries still reference", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = `shared-${Date.now()}`;
      const shared = join(tempHome, "shared.jpg");
      writeFileSync(shared, "shared bytes");
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      addMedia({
        chatId: cid,
        msgId: 1,
        senderName: "Alice",
        type: "photo",
        filePath: shared,
        timestamp: eightDaysAgo,
      });
      addMedia({
        chatId: cid,
        msgId: 2,
        senderName: "Bob",
        type: "photo",
        filePath: shared,
        timestamp: Date.now(),
      });
      loadMediaIndex(); // runs the expiry sweep
      const remaining = getRecentMedia(cid);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].msgId).toBe(2);
      expect(existsSync(shared)).toBe(true);
    });
  });
  describe("dedupe returns the path that actually exists (regression)", () => {
    it("a duplicate photo arriving later resolves to the canonical file", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = "dup-later";
      const original = join(tempHome, "1790753353443-photo_A.jpg");
      const fresh = join(tempHome, "1790794643221-photo_A.jpg");
      writeFileSync(original, "identical photo bytes");
      const first = await addMedia({
        chatId: cid,
        msgId: 43081,
        senderName: "Owner",
        type: "photo",
        filePath: original,
        timestamp: Date.now() - 60_000,
      });
      expect(first).toBe(original);

      writeFileSync(fresh, "identical photo bytes");
      const resolved = await addMedia({
        chatId: cid,
        msgId: 43454,
        senderName: "Owner",
        type: "photo",
        filePath: fresh,
        timestamp: Date.now(),
      });
      // The prompt is built from this path, so it must exist on disk.
      expect(resolved).toBe(original);
      expect(existsSync(resolved)).toBe(true);
      expect(existsSync(fresh)).toBe(false);
      expect(getRecentMedia(cid)[0].filePath).toBe(resolved);
    });

    it("two photos in one batch both resolve to files that exist", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const cid = "dup-batch";
      const old = join(tempHome, "old.jpg");
      writeFileSync(old, "photo two bytes");
      await addMedia({
        chatId: cid,
        msgId: 43239,
        senderName: "Owner",
        type: "photo",
        filePath: old,
        timestamp: Date.now() - 60_000,
      });

      // Album: one new photo, one duplicate of the older one, plus a
      // third identical to the second — all indexed concurrently.
      const a = join(tempHome, "batch-a.jpg");
      const b = join(tempHome, "batch-b.jpg");
      const c = join(tempHome, "batch-c.jpg");
      writeFileSync(a, "photo one bytes");
      writeFileSync(b, "photo two bytes");
      writeFileSync(c, "photo one bytes");
      const now = Date.now();
      const paths = await Promise.all(
        [a, b, c].map((filePath, i) =>
          addMedia({
            chatId: cid,
            msgId: 43454 + i,
            senderName: "Owner",
            type: "photo",
            filePath,
            timestamp: now,
          }),
        ),
      );
      for (const p of paths) expect(existsSync(p)).toBe(true);
      expect(paths[0]).toBe(a);
      expect(paths[1]).toBe(old);
      expect(paths[2]).toBe(a);
      expect(existsSync(b)).toBe(false);
      expect(existsSync(c)).toBe(false);
      for (const e of getRecentMedia(cid)) {
        expect(existsSync(e.filePath)).toBe(true);
      }
    });

    it("download_media serves a deduped message from the index", async () => {
      const { addMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const { chatInfoHandlers } =
        await import("../frontend/telegram/actions/chat-info.js");
      const chatId = 352042062;
      const original = join(tempHome, "orig.jpg");
      const fresh = join(tempHome, "fresh.jpg");
      writeFileSync(original, "same pixels");
      writeFileSync(fresh, "same pixels");
      await addMedia({
        chatId: String(chatId),
        msgId: 43239,
        senderName: "Owner",
        type: "photo",
        filePath: original,
        timestamp: Date.now() - 60_000,
      });
      await addMedia({
        chatId: String(chatId),
        msgId: 43455,
        senderName: "Owner",
        type: "photo",
        filePath: fresh,
        timestamp: Date.now(),
      });

      const handler = chatInfoHandlers.download_media!;
      const ctx = {} as Parameters<typeof handler>[2];
      const res = (await handler({ message_id: "43455" }, chatId, ctx)) as {
        ok: boolean;
        text?: string;
        file_path?: string;
      };
      expect(res.ok).toBe(true);
      expect(res.file_path).toBe(original);
      expect(res.text).toContain(original);

      const missing = (await handler({ message_id: 1 }, chatId, ctx)) as {
        ok: boolean;
      };
      expect(missing.ok).toBe(false);
    });
  });
});
