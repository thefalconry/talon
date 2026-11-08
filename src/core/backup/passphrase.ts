/**
 * Where the backup passphrase comes from — and the rule that plaintext
 * never leaves the machine.
 *
 * Two sources, first match wins:
 *
 *   1. `TALON_BACKUP_PASSPHRASE` in the environment.
 *   2. `backup.encryption.passphraseFile` — a file holding the passphrase
 *      (one line; surrounding whitespace ignored). `talon backup keygen`
 *      writes one with mode 600.
 *
 * With neither, snapshots stay plaintext and local-only: `upload.ts`
 * refuses to hand an unencrypted part to any remote target. When
 * `backup.encryption` is present but yields no passphrase, a snapshot
 * fails instead of silently falling back to plaintext.
 *
 * The passphrase file lives outside every snapshot root on purpose — a
 * key stored inside the backup it unlocks is no key at all. Keep a copy
 * somewhere off this machine (a password manager): without it, encrypted
 * snapshots cannot be restored.
 */

import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logWarn } from "../../util/log.js";
import { TalonError } from "../errors.js";
import { expandUserPath } from "./plan.js";
import type { BackupSettings } from "./types.js";

export const PASSPHRASE_ENV = "TALON_BACKUP_PASSPHRASE";
/** Short enough to be a typo or an empty file, not a passphrase. */
const MIN_PASSPHRASE_LENGTH = 12;

function passphraseError(message: string): TalonError {
  return new TalonError(message, { reason: "bad_request" });
}

function checked(passphrase: string, source: string): string {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw passphraseError(
      `Backup passphrase from ${source} is shorter than ${MIN_PASSPHRASE_LENGTH} characters`,
    );
  }
  return passphrase;
}

async function readPassphraseFile(
  raw: string,
  warnOnMode = true,
): Promise<string> {
  const path = expandUserPath(raw);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw passphraseError(
      `Cannot read backup.encryption.passphraseFile ${path}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
    );
  }
  const mode = (await stat(path)).mode;
  if (warnOnMode && process.platform !== "win32" && (mode & 0o077) !== 0) {
    logWarn("backup", `${path} is readable by other users — chmod 600 it`);
  }
  return checked(text.trim(), path);
}

/**
 * Absolute path of the configured passphrase file, or null. The snapshot
 * builder uses it to keep the key out of every part.
 */
export function passphraseFilePath(
  settings: Pick<BackupSettings, "encryption">,
): string | null {
  const file = settings.encryption?.passphraseFile;
  return file ? expandUserPath(file) : null;
}

/**
 * The passphrase this deployment encrypts with, or null when encryption
 * is not configured. Throws when it is configured but unusable.
 */
export async function resolvePassphrase(
  settings: Pick<BackupSettings, "encryption">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const fromEnv = env[PASSPHRASE_ENV]?.trim();
  if (fromEnv) return checked(fromEnv, PASSPHRASE_ENV);
  const file = settings.encryption?.passphraseFile;
  if (file) return readPassphraseFile(file);
  if (settings.encryption) {
    throw passphraseError(
      `backup.encryption is set but no passphrase was found: set backup.encryption.passphraseFile or ${PASSPHRASE_ENV}`,
    );
  }
  return null;
}

/**
 * What is wrong with the configured key, or null when nothing is. Unlike
 * `resolvePassphrase` this looks at every configured source: a
 * `passphraseFile` that has gone missing is reported even while
 * `TALON_BACKUP_PASSPHRASE` keeps snapshots running, because restoring
 * anywhere without that variable needs the file. `blocking` says whether
 * snapshots fail because of it. Never throws.
 */
export async function passphraseProblem(
  settings: Pick<BackupSettings, "encryption">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ message: string; blocking: boolean } | null> {
  const fromEnv = env[PASSPHRASE_ENV]?.trim();
  let envProblem: string | null = null;
  if (fromEnv) {
    try {
      checked(fromEnv, PASSPHRASE_ENV);
    } catch (err) {
      envProblem = (err as Error).message;
    }
  }
  const file = settings.encryption?.passphraseFile;
  if (file) {
    try {
      await readPassphraseFile(file, false);
    } catch (err) {
      const message = (err as Error).message;
      // A usable environment passphrase wins, so snapshots still run.
      if (fromEnv && !envProblem) {
        return {
          message: `${message} (snapshots still run on ${PASSPHRASE_ENV}, but a restore without it needs this file)`,
          blocking: false,
        };
      }
      return {
        message: envProblem ? `${envProblem}; ${message}` : message,
        blocking: true,
      };
    }
  }
  if (envProblem) return { message: envProblem, blocking: true };
  if (settings.encryption && !file && !fromEnv) {
    return {
      message: `backup.encryption is set but no passphrase was found: set backup.encryption.passphraseFile or ${PASSPHRASE_ENV}`,
      blocking: true,
    };
  }
  return null;
}

/** Like `resolvePassphrase`, for callers that cannot go on without one. */
export async function requirePassphrase(
  settings: Pick<BackupSettings, "encryption">,
  what: string,
): Promise<string> {
  const passphrase = await resolvePassphrase(settings);
  if (passphrase) return passphrase;
  throw passphraseError(
    `${what} is encrypted — set backup.encryption.passphraseFile or ${PASSPHRASE_ENV} to decrypt it`,
  );
}

/**
 * Write a new random passphrase (256 bits, base64url) to `rawPath` with
 * mode 600. Refuses to overwrite: replacing a key orphans every snapshot
 * encrypted with it. Returns the absolute path; never the passphrase.
 */
export async function generatePassphraseFile(rawPath: string): Promise<string> {
  const path = expandUserPath(rawPath);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${randomBytes(32).toString("base64url")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw passphraseError(
        `${path} already exists — refusing to overwrite a backup key`,
      );
    }
    throw err;
  }
  return path;
}
