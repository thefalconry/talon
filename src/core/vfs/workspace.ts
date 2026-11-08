/**
 * Workspace — Claude's home directory.
 * Talon only ensures the root exists. Claude organizes it however it wants.
 * Includes periodic cleanup of old uploads to prevent disk exhaustion.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  renameSync,
  statSync,
  unlinkSync,
  copyFileSync,
  cpSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { log } from "../../util/log.js";
import { dirs, files as pathFiles } from "../../util/paths.js";
import { listSeedPrompts, readPromptAsset } from "#prompt-assets";

const IDENTITY_SEED = `# Identity

<!-- This file defines who you are. It's empty because you're new here. -->
<!-- On your first conversation, ask the user to help you fill this in: -->
<!--   - What should I be called? -->
<!--   - Who are you? Who created me? -->
<!--   - What will I be used for? -->
<!-- Then write your identity here using the Write tool. Keep it concise. -->
`;

// ── Layout migration ────────────────────────────────────────────────────────

/**
 * Migrate from the old workspace/ layout to the new .talon/ layout.
 * Only runs if workspace/ exists and .talon/ does not.
 * Uses renameSync (same filesystem, atomic).
 */
export function migrateLayout(): void {
  const oldRoot = resolve(process.cwd(), "workspace");
  if (!existsSync(oldRoot) || existsSync(dirs.root)) return;

  log("workspace", "Migrating workspace/ → .talon/ layout");

  // Create target directories
  mkdirSync(dirs.data, { recursive: true });
  mkdirSync(dirs.workspace, { recursive: true });

  // File moves: old → new
  const fileMoves: Array<[string, string]> = [
    [join(oldRoot, "talon.json"), dirs.root + "/config.json"],
    [join(oldRoot, "sessions.json"), join(dirs.data, "sessions.json")],
    [join(oldRoot, "history.json"), join(dirs.data, "history.json")],
    [
      join(oldRoot, "chat-settings.json"),
      join(dirs.data, "chat-settings.json"),
    ],
    [join(oldRoot, "cron.json"), join(dirs.data, "cron.json")],
    [join(oldRoot, "media-index.json"), join(dirs.data, "media-index.json")],
    [join(oldRoot, "talon.log"), join(dirs.root, "talon.log")],
    [join(oldRoot, ".user-session"), join(dirs.root, ".user-session")],
  ];

  // Move helper — try rename first (fast, same filesystem), fall back to copy+delete
  const moveFile = (src: string, dst: string) => {
    try {
      renameSync(src, dst);
    } catch {
      // Cross-filesystem: copy then delete
      copyFileSync(src, dst);
      unlinkSync(src);
    }
    log("workspace", `Moved ${src} → ${dst}`);
  };

  for (const [src, dst] of fileMoves) {
    if (existsSync(src)) moveFile(src, dst);
  }

  // Directory moves: old → new
  const dirMoves: Array<[string, string]> = [
    [join(oldRoot, "memory"), join(dirs.workspace, "memory")],
    [join(oldRoot, "uploads"), join(dirs.workspace, "uploads")],
    [join(oldRoot, "logs"), join(dirs.workspace, "logs")],
    [join(oldRoot, "stickers"), join(dirs.workspace, "stickers")],
  ];

  for (const [src, dst] of dirMoves) {
    if (existsSync(src)) {
      try {
        renameSync(src, dst);
      } catch {
        // Cross-filesystem: use cpSync (Node 16+) then rmSync
        cpSync(src, dst, { recursive: true });
        rmSync(src, { recursive: true, force: true });
      }
      log("workspace", `Moved ${src} → ${dst}`);
    }
  }

  // Remove old workspace/ if empty
  try {
    const remaining = readdirSync(oldRoot);
    if (remaining.length === 0) {
      rmdirSync(oldRoot);
      log("workspace", "Removed empty workspace/ directory");
    } else {
      log(
        "workspace",
        `Old workspace/ still has ${remaining.length} item(s) — not removed`,
      );
    }
  } catch {
    /* ignore */
  }

  log("workspace", "Migration complete");
}

// ── Workspace init ───────────────────────────────────────────────────────────

