/**
 * Telegram message formatting and splitting utilities.
 */

import { escapeHtml as escapeNative } from "../../native/htmlents.js";
import { splitMessage as splitNative } from "../../native/textops.js";

/**
 * Split a message into chunks that fit Telegram's 4096 char limit.
 * Delegates to the shared Zig core (native/textops-wasm): fence-aware
 * — splits never strand an open ``` block — and surrogate-safe, unlike
 * the JS loop this replaces.
 */
export function splitMessage(text: string, max: number): string[] {
  return splitNative(text, max);
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 * Must be applied to all text that is NOT inside an HTML tag.
 * Delegates to the Rust core (native/htmlents-wasm): one pass over the
 * bytes instead of the five chained regex passes this replaces.
 */
export function escapeHtml(text: string): string {
  return escapeNative(text);
}

/**
 * Turn Unicode bullet glyphs into Markdown list markers before sending.
 * Telegram's Rich Markdown parser recognizes `-`/`*`/`+` lists, but treats
 * `•` as plain text; its soft line breaks can then collapse adjacent items.
 * Leave fenced code blocks untouched so literal bullets in examples survive.
 */
export function normalizeTelegramMarkdownLists(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^[ \t]*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/^([ \t]*)•([ \t]+)/, "$1-$2");
    })
    .join("\n");
}

/**
 * True when every tag in `html` is closed in the order it was opened.
 *
 * The inline formatters below are independent regex passes with no
 * knowledge of each other's spans, so interleaved delimiters
 * (`**a _b** c_`) emit crossed tags like `<b><i>x</b></i>`. Telegram
 * refuses to parse those and 400s the whole message, so the caller
 * checks before committing to the formatted rendering.
 *
 * Only tags this module generates are possible here — everything else
 * was entity-escaped in step 3 — so a plain stack is sufficient.
 */
function isWellFormedHtml(html: string): boolean {
  const stack: string[] = [];
  const tag = /<(\/?)([a-zA-Z]+)(?:\s[^>]*)?>/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html)) !== null) {
    const [, closing, name] = match;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name!);
    }
  }
  return stack.length === 0;
}

/** `\x00URLn\x00` → the stashed URL, or undefined when it isn't a placeholder. */
function resolveUrlPlaceholder(
  target: string,
  urls: string[],
): string | undefined {
  // oxlint-disable-next-line no-control-regex
  const match = /^\x00URL(\d+)\x00$/.exec(target);
  return match ? urls[Number(match[1])] : undefined;
}

/** Apply the inline delimiter passes to already-escaped text. */
function applyInlineFormatting(input: string, urls: string[]): string {
  let out = input;
  // Bold+italic: ***text*** — must run before the ** and * passes, which
  // would otherwise split it into the crossed pair `<b><i>x</b></i>`.
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
  // Bold: **text**
  out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Italic: *text* (not preceded by another *)
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  // Italic: _text_ (surrounded by non-word or start/end)
  out = out.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");
  // Links: [text](url) — only safe URL schemes become anchors. The target
  // arrives as a `\x00URLn\x00` placeholder (step 2b), so the passes above
  // never saw the URL's own punctuation; resolve it back here. Both text and
  // url were already HTML-escaped (quotes included, so the href attribute
  // can't be broken out of); escaping again here corrupted every & in a
  // query string into &amp;amp;.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, target) => {
    const url = resolveUrlPlaceholder(target, urls) ?? target;
    return /^https?:\/\//i.test(url) ? `<a href="${url}">${text}</a>` : text;
  });
  // Strikethrough: ~~text~~
  out = out.replace(/~~(.+?)~~/g, "<s>$1</s>");
  return out;
}

/**
 * Block-level passes over already-escaped text: ATX headings → bold lines,
 * runs of `> ` lines → one `<blockquote>`. Placeholders for code are opaque
 * `\x00…\x00` tokens, so a `#` inside a fenced block is never seen here.
 */
function applyBlockFormatting(input: string): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let quote: string[] | null = null;
  const flushQuote = () => {
    if (quote) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = null;
  };
  for (const line of lines) {
    const quoted = /^&gt;[ \t]?(.*)$/.exec(line);
    if (quoted) {
      (quote ??= []).push(quoted[1] ?? "");
      continue;
    }
    flushQuote();
    // `#` must be followed by whitespace to be a heading: `#993` is a
    // reference, not a title. Trailing closing hashes (`## Title ##`) are
    // markdown too and are dropped.
    const heading = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    out.push(heading ? `<b>${heading[1]}</b>` : line);
  }
  flushQuote();
  return out.join("\n");
}

