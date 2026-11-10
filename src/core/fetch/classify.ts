/**
 * Response classification for the fetch ladder: is this content, a bot
 * wall worth climbing past, or a definitive answer (a wrong URL) that no
 * amount of climbing will change?
 *
 * Getting "blocked" vs "not found" right is the whole point: climbing on a
 * 404 hammers a site through every exit for nothing and then reports a
 * block that never happened; stopping on a 403 challenge gives up on a
 * page that the next rung would have fetched.
 */

import type { Verdict } from "./types.js";

/** Statuses bot walls answer with. 999 is LinkedIn's. */
const BLOCK_STATUSES = new Set([403, 429, 503, 999]);
const NOT_FOUND_STATUSES = new Set([404, 410]);

/**
 * Challenge pages are small; a real article that merely mentions
 * "captcha" is not. Only bodies under this size are scanned.
 */
const CHALLENGE_SCAN_BYTES = 32 * 1024;

/**
 * Markers of interstitial challenge pages (Cloudflare, DataDome, Akamai,
 * Imperva/Incapsula, PerimeterX). Deliberately no bare "captcha" or
 * reCAPTCHA marker: plenty of ordinary pages embed a form captcha. A 2xx
 * page flagged here is kept as a fallback by the ladder, so a false
 * positive costs extra rungs, never the content.
 */
const CHALLENGE_MARKERS: readonly RegExp[] = [
  // Not "challenge-platform": Cloudflare injects that script path into
  // ordinary pages too. Same for the DataDome/PerimeterX tag scripts —
  // only their challenge iframes/widgets count.
  /cf-chl-|cf_chl_opt|<title>Just a moment\.\.\.<\/title>/i,
  /Attention Required! \| Cloudflare/i,
  /captcha-delivery\.com/i,
  /_Incapsula_Resource|Incapsula incident/i,
  /px-captcha/i,
  /Pardon Our Interruption/i,
  /<title>Access Denied<\/title>[\s\S]*Reference #/i,
  /verify (that )?you are (a )?human|are you a robot/i,
  /challenges\.cloudflare\.com\/turnstile/i,
];

/** All markers as one regex source (for the browser driver subprocess). */
export const CHALLENGE_PATTERN = CHALLENGE_MARKERS.map(
  (re) => `(?:${re.source})`,
).join("|");

/** True when a small body looks like a bot-check interstitial. */
export function looksLikeChallenge(body: Buffer | string): boolean {
  const size = typeof body === "string" ? body.length : body.byteLength;
  if (size === 0 || size > CHALLENGE_SCAN_BYTES) return false;
  const text = typeof body === "string" ? body : body.toString("latin1");
  return CHALLENGE_MARKERS.some((re) => re.test(text));
}

/** Judge one HTTP answer. Network failures never reach here. */
export function classifyResponse(status: number, body: Buffer): Verdict {
  if (BLOCK_STATUSES.has(status)) return "blocked";
  if (looksLikeChallenge(body)) return "blocked";
  if (status >= 200 && status < 300) return "ok";
  if (NOT_FOUND_STATUSES.has(status)) return "not-found";
  return "http-error";
}

/** Verdicts after which trying another rung is pointless. */
export function isDefinitive(verdict: Verdict): boolean {
  return (
    verdict === "ok" || verdict === "not-found" || verdict === "http-error"
  );
}
