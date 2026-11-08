/**
 * Tool-argument resolution: the one rule for every path parameter, plus the
 * string/number coercions that turn an untyped request body field into
 * something the handlers can use.
 */

import { join } from "node:path";
import { userHome } from "../../../../util/fs-path.js";

// — path parameter resolution ----------------------------------------------

/** Expand a leading `~` — local runs only; a device's home is not ours. */
function expandHome(path: string): string {
  if (path === "~") return userHome();
  if (path.startsWith("~/")) return join(userHome(), path.slice(2));
  return path;
}

/**
 * One rule for every path parameter: `~` expands (local runs only),
 * everything else passes through untouched.
 *
 * The namespace has no tool-facing address scheme — its nodes are reached
 * by their real paths (`~/.talon/ns/…`, kept real by the symlink farm in
 * nsdir.ts and the FUSE layer in fusefs.ts). Real paths need no
 * translation and behave identically here, in a bare shell, in another
 * backend's built-in shell (Codex), and in any spawned child process.
 * Teleported, paths belong to the device and pass through verbatim.
 */
export function resolvePathParam(
  path: string,
  teleportedTo: string | undefined,
): string {
  return teleportedTo !== undefined ? path : expandHome(path);
}

// — scalar coercion --------------------------------------------------------

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}