/**
 * Convert Markdown output to Telegram-safe HTML.
 *
 * Handles: bold, italic, inline code, fenced code blocks, links.
 * Escapes HTML entities in non-formatted text.
 *
 * Guarantees well-formed output: when the inline passes would produce
 * crossed tags, the formatting is dropped rather than emitted, because
 * Telegram rejects the entire message on a parse error and the caller's
 * only recourse is a second round-trip with no formatting at all.
 */
export function markdownToTelegramHtml(text: string): string {
  // Step 1: Extract fenced code blocks to avoid processing their contents.
  // We replace them with placeholders and restore after all inline processing.
  const codeBlocks: string[] = [];
  let processed = text.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const escaped = escapeHtml(code.replace(/\n$/, ""));
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      const placeholder = `\x00CODEBLOCK${codeBlocks.length}\x00`;
      codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
      return placeholder;
    },
  );

  // Step 2: Extract inline code spans to protect them from further processing.
  const inlineCode: string[] = [];
  processed = processed.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const placeholder = `\x00INLINECODE${inlineCode.length}\x00`;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // Step 2b: Stash link targets. The emphasis passes run before the link
  // pass and have no idea what a URL is, so punctuation inside the target
  // used to be consumed as a delimiter: a Chomikuj path like
  // `Jak+Si*c4*99+Bawi*c4*85+Ludzie.mp3` reads as two italic runs, the
  // resulting tags cross, and the well-formedness guard then discards the
  // formatting for the *whole* message. Placeholders carry no delimiters,
  // so the URL is invisible to every pass but the link one.
  const urls: string[] = [];
  processed = processed.replace(
    /(\[[^\]\n]*\])\(([^()\s]+)\)/g,
    (_match, label: string, url: string) => {
      const placeholder = `\x00URL${urls.length}\x00`;
      urls.push(escapeHtml(url));
      return `${label}(${placeholder})`;
    },
  );

  // Step 3: Escape HTML in remaining plain text (before applying formatting).
  // Escape HTML in plain text segments (skip placeholders marked with \x00)
  // oxlint-disable-next-line no-control-regex
  processed = processed.replace(/[^`\x00]+/g, (segment) => escapeHtml(segment));

  // Step 3b: Block-level markdown. Telegram HTML has no headings, so an
  // ATX heading becomes a bold line — the alternative is the `###` going
  // out raw, and `# Title` alone turns `#Title` into a hashtag entity.
  // Only `#` followed by whitespace is a heading: `#993` is a PR/hashtag
  // reference and stays literal. Runs of `> ` lines become a blockquote,
  // which Telegram does render. The text is already escaped here, so the
  // quote marker is `&gt;`.
  processed = applyBlockFormatting(processed);

  // Step 4: Apply inline formatting, but only keep it if the result is
  // actually parseable. `processed` at this point holds escaped text plus
  // tag-free placeholders, so it is a safe unformatted fallback.
  const unformatted = processed;
  processed = applyInlineFormatting(processed, urls);
  if (!isWellFormedHtml(processed)) {
    processed = unformatted;
  }

  // Step 4b: Restore any link target that never became an anchor — a
  // non-http scheme, or the unformatted fallback above. Anchors already
  // resolved their placeholder inline.
  for (let i = 0; i < urls.length; i++) {
    processed = processed.replace(`\x00URL${i}\x00`, () => urls[i]!);
  }

  // Steps 5+6: Restore code spans and fenced blocks. The replacement MUST
  // go through a function: with a string, String.replace interprets $-
  // substitution patterns in the *code content* ($& re-inserts the
  // placeholder, $\` splices the whole preceding message), which is how
  // \`$&\` in a code span used to leak a stranded INLINECODEn into chat.
  for (let i = 0; i < inlineCode.length; i++) {
    processed = processed.replace(
      `\x00INLINECODE${i}\x00`,
      () => inlineCode[i],
    );
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`\x00CODEBLOCK${i}\x00`, () => codeBlocks[i]);
  }

  return processed;
}
