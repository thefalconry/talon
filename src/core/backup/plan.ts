/**
 * What goes into a snapshot — the include/exclude rules and the walker
 * that turns them into a list of archive members.
 *
 * The rules answer one question: if this machine died, what would we need
 * to rebuild the same agent? Identity (config, prompts, keys, sessions),
 * everything the agent wrote about itself (memory, skills, scripts), and
 * nothing that can be re-fetched or re-derived (node_modules, venvs,
 * browser downloads, logs, traces). The database is deliberately absent
 * here: a live SQLite file copied byte-wise is a corrupt SQLite file, so
 * the builder adds it via `VACUUM INTO` instead (see snapshot.ts).
 *
 * `~/.talon/ns` is excluded by name and never stat()ed. It is a FUSE
 * mount that can be dead ("Transport endpoint is not connected"), and on
 * a dead mount a stat blocks or throws — a backup must not be the thing
 * that hangs on it.
 *
 * Pure except for the walker: the rules are plain string predicates so
 * they can be tested without a filesystem.
 */

import { lstat, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { BackupSettings } from "./types.js";

/**
 * The workspace is mostly machine-generated bulk (uploads, media, build
 * output, project checkouts). These are the parts that are the agent:
 * what it knows, what it learned to do, and who it decided to be.
 */
export const DEFAULT_WORKSPACE_INCLUDE: readonly string[] = [
  "identity.md",
  "memory.md",
  "state.md",
  "heartbeat-instructions.md",
  "memory/**",
  "skills/**",
  "scripts/**",
  "secrets/**",
  "stickers/**",
];

/**
 * The policy defaults — the single source of truth the zod schema in
 * core/config defers to, so `config.backup` and an absent `config.backup`
 * mean exactly the same thing.
 */
export const DEFAULT_BACKUP_SETTINGS = {
  enabled: true,
  intervalHours: 6,
  keepLocal: 12,
  keepRemote: 30,
  includePalace: true,
  loginSessions: "local",
  includeSessions: true,
  workspaceInclude: DEFAULT_WORKSPACE_INCLUDE,
  extraPaths: [] as readonly string[],
  checkpointBeforeUpdate: true,
} as const;

/** Fill in whatever `config.backup` left out (or was entirely absent). */
export function resolveBackupSettings(
  partial?: Partial<BackupSettings>,
): BackupSettings {
  return { ...DEFAULT_BACKUP_SETTINGS, ...partial };
}

/** Roots under ~/.talon that a snapshot always carries, in archive order. */
export const HOME_INCLUDES: readonly string[] = [
  "config.json",
  "prompts",
  "data",
  "keys",
  "google",
  "plugins",
  "mesh-devices.json",
  "mesh-credentials.json",
  "mesh-history.json",
  "mesh-locations.json",
  "teleport-state.json",
  "agent-workspace",
];

/**
 * Login sessions — the WhatsApp pairing and the userbot's Telegram login
 * (the operator's own account). They get their own part so they can stay
 * on this machine: a stolen remote copy must not be a logged-in session.
 * Re-linking after a disaster is a QR scan; losing the account is not.
 */
export const LOGIN_INCLUDES: readonly string[] = [
  "whatsapp-auth",
  ".user-session",
];

/** The exclusion rules, in the words the manifest records them by. */
export const EXCLUDE_RULES: readonly string[] = [
  "talon.log*",
  "errors.log",
  "node-bin/",
  "*venv*/",
  "ns/ (FUSE mount — never stat()ed)",
  "backups/",
  "data/traces/** (in the sessions part)",
  "data/talon.db* (the database is added via VACUUM INTO)",
  "plugin-src/**/{dist,build,.venv,cache,.cache,__pycache__}/",
  "*.tmp-*",
  "workspace/palace/** (its own part)",
];

/**
 * True when an archive path must not be captured. `path` is the path the
 * member would have INSIDE the archive, which for the ~/.talon roots is
 * also its path relative to the Talon home.
 */
export function isExcluded(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const first = segments[0];
  // Anchored rules — only at the root of the archive.
  if (first === "ns" || first === "backups") return true;
  if (
    first === "data" &&
    (segments[1] === "traces" || segments[1]?.startsWith("talon.db"))
  ) {
    return true;
  }
  if (
    segments.length === 1 &&
    (first.startsWith("talon.log") || first === "errors.log")
  ) {
    return true;
  }
  if (path === "workspace/palace" || path.startsWith("workspace/palace/"))
    return true;
  if (isExcludedAnywhere(path)) return true;
  // Plugin sources: the code and its lockfiles, not what a build or an
  // install regenerates from them.
  if (first === "plugin-src" && segments.some((s) => PLUGIN_BUILD_DIRS.has(s)))
    return true;
  return false;
}

/** Build and cache output inside a plugin checkout — regenerated on install. */
const PLUGIN_BUILD_DIRS = new Set([
  "dist",
  "build",
  ".venv",
  "cache",
  ".cache",
  "__pycache__",
]);

/** Archive roots that live in their own part, exempt from {@link isExcluded}. */
const OWN_PART_ROOTS = ["workspace/palace", "data/traces"] as const;

/**
 * The exclusion rule for one include root. The palace and the traces are
 * kept out of the state part by {@link isExcluded} because they travel in
 * parts of their own; walking those roots (to build their part, or to
 * restore them) must therefore not apply that same rule to them.
 */
export function excludeForRoot(root: string): (archivePath: string) => boolean {
  const own = OWN_PART_ROOTS.find(
    (prefix) => root === prefix || root.startsWith(`${prefix}/`),
  );
  if (!own) return isExcluded;
  return (archivePath) =>
    archivePath === own || archivePath.startsWith(`${own}/`)
      ? isExcludedAnywhere(archivePath)
      : isExcluded(archivePath);
}

/**
 * The rules that hold at any depth: build output, virtualenvs, and
 * half-written files from an atomic write that never landed.
 */
function isExcludedAnywhere(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  return (
    segments.some(
      (s) => s === "node-bin" || s === "node_modules" || s.includes("venv"),
    ) || last.includes(".tmp-")
  );
}

/**
 * Match one workspace-relative path against the `workspaceInclude` list.
 * The pattern language is deliberately two rules wide — an exact relative
 * path, or a `dir/**` prefix — because that is all the config needs and a
 * glob engine is a dependency plus a surprise.
 */
export function matchesWorkspaceInclude(
  relative: string,
  patterns: readonly string[],
): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      if (relative === prefix || relative.startsWith(`${prefix}/`)) return true;
    } else if (pattern === relative) {
      return true;
    }
  }
  return false;
}

