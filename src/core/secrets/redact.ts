/**
 * Inbound credential redaction — runs on a user's message before it is
 * persisted (history DB, interaction logs, traces) or shown to the model.
 *
 * Three matchers, applied in order:
 *  1. any value already stored in ~/.talon/secrets (exact substring);
 *  2. well-known key/token shapes (sk-…, ghp_…, AKIA…, a PEM private key…);
 *  3. a value next to a password word (`password: hunter2`, `pin 4821`).
 *
 * Each hit becomes `[REDACTED:<kind>]`. Conservative on purpose: prose that
 * merely mentions a password ("I forgot my password", "pin the message")
 * is left alone. A value after a bare "is" or space must look like a
 * credential (a digit or symbol, at least six characters; a PIN is four to
 * eight digits); after `:` or `=` any non-trivial token counts.
 *
 * Nothing here logs, and nothing returned carries a matched value.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dirs } from "../../util/paths.js";

type RedactionKind =
  "stored" | "private-key" | "api-key" | "token" | "password" | "pin";

export interface RedactionResult {
  text: string;
  /** Kinds redacted, in first-seen order; empty when nothing matched. */
  kinds: RedactionKind[];
}

const marker = (kind: RedactionKind): string => `[REDACTED:${kind}]`;

// ── Known token shapes ──────────────────────────────────────────────────

