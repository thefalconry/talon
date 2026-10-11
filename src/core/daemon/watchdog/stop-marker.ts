/**
 * Stop marker — the operator said "stay down".
 *
 * `talon stop` writes it; anything that starts the daemon clears it
 * (`talon start`/`restart`, and every daemon boot however launched). The
 * watchdog (./watchdog.ts) reads it and does nothing while it exists, so an
 * intentional stop is never undone by the supervisor.
 *
 * A daemon that went down any other way (crash, SIGKILL, OOM, a reboot,
 * a `/restart` that never came back) leaves no marker, and the watchdog
 * brings it back. SIGTERM is not a stop request: systemd sends it on
 * every reboot.
 */

import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { dirs } from "../../../util/paths.js";

export type StopMarker = {
  /** ISO time of the stop. */
  at: string;
  /** Who asked, for the watchdog's log line (e.g. "talon stop"). */
  by: string;
};

function stopMarkerPath(): string {
  return resolve(dirs.data, "stopped-on-purpose.json");
}

/** Record an intentional stop. Best-effort: never throws. */
export function writeStopMarker(
  by: string,
  path: string = stopMarkerPath(),
  now: Date = new Date(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const marker: StopMarker = { at: now.toISOString(), by };
    writeFileSync(path, JSON.stringify(marker) + "\n", { mode: 0o600 });
  } catch {
    /* a lost marker means the watchdog may restart it — the safe side */
  }
}

/**
 * The marker, or null when there is none. A file that exists but doesn't
 * parse still counts as a stop: the operator's intent wins over a
 * restart.
 */
export function readStopMarker(
  path: string = stopMarkerPath(),
): StopMarker | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StopMarker>;
    return {
      at: typeof parsed.at === "string" ? parsed.at : "unknown",
      by: typeof parsed.by === "string" ? parsed.by : "unknown",
    };
  } catch {
    return { at: "unknown", by: "unknown" };
  }
}

/** Forget an intentional stop (something is starting the daemon). */
export function clearStopMarker(path: string = stopMarkerPath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}
