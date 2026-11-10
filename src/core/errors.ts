/**
 * Typed error classification.
 *
 * One place to classify errors. Every module reads `err.reason` instead
 * of regex-matching error messages. Inspired by OpenClaw's FailoverError.
 */

// ── Error reasons ───────────────────────────────────────────────────────────

type ErrorReason =
  | "rate_limit"
  | "usage_limit"
  | "overloaded"
  | "network"
  | "auth"
  | "context_length"
  | "session_expired"
  | "bad_request"
  | "forbidden"
  | "telegram_api"
  // The user stopped the turn (/stop, talon kill). Not a fault: the
  // frontends deliver nothing for it — the stop acknowledgement already
  // told the user what happened.
  | "stopped"
  | "unknown";

/**
 * Claude subscription usage-limit messages, as produced by Claude Code /
 * the Agent SDK (see rateLimitMessages.ts upstream: "You've hit your
 * weekly limit · resets Jul 10, 9am", "You're out of extra usage", …)
 * plus the legacy "Claude AI usage limit reached|<ts>" format. These are
 * already user-facing text — classification marks them `usage_limit` so
 * `friendlyMessage` passes them through instead of collapsing them to a
 * generic template. Unlike `rate_limit` (a transient 429), a usage limit
 * doesn't clear on a short retry, so `retryable` stays false.
 */
const USAGE_LIMIT_RE =
  /you['’]ve hit your .{0,40}limit|you['’]re out of extra usage|claude ai usage limit reached|usage limit reached/i;

/**
 * Ceiling on how long a failed attempt may have run and still earn the
 * frontend queues' blind retry. `retryable` means "a short pause may clear
 * it", which holds for a 429 or a dropped socket but not for an attempt
 * that already burned minutes before failing (e.g. the 600s remote turn
 * deadline — its rejection is `name: "TimeoutError"`, classified as
 * transient network). Turns serialize per chat, so retrying such an
 * attempt doubles the stall for every message queued behind it.
 */
export const RETRY_ELAPSED_CAP_MS = 120_000;

// ── TalonError class ────────────────────────────────────────────────────────

export class TalonError extends Error {
  readonly reason: ErrorReason;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    params: {
      reason: ErrorReason;
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "TalonError";
    this.reason = params.reason;
    this.retryable = params.retryable ?? false;
    this.status = params.status;
    this.retryAfterMs = params.retryAfterMs;
  }
}

// ── Transport-failure detection ─────────────────────────────────────────────

/**
 * Node / undici error codes that mean "the connection failed, try again".
 *
 * Codes beat message text: they're stable across Node versions and
 * locales, and undici in particular throws bare `TypeError: terminated`
 * / `TypeError: fetch failed` whose message says nothing while the
 * `code` on the cause chain says everything.
 *
 * `ENOTFOUND` is deliberately absent — a DNS name that doesn't resolve
 * is a config error, not a blip. `EAI_AGAIN` (temporary resolver
 * failure) IS here, because that one does clear.
 */
const RETRYABLE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

/**
 * Transient transport failures that surface as prose with no usable
 * `code` — Node's own `socket hang up`, undici's `other side closed` /
 * `Premature close`, and the named 5xx bodies proxies return as text.
 *
 * `timeout`/`timed out` is here but bare `abort` deliberately is NOT: a
 * user interrupt (`controller.abort()` → "This operation was aborted")
 * must stay non-retryable, or cancelling a turn would restart it.
 * `AbortSignal.timeout()` says "aborted due to timeout" and is caught by
 * the timeout half, which is the distinction we want.
 */
const TRANSIENT_TRANSPORT_RE =
  /socket hang up|other side closed|premature close|connection (?:closed|reset|lost)|timed out|time-?out|bad gateway|service unavailable|gateway time-?out|internal server error|upstream connect error|server disconnected/i;

/**
 * Walk the `cause` chain collecting `code` / `errno` / `name` values.
 * undici nests the real fault one or two levels down (`TypeError: fetch
 * failed` → `cause: Error { code: 'ECONNREFUSED' }`), so a shallow look
 * at the thrown object misses it entirely.
 */
function errorCodes(err: unknown, depth = 0): string[] {
  if (depth > 5 || err === null || typeof err !== "object") return [];
  const e = err as { code?: unknown; errno?: unknown; cause?: unknown };
  const codes: string[] = [];
  if (typeof e.code === "string") codes.push(e.code);
  if (typeof e.errno === "string") codes.push(e.errno);
  codes.push(...errorCodes(e.cause, depth + 1));
  return codes;
}

