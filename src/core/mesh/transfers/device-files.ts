/**
 * Device file transfer and self-update — the MeshService collaborator that
 * moves bytes between the daemon host and a device.
 *
 * Two transports for a file body: the chunked command channel (one mesh
 * round trip per chunk, base64 on the wire — the fallback for app builds
 * that predate streaming) and the streamed path, where one command
 * arranges a single-use token and the body then travels as a single raw
 * HTTP request against the native bridge (see transfers.ts). The self-
 * update flows (companion APK, headless node binary) are a push followed
 * by a digest-verified install command.
 *
 * Everything device-resolution and command-dispatch related is the
 * service's; this class reaches it through {@link DeviceFilesHost}.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { logDebug } from "../../../util/log.js";
import { dirs } from "../../../util/paths.js";
import {
  formatBytes,
  FS_COMMAND_TIMEOUT_MS,
  requirePath,
  type MeshToolResult,
} from "../tool-surface.js";
import {
  hashFile,
  normalizeGoarch,
  platformToGoos,
  type NodeBinaryResolver,
} from "../links/node-binaries.js";
import { TransferStore } from "./transfers.js";
import type { DeviceCommandResult, DeviceInfo } from "../types.js";

/** The slice of MeshService a transfer needs. */
export interface DeviceFilesHost {
  load(): Promise<void>;
  resolveDevice(query?: unknown): { target: DeviceInfo } | { error: string };
  dispatchCommand(
    query: unknown,
    name: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<
    { target: DeviceInfo; result: DeviceCommandResult } | { error: string }
  >;
  readonly commandTimeoutMs: number;
  readonly resolveNode: NodeBinaryResolver;
}

/**
 * Bytes of file payload per FALLBACK transfer chunk (base64 on the wire).
 * The chunked command channel costs one full mesh round trip per chunk, so
 * it's only used for app builds that don't advertise the streaming commands
 * (`upload_file`/`download_file`) — modern builds move file bodies as a
 * single raw HTTP stream instead (see TransferStore). 1MB keeps even the
 * fallback tolerable without bloating a single SSE frame too far.
 */
const FILE_CHUNK_BYTES = 1024 * 1024;
/**
 * Wall-clock budget for one streamed transfer (command dispatch → done).
 *
 * A device that accepts the transfer command and then goes silent answers
 * never: a stalled body stream on a flaky mobile link delivers neither
 * bytes nor a FIN, so the device-side `await` for the body never completes
 * and never throws, and the command result it would have posted afterwards
 * is never posted. The dispatch timeout is the only thing that ends that
 * wait — and since turns serialize per chat, the whole chat's message loop
 * queues behind it. A flat budget sized for the largest transfer would
 * take a chat offline that long over one dropped TCP connection.
 *
 * So the budget is sized to the payload instead: a fixed grace for the
 * handshake and device-side setup, plus the body at a deliberately
 * pessimistic floor throughput, clamped at both ends. A genuinely slow
 * link still finishes; a dead one gives up in minutes.
 */
const STREAM_TRANSFER_GRACE_MS = 60_000;
const STREAM_TRANSFER_FLOOR_BYTES_PER_SEC = 32 * 1024;
/**
 * Ceiling, so a payload large enough to out-scale the formula still can't
 * block a chat indefinitely. Deliberately well above what a big transfer
 * over a slow link needs — the common wedge is a SMALL transfer, and its
 * budget runs out in about a minute.
 */
const STREAM_TRANSFER_MAX_MS = 30 * 60 * 1000;

/**
 * Budget for streaming `bytes` to or from a device. An unknown size — a
 * pull whose caller has not already paid for a `stat` — takes the ceiling
 * rather than an extra mesh round trip to size a budget with: still
 * bounded, just less tightly. Either way the device-side idle timeout
 * normally answers long before this fires; this is the backstop for a
 * device that has stopped answering altogether.
 */
export function streamTransferTimeoutMs(bytes?: number): number {
  if (bytes === undefined || !Number.isFinite(bytes)) {
    return STREAM_TRANSFER_MAX_MS;
  }
  const forBody =
    (Math.max(0, bytes) / STREAM_TRANSFER_FLOOR_BYTES_PER_SEC) * 1000;
  return Math.min(
    Math.round(STREAM_TRANSFER_GRACE_MS + forBody),
    STREAM_TRANSFER_MAX_MS,
  );
}
/** readFileBytes switches to the streaming path above this size. */
const STREAM_READ_THRESHOLD_BYTES = 4 * 1024 * 1024;
/**
 * Hard ceiling on a chunked (command-channel) transfer. The chunked path
 * assembles the whole file in daemon memory one mesh round trip at a time —
 * past this size it's both a memory hazard and unusably slow, so fail with
 * a pointer to the streaming path instead of grinding on.
 */
const MAX_CHUNKED_TRANSFER_BYTES = 64 * 1024 * 1024;
/**
 * No policy size cap on transfers — a transfer is attempted whatever the
 * size and fails with a concrete error when a real limit bites (device read
 * error, stream timeout, disk). The streamed paths are disk-to-disk and
 * never hold the file in daemon memory; only the chunked FALLBACK and
 * readFileBytes (whose callers need a Buffer) are memory-bound.
 */
/**
 * Where pulled device files land on the daemon host when no dest is given.
 * Resolved lazily (not at module load) so a test that mocks `util/paths`
 * doesn't hit its workspace binding before initialization.
 */
function pullDir(): string {
  return resolve(dirs.workspace, "mesh-pull");
}

export class DeviceFiles {
  /** One-time tokens arranging streamed (single-HTTP-request) transfers. */
  private readonly transfers = new TransferStore();