/** Ensure workspace directories exist. */
export function initWorkspace(root: string): void {
  migrateLayout();
  // Ensure .talon/ tree exists
  for (const dir of [dirs.root, dirs.data, dirs.workspace]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  // Ensure the caller-supplied root exists too (may differ in tests)
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  // Ensure subdirectories exist
  for (const sub of [
    dirs.memory,
    dirs.dailyMemory,
    dirs.uploads,
    dirs.logs,
    dirs.stickers,
    dirs.prompts,
    dirs.traces,
  ]) {
    if (!existsSync(sub)) mkdirSync(sub, { recursive: true });
  }

  // Seed identity.md for new workspaces
  if (!existsSync(pathFiles.identity)) {
    writeFileSync(pathFiles.identity, IDENTITY_SEED);
  }

  // Seed user-editable prompt files from the package into
  // ~/.talon/prompts/. Sourced through the #prompt-assets seam (disk
  // under tsx, embedded under a compiled binary), so seeding works even
  // when there is no package source tree on disk. listSeedPrompts()
  // already skips the architecture README and the system/ subdirectory
  // (package-owned templates read in place — a seeded copy would go
  // stale; see prompts/README.md).
  seedPrompts();
}

// ── Prompt seeding ──────────────────────────────────────────────────────────

/**
 * Manifest of what was last seeded, `file → sha256(content)`, stored
 * next to the seeded prompts. This is what lets upgrades tell "still
 * the pristine seeded copy" apart from "the user edited this": a file
 * whose on-disk hash matches its seeded hash is safe to refresh when
 * the packaged version changes; anything else is user-owned and never
 * touched. (dpkg conffile semantics.)
 */
const SEED_MANIFEST = ".seeded.json";

function seedManifestPath(): string {
  return join(dirs.prompts, SEED_MANIFEST);
}

function readSeedManifest(): Record<string, string> {
  try {
    const path = seedManifestPath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Provenance of the seeded prompts, for diagnostics (`talon doctor`):
 * which files still track the package (pristine seeded copy or already
 * the current package content) and which the user has edited (never
 * touched by upgrades again). Files that can't be read are skipped.
 */
export function promptSeedReport(): { tracking: string[]; edited: string[] } {
  const manifest = readSeedManifest();
  const tracking: string[] = [];
  const edited: string[] = [];
  for (const file of listSeedPrompts()) {
    const dst = join(dirs.prompts, file);
    let curHash: string;
    try {
      curHash = sha256(readFileSync(dst, "utf-8"));
    } catch {
      continue;
    }
    let pkgHash: string | undefined;
    try {
      pkgHash = sha256(readPromptAsset(file));
    } catch {
      pkgHash = undefined;
    }
    if (curHash === pkgHash || curHash === manifest[file]) {
      tracking.push(file);
    } else {
      edited.push(file);
    }
  }
  return { tracking, edited };
}

/**
 * Seed prompts with upgrade-aware refresh:
 *
 *   - missing file        → write it, record its hash
 *   - pristine seeded copy → refresh when the package version changed
 *   - user-edited copy    → never touched
 *
 * Deployments that predate the manifest have unknown provenance (old
 * package version vs. user edit is indistinguishable), so their
 * existing files are adopted as user-owned unless byte-identical to
 * the current package copy — from then on they track upgrades again.
 */
function seedPrompts(): void {
  const manifestPath = seedManifestPath();
  const manifest = readSeedManifest();

  let manifestDirty = false;
  for (const file of listSeedPrompts()) {
    const dst = join(dirs.prompts, file);
    // Seeding must never break boot: an unreadable package asset (or
    // an unwritable destination) skips that one file, not the rest.
    let pkg: string;
    try {
      pkg = readPromptAsset(file);
    } catch (err) {
      log(
        "workspace",
        `Skipping prompt seed for ${file}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    const pkgHash = sha256(pkg);

    if (!existsSync(dst)) {
      // Atomic: a write cut short (ENOSPC, crash) must leave no file
      // rather than a truncated one, which the next boot could not tell
      // from a user edit and would keep forever.
      try {
        writeFileAtomic.sync(dst, pkg);
      } catch (err) {
        log(
          "workspace",
          `Skipping prompt seed for ${file}: ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      manifest[file] = pkgHash;
      manifestDirty = true;
      log("workspace", `Seeded prompt: ${file}`);
      continue;
    }

    let curHash: string;
    try {
      curHash = sha256(readFileSync(dst, "utf-8"));
    } catch {
      continue;
    }
    const seededHash = manifest[file];

    if (curHash === pkgHash) {
      // Already the current package copy, whatever its provenance
      // (pre-manifest adoption, or a user edit that happens to match).
      // Record it so the file tracks upgrades from here on.
      if (seededHash !== pkgHash) {
        manifest[file] = pkgHash;
        manifestDirty = true;
      }
    } else if (seededHash !== undefined && curHash === seededHash) {
      // Pristine seeded copy + package changed → refresh on upgrade.
      try {
        writeFileAtomic.sync(dst, pkg);
      } catch {
        continue; // manifest keeps the old hash — retried next boot
      }
      manifest[file] = pkgHash;
      manifestDirty = true;
      log("workspace", `Updated prompt (unedited since seeding): ${file}`);
    }
    // Remaining cases — no manifest entry and content differs from the
    // package (unknown provenance), or an entry exists and the file was
    // edited since seeding → user-owned: leave it alone, forever.
  }

  if (manifestDirty) {
    try {
      writeFileAtomic.sync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
      /* non-fatal — worst case we re-derive next boot */
    }
  }
}

/** Calculate total disk usage of the workspace in bytes. */
export function getWorkspaceDiskUsage(root: string): number {
  let total = 0;
  function walk(dir: string): void {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          try {
            total += statSync(full).size;
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* skip */
    }
  }
  walk(root);
  return total;
}

// ── Upload cleanup ──────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // check every hour
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Delete files in uploads/ older than maxAgeMs.
 * Returns number of files deleted.
 */
export function cleanupUploads(
  root: string,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): number {
  const uploadsDir = join(root, "uploads");
  if (!existsSync(uploadsDir)) return 0;

  const now = Date.now();
  let deleted = 0;

  try {
    for (const entry of readdirSync(uploadsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = join(uploadsDir, entry.name);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs >= maxAgeMs) {
          unlinkSync(filePath);
          deleted++;
        }
      } catch {
        /* skip individual file errors */
      }
    }
  } catch {
    /* skip if directory unreadable */
  }

  if (deleted > 0) {
    log("workspace", `Cleaned up ${deleted} old upload(s)`);
  }
  return deleted;
}

/** Start periodic upload cleanup. Call once at startup. */
export function startUploadCleanup(root: string): void {
  if (cleanupTimer) return;
  // Run once immediately, then every hour
  cleanupUploads(root);
  cleanupTimer = setInterval(() => cleanupUploads(root), CLEANUP_INTERVAL_MS);
}

/** Stop the cleanup timer. */
export function stopUploadCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