const TOKEN_PATTERNS: ReadonlyArray<{ kind: RedactionKind; re: RegExp }> = [
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // OpenAI / Anthropic / OpenRouter style: sk-…, sk-ant-…, sk-proj-…
  { kind: "api-key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  // GitHub tokens
  {
    kind: "token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
  },
  // AWS access key id
  { kind: "api-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Google API key
  { kind: "api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Stripe
  { kind: "api-key", re: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g },
  // Slack
  { kind: "token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // Telegram bot token
  { kind: "token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  // JWT
  { kind: "token", re: /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g },
  // `api_key=…`, `token: …`, `Bearer …` — a labelled long opaque value
  {
    kind: "token",
    re: /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|token|bearer)\s*(?:[:=]\s*|\s+))([A-Za-z0-9._~+/=-]{16,})/gi,
  },
];

// ── Password-word values ────────────────────────────────────────────────

// Not bare "pass": "I'll pass on 2pm-ish" is prose.
const PASSWORD_WORDS = "password|passwd|passphrase|passcode|pwd|pw";
const PIN_WORDS = "pin code|pincode|pin";
const SEPARATOR = String.raw`(?:\s+(?:is|was)\s+|\s*[:=]\s*|\s+-\s+|\s+)`;

/** `<word> [is|:|=|-] <value>` — the separator is captured to judge the value. */
const PASSWORD_RE = new RegExp(
  String.raw`\b((?:${PASSWORD_WORDS})\b${SEPARATOR})(\S+)`,
  "gi",
);
const PIN_RE = new RegExp(
  String.raw`\b((?:${PIN_WORDS})\b${SEPARATOR})(\S+)`,
  "gi",
);

/** Trailing sentence punctuation isn't part of the value. */
function splitTrailing(token: string): [string, string] {
  const m = /^(.*?)([.,;!?)"']*)$/.exec(token);
  return m ? [m[1] ?? "", m[2] ?? ""] : [token, ""];
}

function looksLikePassword(value: string, explicit: boolean): boolean {
  if (value.startsWith("[REDACTED:")) return false;
  if (explicit) return value.length >= 3;
  if (value.length < 6) return false;
  // A bare word after "is"/space is prose ("my password is wrong").
  return /[0-9]/.test(value) || /[^A-Za-z0-9]/.test(value);
}

function replaceWordValues(
  text: string,
  re: RegExp,
  kind: RedactionKind,
  accept: (value: string, explicit: boolean) => boolean,
  hit: (k: RedactionKind) => void,
): string {
  return text.replace(re, (whole, lead: string, token: string) => {
    const [value, trailing] = splitTrailing(token);
    const explicit = /[:=]\s*$/.test(lead);
    if (!value || !accept(value, explicit)) return whole;
    hit(kind);
    return `${lead}${marker(kind)}${trailing}`;
  });
}

// ── Stored secrets (cached on the folder's mtime) ───────────────────────

/** Shorter stored values would redact ordinary words and numbers. */
const MIN_STORED_LENGTH = 6;

let storedCache: { dir: string; stamp: number; values: string[] } | undefined;

function storedValues(dir: string): string[] {
  let stamp: number;
  try {
    stamp = statSync(dir).mtimeMs;
  } catch {
    return [];
  }
  if (storedCache && storedCache.dir === dir && storedCache.stamp === stamp) {
    return storedCache.values;
  }
  const values: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      try {
        const v = readFileSync(join(dir, name), "utf8").trim();
        if (v.length >= MIN_STORED_LENGTH && v.length <= 4096) values.push(v);
      } catch {
        /* unreadable entry — skip */
      }
    }
  } catch {
    return [];
  }
  // Longest first, so a value containing another is replaced whole.
  values.sort((a, b) => b.length - a.length);
  storedCache = { dir, stamp, values };
  return values;
}

/** Drop the stored-value cache (tests; a write changes the mtime anyway). */
export function resetRedactionCache(): void {
  storedCache = undefined;
}

// ── Entry point ─────────────────────────────────────────────────────────

/** Redact credentials from one inbound message's text. */
export function redactInbound(
  text: string,
  opts: { secretsDir?: string } = {},
): RedactionResult {
  if (!text) return { text, kinds: [] };
  const kinds: RedactionKind[] = [];
  const hit = (k: RedactionKind): void => {
    if (!kinds.includes(k)) kinds.push(k);
  };
  let out = text;

  for (const value of storedValues(opts.secretsDir ?? dirs.secrets)) {
    if (out.includes(value)) {
      out = out.split(value).join(marker("stored"));
      hit("stored");
    }
  }

  for (const { kind, re } of TOKEN_PATTERNS) {
    out = out.replace(re, (whole: string, lead?: string, value?: string) => {
      // Labelled pattern: keep the label, redact only the value.
      if (typeof lead === "string" && typeof value === "string") {
        if (value.startsWith("[REDACTED:") || !/[0-9]/.test(value))
          return whole;
        hit(kind);
        return `${lead}${marker(kind)}`;
      }
      hit(kind);
      return marker(kind);
    });
  }

  out = replaceWordValues(out, PASSWORD_RE, "password", looksLikePassword, hit);
  out = replaceWordValues(
    out,
    PIN_RE,
    "pin",
    (v, explicit) => /^\d{4,8}$/.test(v) || (explicit && /^\d{3,12}$/.test(v)),
    hit,
  );

  return { text: out, kinds };
}

/** The one-time nudge shown when something was redacted. */
function redactionNotice(
  kinds: readonly RedactionKind[],
  deleted: boolean,
): string {
  const what = kinds.join(", ");
  return (
    `🔒 That message looked like it contained a credential (${what}). ` +
    `I redacted it before saving or reading it` +
    (deleted ? " and deleted the original message" : "") +
    `. Next time, use /secret <name> to store it via a one-time private link.`
  );
}

const noticed = new Set<string>();

/** True the first time per chat (per daemon run) — the nudge is said once. */
function shouldNotifyRedaction(chatKey: string): boolean {
  if (noticed.has(chatKey)) return false;
  noticed.add(chatKey);
  return true;
}

/** Whether to delete the original platform message for this chat. */
export function shouldDeleteRedacted(
  mode: "dm" | "always" | "never" | undefined,
  isDm: boolean,
): boolean {
  const m = mode ?? "dm";
  return m === "always" || (m === "dm" && isDm);
}

export interface InboundRedaction {
  text: string;
  redacted: boolean;
  /** Delete the platform's copy of the message (config + DM-ness). */
  deleteOriginal: boolean;
  /** The once-per-chat nudge to send, if any. */
  notice?: string;
}

/**
 * The one call a frontend makes per inbound message: redact `text` per the
 * `redaction` config and decide on deletion and the nudge.
 */
export function applyInboundRedaction(
  text: string,
  ctx: {
    chatKey: string;
    isDm: boolean;
    config?: { enabled?: boolean; deleteOriginal?: "dm" | "always" | "never" };
    secretsDir?: string;
  },
): InboundRedaction {
  if (ctx.config?.enabled === false || !text) {
    return { text, redacted: false, deleteOriginal: false };
  }
  const result = redactInbound(text, { secretsDir: ctx.secretsDir });
  if (!result.kinds.length) {
    return { text, redacted: false, deleteOriginal: false };
  }
  const deleteOriginal = shouldDeleteRedacted(
    ctx.config?.deleteOriginal,
    ctx.isDm,
  );
  return {
    text: result.text,
    redacted: true,
    deleteOriginal,
    ...(shouldNotifyRedaction(ctx.chatKey)
      ? { notice: redactionNotice(result.kinds, deleteOriginal) }
      : {}),
  };
}
