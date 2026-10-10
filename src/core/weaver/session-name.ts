/**
 * Session-name extraction.
 *
 * On the first turn of a chat we want a short human-readable name so the
 * session shows up sensibly in `/sessions`, the debug surface, and any
 * future inbox UI. Use the user's first message after stripping the
 * formatting prefixes added by the prompt formatter.
 *
 * This logic is shared by every backend — without it, the same stripping
 * code lived in three handlers and drifted independently.
 */

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_NAME_LENGTH = 30;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract a session name from the user's first message text.
 *
 * Removes:
 *   - Leading `[bracketed-prefix]` (e.g. the `[Name]` group-chat label
 *     added by `formatUserPrompt`).
 *   - `[msg_id:N]` reference markers anywhere in the string.
 *
 * Truncates to `MAX_NAME_LENGTH` characters and appends an ellipsis.
 * Returns `undefined` when the cleaned text is empty (e.g. the user
 * sent only a sticker or an attachment with no caption).
 */
function unescapeHtml(text: string): string {
  if (!text.includes("&")) return text;
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&#60;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#62;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&#(?:x([0-9a-fA-F]+)|(\d+));/g, (_, hex, dec) => {
      const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&");
}

export function extractSessionName(rawText: string): string | undefined {
  if (!rawText) return undefined;
  const unescaped = unescapeHtml(rawText);
  const cleaned = unescaped
    .replace(/^\[.*?\]\s*/g, "")
    .replace(/\[msg_id:\d+\]\s*/g, "")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_NAME_LENGTH
    ? cleaned.slice(0, MAX_NAME_LENGTH - 3) + "..."
    : cleaned;
}
