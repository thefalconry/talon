/**
 * Message attachments end to end: streaming an upload to disk, describing it
 * on the wire, resolving a client's references back to what the daemon
 * actually wrote, the prompt lines the model is handed, and the round trip
 * through persisted history.
 *
 * TALON_HOME is redirected before the modules under test are imported —
 * `util/paths.ts` resolves the uploads dir once at import time — so nothing
 * here touches the real ~/.talon.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

process.env.TALON_HOME = await mkdtemp(join(tmpdir(), "talon-attach-"));

const { dirs } = await import("../util/paths.js");
const {
  contentTypeFor,
  describeAttachment,
  isImageType,
  mediaIdFrom,
  resolveUpload,
  safeUploadName,
  saveUploadStream,
} = await import("../frontend/native/media/media.js");
const { attachmentPrompt } = await import("../frontend/native/turn/turn.js");
const { emitUser } = await import("../frontend/native/turn/emit.js");
const { historyPage } = await import("../frontend/native/chats/history.js");
const { createNativeRuntime } = await import("../frontend/native/runtime.js");
type Runtime = Awaited<
  ReturnType<typeof import("../frontend/native/runtime.js").createNativeRuntime>
>;
const { toClientChat } = await import("../frontend/native/chats/chat-wire.js");
const { setQueued, takeQueued } =
  await import("../frontend/native/turn/queue.js");
import type { TalonConfig } from "../core/config/index.js";
import type { Gateway } from "../core/engine/gateway.js";
import type { BridgeEvent } from "../frontend/native/protocol.js";

let runtime: Runtime;
let events: BridgeEvent[];

beforeAll(() => {
  events = [];
  runtime = createNativeRuntime(
    { botDisplayName: "Talon" } as TalonConfig,
    {} as Gateway,
    (event) => events.push(event),
  );
});

/** Stream `body` through the real upload path and describe the result. */
async function upload(name: string, body: string, contentType?: string) {
  const saved = await saveUploadStream(
    runtime,
    name,
    Readable.from([Buffer.from(body)]),
    1024 * 1024,
  );
  return describeAttachment(runtime, {
    path: saved.path,
    name,
    size: saved.size,
    contentType,
  });
}

describe("upload naming and typing", () => {
  it("types files by extension and only calls images inline-able", () => {
    expect(contentTypeFor("/x/report.pdf")).toBe("application/pdf");
    expect(contentTypeFor("/x/bundle.zip")).toBe("application/zip");
    expect(contentTypeFor("/x/notes.md")).toBe("text/markdown");
    expect(contentTypeFor("/x/clip.mp4")).toBe("video/mp4");
    expect(contentTypeFor("/x/mystery.qqq")).toBe("application/octet-stream");
    expect(isImageType("image/webp")).toBe(true);
    expect(isImageType("application/zip")).toBe(false);
  });

  it("reduces a hostile filename to one safe segment", () => {
    expect(safeUploadName("../../etc/passwd")).toBe("passwd");
    expect(safeUploadName("C:\\Windows\\evil .exe")).toBe("evil_.exe");
    expect(safeUploadName("...")).toBe("upload");
    expect(safeUploadName("")).toBe("upload");
  });

  it("prefers a specific declared content type over the extension", async () => {
    const typed = await upload("data.bin", "hello", "application/zip");
    expect(typed.mimeType).toBe("application/zip");
    // A generic declaration defers to what the extension says.
    const generic = await upload(
      "sheet.csv",
      "a,b",
      "application/octet-stream",
    );
    expect(generic.mimeType).toBe("text/csv");
  });
});

