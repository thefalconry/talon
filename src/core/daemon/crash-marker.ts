/**
 * Crash marker — how a daemon that died tells the next one.
 *
 * A dying process can't reliably message anyone: the uncaught-exception
 * path runs `process.exit(1)` within the same tick, and an async send to
 * Telegram never leaves. So the crash path writes one small file,
 * synchronously, and the next boot — once the admin notifier and the
 * frontends are up — turns it into a `daemon.crash` alert and deletes it.
 *
 * Four writers: the uncaught-exception handler (./crash.ts), the fatal
 * startup path (app.ts), the handoff watcher (./handoff.ts) when a
 * `/restart` successor never served, and the watchdog (./watchdog/watchdog.ts) when
 * it found no daemon and started one. Last write wins; the file is tiny on
 * purpose and never grows. This module imports nothing from core so the
 * handoff watcher's bare runtime can carry it.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirs } from "../../util/paths.js";

export type CrashKind = "uncaught" | "startup" | "handoff" | "watchdog";

export type CrashMarker = {
  kind: CrashKind;
  /** ISO time of the crash. */
  at: string;
  message: string;
  /** The first few stack lines, frames only. */
  stack: string[];
  pid: number;
};

const STACK_LINES = 5;
const MAX_MESSAGE = 500;

function crashMarkerPath(): string {
  return resolve(dirs.data, "last-crash.json");
}

/** Error → message plus its top frames, bounded. */
function describe(err: unknown): { message: string; stack: string[] } {
  if (!(err instanceof Error)) {
    return { message: String(err).slice(0, MAX_MESSAGE), stack: [] };
  }
  const stack = (err.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, STACK_LINES);
  const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
  return { message: `${name}${err.message}`.slice(0, MAX_MESSAGE), stack };
}

/**
 * Record a crash. Synchronous by design — the caller is about to exit.
 * Throws on failure (a full disk); crash-path callers wrap it in
 * `crashStep`.
 */
export function writeCrashMarker(
  kind: CrashKind,
  err: unknown,
  opts: { path?: string; keepExisting?: boolean } = {},
): void {
  const marker: CrashMarker = {
    kind,
    at: new Date().toISOString(),
    ...describe(err),
    pid: process.pid,
  };
  // keepExisting: the handoff watcher must not clobber the more specific
  // marker a successor that crashed on its own already left.
  writeFileSync(opts.path ?? crashMarkerPath(), JSON.stringify(marker), {
    mode: 0o600,
    flag: opts.keepExisting ? "wx" : "w",
  });
}

/**
 * Read and delete the marker. Null when there is none; a corrupt marker
 * is deleted and reported as null. Never throws.
 */
export function takeCrashMarker(
  path: string = crashMarkerPath(),
): CrashMarker | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    unlinkSync(path);
  } catch {
    /* a marker we can't delete would re-announce next boot — acceptable */
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CrashMarker>;
    if (typeof parsed.at !== "string" || typeof parsed.message !== "string")
      return null;
    return {
      kind: parsed.kind ?? "uncaught",
      at: parsed.at,
      message: parsed.message,
      stack: Array.isArray(parsed.stack) ? parsed.stack : [],
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Cross-boot throttle. Under systemd's `Restart=on-failure` a crash loop
 * boots a fresh process every few seconds, and each would otherwise send
 * its own alert — the in-process cooldown can't see across restarts.
 * Returns how many crashes were held back since the last announcement
 * (fold them into the message), or null when this one is inside the
 * cooldown and should only be counted. Never throws.
 */
export function claimCrashAnnouncement(
  cooldownMs: number,
  path: string = resolve(dirs.data, "crash-announced.json"),
  now: number = Date.now(),
): number | null {
  let prior = { at: 0, held: 0 };
  try {
    prior = { ...prior, ...JSON.parse(readFileSync(path, "utf-8")) };
  } catch {
    /* first crash, or an unreadable ledger — announce */
  }
  const inCooldown = now - prior.at < cooldownMs;
  const next = inCooldown
    ? { at: prior.at, held: prior.held + 1 }
    : { at: now, held: 0 };
  try {
    writeFileSync(path, JSON.stringify(next), { mode: 0o600 });
  } catch {
    /* worst case the next crash announces too */
  }
  return inCooldown ? null : prior.held;
}