/** The workspace subtrees to walk, derived from the include patterns. */
export function workspaceRoots(patterns: readonly string[]): string[] {
  return [
    ...new Set(patterns.map((p) => (p.endsWith("/**") ? p.slice(0, -3) : p))),
  ];
}

/** Expand a leading `~` and resolve against the home directory. */
export function expandUserPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(homedir(), trimmed);
}

/** One member the builder will hand to the tar writer. */
export type SourceEntry = {
  /** Path inside the archive (POSIX separators). */
  archivePath: string;
  /** Absolute path on disk. */
  source: string;
  type: "file" | "dir" | "symlink";
  mode: number;
  /** Epoch seconds. */
  mtime: number;
  size: number;
  linkTarget?: string;
};

/**
 * Walk one root into archive members. Missing roots are skipped silently —
 * a fresh install has no whatsapp-auth/, and that is not an error. An
 * unreadable entry is skipped too: a backup that aborts because one file
 * lost its permissions is a backup that never runs.
 */
export async function collectTree(
  absRoot: string,
  archiveRoot: string,
  opts: {
    /** Defaults to {@link isExcluded}; the palace part overrides it. */
    exclude?: (archivePath: string) => boolean;
    onSkip?: (path: string, err: unknown) => void;
  } = {},
): Promise<SourceEntry[]> {
  const { exclude = isExcluded, onSkip } = opts;
  const entries: SourceEntry[] = [];
  const visit = async (abs: string, archivePath: string): Promise<void> => {
    if (exclude(archivePath)) return;
    let stats;
    try {
      stats = await lstat(abs);
    } catch (err) {
      // A root that does not exist is the normal case on a fresh install
      // (no whatsapp-auth/, no agent-workspace/) — only real failures
      // (permissions, I/O) are worth a line in the log.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") onSkip?.(abs, err);
      return;
    }
    const mtime = Math.floor(stats.mtimeMs / 1000);
    const mode = stats.mode & 0o7777;
    if (stats.isSymbolicLink()) {
      try {
        entries.push({
          archivePath,
          source: abs,
          type: "symlink",
          mode,
          mtime,
          size: 0,
          linkTarget: await readlink(abs),
        });
      } catch (err) {
        onSkip?.(abs, err);
      }
      return;
    }
    if (stats.isDirectory()) {
      entries.push({
        archivePath,
        source: abs,
        type: "dir",
        mode,
        mtime,
        size: 0,
      });
      let children: string[] = [];
      try {
        children = (await readdir(abs)).sort();
      } catch (err) {
        onSkip?.(abs, err);
        return;
      }
      for (const child of children) {
        await visit(join(abs, child), `${archivePath}/${child}`);
      }
      return;
    }
    if (!stats.isFile()) return; // sockets, fifos, devices: not agent state
    entries.push({
      archivePath,
      source: abs,
      type: "file",
      mode,
      mtime,
      size: stats.size,
    });
  };
  await visit(absRoot, archiveRoot);
  return entries;
}

/** True when `path` is inside `root` (or is `root`). */
export function isInside(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalized = resolve(path);
  return (
    normalized === normalizedRoot || normalized.startsWith(normalizedRoot + sep)
  );
}
