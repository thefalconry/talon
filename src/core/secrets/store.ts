/**
 * The secrets folder — one file per value under ~/.talon/secrets/, mode 600.
 *
 * Writes are atomic (temp file in the same directory, fsync, rename), so a
 * crash mid-write leaves the old value or the new one, never half of
 * either. Names are a closed alphabet, checked before any path is built,
 * and the resolved path must sit directly inside the folder — a name can
 * never climb out of it or into a subdirectory.
 *
 * Nothing here logs a value, and no error message carries one.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { dirs } from "../../util/paths.js";

/** Largest value the drop accepts. A password, a key file, not a dump. */
const MAX_SECRET_BYTES = 64 * 1024;

/**
 * Letters, digits, `.`, `_`, `-`; starts with a letter or digit; at most
 * 64 characters. No separators, so no traversal; no leading dot, so no
 * hidden files and no `..`.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Why `name` can't be a secret name, or undefined when it can. */
export function secretNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string" || !name) return "a name is required";
  if (!NAME_RE.test(name)) {
    return "use 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit";
  }
  if (name.includes("..")) return "'..' is not allowed in a name";
  return undefined;
}

/** The folder secrets live in. Overridable for tests. */
function secretsDir(): string {
  return dirs.secrets;
}

/**
 * The file a name maps to, or an error. Checks the name and then the
 * resolved path, so the second check still holds if the first ever widens.
 */
export function secretPath(
  name: string,
  dir: string = secretsDir(),
): { ok: true; path: string } | { ok: false; error: string } {
  const problem = secretNameProblem(name);
  if (problem) return { ok: false, error: `Invalid secret name: ${problem}` };
  const root = resolve(dir);
  const path = resolve(root, name);
  if (dirname(path) !== root) {
    return { ok: false, error: "Invalid secret name: it leaves the folder" };
  }
  return { ok: true, path };
}

/**
 * Write one secret atomically with mode 600, creating the folder (700)
 * when it's missing. A trailing newline from a paste is dropped; nothing
 * else about the value is touched.
 */
export async function writeSecret(
  name: string,
  value: string,
  dir: string = secretsDir(),
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const target = secretPath(name, dir);
  if (!target.ok) return target;
  const clean = value.replace(/\r?\n$/, "");
  if (!clean) return { ok: false, error: "The value is empty" };
  if (Buffer.byteLength(clean, "utf8") > MAX_SECRET_BYTES) {
    return { ok: false, error: "The value is too large" };
  }
  const root = resolve(dir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask and ignored for a folder that exists.
  await chmod(root, 0o700).catch(() => {});
  const temp = join(root, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await open(temp, "wx", 0o600);
    try {
      await fh.writeFile(clean, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await chmod(temp, 0o600);
    // rename replaces a symlink at the target, never what it points to.
    await rename(temp, target.path);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    return { ok: false, error: `Could not write the secret (${code})` };
  }
  return { ok: true, path: target.path };
}
