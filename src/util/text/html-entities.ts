/**
 * Decode the handful of HTML entities that leak into chat titles and
 * previews. Single pass on purpose: each `&...;` in the input is decoded at
 * most once, so `&amp;lt;` becomes the literal text `&lt;`, never `<`.
 */
const NAMED: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  amp: "&",
};

const ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(quot|apos|lt|gt|nbsp|amp));/g;

export function unescapeHtml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    ENTITY,
    (match, hex?: string, dec?: string, name?: string) => {
      if (name) return NAMED[name] ?? match;
      const code = hex ? parseInt(hex, 16) : parseInt(dec ?? "", 10);
      if (!(code > 0 && code <= 0x10ffff)) return match;
      return code === 160 ? " " : String.fromCodePoint(code);
    },
  );
}
