/**
 * The error text an operator alert or a key=value log line may carry.
 *
 * Alerts land on a phone and log lines get pasted into issues, so the
 * raw message is flattened to one line, clipped, and stripped of the
 * credential shapes a provider error can echo back (bearer tokens, API
 * keys, `token=` query parameters).
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[\w.~+/=-]+/gi,
  /\b(?:sk|pk|rk)-[\w-]{8,}/g,
  /\b(?:gh[pousr]|github_pat)_\w{8,}/g,
  /\bxox[abprs]-[\w-]{8,}/g,
  /\b(access_token|refresh_token|api_key|apikey|token|key|secret|password)=[^\s&"']+/gi,
];

/** One-line, clipped, secret-free text for `err`. */
export function faultText(err: unknown, max = 200): string {
  let raw: string;
  if (err instanceof Error) raw = err.message || err.name;
  else if (typeof err === "string") raw = err;
  else {
    try {
      raw = String(err);
    } catch {
      raw = "[unprintable error]";
    }
  }
  let text = raw.replace(/\s+/g, " ").trim();
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, name?: string) =>
      typeof name === "string" && match.includes("=")
        ? `${name}=[redacted]`
        : "[redacted]",
    );
  }
  if (!text) return "unknown error";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
