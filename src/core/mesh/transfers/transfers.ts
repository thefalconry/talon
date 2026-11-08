/**
 * TransferStore — one-time tokens for streaming device file transfers.
 *
 * The chunked command channel moves file bytes at 256KB–1MB per full mesh
 * round trip (SSE command out, HTTP result back) — fine for small text,
 * hopeless for real files. The streaming path costs ONE command round trip
 * to arrange the transfer, then the file body flows as a single raw HTTP
 * stream between the companion and the bridge at full TCP throughput:
 *
 *   pull (device → daemon):
 *     daemon: token = createPull(deviceId, destPath)
 *     daemon → device (command): upload_file { token, path }
 *     device → daemon (HTTP):    POST /devices/file?transfer=token  (raw body)
 *     bridge route:              acceptUpload(token, stream) → tmp+rename
 *     device → daemon (command result): ok + bytes + sha256 — the command
 *     round trip doubles as the completion signal, and the daemon checks the
 *     device's digest against the one it computed while receiving.
 *
 *   push (daemon → device):
 *     daemon: token = createPush(deviceId, sourcePath)
 *     daemon → device (command): download_file { token, path, sha256 }
 *     device → daemon (HTTP):    GET /devices/file?transfer=token
 *     bridge route:              openDownload(token) → stream the source
 *     device hashes while writing its temp file, refuses to rename it into
 *     place on a digest mismatch, and answers with ok + bytes + sha256.
 *
 * The digests are additive: a device build that predates them ignores the
 * push param and omits the pull result key, and the daemon then skips the
 * check.
 *
 * Tokens are single-use, bound to one device + one path, and expire unused.
 * The registry never trusts the HTTP caller with a path — the token IS the
 * authorization, and it only reaches the device over the authed mesh
 * channel (the HTTP routes additionally sit behind the bridge bearer token).
 * The device binding is enforced on the HTTP leg too: a caller that names
 * itself must name the device the token was minted for (see take()).
 */

import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

/** Unused tokens die after this long (transfer not started). */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** What a finished pull delivered: its size and the SHA-256 (hex) of the
 *  bytes as they arrived, hashed in stream. */
export type PullReceipt = { bytes: number; sha256: string };

type Transfer = {
  token: string;
  direction: "pull" | "push";
  deviceId: string;
  /** pull: destination on the daemon host; push: source on the daemon host. */
  localPath: string;
  createdAt: number;
  /** Set once the HTTP leg has started (single-use latch). */
  consumed: boolean;
  /** pull only — resolved by acceptUpload with what arrived. */
  uploadDone?: {
    promise: Promise<PullReceipt>;
    resolve: (receipt: PullReceipt) => void;
    reject: (err: Error) => void;
  };
  /** pull only — tears down the upload once its HTTP leg is streaming. */
  abort?: AbortController;
};

export class TransferStore {
  private readonly transfers = new Map<string, Transfer>();

  /** Arrange a device→daemon transfer. Returns the token to send to the
   *  device and a promise that resolves (bytes + digest) when the upload
   *  lands. */
  createPull(
    deviceId: string,
    destPath: string,
  ): { token: string; done: Promise<PullReceipt> } {
    this.sweep();
    const token = randomBytes(24).toString("base64url");
    let resolve!: (receipt: PullReceipt) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<PullReceipt>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A pull whose upload never arrives must not leave an eternally-pending
    // promise; callers race it with the command result, which times out.
    promise.catch(() => {});
    this.transfers.set(token, {
      token,
      direction: "pull",
      deviceId,
      localPath: destPath,
      createdAt: Date.now(),
      consumed: false,
      uploadDone: { promise, resolve, reject },
    });
    return { token, done: promise };
  }

  /** Arrange a daemon→device transfer of `sourcePath`. */
  createPush(deviceId: string, sourcePath: string): { token: string } {
    this.sweep();
    const token = randomBytes(24).toString("base64url");
    this.transfers.set(token, {
      token,
      direction: "push",
      deviceId,
      localPath: sourcePath,
      createdAt: Date.now(),
      consumed: false,
    });
    return { token };
  }