// ── Classify any error ──────────────────────────────────────────────────────

/**
 * A backend session that expired or no longer exists. Claude's CLI answers
 * a resume of a session whose transcript is missing with "No conversation
 * found with session ID: …" — a definite not-found; without the match
 * every later turn in the chat fails the same way. The reset that follows
 * archives the old id (resetSession), so a transcript that turns up again
 * can be re-attached.
 */
const SESSION_EXPIRED_RE =
  /session.*expired|expired.*session|invalid.*resume|no conversation found/i;

/**
 * Wrap or classify any thrown value into a TalonError.
 * Call this at module boundaries (backend catch, bridge catch) to convert
 * raw errors into typed ones that callers can switch on.
 */
export function classify(err: unknown): TalonError {
  if (err instanceof TalonError) return err;

  let msg: string;
  if (err instanceof Error) msg = err.message;
  else if (typeof err === "string") msg = err;
  else {
    try {
      msg = String(err);
    } catch {
      msg = "[non-stringifiable error]";
    }
  }
  const cause = err instanceof Error ? err : undefined;

  // Extract HTTP error status if present (4xx/5xx only — success codes are
  // not actionable and matching them from unrelated numbers, e.g. "200ms",
  // would produce a spurious status on the returned TalonError)
  const statusMatch = msg.match(/\b([45]\d{2})\b/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

  // Subscription usage limit — checked before the generic rate-limit
  // branch ("usage limit reached" would otherwise never be reached, and
  // "You've hit your…" carries no 429/rate-limit marker at all).
  if (USAGE_LIMIT_RE.test(msg)) {
    return new TalonError(msg, {
      reason: "usage_limit",
      retryable: false,
      status: status ?? 429,
      cause,
    });
  }

  // Rate limit
  if (/rate.?limit|429|too many requests/i.test(msg)) {
    const retryMatch = msg.match(/retry.?after[:\s]*(\d+)/i);
    const retryAfterMs = retryMatch
      ? Math.min(parseInt(retryMatch[1], 10) * 1000, 300_000)
      : 60_000;
    return new TalonError(msg, {
      reason: "rate_limit",
      retryable: true,
      status: status ?? 429,
      retryAfterMs,
      cause,
    });
  }

  // Transport failure by CODE, before any prose matching. undici wraps
  // the real fault ("TypeError: fetch failed" → cause.code) so the
  // message alone is often empty of signal while the code is decisive.
  //
  // `TimeoutError` (what AbortSignal.timeout throws) is a transient
  // deadline and retries. `AbortError` is NOT handled here on purpose —
  // it means a user interrupt, and retrying a cancelled turn would
  // restart work the user just stopped.
  const errName = err instanceof Error ? err.name : "";
  const transportCode = errorCodes(err).find((code) =>
    RETRYABLE_TRANSPORT_CODES.has(code),
  );
  if (transportCode !== undefined || errName === "TimeoutError") {
    return new TalonError(msg, {
      reason: "network",
      retryable: true,
      retryAfterMs: 2_000,
      cause,
    });
  }

  // Overloaded / capacity
  if (/overloaded|503|capacity/i.test(msg)) {
    return new TalonError(msg, {
      reason: "overloaded",
      retryable: true,
      status: status ?? 503,
      retryAfterMs: 5_000,
      cause,
    });
  }

  // Network errors — codes echoed into the message text (a stringified
  // cause, a provider wrapping the errno into prose), plus the
  // code-less transient shapes in TRANSIENT_TRANSPORT_RE.
  //
  // The prose half only applies when NO HTTP status was found. A real
  // status is the stronger signal and its own branches below own it:
  // "500 Internal Server Error" must stay `overloaded` carrying
  // status 500, not become a status-less `network`.
  if (
    /network|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_|fetch failed|connection reset/i.test(
      msg,
    ) ||
    (status === undefined && TRANSIENT_TRANSPORT_RE.test(msg))
  ) {
    return new TalonError(msg, {
      reason: "network",
      retryable: true,
      retryAfterMs: 2_000,
      cause,
    });
  }

  // 408 Request Timeout — a transient deadline like any other, but it
  // is neither 4xx-terminal nor 5xx, so without this branch it falls
  // through to `unknown`/non-retryable and strands the request.
  if (status === 408) {
    return new TalonError(msg, {
      reason: "network",
      retryable: true,
      status: 408,
      retryAfterMs: 2_000,
      cause,
    });
  }

  // Session expired (or gone — see SESSION_EXPIRED_RE)
  if (SESSION_EXPIRED_RE.test(msg)) {
    return new TalonError(msg, {
      reason: "session_expired",
      retryable: false,
      cause,
    });
  }

  // Context length / overflow
  if (
    /context.{0,10}length|too.{0,10}long|token.{0,10}limit|context.{0,10}overflow/i.test(
      msg,
    )
  ) {
    return new TalonError(msg, {
      reason: "context_length",
      retryable: false,
      cause,
    });
  }

  // Auth
  if (/authentication|unauthorized|401|api.?key/i.test(msg)) {
    return new TalonError(msg, {
      reason: "auth",
      retryable: false,
      status: status ?? 401,
      cause,
    });
  }

  // Bad request (don't retry)
  if (status === 400) {
    return new TalonError(msg, {
      reason: "bad_request",
      retryable: false,
      status: 400,
      cause,
    });
  }

  // Forbidden (don't retry)
  if (status === 403) {
    return new TalonError(msg, {
      reason: "forbidden",
      retryable: false,
      status: 403,
      cause,
    });
  }

  // Server errors (5xx) are generally retryable
  if (status && status >= 500) {
    return new TalonError(msg, {
      reason: "overloaded",
      retryable: true,
      status,
      retryAfterMs: 2_000,
      cause,
    });
  }

  // Unknown
  return new TalonError(msg, {
    reason: "unknown",
    retryable: false,
    status,
    cause,
  });
}

// ── User-friendly messages ──────────────────────────────────────────────────

const FRIENDLY_MESSAGES: Record<ErrorReason, string> = {
  rate_limit: "Rate limited. Try again in a moment.",
  usage_limit: "Usage limit reached. Try again after it resets.",
  overloaded:
    "Upstream model is busy right now. Retrying with a faster fallback...",
  network: "Connection issue. Retrying shortly.",
  auth: "API key error. Bot operator: check the backend's credentials (admins: /auth to sign in again).",
  context_length:
    "Conversation too long for the context window. Use /reset to start fresh.",
  session_expired: "Session expired. Retrying automatically...",
  bad_request: "Something went wrong. Try /reset if this keeps happening.",
  forbidden: "Permission denied for this action.",
  telegram_api: "Telegram API error. Try again.",
  stopped: "⏹ Stopped.",
  unknown: "Something went wrong. Try again or /reset.",
};

/**
 * Reasons whose template alone tells the user nothing actionable — the
 * underlying error detail is appended so "Something went wrong" always
 * says WHAT went wrong. Templated reasons like `network`/`overloaded`
 * stay terse: they're transient and the detail is just transport noise.
 */
const DETAIL_REASONS: ReadonlySet<ErrorReason> = new Set([
  "auth",
  "bad_request",
  "forbidden",
  "unknown",
]);

/** Collapse whitespace and clip the raw error for inline display. */
function clipDetail(msg: string, max = 300): string {
  const flat = msg.replace(/\s+/g, " ").trim();
  if (!flat || flat === "[non-stringifiable error]") return "";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Get a user-friendly error message. For rate limits, includes retry timing.
 * Usage-limit and session-expired messages pass through verbatim (they're
 * already user-facing); generic reasons carry the underlying detail.
 */
export function friendlyMessage(err: unknown): string {
  const classified = err instanceof TalonError ? err : classify(err);

  if (classified.reason === "rate_limit" && classified.retryAfterMs) {
    const seconds = Math.ceil(classified.retryAfterMs / 1000);
    return `Rate limited. Try again in ${seconds} seconds.`;
  }

  // Already user-friendly from the backend — pass through as-is.
  if (
    classified.reason === "session_expired" ||
    classified.reason === "usage_limit"
  ) {
    return classified.message || FRIENDLY_MESSAGES[classified.reason];
  }

  const base = FRIENDLY_MESSAGES[classified.reason];
  if (DETAIL_REASONS.has(classified.reason)) {
    const detail = clipDetail(classified.message);
    // Skip when the detail adds nothing over the template itself.
    if (detail && detail !== base) return `${base}\n\nDetail: ${detail}`;
  }
  return base;
}