describe("saveUploadStream", () => {
  it("streams the body to the uploads dir under a unique name", async () => {
    const saved = await saveUploadStream(
      runtime,
      "notes.txt",
      Readable.from([Buffer.from("alpha"), Buffer.from("beta")]),
      1024,
    );
    expect(saved.size).toBe(9);
    expect(saved.path.startsWith(dirs.uploads)).toBe(true);
    expect(saved.path.endsWith("-notes.txt")).toBe(true);
    expect(await readFile(saved.path, "utf8")).toBe("alphabeta");
  });

  it("rejects a body past the cap and leaves no partial file behind", async () => {
    const before = (await readdir(dirs.uploads)).length;
    await expect(
      saveUploadStream(
        runtime,
        "big.bin",
        Readable.from([Buffer.alloc(64), Buffer.alloc(64)]),
        100,
      ),
    ).rejects.toThrow(/limit/i);
    expect((await readdir(dirs.uploads)).length).toBe(before);
  });

  it("rejects an empty body", async () => {
    await expect(
      saveUploadStream(runtime, "nothing.txt", Readable.from([]), 1024),
    ).rejects.toThrow(/empty/i);
  });
});

describe("resolving a client's attachment references", () => {
  it("resolves by media id, and by path for single-file clients", async () => {
    const zip = await upload("archive.zip", "PK\u0003\u0004");
    expect(mediaIdFrom(zip.url)).toBeDefined();
    expect(resolveUpload(runtime, { url: zip.url })).toEqual(zip);
    expect(resolveUpload(runtime, { path: zip.path })).toEqual(zip);
  });

  it("refuses a reference to a file this daemon never wrote", async () => {
    await writeFile(join(dirs.uploads, "planted.txt"), "not mine");
    expect(
      resolveUpload(runtime, { path: join(dirs.uploads, "planted.txt") }),
    ).toBeUndefined();
    expect(resolveUpload(runtime, { path: "/etc/passwd" })).toBeUndefined();
    expect(resolveUpload(runtime, { url: "/media?id=nope" })).toBeUndefined();
    expect(resolveUpload(runtime, undefined)).toBeUndefined();
  });
});

describe("the prompt the model is handed", () => {
  it("keeps the image wording and gives every file its own line", async () => {
    const shot = await upload("shot.png", "png-bytes");
    const zip = await upload("archive.zip", "x".repeat(2048));
    const prompt = attachmentPrompt("look at these", [shot, zip]);
    expect(prompt).toBe(
      [
        "look at these",
        "",
        `[Attached image: ${shot.path}]`,
        `[Attached file: archive.zip (application/zip, 2.0 KB) at ${zip.path}]`,
      ].join("\n"),
    );
  });

  it("is just the attachment lines when no text was typed", async () => {
    const zip = await upload("solo.zip", "z");
    expect(attachmentPrompt("", [zip])).toBe(
      `[Attached file: solo.zip (application/zip, 1 B) at ${zip.path}]`,
    );
  });

  it("passes text straight through when nothing is attached", () => {
    expect(attachmentPrompt("plain", [])).toBe("plain");
  });
});

