/**
 * The snapshot builder — one run, one directory, up to three parts
 * (state, login sessions, palace).
 *
 * Everything here streams: entries are handed to the tar writer one at a
 * time, the tar bytes go straight through zstd into the part file, and
 * the sha256 is taken off the compressed stream on its way past. A
 * multi-gigabyte workspace therefore costs one chunk of memory, not one
 * workspace.
 *
 * Two rules worth keeping in mind while reading:
 *
 *   - The database is never copied from disk. `VACUUM INTO` (see
 *     storage/db.ts) hands us a consistent single-file copy that goes in
 *     as `db/talon.db`; the live `data/talon.db*` files are excluded.
 *   - The memory palace is content-addressed. Its tree fingerprint is
 *     computed first, and if it matches the previous snapshot's the old
 *     part is hard-linked instead of recompressed — which is what makes
 *     a six-hourly backup of a large palace nearly free, locally and on
 *     every remote target.
 */

import { createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { dirs } from "../../util/paths.js";
import { log, logWarn } from "../../util/log.js";
import { talonVersion } from "../../util/version.js";
import {
  snapshotDatabase,
  snapshotSqliteFile,
} from "../../storage/backup/index.js";
import { TalonError } from "../errors.js";
import {
  Sha256Tap,
  sha256File,
  treeHash,
  type TreeFile,
} from "./archive/digest.js";
import {
  ENCRYPTED_SUFFIX,
  createEncryptor,
  passphraseOpens,
} from "./archive/crypt.js";
import { signManifest } from "./archive/manifest-auth.js";
import { TarWriter } from "./archive/tar.js";
import { createCompressor } from "./archive/zstd.js";
import { verifyWrittenParts } from "./archive/verify.js";
import {
  collectTree,
  excludeForRoot,
  expandUserPath,
  isInside,
  EXCLUDE_RULES,
  HOME_INCLUDES,
  LOGIN_INCLUDES,
  workspaceRoots,
  type SourceEntry,
} from "./plan.js";
import { passphraseFilePath, resolvePassphrase } from "./passphrase.js";
import { discoverPlugins } from "./sources/plugins.js";
import {
  discoverSessionRoots,
  type SourceContext,
} from "./sources/sessions.js";
import {
  DB_MEMBER,
  STATE_PART,
  indexSnapshot,
  linkOrCopy,
  listLocalManifests,
  newSnapshotId,
  snapshotDir,
  writeManifest,
} from "./store.js";
import type {
  BackupSettings,
  ExternalRoot,
  Manifest,
  SnapshotKind,
  SnapshotPart,
} from "./types.js";
import { userHome } from "../../util/fs-path.js";

/** The part that holds WhatsApp auth and the userbot session. */
const LOGINS_PART = "logins.tar.zst";
/** How a clone reinstalls fetched plugins (see sources/plugins.ts). */
const PLUGINS_MANIFEST = "plugins-manifest.json";
/** Session transcripts and traces: large, churning, and their own part. */
const SESSIONS_PART = "sessions.tar.zst";

export type BuildOptions = {
  kind: SnapshotKind;
  label?: string;
  pinned?: boolean;
  settings: BackupSettings;
  /** Talon home; tests point this at a scratch directory. */
  home?: string;
  /** Database copier — injected by tests that have no database. */
  copyDatabase?: (destPath: string) => void;
  /** Clock, for deterministic ids in tests. */
  now?: Date;
  /**
   * The OS user's home, where backend session stores live. Defaults to
   * `os.homedir()` for the real Talon home; a test that passes `home`
   * without it gets no outside-the-home sources at all.
   */
  userHome?: string | null;
  /** Environment for store discovery (CODEX_HOME, …); same default rule. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * The OS user's home to record as this snapshot's origin when `userHome`
   * is not in play. Recording where a snapshot came from is independent of
   * archiving anything outside the Talon home: the daemon's scheduler
   * passes `home` explicitly (so it discovers no outside stores) but its
   * snapshots still carry absolute plugin paths, and a clone can only
   * relocate those if it knows the home they were recorded under.
   */
  originUserHome?: string;
};

// ── Archive writing ─────────────────────────────────────────────────────────

/**
 * Open failures that mean "this file is gone or locked since the walk":
 * traces and backend transcripts churn while a snapshot runs, and one of
 * them disappearing must not cost the whole backup (see collectTree).
 */
const SKIPPABLE_OPEN_ERRORS = new Set(["ENOENT", "EACCES", "EPERM"]);

async function addEntries(
  writer: TarWriter,
  entries: readonly SourceEntry[],
): Promise<void> {
  const skipped: string[] = [];
  for (const entry of entries) {
    if (entry.type === "dir") {
      await writer.addDirectory(entry.archivePath, entry.mode, entry.mtime);
    } else if (entry.type === "symlink") {
      await writer.addSymlink(
        entry.archivePath,
        entry.linkTarget ?? "",
        entry.mode,
        entry.mtime,
      );
    } else {
      try {
        await writer.addFile(
          entry.archivePath,
          entry.source,
          entry.mode,
          entry.mtime,
          entry.size,
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (!SKIPPABLE_OPEN_ERRORS.has(code)) throw err;
        skipped.push(`${entry.source} (${code})`);
      }
    }
  }
  if (skipped.length > 0) {
    logWarn(
      "backup",
      `Skipped ${skipped.length} file(s) that vanished or became unreadable mid-snapshot; first: ${skipped[0]}`,
    );
  }
}

/** A part's file name: `.enc` marks one written through the encryptor. */
function partName(base: string, passphrase: string | null): string {
  return passphrase ? `${base}${ENCRYPTED_SUFFIX}` : base;
}

/**
 * Write one compressed (and, with a passphrase, encrypted) part and
 * return its size and digest. The digest is taken off the bytes as they
 * land on disk, so verifying a part before extraction costs one pass
 * over the file and no decompression.
 */
async function writePart(
  destPath: string,
  fill: (writer: TarWriter) => Promise<void>,
  passphrase: string | null,
): Promise<{ bytes: number; sha256: string }> {
  await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
  const compressor = createCompressor();
  const tap = new Sha256Tap();
  // Owner-only even when encrypted: a plaintext local part holds every
  // credential this install has.
  const out = createWriteStream(destPath, { mode: 0o600 });
  const flushed = passphrase
    ? pipeline(compressor, await createEncryptor(passphrase), tap, out)
    : pipeline(compressor, tap, out);
  // A sink failure (ENOSPC) rejects this while `fill` is still writing, and
  // `fill` then throws the same error — so the await below is never
  // reached. Observe it here, or it surfaces as an unhandled rejection
  // that kills the CLI before the cleanup runs.
  flushed.catch(() => {});
  try {
    const writer = new TarWriter(compressor);
    await fill(writer);
    await writer.finalize();
    compressor.end();
    await flushed;
  } catch (err) {
    compressor.destroy();
    out.destroy();
    await rm(destPath, { force: true });
    throw err;
  }
  return { bytes: tap.byteLength, sha256: tap.digest() };
}

// ── What goes in ────────────────────────────────────────────────────────────

type Collected = {
  entries: SourceEntry[];
  /** WhatsApp auth + userbot session, bound for their own part. */
  logins: SourceEntry[];
  includes: string[];
  extras: { n: number; source: string }[];
};

/**
 * Drop the passphrase file wherever it turned up (an extra path, the
 * secrets folder): a key inside the backup it unlocks is no key at all.
 */
function withoutKeyFile(
  entries: SourceEntry[],
  keyFile: string | null,
): SourceEntry[] {
  if (!keyFile) return entries;
  const kept = entries.filter((entry) => resolve(entry.source) !== keyFile);
  if (kept.length !== entries.length) {
    logWarn(
      "backup",
      `Left the backup passphrase file ${keyFile} out of the snapshot — keep it outside backed-up paths`,
    );
  }
  return kept;
}

/** Everything under ~/.talon plus the configured workspace subset and extras. */
async function collectStateEntries(
  home: string,
  settings: BackupSettings,
): Promise<Collected> {
  const skipped: string[] = [];
  const onSkip = (path: string, err: unknown) => {
    skipped.push(
      `${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  };
  const entries: SourceEntry[] = [];
  const logins: SourceEntry[] = [];
  const includes: string[] = [];

  for (const root of HOME_INCLUDES) {
    const found = await collectTree(join(home, root), root, { onSkip });
    if (found.length > 0) {
      entries.push(...found);
      includes.push(root);
    }
  }
  if (settings.loginSessions !== "off") {
    for (const root of LOGIN_INCLUDES) {
      const found = await collectTree(join(home, root), root, { onSkip });
      if (found.length > 0) {
        logins.push(...found);
        includes.push(root);
      }
    }
  }
  for (const root of workspaceRoots(settings.workspaceInclude)) {
    const archiveRoot = `workspace/${root}`;
    const found = await collectTree(
      join(home, "workspace", root),
      archiveRoot,
      { onSkip },
    );
    if (found.length > 0) {
      entries.push(...found);
      includes.push(archiveRoot);
    }
  }
  const extras: { n: number; source: string }[] = [];
  for (const [index, raw] of settings.extraPaths.entries()) {
    const source = expandUserPath(raw);
    // Never reach into the FUSE namespace (it can be a dead mount) or back
    // into the backup directory itself.
    if (
      isInside(join(home, "ns"), source) ||
      isInside(join(home, "backups"), source)
    ) {
      logWarn(
        "backup",
        `extraPaths entry skipped (inside ~/.talon/ns or backups/): ${raw}`,
      );
      continue;
    }
    const archiveRoot = `extra/${index}`;
    const found = await collectTree(source, archiveRoot, { onSkip });
    if (found.length === 0) {
      logWarn("backup", `extraPaths entry is empty or unreadable: ${raw}`);
      continue;
    }
    entries.push(...found);
    includes.push(archiveRoot);
    extras.push({ n: index, source });
  }
  if (skipped.length > 0) {
    logWarn(
      "backup",
      `Skipped ${skipped.length} unreadable path(s); first: ${skipped[0]}`,
    );
  }
  const keyFile = passphraseFilePath(settings);
  return {
    entries: withoutKeyFile(entries, keyFile),
    logins: withoutKeyFile(logins, keyFile),
    includes,
    extras,
  };
}

// ── The memory palace part ──────────────────────────────────────────────────

/**
 * Fingerprint the palace: path + size + mtime + content digest of every
 * file. Content, not just mtime, because a restored or re-synced palace
 * has new timestamps and identical bytes — and re-uploading gigabytes
 * over a changed mtime is exactly what this is here to avoid.
 */
async function palaceFingerprint(
  entries: readonly SourceEntry[],
): Promise<string> {
  const files: TreeFile[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    let sha256: string;
    try {
      sha256 = await sha256File(entry.source);
    } catch (err) {
      // Gone since the walk: the part will skip it too (see addEntries).
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (SKIPPABLE_OPEN_ERRORS.has(code)) continue;
      throw err;
    }
    files.push({
      path: entry.archivePath,
      size: entry.size,
      mtime: entry.mtime,
      sha256,
    });
  }
  return treeHash(files);
}

/**
 * Build (or reuse) the palace part. Reuse means an identical part already
 * exists in an older snapshot: same name, same bytes, so it is hard-linked
 * and marked `contentAddressed` — targets that already hold it skip the
 * upload too.
 */
async function buildPalacePart(
  id: string,
  home: string,
  passphrase: string | null,
): Promise<{ part: SnapshotPart; palaceHash: string } | null> {
  const palaceDir = join(home, "workspace", "palace");
  const entries = await collectTree(palaceDir, "workspace/palace", {
    exclude: excludeForRoot("workspace/palace"),
  });
  if (entries.length === 0) return null;

  const palaceHash = await palaceFingerprint(entries);
  const name = partName(
    `palace-${palaceHash.slice(0, 12)}.tar.zst`,
    passphrase,
  );
  const dest = join(snapshotDir(id, home), name);

  const reused = await reusePalacePart(
    home,
    palaceHash,
    name,
    dest,
    passphrase,
  );
  if (reused) return { part: reused, palaceHash };

  const written = await writePart(
    dest,
    (writer) => addEntries(writer, entries),
    passphrase,
  );
  return {
    part: {
      name,
      bytes: written.bytes,
      sha256: written.sha256,
      contentAddressed: true,
      ...(passphrase ? { encrypted: true } : {}),
    },
    palaceHash,
  };
}

/**
 * Hard-link an identical palace part from an older snapshot, if there is
 * one. An encrypted part is only reused when the current passphrase opens
 * it — after a key change the palace is re-encrypted rather than carried
 * forward under a key the operator may no longer hold.
 */
async function reusePalacePart(
  home: string,
  palaceHash: string,
  name: string,
  dest: string,
  passphrase: string | null,
): Promise<SnapshotPart | null> {
  for (const previous of await listLocalManifests(home)) {
    if (previous.palaceHash !== palaceHash) continue;
    const reusable = previous.parts.find((part) => part.name === name);
    if (!reusable) continue;
    const source = join(snapshotDir(previous.id, home), name);
    if (passphrase && !(await passphraseOpens(source, passphrase))) break;
    try {
      await linkOrCopy(source, dest);
      log("backup", `Reused palace part from ${previous.id} (${name})`);
      return { ...reusable, contentAddressed: true };
    } catch (err) {
      logWarn(
        "backup",
        `Could not reuse palace part from ${previous.id}: ${String(err)}`,
      );
      break;
    }
  }
  return null;
}

// ── Outside the home: plugins and sessions ─────────────────────────────────

/** config.json as data — the snapshot reads what it is about to archive. */
async function readConfigJson(home: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(home, "config.json"), "utf8"),
    );
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function sourceContext(
  options: BuildOptions,
  home: string,
): Promise<SourceContext> {
  const realHome = options.home === undefined;
  return {
    home,
    userHome:
      options.userHome !== undefined
        ? options.userHome
        : realHome
          ? userHome()
          : null,
    env: options.env ?? (realHome ? process.env : {}),
    config: await readConfigJson(home),
  };
}

type CollectedExternal = {
  entries: SourceEntry[];
  includes: string[];
  external: ExternalRoot[];
};

/** Walk external directory roots into archive members. */
async function collectExternal(
  roots: readonly ExternalRoot[],
): Promise<CollectedExternal> {
  const collected: CollectedExternal = {
    entries: [],
    includes: [],
    external: [],
  };
  for (const root of roots) {
    const found = await collectTree(root.source, root.root, {
      exclude: excludeForRoot(root.root),
    });
    if (found.length === 0) continue;
    collected.entries.push(...found);
    collected.includes.push(root.root);
    collected.external.push(root);
  }
  return collected;
}

/**
 * Plugin checkouts plus `plugins-manifest.json` (written next to the part
 * and archived as a file at the root, so a restore leaves it in the home).
 */
async function collectPlugins(
  ctx: SourceContext,
  dir: string,
): Promise<CollectedExternal> {
  const { manifest, roots } = await discoverPlugins(ctx);
  const collected = await collectExternal(roots);
  const manifestPath = join(dir, `${PLUGINS_MANIFEST}.tmp`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });
  const { size, mtimeMs } = await stat(manifestPath);
  collected.entries.push({
    archivePath: PLUGINS_MANIFEST,
    source: manifestPath,
    type: "file",
    mode: 0o600,
    mtime: Math.floor(mtimeMs / 1000),
    size,
  });
  collected.includes.push(PLUGINS_MANIFEST);
  return collected;
}

/**
 * Consistent copies of the SQLite files among the session roots. A store
 * that SQLite cannot open is skipped with a warning rather than copied
 * byte-wise — a torn copy would restore as a corrupt session store.
 */
async function copySqliteRoots(
  roots: readonly ExternalRoot[],
  dir: string,
): Promise<CollectedExternal> {
  const collected: CollectedExternal = {
    entries: [],
    includes: [],
    external: [],
  };
  for (const [index, root] of roots.entries()) {
    const temp = join(dir, `sqlite-${index}.tmp`);
    try {
      await rm(temp, { force: true });
      snapshotSqliteFile(root.source, temp);
    } catch (err) {
      logWarn("backup", `Skipped ${root.source}: ${String(err)}`);
      continue;
    }
    const { size } = await stat(temp);
    collected.entries.push({
      archivePath: root.root,
      source: temp,
      type: "file",
      mode: 0o600,
      mtime: Math.floor(Date.now() / 1000),
      size,
    });
    collected.includes.push(root.root);
    collected.external.push(root);
  }
  return collected;
}

/** The sessions part: backend transcripts, session databases, traces. */
async function buildSessionsPart(
  dir: string,
  ctx: SourceContext,
  passphrase: string | null,
): Promise<{ part: SnapshotPart; collected: CollectedExternal } | null> {
  const roots = await discoverSessionRoots(ctx);
  const trees = await collectExternal(roots.filter((r) => !r.sqlite));
  const traces = await collectTree(
    join(ctx.home, "data", "traces"),
    "data/traces",
    { exclude: excludeForRoot("data/traces") },
  );
  const databases = await copySqliteRoots(
    roots.filter((r) => r.sqlite),
    dir,
  );
  const entries = [...trees.entries, ...traces, ...databases.entries];
  if (entries.length === 0) return null;
  const name = partName(SESSIONS_PART, passphrase);
  const written = await writePart(
    join(dir, name),
    (writer) => addEntries(writer, entries),
    passphrase,
  );
  return {
    part: {
      name,
      bytes: written.bytes,
      sha256: written.sha256,
      ...(passphrase ? { encrypted: true } : {}),
    },
    collected: {
      entries,
      includes: [
        ...trees.includes,
        ...(traces.length > 0 ? ["data/traces"] : []),
        ...databases.includes,
      ],
      external: [...trees.external, ...databases.external],
    },
  };
}

// ── Provenance ──────────────────────────────────────────────────────────────

/** Short git HEAD of the checkout Talon runs from, when there is one. */
async function readGitHead(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 12; depth++) {
    try {
      const head = (await readFile(join(dir, ".git", "HEAD"), "utf8")).trim();
      if (head.startsWith("ref: ")) {
        const ref = head.slice(5).trim();
        const sha = await readFile(join(dir, ".git", ref), "utf8");
        return sha.trim().slice(0, 12);
      }
      return head.slice(0, 12);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

// ── The build ───────────────────────────────────────────────────────────────

/**
 * The state part: identity, state, workspace subset, extras, the plugin
 * checkouts and the database copy.
 */
async function writeStatePart(
  dir: string,
  entries: readonly SourceEntry[],
  passphrase: string | null,
  options: BuildOptions,
): Promise<SnapshotPart> {
  const dbTemp = join(dir, "db-snapshot.tmp");
  await rm(dbTemp, { force: true });
  (options.copyDatabase ?? snapshotDatabase)(dbTemp);
  const dbStat = await stat(dbTemp);
  const name = partName(STATE_PART, passphrase);
  const written = await writePart(
    join(dir, name),
    async (writer) => {
      await addEntries(writer, entries);
      await writer.addFile(
        DB_MEMBER,
        dbTemp,
        0o600,
        Math.floor(Date.now() / 1000),
        dbStat.size,
      );
    },
    passphrase,
  );
  await rm(dbTemp, { force: true });
  return { name, ...written, ...(passphrase ? { encrypted: true } : {}) };
}

/**
 * The login-sessions part, when there is anything to put in it. Marked
 * local-only unless the operator opted in to shipping sessions off-host.
 */
async function writeLoginsPart(
  dir: string,
  entries: readonly SourceEntry[],
  passphrase: string | null,
  settings: BackupSettings,
): Promise<SnapshotPart | null> {
  if (entries.length === 0) return null;
  const name = partName(LOGINS_PART, passphrase);
  const written = await writePart(
    join(dir, name),
    (writer) => addEntries(writer, entries),
    passphrase,
  );
  return {
    name,
    ...written,
    ...(passphrase ? { encrypted: true } : {}),
    ...(settings.loginSessions === "remote" ? {} : { localOnly: true }),
  };
}

/** Delete the scratch files a build leaves beside its parts. */
async function removeScratch(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    if (name.endsWith(".tmp")) await rm(join(dir, name), { force: true });
  }
}

/**
 * Build one snapshot end to end: collect, archive, hash, write the
 * manifest, index it. Leaves nothing behind on failure — a half-written
 * directory would be indistinguishable from a good snapshot at restore
 * time, which is the one thing a safety net may not be.
 */
export async function buildSnapshot(options: BuildOptions): Promise<Manifest> {
  const home = options.home ?? dirs.root;
  // Resolved before anything is written: a configured-but-broken key must
  // fail the snapshot, never degrade it to plaintext.
  const passphrase = await resolvePassphrase(options.settings);
  const id = newSnapshotId(options.now ?? new Date());
  const dir = snapshotDir(id, home);
  const started = Date.now();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  try {
    const ctx = await sourceContext(options, home);
    const state = await collectStateEntries(home, options.settings);
    const plugins = await collectPlugins(ctx, dir);
    const parts: SnapshotPart[] = [
      await writeStatePart(
        dir,
        [...state.entries, ...plugins.entries],
        passphrase,
        options,
      ),
    ];
    const logins = await writeLoginsPart(
      dir,
      state.logins,
      passphrase,
      options.settings,
    );
    if (logins) parts.push(logins);
    const includes = [...state.includes, ...plugins.includes];
    const external = [...plugins.external];

    if (options.settings.includeSessions) {
      const sessions = await buildSessionsPart(dir, ctx, passphrase);
      if (sessions) {
        parts.push(sessions.part);
        includes.push(...sessions.collected.includes);
        external.push(...sessions.collected.external);
      }
    }
    let palaceHash: string | undefined;
    if (options.settings.includePalace) {
      const palace = await buildPalacePart(id, home, passphrase);
      if (palace) {
        parts.push(palace.part);
        palaceHash = palace.palaceHash;
        includes.push("workspace/palace");
      }
    }
    await removeScratch(dir);
    const verifiedAt = await verifyWrittenParts(dir, parts, passphrase);

    const gitHead = await readGitHead(process.cwd());
    const manifest: Manifest = {
      schema: 1,
      id,
      kind: options.kind,
      ...(options.label ? { label: options.label } : {}),
      pinned: options.pinned ?? false,
      createdAt: Date.now(),
      host: hostname(),
      talonVersion: talonVersion(),
      ...(gitHead ? { gitHead } : {}),
      parts,
      includes: [...includes, DB_MEMBER],
      excludes: [...EXCLUDE_RULES],
      ...(state.extras.length > 0 ? { extras: state.extras } : {}),
      ...(external.length > 0 ? { external } : {}),
      ...(ctx.userHome || options.originUserHome
        ? {
            origin: {
              userHome: (ctx.userHome || options.originUserHome) as string,
              home,
            },
          }
        : {}),
      ...(palaceHash ? { palaceHash } : {}),
      sizeBytes: parts.reduce((sum, part) => sum + part.bytes, 0),
      remote: {},
      verifiedAt,
    };
    if (passphrase) manifest.auth = await signManifest(manifest, passphrase);
    await writeManifest(manifest, home);
    indexSnapshot(manifest);
    log(
      "backup",
      `Snapshot ${id} (${options.kind}${options.label ? `: ${options.label}` : ""}) ` +
        `— ${parts.length} part(s), ${(manifest.sizeBytes / 1024 / 1024).toFixed(1)} MB, ` +
        `${Math.round((Date.now() - started) / 1000)}s`,
    );
    return manifest;
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err instanceof TalonError
      ? err
      : new TalonError(
          `Snapshot ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "unknown", cause: err },
        );
  }
}
