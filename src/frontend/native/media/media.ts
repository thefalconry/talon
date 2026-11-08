/**
 * Media handling — the id → path registry the `/media` route serves from,
 * the uploads directory client attachments land in, and the MIME table both
 * the upload path and the `/media` route classify files with.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { dirs } from "../../../util/paths.js";
import type { ClientAttachment } from "../protocol.js";
import type { NativeRuntime } from "../runtime.js";

/**
 * Upload ceiling. Bodies stream straight to disk, so this bounds what a
 * client may park in the uploads dir rather than what has to fit in memory —
 * high enough for the archives and media people actually attach.
 */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** Register a file for serving and return its short media id (stable per
 *  path for the life of the daemon). */
export function registerMedia(
  runtime: NativeRuntime,
  filePath: string,
): string {
  const known = runtime.mediaIds.get(filePath);
  if (known) return known;
  const id = `m${runtime.nextId().toString(36)}`;
  runtime.media.set(id, filePath);
  runtime.mediaIds.set(filePath, id);
  return id;
}

/** The relative bridge path a client renders a registered media id from. */
export function mediaUrl(mediaId: string): string {
  return `/media?id=${encodeURIComponent(mediaId)}`;
}

/**
 * Extension → MIME. Deliberately small: the types a companion client is
 * likely to attach (images it renders inline, archives, documents, code,
 * audio/video), with `application/octet-stream` for everything else — which
 * is a correct answer for a download, just not a descriptive one.
 */
const MIME_BY_EXT: Record<string, string> = {
  // Images (the set `isImageType` renders inline).
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  // Archives.
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".zst": "application/zstd",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  // Documents.
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".rtf": "application/rtf",
  ".epub": "application/epub+zip",
  // Text + code.
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".log": "text/plain",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/x-typescript",
  ".tsx": "text/x-typescript",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".sh": "application/x-sh",
  ".sql": "application/sql",
  ".patch": "text/x-diff",
  ".diff": "text/x-diff",
  // Audio / video.
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  // Fonts.
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Best-effort MIME type for a path, by extension. */
export function contentTypeFor(filePath: string): string {
  return (
    MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream"
  );
}

/** Whether a MIME type is one clients render inline as an image. */
export function isImageType(mimeType: string): boolean {
  // SVG is an image by type but a script host by nature — clients render it
  // through the same <img> path, so keep it inline-able; the bytes are only
  // ever served back to the authenticated client that uploaded them.
  return mimeType.startsWith("image/");
}

/**
 * Sanitise an uploaded file name to a single safe path segment. Strips any
 * directory component (`../`, absolute paths, Windows separators) and any
 * character outside a conservative allowlist, so an upload can never escape
 * the uploads dir no matter what the client sends.
 */
export function safeUploadName(filename: string): string {
  const base = basename(filename.replace(/\\/g, "/"));
  const safe = base.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  return safe || "upload";
}

/** The absolute path an upload with this name lands at (unique per call). */
function uploadDest(runtime: NativeRuntime, filename: string): string {
  return join(
    dirs.uploads,
    `${Date.now()}-${runtime.nextId().toString(36)}-${safeUploadName(filename)}`,
  );
}

/**
 * Stream an upload body straight to the uploads dir — never buffering the
 * whole file in memory, so a multi-hundred-megabyte archive costs a socket
 * and a file handle rather than the heap. Aborts (and cleans up the partial
 * file) as soon as `maxBytes` is exceeded.
 */
export async function saveUploadStream(
  runtime: NativeRuntime,
  filename: string,
  body: Readable,
  maxBytes: number,
): Promise<{ path: string; size: number }> {
  await mkdir(dirs.uploads, { recursive: true });
  const dest = uploadDest(runtime, filename);
  const sink = createWriteStream(dest);
  let size = 0;
  let tooLarge = false;
  try {
    await pipeline(
      body,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > maxBytes) {
            tooLarge = true;
            throw new Error(
              `Upload exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`,
            );
          }
          yield chunk;
        }
      },
      sink,
    );
  } catch (err) {
    // Wait for the sink to actually close before removing the partial file:
    // the pipeline can reject before the fd exists, and an unlink that races
    // it leaves the file on disk once the open finally lands.
    await closed(sink);
    await unlink(dest).catch(() => {});
    if (tooLarge) throw err;
    throw new Error(
      `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (size === 0) {
    await closed(sink);
    await unlink(dest).catch(() => {});
    throw new Error("Empty upload");
  }
  return { path: dest, size };
}

/** Resolve once a write stream is closed, destroying it if it still is not. */
function closed(sink: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (sink.closed) return resolve();
    sink.once("close", () => resolve());
    sink.destroy();
  });
}

/**
 * Register a saved upload for serving and project it to its wire shape. The
 * declared content type wins when it is specific; otherwise the extension
 * decides, so a client that sends `application/octet-stream` for everything
 * still gets a usefully typed attachment back.
 */
export function describeAttachment(
  runtime: NativeRuntime,
  file: { path: string; name: string; size: number; contentType?: string },
): ClientAttachment {
  const declared = (file.contentType ?? "").split(";")[0]?.trim().toLowerCase();
  const mimeType =
    declared && declared !== "application/octet-stream"
      ? declared
      : contentTypeFor(file.name || file.path);
  const mediaId = registerMedia(runtime, file.path);
  const attachment: ClientAttachment = {
    path: file.path,
    name: safeUploadName(file.name || basename(file.path)),
    size: file.size,
    mimeType,
    url: mediaUrl(mediaId),
    image: isImageType(mimeType),
  };
  // Remember it by media id: `/send` resolves the client's references through
  // this registry instead of trusting paths off the wire.
  runtime.uploads.set(mediaId, attachment);
  return attachment;
}

/** The media id inside a `/media?id=…` reference, or undefined. */
export function mediaIdFrom(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /[?&]id=([^&]+)/.exec(url);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Resolve one attachment reference from a client into the record this daemon
 * minted at upload time. Unknown ids resolve to undefined — a client cannot
 * name a file the daemon did not write to its own uploads dir.
 */
export function resolveUpload(
  runtime: NativeRuntime,
  ref: { url?: string; path?: string } | undefined,
): ClientAttachment | undefined {
  if (!ref) return undefined;
  const byId = mediaIdFrom(ref.url);
  if (byId) {
    const known = runtime.uploads.get(byId);
    if (known) return known;
  }
  // Legacy single-file clients send only the on-disk path back. Match it
  // against what was uploaded this run rather than accepting it outright.
  if (ref.path) {
    for (const entry of runtime.uploads.values()) {
      if (entry.path === ref.path) return entry;
    }
  }
  return undefined;
}

/**
 * Re-describe an attachment persisted in history: the stored record already
 * has the name/size/type, it just needs a fresh media id (ids are per-daemon
 * run) so the bytes are fetchable again after a restart.
 */
export function rehydrateAttachment(
  runtime: NativeRuntime,
  stored: ClientAttachment,
): ClientAttachment {
  return { ...stored, url: mediaUrl(registerMedia(runtime, stored.path)) };
}