  constructor(private readonly host: DeviceFilesHost) {}

  // ── Streaming transfer bridge surface ─────────────────────────────────────
  // The HTTP routes on the native bridge delegate here; the token is the
  // entire authorization (single-use, device- and path-bound). `fromDeviceId`
  // is the caller's self-declared identity — checked against the device the
  // token was minted for, so a leaked token can't be redeemed by a peer.

  /** POST /devices/file — a device streams a pull's file body up. */
  acceptFileUpload(
    token: string,
    body: Readable,
    fromDeviceId?: string,
  ): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
    return this.transfers.acceptUpload(token, body, fromDeviceId);
  }

  /** GET /devices/file — a device asks for a push's file body. */
  openFileDownload(
    token: string,
    fromDeviceId?: string,
  ): Promise<{ path: string; size: number } | null> {
    return this.transfers.openDownload(token, fromDeviceId);
  }

  /** Streaming is per-command capability — old app builds fall back. */
  private canStream(
    target: DeviceInfo,
    command: "upload_file" | "download_file",
  ): boolean {
    return target.capabilities?.includes(command) ?? false;
  }

  /**
   * Streamed device→daemon transfer: one command round trip to arrange it,
   * then the file body arrives as a single raw HTTP request, written
   * atomically to `dest`. Resolves with the byte count.
   */
  private async pullViaStream(
    target: DeviceInfo,
    remote: string,
    dest: string,
    sizeHint?: number,
  ): Promise<{ bytes: number } | { error: string }> {
    const { token, done } = this.transfers.createPull(target.id, dest);
    const dispatched = await this.host.dispatchCommand(
      target.id,
      "upload_file",
      { token, path: remote },
      streamTransferTimeoutMs(sizeHint),
    );
    if ("error" in dispatched) {
      this.transfers.cancel(token);
      return { error: dispatched.error };
    }
    if (!dispatched.result.ok) {
      this.transfers.cancel(token);
      return {
        error:
          dispatched.result.message ??
          `${target.name} could not upload ${remote}.`,
      };
    }
    // The device answers the command AFTER its upload completes, so `done`
    // is normally already resolved — the grace window only catches a device
    // that claims success without having streamed anything.
    try {
      const receipt = await Promise.race([
        done,
        new Promise<never>((_, rej) =>
          setTimeout(
            () =>
              rej(
                new Error(
                  `${target.name} reported success but no upload arrived.`,
                ),
              ),
            15_000,
          ).unref?.(),
        ),
      ]);
      // The device hashed what it sent; the store hashed what arrived.
      const mismatch = digestMismatch(
        dispatched.result,
        receipt.sha256,
        `pull of ${remote} from ${target.name}`,
      );
      if (mismatch) {
        await rm(dest, { force: true }).catch(() => {});
        return {
          error: `Integrity check failed pulling ${remote} from ${target.name}: ${mismatch}. The received copy was discarded.`,
        };
      }
      return { bytes: receipt.bytes };
    } catch (err) {
      this.transfers.cancel(token);
      return { error: (err as Error).message };
    }
  }

