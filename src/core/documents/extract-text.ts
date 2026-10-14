/**
 * Plain text out of a document a user sent: PDF, Word (docx), PowerPoint
 * (pptx) and plain-text files.
 *
 * Why the daemon does this rather than the model: a turn from anyone but
 * the operator runs with the conversation-only tool set (see
 * core/mcp-hub/guest-scope.ts) — no shell and no file reads — so telling
 * the model "the PDF is saved at /path" leaves it unable to open it. Text
 * extracted here goes into the prompt itself, along with an exact word
 * count, so the document is readable on every tool surface and nobody
 * has to estimate its length by eye.
 *
 * PDFs go through poppler's `pdftotext` when it is installed; without it,
 * or for a scanned PDF with no text layer, the result says why instead.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { unescapeHtml } from "../../util/text/html-entities.js";
import { malformedDocument, readZipTextEntries } from "./zip-entries.js";

export type DocumentKind = "pdf" | "docx" | "pptx" | "text";

export type ExtractedText =
  | { ok: true; kind: DocumentKind; text: string; words: number }
  | { ok: false; reason: string };

const PDFTOTEXT_TIMEOUT_MS = 30_000;
/** Output cap for pdftotext — far beyond any essay, short of a runaway. */
const PDFTOTEXT_MAX_BUFFER = 32 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "log",
  "xml",
  "html",
  "htm",
  "yaml",
  "yml",
]);

const MIME_KINDS: Record<string, DocumentKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/json": "text",
};

/** Whitespace-separated words — what a word processor's count approximates. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

/** Which extractor applies, from the file name first, then the MIME type. */
export function documentKind(
  fileName: string,
  mimetype?: string,
): DocumentKind | undefined {
  const ext = extname(fileName).slice(1).toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  const mime = mimetype?.split(";")[0]?.trim().toLowerCase();
  if (!mime) return undefined;
  return MIME_KINDS[mime] ?? (mime.startsWith("text/") ? "text" : undefined);
}

function pdfToText(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "pdftotext",
      ["-enc", "UTF-8", filePath, "-"],
      { timeout: PDFTOTEXT_TIMEOUT_MS, maxBuffer: PDFTOTEXT_MAX_BUFFER },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** XML markup → text: paragraph/line/tab markers first, then tags stripped. */
function xmlText(xml: string, paragraphEnd: RegExp): string {
  return unescapeHtml(
    xml
      .replace(/<w:tab\/>|<a:tab\/>/g, "\t")
      .replace(/<w:br\/>|<w:cr\/>|<a:br\/>/g, "\n")
      .replace(paragraphEnd, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function docxText(buf: Buffer): string {
  const [doc] = readZipTextEntries(buf, (n) => n === "word/document.xml");
  if (!doc) throw malformedDocument("no word/document.xml in the archive");
  return xmlText(doc.text, /<\/w:p>/g);
}

function pptxSlides(buf: Buffer): string[] {
  const slideNo = (name: string) =>
    Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
  return readZipTextEntries(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNo(a.name) - slideNo(b.name))
    .map((s) => xmlText(s.text, /<\/a:p>/g));
}

/**
 * A document as sections: PDF pages (pdftotext separates them with form
 * feeds), pptx slides, or one section for everything else. Pages and
 * slides get numbered markers so the model can cite "page 14".
 */
type Sections = { unit?: "page" | "slide"; parts: string[] };

async function extractSections(
  kind: DocumentKind,
  filePath: string,
): Promise<Sections> {
  if (kind === "pdf") {
    const pages = (await pdfToText(filePath)).split("\f");
    // pdftotext ends the last page with a form feed too.
    if (pages.length > 1 && !pages[pages.length - 1]!.trim()) pages.pop();
    return { unit: "page", parts: pages };
  }
  const buf = await readFile(filePath);
  if (kind === "docx") return { parts: [docxText(buf)] };
  if (kind === "pptx") return { unit: "slide", parts: pptxSlides(buf) };
  return { parts: [buf.toString("utf8")] };
}

function joinSections({ unit, parts }: Sections): string {
  const clean = parts.map((p) => p.replace(/\r\n?/g, "\n").trim());
  if (!unit || clean.length < 2) return clean.join("\n\n").trim();
  return clean.map((p, i) => `--- ${unit} ${i + 1} ---\n${p}`).join("\n\n");
}

function failureReason(kind: DocumentKind, err: unknown): string {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT" && kind === "pdf") {
    return "pdftotext (poppler-utils) is not installed on this host";
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract a document's text. Never throws: an unsupported type or a
 * failed extraction comes back as `{ ok: false, reason }`, which the
 * caller passes on to the model so it can say what went wrong.
 */
export async function extractDocumentText(
  filePath: string,
  meta: { fileName?: string; mimetype?: string } = {},
): Promise<ExtractedText> {
  const kind = documentKind(meta.fileName ?? filePath, meta.mimetype);
  if (!kind) {
    return { ok: false, reason: "no text extractor for this file type" };
  }
  try {
    const sections = await extractSections(kind, filePath);
    // Counted before page/slide markers are added, so they don't inflate it.
    const words = sections.parts.reduce((n, p) => n + countWords(p), 0);
    if (words === 0) {
      return {
        ok: false,
        reason:
          kind === "pdf"
            ? "the PDF has no text layer (probably scanned images of pages)"
            : "the document contains no text",
      };
    }
    return { ok: true, kind, text: joinSections(sections), words };
  } catch (err) {
    return { ok: false, reason: failureReason(kind, err) };
  }
}
