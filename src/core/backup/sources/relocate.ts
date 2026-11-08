/**
 * Clone — putting a snapshot's outside-the-home roots where they belong
 * on a different machine.
 *
 * Everything under the Talon home restores relative to whatever home the
 * new machine has. The external roots (session stores, plugin checkouts)
 * were recorded by absolute path, and two things about those paths are
 * host-specific:
 *
 *   - the user's home directory (`/home/alice` → `/Users/alice`), and
 *   - Claude Code's project slug, which IS the absolute cwd with its
 *     separators flattened — a transcript filed under the old workspace
 *     path is invisible to a session started in the new one.
 *
 * A clone rewrites both, and rewrites the same prefixes inside
 * config.json (plugin paths, a passphrase file) so the restored config
 * points at the restored files.
 */

import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { isInside } from "../plan.js";
import type { ExternalRoot, SnapshotOrigin } from "../types.js";
import {
  claudeProjectSlug,
  claudeProjectsDir,
  sessionCwds,
  type SourceContext,
} from "./sessions.js";

/** The machine a clone lands on. */
export type CloneTarget = Pick<SourceContext, "home" | "env"> & {
  userHome: string;
};

/** Move `path` from one prefix to another; unchanged when outside it. */
function reprefix(path: string, from: string, to: string): string {
  if (from === to || !isInside(from, path)) return path;
  const rest = relative(from, path);
  return rest ? join(to, rest) : to;
}

/** Re-slug a Claude project directory name for the new Talon home. */
export function relocateClaudeSlug(
  name: string,
  originHome: string,
  targetHome: string,
): string {
  const pairs = sessionCwds(originHome).map((cwd, i) => [
    claudeProjectSlug(cwd),
    claudeProjectSlug(sessionCwds(targetHome)[i]),
  ]);
  // Longest first: agent-workspace's slug must not be matched as a
  // prefix-extension of some shorter one.
  pairs.sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of pairs) {
    if (name === from || name.startsWith(`${from}-`))
      return to + name.slice(from.length);
  }
  return name;
}

/** Where one external root lands on the clone target. */
export function relocateRoot(
  root: ExternalRoot,
  origin: SnapshotOrigin,
  target: CloneTarget,
): string {
  if (root.kind === "claude-project") {
    return join(
      claudeProjectsDir(target.userHome, target.env),
      relocateClaudeSlug(basename(root.source), origin.home, target.home),
    );
  }
  const moved = reprefix(root.source, origin.home, target.home);
  return moved !== root.source
    ? moved
    : reprefix(root.source, origin.userHome, target.userHome);
}

/** Deep-rewrite every string that is a path under the origin's homes. */
function rewriteValue(
  value: unknown,
  origin: SnapshotOrigin,
  target: CloneTarget,
): unknown {
  if (typeof value === "string") {
    // Cheap "is this a path?" gate. isAbsolute, not a leading "/": on
    // Windows an absolute path is "C:\\Users\\…", and a clone that
    // skipped those left config.json pointing at the origin machine.
    if (!isAbsolute(value)) return value;
    const moved = reprefix(value, origin.home, target.home);
    return moved !== value
      ? moved
      : reprefix(value, origin.userHome, target.userHome);
  }
  if (Array.isArray(value))
    return value.map((item) => rewriteValue(item, origin, target));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        rewriteValue(item, origin, target),
      ]),
    );
  }
  return value;
}

/**
 * Point the restored config.json at the clone's paths. Returns false when
 * there was nothing to change (same homes, or no config).
 */
export async function rewriteConfigForClone(
  origin: SnapshotOrigin,
  target: CloneTarget,
): Promise<boolean> {
  if (origin.home === target.home && origin.userHome === target.userHome)
    return false;
  const path = join(target.home, "config.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return false;
  }
  const rewritten = JSON.stringify(
    rewriteValue(JSON.parse(raw), origin, target),
    null,
    2,
  );
  if (rewritten === JSON.stringify(JSON.parse(raw), null, 2)) return false;
  await writeFileAtomic(path, rewritten + "\n", { mode: 0o600 });
  return true;
}