describe("attachments through a message and back out of history", () => {
  it("broadcasts, persists and re-hydrates every file", async () => {
    const entry = runtime.chats.create();
    const shot = await upload("diagram.png", "png");
    const zip = await upload("logs.zip", "zip");
    const id = emitUser(runtime, entry, "have a look", [shot, zip]);

    const broadcast = events.find(
      (e) => e.kind === "message" && e.message.id === String(id),
    );
    expect(broadcast).toMatchObject({
      message: {
        attachments: [shot, zip],
        // The first image stays mirrored onto the single-image field.
        imagePath: shot.url,
      },
    });

    const [row] = historyPage(runtime, entry.id);
    expect(row?.attachments).toHaveLength(2);
    expect(row?.attachments?.map((a) => a.name)).toEqual([
      "diagram.png",
      "logs.zip",
    ]);
    expect(row?.attachments?.map((a) => a.path)).toEqual([shot.path, zip.path]);
    // Media ids are per-run, so hydration registers fetchable URLs.
    for (const a of row?.attachments ?? []) {
      expect(a.url).toMatch(/^\/media\?id=/);
      expect(runtime.media.get(mediaIdFrom(a.url) ?? "")).toBe(a.path);
    }
    expect(row?.imagePath).toBe(row?.attachments?.[0]?.url);
  });

  it("re-serves the same media ids however often history is fetched", async () => {
    const entry = runtime.chats.create();
    const shot = await upload("again.png", "png");
    emitUser(runtime, entry, "", [shot]);

    const urls = () => historyPage(runtime, entry.id)[0]?.attachments?.[0]?.url;
    const first = urls();
    const registered = runtime.media.size;
    // A reconnecting client re-fetches its open chat every time.
    for (let i = 0; i < 5; i++) expect(urls()).toBe(first);
    expect(runtime.media.size).toBe(registered);
  });

  it("previews a file-only message by name in the sidebar", async () => {
    const entry = runtime.chats.create();
    const zip = await upload("backup.zip", "zip");
    emitUser(runtime, entry, "", [zip]);
    expect(runtime.chats.get(entry.id)?.preview).toBe("[backup.zip]");

    const many = runtime.chats.create();
    emitUser(runtime, many, "", [zip, await upload("second.zip", "zip")]);
    expect(runtime.chats.get(many.id)?.preview).toBe("[2 files]");
  });

  it("re-hydrates a single-image row written before multi-file attachments", async () => {
    const entry = runtime.chats.create();
    const { pushMessage } = await import("../storage/history.js");
    pushMessage(entry.id, {
      msgId: 90001,
      senderId: 1,
      senderName: "User",
      text: "legacy",
      timestamp: Date.now(),
      mediaType: "photo",
      filePath: join(dirs.uploads, "old.png"),
    });
    const [row] = historyPage(runtime, entry.id);
    expect(row?.attachments).toHaveLength(1);
    expect(row?.attachments?.[0]).toMatchObject({
      name: "old.png",
      mimeType: "image/png",
      image: true,
    });
    expect(row?.imagePath).toBe(row?.attachments?.[0]?.url);
  });
});

describe("a queued follow-up's attachments", () => {
  it("survives the queue and reports its count to clients", async () => {
    const entry = runtime.chats.create();
    const zip = await upload("queued.zip", "zip");
    setQueued(runtime, entry.id, { text: "after this", attachments: [zip] });
    expect(toClientChat(runtime, entry).queued).toEqual({
      text: "after this",
      hasAttachment: true,
      attachmentCount: 1,
    });
    expect(takeQueued(runtime, entry)?.attachments).toEqual([zip]);
  });
});

describe("the upload route's answers", () => {
  it("reports too-large, empty and server failures apart", async () => {
    const { chatRoutes } =
      await import("../frontend/native/bridge/routes/chats.js");
    const answers: Array<{ status: number; body: Record<string, unknown> }> =
      [];
    const host = {
      json: (_res: unknown, status: number, body: Record<string, unknown>) =>
        answers.push({ status, body }),
      readJson: async () => ({}),
      handlers: {
        upload: async (filename: string) => {
          if (filename === "big")
            throw new Error("Upload exceeds the 512 MB limit");
          if (filename === "empty") throw new Error("Empty upload");
          if (filename === "broken")
            throw new Error("EACCES: permission denied");
          return {
            path: "/u/f",
            name: "f",
            size: 1,
            mimeType: "text/plain",
            url: "/media?id=m1",
            image: false,
          };
        },
      },
    } as never;
    const routes = chatRoutes(host);
    const call = async (filename: string) =>
      routes["POST /upload"]({
        req: Object.assign(Readable.from([]), { headers: {} }) as never,
        res: {} as never,
        url: new URL(`http://x/upload?filename=${filename}`),
      } as never);

    await call("ok");
    await call("big");
    await call("empty");
    await call("broken");
    expect(answers.map((a) => a.status)).toEqual([200, 413, 400, 500]);
    // A successful upload mirrors its URL onto the legacy single-image field.
    expect(answers[0]?.body).toMatchObject({
      ok: true,
      url: "/media?id=m1",
      imagePath: "/media?id=m1",
    });
  });
});
