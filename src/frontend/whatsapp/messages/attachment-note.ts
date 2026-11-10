/**
 * What the model is told about an inbound attachment, and about the
 * length of a long pasted message.
 *
 * A document's path alone is not enough: turns from anyone but the
 * operator have no file tools (core/mcp-hub/guest-scope.ts), so the
 * model could see "[attached document: …pdf]" and still not open it.
 * Documents therefore travel with their extracted text and an exact word
 * count — counting words by eye is how a model ends up 30% out.
 */

import {
  countWords,
  extractDocumentText,
} from "../../../core/documents/extract-text.js";
import type { SavedMedia } from "./media-store.js";

/** Most document text put into one prompt (~13k words). */
const DOCUMENT_PROMPT_CHAR_CAP = 80_000;

/** Pasted messages at least this long get their word count attached. */
const PASTE_WORD_COUNT_MIN = 100;

const COUNT_BASIS =
  "whitespace-separated, so a word processor's count may differ by a few";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** The note for a saved document: header, then its text or why there is none. */
export async function documentNote(media: SavedMedia): Promise<string> {
  const name = media.fileName ?? media.filePath.split("/").pop() ?? "document";
  const header =
    `[attached document: "${name}" (${media.mimetype ?? "unknown type"}, ` +
    `${formatSize(media.size)}), saved to: ${media.filePath}]`;
  const extracted = await extractDocumentText(media.filePath, {
    fileName: name,
    ...(media.mimetype ? { mimetype: media.mimetype } : {}),
  });
  if (!extracted.ok) {
    return (
      `${header}\n[the document's text could not be extracted: ` +
      `${extracted.reason}. Without file tools you can't open it either — ` +
      `say so, and ask for the text to be pasted or the file re-sent as .docx or .pdf.]`
    );
  }
  const { text, words } = extracted;
  const shown = text.slice(0, DOCUMENT_PROMPT_CHAR_CAP);
  const scope =
    shown.length < text.length
      ? `only the first ${fmt(shown.length)} of ${fmt(text.length)} characters are shown`
      : "the full text is below";
  return (
    `${header}\n[document text, extracted for you: ${fmt(words)} words ` +
    `(${COUNT_BASIS}); ${scope}]\n<document>\n${shown}\n</document>`
  );
}

/** The prompt suffix for an attachment of any kind ("" for none). */
export async function attachmentNote(
  media: SavedMedia | undefined,
): Promise<string> {
  if (!media) return "";
  if (media.type === "document") return `\n${await documentNote(media)}`;
  return `\n[attached ${media.type}: ${media.filePath}]`;
}

/** "[this message is N words …]" for a long paste, else "". */
export function pastedLengthNote(text: string): string {
  const words = countWords(text);
  if (words < PASTE_WORD_COUNT_MIN) return "";
  return `\n[this message is ${fmt(words)} words (${COUNT_BASIS})]`;
}