  /**
   * Streamed daemon→device transfer: one command round trip, the body as a
   * single raw HTTP response. The source's SHA-256 rides along so the device
   * can refuse to rename a corrupted temp file into place; its reported
   * digest is checked here too.
   */
  private async pushViaStream(
    target: DeviceInfo,
    local: string,
    remote: string,
  ): Promise<MeshToolResult> {
    const started = Date.now();
    // Hashing the source also sizes the budget (a local read, not a mesh
    // round trip). A source we cannot read still gets a bounded, looser
    // budget and no digest — this decides a timeout, not whether the
    // transfer may start.
    const source = await hashFile(local).catch(() => undefined);
    const { token } = this.transfers.createPush(target.id, local);
    const dispatched = await this.host.dispatchCommand(
      target.id,
      "download_file",
      { token, path: remote, ...(source && { sha256: source.sha256 }) },
      streamTransferTimeoutMs(source?.size),
    );
    if ("error" in dispatched) {
      this.transfers.cancel(token);
      return { ok: false, text: dispatched.error };
    }
    if (!dispatched.result.ok) {
      this.transfers.cancel(token);
      return {
        ok: false,
        text:
          dispatched.result.message ??
          `${target.name} could not download ${local}.`,
      };
    }
    const mismatch =
      source &&
      digestMismatch(
        dispatched.result,
        source.sha256,
        `push of ${local} to ${target.name}`,
      );
    if (mismatch) {
      return {
        ok: false,
        text: `Integrity check failed pushing ${local} to ${remote} on ${target.name}: ${mismatch}.`,
      };
    }
    const bytes = dispatched.result.data?.bytesWritten;
    const size = typeof bytes === "number" ? bytes : 0;
    return {
      ok: true,
      text: `Pushed ${formatBytes(size)} to ${remote} on ${target.name} (streamed, ${transferRate(size, started)})`,
    };
  }

  /**
   * Raw file bytes off a device — the structured primitive under both the
   * human-readable tool below and the native read/edit path (which must not
   * have to parse a display envelope to recover the content).
   *
   * Small files ride the chunked command channel (one round trip). Files
   * over the streaming threshold are pulled via the streaming path into a
   * temp file first — the chunked channel pays a full mesh round trip per
   * chunk and is far too slow for big payloads.
   */
  async readFileBytes(
    query: unknown,
    path: unknown,
  ): Promise<{ data: Buffer; deviceName: string } | { error: string }> {
    const p = requirePath(path);
    if (!p) return { error: "A file path is required." };
    await this.host.load();
    const resolved = this.host.resolveDevice(query);
    if ("error" in resolved) return { error: resolved.error };
    const target = resolved.target;
    if (this.canStream(target, "upload_file")) {
      const size = await this.statSize(target.id, p);
      if (size !== undefined && size > STREAM_READ_THRESHOLD_BYTES) {
        const tmp = join(tmpdir(), `talon-pull-${randomUUID()}-${basename(p)}`);
        const pulled = await this.pullViaStream(target, p, tmp, size);
        if ("error" in pulled) return { error: pulled.error };
        try {
          const data = await readFile(tmp);
          return { data, deviceName: target.name };
        } catch (err) {
          return {
            error: `Pulled ${p} but could not read the temp copy: ${(err as Error).message}`,
          };
        } finally {
          await rm(tmp, { force: true }).catch(() => {});
        }
      }
    }
    return this.pullBytes(target.id, p);
  }

