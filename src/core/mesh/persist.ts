/**
 * Shared 0600 JSON persistence for mesh sidecars.
 *
 * Writes are atomic (tmp file + rename — a rename on the same filesystem is
 * atomic, so a crash mid-write can never leave a truncated file that a reader
 * would silently drop) and serialized per path (concurrent writers can't
 * interleave, and never race the temp file).
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Per-path write chain: new writes queue onto the tail promise. */
const writeQueues = new Map<string, Promise<void>>();

/** Read a JSON array file, returning [] on any missing/corrupt/non-array. */
export async function readArray<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Resolve once every write queued for `path` so far has finished (settled,
 * success or failure) — for callers that persisted fire-and-forget and now
 * need the file on disk.
 */
export function writesSettled(path: string): Promise<void> {
  return writeQueues.get(path) ?? Promise.resolve();
}

/** Persist JSON atomically with 0600 perms, serialized per path. */
export async function writePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  const prior = writeQueues.get(path) ?? Promise.resolve();
  const next = prior.then(() => atomicWriteJson(path, value));
  // The queued tail must never reject: a failed write is reported to its
  // caller through `next`; a rejecting tail that no later writer happens to
  // chain onto surfaces as a process-level unhandled rejection.
  const tail: Promise<void> = next
    .catch(() => {})
    .then(() => {
      if (writeQueues.get(path) === tail) writeQueues.delete(path);
    });
  writeQueues.set(path, tail);
  return next;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tmp, path);
  } catch (err) {
    // Each attempt names a fresh temp file, so one left behind is never
    // reused — on a full disk every heartbeat would strand another.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