  /**
   * Drop a token — the arrangement failed, or the daemon gave up waiting.
   * An upload already streaming is aborted too: otherwise a peer that
   * stalls mid-body holds the request (and its temp file) open until the
   * bridge's whole-request deadline, and one that finishes late renames a
   * file into place after the caller was told the pull failed.
   */
  cancel(token: string): void {
    const t = this.transfers.get(token);
    if (t?.uploadDone && !t.consumed) {
      t.uploadDone.reject(new Error("transfer cancelled"));
    }
    t?.abort?.abort(new Error("transfer cancelled"));
    this.transfers.delete(token);
  }

  /**
   * Bridge route: a device is streaming a pull's file body up. Writes to a
   * temp file and renames into place, so a dropped connection can't leave a
   * half-written destination. Resolves the pull's `done` promise with the
   * SHA-256 of the bytes, hashed as they stream through (no second read).
   *
   * `fromDeviceId` is the device the HTTP caller says it is (see take()).
   */
  async acceptUpload(
    token: string,
    body: Readable,
    fromDeviceId?: string,
  ): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
    const t = this.take(token, "pull", fromDeviceId);
    if (!t)
      return { ok: false, error: "Unknown or already-used transfer token." };
    const tmp = `${t.localPath}.part-${randomBytes(4).toString("hex")}`;
    const abort = new AbortController();
    t.abort = abort;
    try {
      await mkdir(dirname(t.localPath), { recursive: true });
      let bytes = 0;
      const hash = createHash("sha256");
      body.on("data", (d: Buffer) => {
        bytes += d.length;
        hash.update(d);
      });
      await pipeline(body, createWriteStream(tmp, { mode: 0o600 }), {
        signal: abort.signal,
      });
      abort.signal.throwIfAborted();
      await rename(tmp, t.localPath);
      this.transfers.delete(token);
      t.uploadDone?.resolve({ bytes, sha256: hash.digest("hex") });
      return { ok: true, bytes };
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      this.transfers.delete(token);
      const error = `Upload for ${t.localPath} failed mid-stream: ${(err as Error).message}`;
      t.uploadDone?.reject(new Error(error));
      return { ok: false, error };
    }
  }

  /**
   * Bridge route: a device wants a push's file body. Returns the source
   * path to stream (single use) or null for unknown/used tokens.
   */
  async openDownload(
    token: string,
    fromDeviceId?: string,
  ): Promise<{ path: string; size: number } | null> {
    const t = this.take(token, "push", fromDeviceId);
    if (!t) return null;
    try {
      const s = await stat(t.localPath);
      if (!s.isFile()) throw new Error("not a file");
      return { path: t.localPath, size: s.size };
    } catch {
      return null;
    } finally {
      // Single-use either way; the device retries by re-arranging.
      this.transfers.delete(token);
    }
  }

  /**
   * Validate + latch a token for its HTTP leg.
   *
   * `fromDeviceId` is the device the caller claims to be (the `deviceId`
   * query param on /devices/file). A token is minted for exactly one device,
   * so a claim naming a DIFFERENT device is refused — a token that leaked to
   * another mesh member can't be redeemed under that member's own identity.
   * The refusal happens before the single-use latch, so a wrong claim can't
   * burn the real device's token either.
   *
   * A caller that claims nothing is still served. Requiring the claim would
   * break the transfer that ships the client build able to make it:
   * `update_device`/`update_node` push the new binary over `download_file`,
   * so a daemon upgraded ahead of its fleet would refuse the very transfer
   * that updates the fleet. Since the token only ever reaches the target
   * device (over the addressed command channel) and is single-use with a
   * 10-minute TTL, tolerating an unclaimed leg costs little; once the fleet
   * advertises the claim, dropping this line makes the binding mandatory.
   */
  private take(
    token: string,
    direction: Transfer["direction"],
    fromDeviceId?: string,
  ) {
    this.sweep();
    const t = this.transfers.get(token);
    if (!t || t.direction !== direction || t.consumed) return null;
    if (fromDeviceId && fromDeviceId !== t.deviceId) return null;
    if (Date.now() - t.createdAt > TOKEN_TTL_MS) {
      this.cancel(token);
      return null;
    }
    t.consumed = true;
    return t;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, t] of this.transfers) {
      if (!t.consumed && now - t.createdAt > TOKEN_TTL_MS) this.cancel(token);
    }
  }
}