  /** Size of a device path via the `stat` command, if the device can. */
  private async statSize(
    deviceId: string,
    path: string,
  ): Promise<number | undefined> {
    const dispatched = await this.host.dispatchCommand(
      deviceId,
      "stat",
      { path },
      FS_COMMAND_TIMEOUT_MS,
    );
    if ("error" in dispatched || !dispatched.result.ok) return undefined;
    const size = dispatched.result.data?.size;
    return typeof size === "number" ? size : undefined;
  }

  /** `device_read_file`: read a (text) file off the device, chunked. */
  async readFileFromDevice(
    query: unknown,
    path: unknown,
  ): Promise<MeshToolResult> {
    const p = requirePath(path);
    if (!p) return { ok: false, text: "A file path is required." };
    const buf = await this.readFileBytes(query, p);
    if ("error" in buf) return { ok: false, text: buf.error };
    return {
      ok: true,
      text: `${p} on ${buf.deviceName} (${formatBytes(buf.data.length)}):\n\n${buf.data.toString("utf8")}`,
    };
  }

  /** `device_write_file`: write text content to a file on the device. */
  async writeFileToDevice(
    query: unknown,
    path: unknown,
    content: unknown,
  ): Promise<MeshToolResult> {
    const p = requirePath(path);
    if (!p) return { ok: false, text: "A file path is required." };
    // A non-string body must fail, not silently truncate the target to an
    // empty file (an empty string is a legitimate truncate-to-zero).
    if (typeof content !== "string") {
      return { ok: false, text: "File content must be a string." };
    }
    const written = await this.pushBytes(
      query,
      p,
      Buffer.from(content, "utf8"),
    );
    if ("error" in written) return { ok: false, text: written.error };
    return {
      ok: true,
      text: `Wrote ${formatBytes(written.bytes)} to ${p} on ${written.deviceName}.`,
    };
  }

