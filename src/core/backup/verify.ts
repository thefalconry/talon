/**
 * Read-back verification of a freshly written snapshot.
 *
 * A digest taken off the bytes on their way to disk says what was sent,
 * not what landed. Before a snapshot is allowed to count as good, every
 * part is read back from disk and re-hashed, and an encrypted part is
 * decrypted end to end (and discarded) so a broken encryptor cannot
 * produce a snapshot nobody can open. The result is `verifiedAt` in the
 * manifest, and retention never prunes the newest snapshot that has one
 * (see retention.ts).
 *
 * Runs before the manifest is signed, so `verifiedAt` is covered by the
 * MAC like every other field written at build time.
 */

import { join } from "node:path";
import { TalonError } from "../errors.js";
import { isEncryptedFile, verifyDecryptable } from "./archive/crypt.js";
import { sha256File } from "./archive/digest.js";
import type { SnapshotPart } from "./types.js";

/**
 * Throws a TalonError naming the first part that does not read back.
 * Returns the time verification finished.
 */
export async function verifyWrittenParts(
  dir: string,
  parts: readonly SnapshotPart[],
  passphrase: string | null,
  now: () => number = Date.now,
): Promise<number> {
  for (const part of parts) {
    const path = join(dir, part.name);
    const actual = await sha256File(path);
    if (actual !== part.sha256) {
      throw new TalonError(
        `Part ${part.name} does not read back (sha256 mismatch)`,
        { reason: "unknown" },
      );
    }
    if (passphrase && (await isEncryptedFile(path))) {
      try {
        await verifyDecryptable(path, passphrase);
      } catch (err) {
        throw new TalonError(
          `Part ${part.name} cannot be decrypted after writing: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "unknown", cause: err },
        );
      }
    }
  }
  return now();
}
