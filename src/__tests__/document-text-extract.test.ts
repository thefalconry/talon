/**
 * Document text extraction (core/documents): PDF via pdftotext, docx and
 * pptx via the built-in zip reader, plain text as-is — with word counts
 * that leave page/slide markers out, and failures returned, not thrown.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

type ExecCb = (err: Error | null, stdout: string) => void;
const execFile = vi.fn(
  (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => cb(null, ""),
);
// Only pdftotext is faked; anything else the process spawns runs for real.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    execFile: (...args: unknown[]) =>
      args[0] === "pdftotext"
        ? execFile(...(args as [string, string[], unknown, ExecCb]))
        : (real.execFile as (...a: unknown[]) => unknown)(...args),
  };
});

import {
  countWords,
  documentKind,
  extractDocumentText,
} from "../core/documents/extract-text.js";
import { readZipTextEntries } from "../core/documents/zip-entries.js";

/** A minimal zip (deflated entries) — what Office writes, in miniature. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(body, "utf8");
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const dir = mkdtempSync(join(tmpdir(), "doc-extract-"));
function file(name: string, content: string | Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const DOCX_XML =
  "<w:document><w:body><w:p><w:r><w:t>Play matters in</w:t></w:r>" +
  '<w:r><w:t xml:space="preserve"> early years.</w:t></w:r></w:p>' +
  "<w:p><w:r><w:t>Second &amp; last</w:t><w:tab/><w:t>paragraph.</w:t></w:r></w:p>" +
  "</w:body></w:document>";

beforeEach(() => {
  execFile.mockClear();
});

describe("countWords / documentKind", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("  one two\n\nthree\tfour ")).toBe(4);
    expect(countWords("   ")).toBe(0);
  });

  it("picks the extractor from the name, then the MIME type", () => {
    expect(documentKind("Essay.PDF")).toBe("pdf");
    expect(documentKind("x", "application/pdf")).toBe("pdf");
    expect(
      documentKind(
        "untitled",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("docx");
    expect(documentKind("notes", "text/plain; charset=utf-8")).toBe("text");
    expect(documentKind("photo.heic", "image/heic")).toBeUndefined();
  });
});

describe("extractDocumentText", () => {
  it("reads a docx's paragraphs, with entities decoded", async () => {
    const p = file("a.docx", makeZip({ "word/document.xml": DOCX_XML }));
    const r = await extractDocumentText(p);
    expect(r).toEqual({
      ok: true,
      kind: "docx",
      text: "Play matters in early years.\nSecond & last\tparagraph.",
      words: 9,
    });
  });

  it("reads pptx slides in slide order, markers left out of the count", async () => {
    const slide = (t: string) =>
      `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
    const p = file(
      "deck.pptx",
      makeZip({
        "ppt/slides/slide10.xml": slide("ten"),
        "ppt/slides/slide2.xml": slide("two words"),
        "ppt/slides/slide1.xml": slide("one"),
        "ppt/notesSlides/notesSlide1.xml": slide("speaker notes"),
      }),
    );
    const r = await extractDocumentText(p);
    expect(r.ok && r.text).toBe(
      "--- slide 1 ---\none\n\n--- slide 2 ---\ntwo words\n\n--- slide 3 ---\nten",
    );
    expect(r.ok && r.words).toBe(4);
  });

  it("numbers PDF pages from pdftotext's form feeds", async () => {
    execFile.mockImplementationOnce((_c, _a, _o, cb) =>
      cb(null, "Title page here\fBody text on two\f"),
    );
    const p = file("essay.pdf", "%PDF-1.4");
    const r = await extractDocumentText(p, { fileName: "Essay.pdf" });
    expect(execFile.mock.calls[0]?.[0]).toBe("pdftotext");
    expect(execFile.mock.calls[0]?.[1]).toEqual(["-enc", "UTF-8", p, "-"]);
    expect(r).toEqual({
      ok: true,
      kind: "pdf",
      text: "--- page 1 ---\nTitle page here\n\n--- page 2 ---\nBody text on two",
      words: 7,
    });
  });

  it("says why when a PDF has no text layer or pdftotext is missing", async () => {
    const p = file("scan.pdf", "%PDF-1.4");
    execFile.mockImplementationOnce((_c, _a, _o, cb) => cb(null, "\f\f"));
    const scanned = await extractDocumentText(p);
    expect(scanned).toEqual({
      ok: false,
      reason: expect.stringMatching(/no text layer/),
    });

    execFile.mockImplementationOnce((_c, _a, _o, cb) =>
      cb(
        Object.assign(new Error("spawn pdftotext ENOENT"), { code: "ENOENT" }),
        "",
      ),
    );
    const missing = await extractDocumentText(p);
    expect(missing).toEqual({
      ok: false,
      reason: expect.stringMatching(/pdftotext.*not installed/),
    });
  });

  it("reads plain text and refuses unknown types without throwing", async () => {
    const t = await extractDocumentText(file("n.txt", "a b\r\nc"));
    expect(t).toEqual({ ok: true, kind: "text", text: "a b\nc", words: 3 });
    const bad = await extractDocumentText(file("x.docx", "not a zip"));
    expect(bad).toEqual({ ok: false, reason: "not a zip archive" });
    const unknown = await extractDocumentText(file("x.heic", "…"));
    expect(unknown.ok).toBe(false);
  });
});

describe("readZipTextEntries", () => {
  it("returns only the matching entries", () => {
    const zip = makeZip({ "a.xml": "<a/>", "b.xml": "<b/>" });
    expect(readZipTextEntries(zip, (n) => n === "b.xml")).toEqual([
      { name: "b.xml", text: "<b/>" },
    ]);
  });
});
