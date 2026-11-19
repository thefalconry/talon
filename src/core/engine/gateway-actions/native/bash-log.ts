/**
 * Where `bash` job output lands: the detached foreground runs
 * (exec-detach.ts) and the background:true launches (exec-background.ts).
 *
 * The logs hold whatever the command printed, secrets included, and they
 * live under the shared tmpdir. So the directory is this user's alone
 * (0700, owned by us, not a symlink) and every log is created fresh with
 * mode 0600, refusing to follow a symlink or reuse an existing file. When
 * the stable per-user directory fails those checks (another user created
 * it first, or it is a symlink), a private mkdtemp directory is used for
 * the rest of this process instead.
 */

import {
  constants,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cachedDir: string | null = null;

/** Forget the chosen directory — test isolation. */
export function resetBashLogDir(): void {
  cachedDir = null;
}

function uid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * True when `dir` is a real directory owned by this user and closed to
 * everyone else. Tightens the mode of our own directory when it is open.
 */
function isPrivateDir(dir: string, owner: number): boolean {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return false;
  }
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== owner) {
    return false;
  }
  if ((st.mode & 0o077) !== 0) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      return false;
    }
  }
  return true;
}

/** The private directory for bash logs, created on first use. */
export function bashLogDir(): string {
  if (cachedDir) return cachedDir;
  const owner = uid();
  // Windows: tmpdir() is already per-user and there is no uid to check.
  if (owner === undefined) {
    const dir = join(tmpdir(), "talon-bash");
    mkdirSync(dir, { recursive: true });
    cachedDir = dir;
    return dir;
  }
  const stable = join(tmpdir(), `talon-bash-${owner}`);
  try {
    mkdirSync(stable, { mode: 0o700 });
  } catch {
    // Already there (ours from an earlier run, or someone else's): checked below.
  }
  cachedDir = isPrivateDir(stable, owner)
    ? stable
    : mkdtempSync(join(tmpdir(), `talon-bash-${owner}-`));
  return cachedDir;
}

/** A filesystem-safe name fragment from the command. */
function slugOf(cmd: string): string {
  return (
    cmd
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "job"
  );
}

/**
 * Create a new, private log file for one job and open it for appending.
 * Never opens an existing file or follows a symlink.
 */
export function openBashLog(cmd: string): { fd: number; path: string } {
  const dir = bashLogDir();
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_APPEND |
    (constants.O_NOFOLLOW ?? 0);
  const base = `${Date.now()}-${slugOf(cmd)}`;
  for (let attempt = 0; ; attempt++) {
    const path = join(
      dir,
      attempt === 0 ? `${base}.log` : `${base}-${attempt}.log`,
    );
    try {
      return { fd: openSync(path, flags, 0o600), path };
    } catch (err) {
      // Two jobs with the same command in the same millisecond: next name.
      if ((err as NodeJS.ErrnoException).code === "EEXIST" && attempt < 20) {
        continue;
      }
      throw err;
    }
  }
}
