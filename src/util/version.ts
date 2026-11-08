/**
 * The daemon's own release version, as a runtime value.
 *
 * A JSON import (not an fs read) so every packaging shape agrees: tsx and
 * Node resolve the file, and `bun build --compile` inlines it into the
 * standalone binary, where no package.json exists on disk. This is the
 * version the node-binary resolver keys caches and release-asset URLs on,
 * so it must exactly match the published tag (publish.yml verifies that).
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };

/** Talon's semver (e.g. "3.3.0") — the release identity of this build. */
export function talonVersion(): string {
  return pkg.version;
}

let commitCache: string | null | undefined;

/**
 * Short git commit of the running checkout, or null for packaged builds
 * (no .git) or when git isn't available. Read once and cached: the checkout
 * can't change under a running daemon without a restart.
 */
export function talonCommit(): string | null {
  if (commitCache !== undefined) return commitCache;
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const out = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    commitCache = /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    commitCache = null;
  }
  return commitCache;
}

/** "v5.10.0" or "v5.10.0 (ab12cd34)" when running from a git checkout. */
export function talonVersionLabel(): string {
  const commit = talonCommit();
  return `v${talonVersion()}${commit ? ` (${commit})` : ""}`;
}
