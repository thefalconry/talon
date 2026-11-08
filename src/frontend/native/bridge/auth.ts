/**
 * Bridge auth token — the shared secret behind every non-/health route.
 *
 * The operator can set one explicitly (`native.token`); this module covers
 * the case where they didn't but the bridge is about to bind a non-loopback
 * host. Serving the full agent API unauthenticated to the LAN is never an
 * acceptable default, so a token is minted once and persisted under
 * ~/.talon/keys/ — stable across restarts so paired clients keep working.
 *
 * The token value itself never goes to the log (SECURITY.md treats
 * credentials in logs as a vulnerability); same-machine clients pick it up
 * from the 0600 discovery file, remote clients read it from the key file.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirs } from "../../../util/paths.js";
import { log, logWarn } from "../../../util/log.js";

const TOKEN_FILE = "bridge-token";
/** 32 random bytes → 43 base64url chars; comfortably beyond brute force. */
const TOKEN_BYTES = 32;

/** Path of the persisted token, for operator-facing messages. */
export function bridgeTokenPath(dir: string = dirs.keys): string {
  return resolve(dir, TOKEN_FILE);
}

/**
 * Load the persisted auto-generated bridge token, minting it on first use.
 * Lives under ~/.talon/keys/ with owner-only permissions, like the TLS
 * identity next to it.
 */
export function loadOrCreateBridgeToken(dir: string = dirs.keys): string {
  const path = bridgeTokenPath(dir);
  try {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing) return existing;
  } catch {
    // first boot — nothing persisted yet
  }
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // mode above is ignored when the file exists
  log(
    "native",
    `Minted bridge auth token (non-loopback bind with no native.token) — pair remote clients with the value in ${path}`,
  );
  return token;
}

// ── Token strength ─────────────────────────────────────────────────────────

/** Below this estimate a configured token is treated as guessable. */
export const MIN_TOKEN_BITS = 128;

/**
 * Rough entropy estimate for a configured bridge token: length × bits per
 * character, where the per-character figure comes from the alphabet the
 * token visibly uses. It errs low on purpose:
 *
 *   - digits only                     → log2(10) ≈ 3.3 bits/char
 *   - hex                             → 4 bits/char
 *   - one letter case, nothing else   → log2(26) ≈ 4.7 bits/char
 *   - base64 / base64url (≥2 classes) → 6 bits/char (padding ignored)
 *   - anything else (spaces, punctuation — i.e. human-typed) → 3 bits/char
 *
 * A token with fewer than 8 distinct characters is capped at log2(distinct)
 * bits/char, so "aaaa…" can't pass on length alone.
 *
 * This is a heuristic for catching `hunter2`-grade secrets, not a
 * dictionary checker; the real fix is to let Talon generate the token.
 */
export function estimateTokenBits(token: string): number {
  const body = token.replace(/={1,2}$/, "");
  if (body.length === 0) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) =>
    re.test(body),
  ).length;
  let perChar: number;
  if (/^[0-9]+$/.test(body)) perChar = Math.log2(10);
  else if (/^[0-9a-fA-F]+$/.test(body)) perChar = 4;
  else if (/^[a-z]+$/.test(body) || /^[A-Z]+$/.test(body))
    perChar = Math.log2(26);
  else if (/^[A-Za-z0-9+/_-]+$/.test(body) && classes >= 2) perChar = 6;
  else perChar = 3;
  const distinct = new Set(body).size;
  if (distinct < 8) perChar = Math.min(perChar, Math.log2(distinct));
  return Math.floor(body.length * perChar);
}

/**
 * Startup gate for a configured `native.token`.
 *
 * - Strong enough (≥ MIN_TOKEN_BITS), or no token → nothing to say.
 * - Weak on a loopback bind → warn: nothing off-box can reach it.
 * - Weak on any other bind → throw, unless the operator opted in with
 *   `native.allowWeakToken: true`, in which case warn loudly every start.
 *
 * Neither the token nor any part of it is ever logged.
 */
export function checkBridgeTokenStrength(opts: {
  token: string | undefined;
  loopback: boolean;
  allowWeakToken?: boolean;
}): void {
  if (!opts.token) return;
  const bits = estimateTokenBits(opts.token);
  if (bits >= MIN_TOKEN_BITS) return;
  const fix =
    `Remove native.token so Talon mints a 256-bit token into ${bridgeTokenPath()}, ` +
    "or replace it with the output of `openssl rand -hex 32`.";
  const what = `native.token looks weak (~${bits} bits estimated, want ≥ ${MIN_TOKEN_BITS})`;
  if (opts.loopback) {
    logWarn(
      "native",
      `${what}. The bridge is loopback-only, so continuing. ${fix}`,
    );
    return;
  }
  if (opts.allowWeakToken) {
    logWarn(
      "native",
      `SECURITY: ${what} on a network-reachable bind, allowed by native.allowWeakToken. ` +
        `Anyone who can reach this port can try to guess it. ${fix}`,
    );
    return;
  }
  throw new Error(
    `Refusing to start the bridge: ${what} on a network-reachable bind. ${fix} ` +
      "(To accept the risk anyway, set native.allowWeakToken: true.)",
  );
}
