/**
 * The backup vocabulary — the shapes every other module in this subsystem
 * and every surface above it speaks.
 *
 * `Manifest` is the contract with the future: it is written next to the
 * parts on disk, uploaded last to every remote target (its presence is
 * what marks a remote snapshot complete), and it is the source of truth
 * for a restore. The SQLite index is a cache over these files, never the
 * other way round — a snapshot whose row was lost is still restorable,
 * a row whose directory is gone is not.
 *
 * `BackupSettings` is declared structurally rather than derived from the
 * zod schema in core/config: the config layer imports this subsystem for
 * its defaults, so the type may not travel back the other way.
 */

/** Scheduled and pruned, or deliberate and kept. */
export type SnapshotKind = "backup" | "checkpoint";

/** One compressed file inside a snapshot directory. */
export type SnapshotPart = {
  /** File name within the snapshot directory (also the remote object name). */
  name: string;
  bytes: number;
  sha256: string;
  /**
   * The part's name encodes its content hash, so an identical part in an
   * older snapshot is the same bytes: the local store hard-links it and
   * targets may skip the upload entirely.
   */
  contentAddressed?: boolean;
  /** Written through archive/crypt.ts (name ends in `.enc`). */
  encrypted?: boolean;
  /**
   * Kept on this machine only — never handed to a remote target. Login
   * sessions (WhatsApp, the userbot) are, unless `backup.loginSessions`
   * is "remote". A restore from a remote copy skips a missing local-only
   * part instead of failing.
   */
  localOnly?: boolean;
};

/**
 * The MAC over a manifest (see archive/manifest-auth.ts). Present on
 * every snapshot written with a backup passphrase.
 */
export type ManifestAuth = {
  v: 1;
  alg: "hmac-sha256";
  kdf: "scrypt";
  log2N: number;
  r: number;
  p: number;
  /** base64 */
  salt: string;
  /** base64 */
  mac: string;
};

/**
 * Where WhatsApp and userbot login sessions may go: nowhere, the local
 * snapshot store only, or also to remote targets.
 */
type LoginSessionsPolicy = "off" | "local" | "remote";

/** Per-target upload state, mirrored into the `backup_remotes` table. */
export type RemoteState = {
  status: "pending" | "uploaded" | "failed";
  remoteId?: string;
  uploadedAt?: number;
  error?: string;
};

/** Where an `extra/<n>/…` subtree came from, so restore can put it back. */
type ExtraMapping = { n: number; source: string };

/**
 * A root captured from outside the Talon home — a backend's session
 * store, a plugin checkout. `source` is the absolute path at snapshot
 * time; a clone rewrites it for the new machine (see sources/relocate.ts).
 */
export type ExternalRoot = {
  /** Archive path of the root (`sessions/claude/<slug>`, `plugin-src/<n>-<name>`). */
  root: string;
  source: string;
  /** How a clone relocates it. */
  kind: "claude-project" | "session-store" | "plugin";
  /** A SQLite file captured via `VACUUM INTO`, not copied byte-wise. */
  sqlite?: boolean;
};

/** The paths a snapshot was taken against — what a clone rewrites from. */
export type SnapshotOrigin = {
  /** The operating-system user's home directory. */
  userHome: string;
  /** The Talon home (`~/.talon`). */
  home: string;
};

export type Manifest = {
  schema: 1;
  id: string;
  kind: SnapshotKind;
  label?: string;
  pinned: boolean;
  /** Epoch ms. */
  createdAt: number;
  host: string;
  talonVersion: string;
  gitHead?: string;
  parts: SnapshotPart[];
  /** Archive-relative roots this snapshot covers — what a restore replaces. */
  includes: string[];
  /** Human-readable exclusion rules, recorded so an old snapshot explains itself. */
  excludes: string[];
  /** `extra/<n>` → absolute source path. */
  extras?: ExtraMapping[];
  /** Session stores and plugin sources from outside the Talon home. */
  external?: ExternalRoot[];
  origin?: SnapshotOrigin;
  /** Tree fingerprint of the palace part, for content-addressed reuse. */
  palaceHash?: string;
  /** Total bytes of all parts. */
  sizeBytes: number;
  remote: Record<string, RemoteState>;
  /**
   * Epoch ms at which every part was read back and matched its digest
   * (and, when encrypted, decrypted end to end) — see archive/verify.ts. Set
   * before signing, so the MAC covers it. Absent on snapshots written
   * before verification existed. Retention never prunes the newest
   * verified snapshot.
   */
  verifiedAt?: number;
  /** MAC under the backup passphrase; absent on plaintext/legacy snapshots. */
  auth?: ManifestAuth;
};

/** A snapshot as the listing surfaces show it. */
export type SnapshotSummary = {
  id: string;
  kind: SnapshotKind;
  label?: string;
  pinned: boolean;
  createdAt: number;
  sizeBytes: number;
  /** False when the index has a row but the directory is gone (remote-only). */
  local: boolean;
  remote: Record<string, RemoteState>;
};

/** `config.backup`, with every default already applied. */
export type BackupSettings = {
  enabled: boolean;
  intervalHours: number;
  keepLocal: number;
  keepRemote: number;
  /** Newest snapshot per day, for this many days (0 = off). */
  keepDaily: number;
  /** Newest snapshot per ISO week, for this many weeks (0 = off). */
  keepWeekly: number;
  /** Unpinned checkpoints kept, apart from the scheduled snapshots. */
  keepCheckpoints: number;
  includePalace: boolean;
  /** WhatsApp auth + userbot session: see {@link LoginSessionsPolicy}. */
  loginSessions: LoginSessionsPolicy;
  /** Backend session transcripts and traces, in a part of their own. */
  includeSessions: boolean;
  workspaceInclude: readonly string[];
  extraPaths: readonly string[];
  /** Unset = every registered target; `[]` = local only. */
  targets?: readonly string[];
  checkpointBeforeUpdate: boolean;
  notifyChatId?: string;
  /** Present = snapshots must be encrypted (see passphrase.ts). */
  encryption?: { passphraseFile?: string };
};