  /** `device_pull_file`: copy a device file to the daemon host — streamed
   *  (single HTTP request, disk-to-disk) when the app supports it, chunked
   *  command-channel fallback otherwise. */
  async pullFileFromDevice(
    query: unknown,
    remotePath: unknown,
    localPath?: unknown,
  ): Promise<MeshToolResult> {
    const remote = requirePath(remotePath);
    if (!remote) return { ok: false, text: "A remote file path is required." };
    await this.host.load();
    const resolved = this.host.resolveDevice(query);
    if ("error" in resolved) return { ok: false, text: resolved.error };
    const target = resolved.target;
    const dest =
      typeof localPath === "string" && localPath.trim()
        ? resolve(dirs.workspace, localPath.trim())
        : resolve(
            pullDir(),
            `${target.name.replace(/\W+/g, "_")}-${basename(remote)}`,
          );
    if (this.canStream(target, "upload_file")) {
      const started = Date.now();
      const pulled = await this.pullViaStream(target, remote, dest);
      if ("error" in pulled) return { ok: false, text: pulled.error };
      return {
        ok: true,
        text: `Pulled ${formatBytes(pulled.bytes)} from ${remote} on ${target.name} → ${dest} (streamed, ${transferRate(pulled.bytes, started)})`,
      };
    }
    const buf = await this.pullBytes(target.id, remote);
    if ("error" in buf) return { ok: false, text: buf.error };
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf.data);
    return {
      ok: true,
      text: `Pulled ${formatBytes(buf.data.length)} from ${remote} on ${buf.deviceName} → ${dest} (chunked fallback — update the companion app for streamed transfers)`,
    };
  }

  /** `device_push_file`: copy a daemon-host file to the device — streamed
   *  when the app supports it (never buffers the file in daemon memory),
   *  chunked command-channel fallback otherwise. */
  async pushFileToDevice(
    query: unknown,
    localPath: unknown,
    remotePath: unknown,
  ): Promise<MeshToolResult> {
    const remote = requirePath(remotePath);
    if (!remote)
      return { ok: false, text: "A remote destination path is required." };
    const local =
      typeof localPath === "string" && localPath.trim()
        ? resolve(dirs.workspace, localPath.trim())
        : "";
    if (!local) return { ok: false, text: "A local source path is required." };
    await this.host.load();
    const resolved = this.host.resolveDevice(query);
    if ("error" in resolved) return { ok: false, text: resolved.error };
    const target = resolved.target;
    if (this.canStream(target, "download_file")) {
      return this.pushViaStream(target, local, remote);
    }
    let data: Buffer;
    try {
      data = await readFile(local);
    } catch (err) {
      // Includes Node's buffer-size ceiling (ERR_FS_FILE_TOO_LARGE) for
      // files too big to hold in memory — surface the real reason.
      return {
        ok: false,
        text: `Cannot read local file ${local}: ${(err as Error).message}`,
      };
    }
    const written = await this.pushBytes(target.id, remote, data);
    if ("error" in written) return { ok: false, text: written.error };
    return {
      ok: true,
      text: `Pushed ${formatBytes(written.bytes)} to ${remote} on ${written.deviceName} (chunked fallback — update the companion app for streamed transfers).`,
    };
  }

  /**
   * `update_device`: remote self-update for the companion. Streams a new APK
   * to the device, then tells it to silently install (root or Shizuku) and
   * restart. The mesh foreground service's autoRunOnMyPackageReplaced brings
   * the connection back on its own — the link drops only for the seconds the
   * process is swapped, no manual reopen.
   *
   * The APK is hashed here and the digest travels with the install command;
   * the device re-hashes the pushed file and refuses to install on a
   * mismatch, so a truncated transfer can never be installed.
   */
  async updateDeviceApp(
    query: unknown,
    localApkPath: unknown,
    remotePath?: unknown,
  ): Promise<MeshToolResult> {
    const local =
      typeof localApkPath === "string" && localApkPath.trim()
        ? resolve(dirs.workspace, localApkPath.trim())
        : "";
    if (!local) return { ok: false, text: "A local APK path is required." };
    await this.host.load();
    const resolved = this.host.resolveDevice(query);
    if ("error" in resolved) return { ok: false, text: resolved.error };
    const target = resolved.target;
    if (target.capabilities && !target.capabilities.includes("install_apk")) {
      return {
        ok: false,
        text: `${target.name} can't self-update — it needs a companion build with the install_apk capability and root or Shizuku enabled (device control on).`,
      };
    }

    let sha256: string;
    let size: number;
    try {
      ({ sha256, size } = await hashFile(local));
    } catch (err) {
      return {
        ok: false,
        text: `Cannot read APK ${local}: ${(err as Error).message}`,
      };
    }
    if (size === 0) {
      return { ok: false, text: `APK ${local} is empty.` };
    }

    const remote =
      typeof remotePath === "string" && remotePath.trim()
        ? remotePath.trim()
        : "/sdcard/Download/talon-companion-update.apk";

    // 1. Stream the APK to the device.
    const push = await this.pushFileToDevice(target.id, local, remote);
    if (!push.ok) {
      return { ok: false, text: `Update aborted — push failed: ${push.text}` };
    }

    // 2. Trigger the silent install (device verifies the digest first).
    const dispatched = await this.host.dispatchCommand(
      target.id,
      "install_apk",
      { path: remote, sha256 },
      this.host.commandTimeoutMs,
    );
    if ("error" in dispatched) return { ok: false, text: dispatched.error };
    if (!dispatched.result.ok) {
      return {
        ok: false,
        text:
          dispatched.result.message ?? `${target.name} refused the install.`,
      };
    }
    return {
      ok: true,
      text:
        `Pushed ${formatBytes(size)} and staged the update on ${target.name}. ` +
        `${dispatched.result.message ?? "Installing now."} ` +
        `Confirm with get_device_status once it reconnects (appVersion should change).`,
    };
  }

  /**
   * `update_node`: remote self-update for a headless talon-node. Streams a
   * replacement binary to the node, then sends `update_node` so the node
   * verifies the digest, atomically swaps its own binary, and restarts into
   * it (an in-place execve under systemd/launchd, so the mesh connection
   * returns on its own within seconds — the same UX as the Android path).
   *
   * The binary is hashed here and the digest travels with the command; the
   * node re-hashes the pushed file and refuses to swap on a mismatch, so a
   * truncated transfer can never be installed.
   *
   * With no binary_path, the replacement is auto-resolved for the node's
   * registered platform/arch (source build in a dev checkout, else the
   * version-matched release download — see links/node-binaries.ts).
   */
  async updateNodeBinary(
    query: unknown,
    localBinaryPath?: unknown,
    remotePath?: unknown,
  ): Promise<MeshToolResult> {
    await this.host.load();
    const resolved = this.host.resolveDevice(query);
    if ("error" in resolved) return { ok: false, text: resolved.error };
    const target = resolved.target;
    if (target.capabilities && !target.capabilities.includes("update_node")) {
      return {
        ok: false,
        text: `${target.name} can't self-update — it needs the update_node capability (a talon-node headless device).`,
      };
    }

    let local: string;
    let provenance = "";
    if (typeof localBinaryPath === "string" && localBinaryPath.trim()) {
      local = resolve(dirs.workspace, localBinaryPath.trim());
    } else {
      const goos = platformToGoos(target.platform);
      if (!goos) {
        return {
          ok: false,
          text: `${target.name} is a ${target.platform} device — update_node targets headless nodes only.`,
        };
      }
      const goarch = normalizeGoarch(target.arch);
      if (!goarch) {
        return {
          ok: false,
          text: `${target.name} has not advertised its CPU architecture (a node build from before arch reporting). Pass binary_path explicitly for this update — after it, the node advertises arch and future updates auto-resolve.`,
        };
      }
      try {
        const bin = await this.host.resolveNode(goos, goarch);
        local = bin.path;
        provenance = ` (auto-resolved ${bin.version} for ${goos}/${goarch} via ${bin.source})`;
      } catch (err) {
        return { ok: false, text: (err as Error).message };
      }
    }

    let sha256: string;
    let size: number;
    try {
      ({ sha256, size } = await hashFile(local));
    } catch (err) {
      return {
        ok: false,
        text: `Cannot read binary ${local}: ${(err as Error).message}`,
      };
    }
    if (size === 0) return { ok: false, text: `Binary ${local} is empty.` };

    // Default staging path is /tmp on unix nodes (the node re-stages next to
    // its own executable before the atomic swap, so this is only transient).
    const remote =
      typeof remotePath === "string" && remotePath.trim()
        ? remotePath.trim()
        : "/tmp/talon-node.update";

    // 1. Stream the new binary to the node.
    const push = await this.pushFileToDevice(target.id, local, remote);
    if (!push.ok) {
      return { ok: false, text: `Update aborted — push failed: ${push.text}` };
    }

    // 2. Trigger the swap + restart (node verifies the digest first).
    const dispatched = await this.host.dispatchCommand(
      target.id,
      "update_node",
      { path: remote, sha256 },
      this.host.commandTimeoutMs,
    );
    if ("error" in dispatched) return { ok: false, text: dispatched.error };
    if (!dispatched.result.ok) {
      return {
        ok: false,
        text: dispatched.result.message ?? `${target.name} refused the update.`,
      };
    }
    return {
      ok: true,
      text:
        `Pushed ${formatBytes(size)}${provenance} and staged the update on ${target.name}. ` +
        `${dispatched.result.message ?? "Restarting now."} ` +
        `Confirm with get_device_status once it reconnects (appVersion should change).`,
    };
  }

  /**
   * Chunked read of a remote file into a Buffer. Loops `read_file` with
   * increasing offsets until the device reports EOF.
   *
   * End-of-file is the DEVICE's call (`eof: true`), never inferred from a
   * short chunk: devices cap their chunk size (the companion serves at most
   * 256KB per read regardless of the requested length), so a chunk shorter
   * than the request is normal mid-file and treating it as EOF silently
   * truncated every chunked read past the device's cap. A zero-length chunk
   * without `eof` is a stuck transfer and fails loudly instead of looping.
   */
  private async pullBytes(
    query: unknown,
    path: string,
  ): Promise<{ data: Buffer; deviceName: string } | { error: string }> {
    const chunks: Buffer[] = [];
    let offset = 0;
    let deviceName = "device";
    for (;;) {
      const dispatched = await this.host.dispatchCommand(
        query,
        "read_file",
        { path, offset, len: FILE_CHUNK_BYTES },
        FS_COMMAND_TIMEOUT_MS,
      );
      if ("error" in dispatched) {
        return {
          error:
            offset > 0
              ? `${dispatched.error} (transfer of ${path} aborted after ${formatBytes(offset)})`
              : dispatched.error,
        };
      }
      deviceName = dispatched.target.name;
      const { result } = dispatched;
      if (!result.ok) {
        const reason = result.message ?? `Could not read ${path}.`;
        return {
          error:
            offset > 0
              ? `${reason} (transfer aborted after ${formatBytes(offset)})`
              : reason,
        };
      }
      const b64 =
        typeof result.data?.base64 === "string" ? result.data.base64 : "";
      const chunk = Buffer.from(b64, "base64");
      chunks.push(chunk);
      offset += chunk.length;
      if (result.data?.eof === true) break;
      if (chunk.length === 0) {
        return {
          error: `${path} transfer stalled: the device returned an empty chunk without reporting end-of-file (after ${formatBytes(offset)}).`,
        };
      }
      if (offset > MAX_CHUNKED_TRANSFER_BYTES) {
        return {
          error: `${path} exceeds the ${formatBytes(MAX_CHUNKED_TRANSFER_BYTES)} chunked-transfer limit (device never reported end-of-file after ${formatBytes(offset)}). Use device_pull_file with a streaming-capable companion build for large files.`,
        };
      }
    }
    try {
      return { data: Buffer.concat(chunks), deviceName };
    } catch (err) {
      // Node buffer ceiling / out of memory — the one real size limit left.
      return {
        error: `${path} transferred ${formatBytes(offset)} but is too large to assemble in daemon memory: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Chunked write of a Buffer to a remote file. The first chunk truncates the
   * target; subsequent chunks append at their offset.
   */
  private async pushBytes(
    query: unknown,
    path: string,
    data: Buffer,
  ): Promise<{ bytes: number; deviceName: string } | { error: string }> {
    let offset = 0;
    let deviceName = "device";
    // On a mid-transfer failure the device is left with a partial file —
    // say so, with how far the transfer got, so the state isn't a mystery.
    const partial = (reason: string): { error: string } => ({
      error:
        offset > 0
          ? `${reason} (upload aborted — ${path} on the device is a ${formatBytes(offset)} partial write of ${formatBytes(data.length)})`
          : reason,
    });
    // A zero-length write still needs one call to create/truncate the file.
    do {
      const chunk = data.subarray(offset, offset + FILE_CHUNK_BYTES);
      const dispatched = await this.host.dispatchCommand(
        query,
        "write_file",
        {
          path,
          base64: chunk.toString("base64"),
          offset,
          truncate: offset === 0,
        },
        FS_COMMAND_TIMEOUT_MS,
      );
      if ("error" in dispatched) return partial(dispatched.error);
      deviceName = dispatched.target.name;
      if (!dispatched.result.ok) {
        return partial(dispatched.result.message ?? `Could not write ${path}.`);
      }
      offset += chunk.length;
    } while (offset < data.length);
    return { bytes: data.length, deviceName };
  }
}

/**
 * Compare the SHA-256 a device reported for a streamed transfer with the one
 * the daemon holds. Returns a description of a mismatch, or null when they
 * agree. A device build that predates transfer digests reports none; the
 * check is then skipped (with a debug line), never failed.
 */
function digestMismatch(
  result: DeviceCommandResult,
  expected: string,
  what: string,
): string | null {
  const reported = result.data?.sha256;
  if (typeof reported !== "string" || !reported) {
    logDebug(
      "mesh",
      `${what}: device reported no sha256 (older build) — skipping the integrity check`,
    );
    return null;
  }
  if (reported.toLowerCase() === expected.toLowerCase()) return null;
  return `the device reported sha256 ${reported}, the daemon has ${expected}`;
}

/** "12.4 MB/s in 3.2s" — observability for streamed transfers. */
function transferRate(bytes: number, startedAtMs: number): string {
  const seconds = Math.max((Date.now() - startedAtMs) / 1000, 0.001);
  return `${formatBytes(bytes / seconds)}/s over ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}
