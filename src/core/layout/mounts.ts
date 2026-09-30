/**
 * Which filesystem a path lives on, read from /proc/self/mountinfo.
 *
 * Inside a container the root filesystem is the image's writable layer:
 * whatever is written there is gone the moment the container is recreated
 * (an image update, a NAS app redeploy). Only bind mounts and named
 * volumes outlive it. This module answers "is this path on one of those?"
 * without shelling out to `mountpoint` or `df`.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** One line of /proc/self/mountinfo, the fields this module needs. */
export type MountEntry = {
  /** Where it is mounted, in this mount namespace. */
  mountPoint: string;
  /** The directory of the source filesystem that is mounted there. */
  root: string;
  fsType: string;
  source: string;
};

/** Where a path's data lives, as far as surviving a container recreate goes. */
export type Persistence =
  | "persistent"
  /** The container's own writable layer (or a tmpfs): lost on recreate. */
  | "ephemeral"
  /** An anonymous Docker volume: lost when the container is removed. */
  | "anonymous";

/** mountinfo escapes space, tab, newline and backslash as octal. */
function unescape(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) =>
    String.fromCharCode(parseInt(oct, 8)),
  );
}

/**
 * Parse mountinfo text (proc(5)): `id parent maj:min root mountpoint opts
 * [optional…] - fstype source superopts`. Malformed lines are skipped.
 */
export function parseMountInfo(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(" ");
    const dash = fields.indexOf("-");
    if (fields.length < 6 || dash < 6 || dash + 2 >= fields.length) continue;
    out.push({
      root: unescape(fields[3]),
      mountPoint: unescape(fields[4]),
      fsType: fields[dash + 1],
      source: unescape(fields[dash + 2]),
    });
  }
  return out;
}

function covers(mountPoint: string, path: string): boolean {
  if (mountPoint === "/") return true;
  return path === mountPoint || path.startsWith(mountPoint + "/");
}

/**
 * The mount a path is on: the longest covering mount point, and among
 * equal ones the last listed (a later mount on the same point shadows the
 * earlier one).
 */
export function mountFor(
  path: string,
  mounts: readonly MountEntry[],
): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const m of mounts) {
    if (!covers(m.mountPoint, path)) continue;
    if (!best || m.mountPoint.length >= best.mountPoint.length) best = m;
  }
  return best;
}

/** Docker names anonymous volumes by a 64-hex id; named ones by name. */
const ANONYMOUS_VOLUME = /\/volumes\/[0-9a-f]{64}\/_data(\/|$)/;

/** Classify the mount a path is on. A missing mount counts as ephemeral. */
export function classifyMount(mount: MountEntry | undefined): Persistence {
  if (!mount || mount.mountPoint === "/" || mount.fsType === "tmpfs")
    return "ephemeral";
  if (ANONYMOUS_VOLUME.test(mount.root)) return "anonymous";
  return "persistent";
}

/**
 * The real path `path` resolves to once created: symlinks in the part that
 * exists are followed (a `~/.claude` symlinked onto a volume is on that
 * volume), the part that doesn't is appended as-is.
 */
function resolveExisting(path: string): string {
  let head = path;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return path;
    tail.unshift(relative(parent, head));
    head = parent;
  }
  try {
    return tail.length ? join(realpathSync(head), ...tail) : realpathSync(head);
  } catch {
    return path;
  }
}

/** Read this process's mount table; empty when there is none (not Linux). */
export function readMountTable(file = "/proc/self/mountinfo"): MountEntry[] {
  try {
    return parseMountInfo(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/** Whether `path` would survive the container being recreated. */
export function persistenceOf(
  path: string,
  mounts: readonly MountEntry[],
): Persistence {
  const real = resolveExisting(path).split(sep).join("/");
  return classifyMount(mountFor(real, mounts));
}
