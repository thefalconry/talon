/**
 * tar — the container half of a snapshot part (write + streaming extract).
 *
 * Why hand-rolled: a backup is the one subsystem that must keep working
 * when everything else is broken, so it earns zero dependencies. The
 * format is ustar (POSIX 1003.1-1988) with PAX extended headers for the
 * three things ustar cannot say — paths over 100 bytes, symlink targets
 * over 100 bytes, and files over 8 GiB — which is exactly what GNU tar,
 * bsdtar and every library reader already understand. A snapshot is
 * therefore recoverable with `tar --zstd -xf` on any machine, with no
 * Talon present at all.
 *
 * Everything streams. `addFile` pipes from disk one chunk at a time and
 * honours the sink's backpressure; `extractTar` consumes an async
 * iterable and writes as it parses. A 4 GiB workspace never lands in
 * memory on either side.
 *
 * Extraction is hostile-input safe: a snapshot may have been round-tripped
 * through a remote target, so every member path is resolved against the
 * destination and rejected if it escapes (absolute paths, `..` segments,
 * symlinks pointing outside the tree). A backup that can overwrite
 * `~/.ssh/authorized_keys` is not a safety net.
 */

import { createWriteStream } from "node:fs";
import { mkdir, open, symlink, utimes } from "node:fs/promises";
import { once } from "node:events";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Writable } from "node:stream";
import { TalonError } from "../../errors.js";

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
/** Largest size ustar's 11 octal digits can express (8 GiB - 1). */
const MAX_USTAR_SIZE = 0o77777777777;
/** Longest name/linkname ustar's fixed fields can hold. */
const MAX_USTAR_NAME = 100;

type TarEntryType = "file" | "dir" | "symlink";

/** One member of an archive, as both writer and reader see it. */
export type TarEntry = {
  /** Archive path: POSIX separators, relative, no `.` or `..` segments. */
  path: string;
  type: TarEntryType;
  /** Permission bits only (0o7777); the type bits come from `type`. */
  mode: number;
  /** Modification time, epoch SECONDS (tar's resolution). */
  mtime: number;
  /** Payload length; 0 for directories and symlinks. */
  size: number;
  /** Target of a symlink member. */
  linkTarget?: string;
};

function tarError(message: string): TalonError {
  return new TalonError(message, { reason: "bad_request" });
}

// ── Header encoding ─────────────────────────────────────────────────────────

/** `width - 1` octal digits, NUL-terminated — tar's numeric field form. */
function writeOctal(
  header: Buffer,
  value: number,
  offset: number,
  width: number,
): void {
  const digits = Math.max(0, Math.trunc(value))
    .toString(8)
    .padStart(width - 1, "0");
  header.write(digits.slice(-(width - 1)), offset, "ascii");
  header[offset + width - 1] = 0;
}

function writeText(
  header: Buffer,
  value: string,
  offset: number,
  width: number,
): void {
  header.write(value.slice(0, width), offset, width, "utf8");
}

const TYPE_FLAG: Record<TarEntryType, string> = {
  file: "0",
  dir: "5",
  symlink: "2",
};

/**
 * Build one 512-byte ustar header. `name` and `linkTarget` are assumed to
 * fit already — the caller emits a PAX header first when they do not, and
 * passes truncated values here so a PAX-blind reader still sees something
 * recognisable rather than a blank entry.
 */
function buildHeader(
  entry: TarEntry,
  name: string,
  linkTarget: string,
  size: number,
): Buffer {
  const header = Buffer.alloc(BLOCK);
  writeText(header, name, 0, 100);
  writeOctal(header, entry.mode & 0o7777, 100, 8);
  writeOctal(header, 0, 108, 8); // uid — snapshots restore as the running user
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, size, 124, 12);
  writeOctal(header, entry.mtime, 136, 12);
  header.write(TYPE_FLAG[entry.type], 156, 1, "ascii");
  writeText(header, linkTarget, 157, 100);
  header.write("ustar\0" + "00", 257, 8, "ascii");
  writeText(header, "talon", 265, 32); // uname
  writeText(header, "talon", 297, 32); // gname
  // Checksum is computed with the field itself read as eight spaces.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  // Field layout: six octal digits, NUL, space — the NUL and the trailing
  // space are already in place from the fill above.
  writeOctal(header, sum, 148, 7);
  return header;
}

/** `"<len> <key>=<value>\n"`, where `<len>` counts its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  // The length prefix counts itself, so the width is a fixpoint: start at
  // one digit and re-measure until it stops moving (at most four passes for
  // any record a filesystem can produce).
  let len = body.length + 1;
  for (let i = 0; i < 4; i++) {
    const next = String(len).length + body.length;
    if (next === len) break;
    len = next;
  }
  return `${len}${body}`;
}

/** Which PAX records (if any) this entry needs, as one blob. */
function paxBody(entry: TarEntry): string {
  let body = "";
  if (Buffer.byteLength(entry.path) > MAX_USTAR_NAME) {
    body += paxRecord("path", entry.path);
  }
  if (
    entry.linkTarget &&
    Buffer.byteLength(entry.linkTarget) > MAX_USTAR_NAME
  ) {
    body += paxRecord("linkpath", entry.linkTarget);
  }
  if (entry.size > MAX_USTAR_SIZE)
    body += paxRecord("size", String(entry.size));
  return body;
}

function padding(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

// ── Writer ──────────────────────────────────────────────────────────────────

/**
 * Streaming tar writer over any Writable (in practice a zstd compressor).
 * The caller owns the sink: `finalize()` writes tar's two zero blocks but
 * does not end the stream, so the same sink can be finished by a pipeline.
 */
export class TarWriter {
  constructor(private readonly out: Writable) {}

  private async write(chunk: Buffer): Promise<void> {
    if (!this.out.write(chunk)) await once(this.out, "drain");
  }

  /** Header (+ PAX header when needed) for one member. */
  private async writeHeaders(entry: TarEntry): Promise<void> {
    const body = paxBody(entry);
    if (body) {
      const payload = Buffer.from(body, "utf8");
      const paxName = `PaxHeaders/${entry.path.split("/").pop() ?? "entry"}`;
      const paxHeader = buildHeader(
        {
          path: paxName,
          type: "file",
          mode: 0o644,
          mtime: entry.mtime,
          size: payload.length,
        },
        paxName.slice(0, MAX_USTAR_NAME),
        "",
        payload.length,
      );
      paxHeader.write("x", 156, 1, "ascii");
      // The type byte is part of the checksummed image — recompute it.
      paxHeader.fill(0x20, 148, 156);
      let sum = 0;
      for (const byte of paxHeader) sum += byte;
      writeOctal(paxHeader, sum, 148, 7);
      await this.write(paxHeader);
      await this.write(payload);
      const pad = padding(payload.length);
      if (pad) await this.write(Buffer.alloc(pad));
    }
    const size = entry.size > MAX_USTAR_SIZE ? 0 : entry.size;
    await this.write(
      buildHeader(
        entry,
        entry.path.slice(0, MAX_USTAR_NAME),
        (entry.linkTarget ?? "").slice(0, MAX_USTAR_NAME),
        size,
      ),
    );
  }

  async addDirectory(path: string, mode: number, mtime: number): Promise<void> {
    await this.writeHeaders({
      path: `${path}/`,
      type: "dir",
      mode,
      mtime,
      size: 0,
    });
  }

  async addSymlink(
    path: string,
    linkTarget: string,
    mode: number,
    mtime: number,
  ): Promise<void> {
    await this.writeHeaders({
      path,
      type: "symlink",
      mode,
      mtime,
      size: 0,
      linkTarget,
    });
  }

  /** In-memory member — for small synthesized files (manifests, markers). */
  async addBuffer(
    path: string,
    content: Buffer,
    mode = 0o644,
    mtime = Math.floor(Date.now() / 1000),
  ): Promise<void> {
    await this.writeHeaders({
      path,
      type: "file",
      mode,
      mtime,
      size: content.length,
    });
    await this.write(content);
    const pad = padding(content.length);
    if (pad) await this.write(Buffer.alloc(pad));
  }

  /**
   * Stream a file from disk. `size` is the length recorded in the header:
   * a file that changes under us is truncated or zero-padded to it, because
   * a tar whose payload length disagrees with its header is unreadable.
   * The source is opened before the header goes out, so a file that
   * vanished or became unreadable since it was listed throws with nothing
   * written — the archive is still whole and the caller may carry on.
   */
  async addFile(
    path: string,
    source: string,
    mode: number,
    mtime: number,
    size: number,
  ): Promise<void> {
    const handle = await open(source, "r");
    try {
      await this.writeHeaders({ path, type: "file", mode, mtime, size });
    } catch (err) {
      await handle.close();
      throw err;
    }
    let written = 0;
    // Owns the handle from here: closed when the stream ends or is destroyed.
    const stream = handle.createReadStream();
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      const room = size - written;
      if (room <= 0) break;
      const slice = buf.length > room ? buf.subarray(0, room) : buf;
      await this.write(slice);
      written += slice.length;
    }
    if (written < size) await this.write(Buffer.alloc(size - written));
    const pad = padding(size);
    if (pad) await this.write(Buffer.alloc(pad));
  }

  /** Tar's end-of-archive marker: two zero blocks. */
  async finalize(): Promise<void> {
    await this.write(ZERO_BLOCK);
    await this.write(ZERO_BLOCK);
  }
}

// ── Reader ──────────────────────────────────────────────────────────────────

/** Pull-based byte reader over an async chunk source. */
class BlockReader {
  private readonly chunks: Buffer[] = [];
  private length = 0;
  private ended = false;

  constructor(private readonly iter: AsyncIterator<Buffer | Uint8Array>) {}

  private async fill(n: number): Promise<void> {
    while (this.length < n && !this.ended) {
      const next = await this.iter.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const buf = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value);
      if (buf.length === 0) continue;
      this.chunks.push(buf);
      this.length += buf.length;
    }
  }

  private consume(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - filled);
      head.copy(out, filled, 0, take);
      filled += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.length -= n;
    return out;
  }

  /** Exactly `n` bytes; null at a clean end of stream. */
  async take(n: number): Promise<Buffer | null> {
    await this.fill(n);
    if (this.length === 0) return null;
    if (this.length < n) throw tarError("Truncated archive");
    return this.consume(n);
  }

  /** Hand `n` bytes to `sink` in whatever chunks arrive; null sink discards. */
  async drain(
    n: number,
    sink?: (chunk: Buffer) => Promise<void>,
  ): Promise<void> {
    let left = n;
    while (left > 0) {
      await this.fill(Math.min(left, BLOCK));
      if (this.length === 0) throw tarError("Truncated archive body");
      const chunk = this.consume(Math.min(left, this.length));
      if (sink) await sink(chunk);
      left -= chunk.length;
    }
  }
}

type RawHeader = {
  name: string;
  prefix: string;
  mode: number;
  size: number;
  mtime: number;
  typeflag: string;
  linkname: string;
};

function readString(block: Buffer, offset: number, width: number): string {
  const slice = block.subarray(offset, offset + width);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(block: Buffer, offset: number, width: number): number {
  const text = readString(block, offset, width).trim().replace(/\0+$/, "");
  if (!text) return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/** Parse one header block; null means "end-of-archive marker". */
function parseHeader(block: Buffer): RawHeader | null {
  if (block.every((byte) => byte === 0)) return null;
  const stated = readOctal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : block[i];
  }
  if (sum !== stated)
    throw tarError("Bad tar header checksum — archive corrupt");
  return {
    name: readString(block, 0, 100),
    prefix: readString(block, 345, 155),
    mode: readOctal(block, 100, 8),
    size: readOctal(block, 124, 12),
    mtime: readOctal(block, 136, 12),
    typeflag: String.fromCharCode(block[156]) || "0",
    linkname: readString(block, 157, 100),
  };
}

/** `"<len> <key>=<value>\n"` records → a map. Unknown keys are ignored. */
function parsePax(body: string): Map<string, string> {
  const records = new Map<string, string>();
  let cursor = 0;
  while (cursor < body.length) {
    const space = body.indexOf(" ", cursor);
    if (space === -1) break;
    const length = parseInt(body.slice(cursor, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.slice(space + 1, cursor + length).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    cursor += length;
  }
  return records;
}

/**
 * Resolve a member path inside `destDir`, refusing anything that escapes.
 * Absolute paths, drive letters, `..` segments and backslash separators are
 * all rejected rather than sanitized: a snapshot that needs sanitizing is
 * not one we should be unpacking over a live home directory.
 */
export function resolveMemberPath(destDir: string, memberPath: string): string {
  const cleaned = memberPath.replace(/\/+$/, "");
  if (!cleaned || cleaned === ".") throw tarError("Empty member path");
  if (
    isAbsolute(cleaned) ||
    /^[A-Za-z]:/.test(cleaned) ||
    cleaned.includes("\\")
  ) {
    throw tarError(`Unsafe member path in archive: ${memberPath}`);
  }
  if (cleaned.split("/").some((segment) => segment === "..")) {
    throw tarError(`Path traversal in archive: ${memberPath}`);
  }
  const abs = resolve(destDir, cleaned);
  const rel = relative(destDir, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw tarError(`Path escapes destination: ${memberPath}`);
  }
  return abs;
}

/** A symlink may point anywhere inside the extracted tree, and nowhere else. */
function checkLinkTarget(
  destDir: string,
  linkPath: string,
  target: string,
): void {
  if (!target) throw tarError("Symlink with empty target");
  if (isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
    throw tarError(`Absolute symlink target in archive: ${target}`);
  }
  const resolved = resolve(dirname(linkPath), target);
  const rel = relative(destDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw tarError(`Symlink escapes destination: ${target}`);
  }
}

/** Write one regular member to disk, streaming `size` bytes from the reader. */
async function writeFileMember(
  reader: BlockReader,
  dest: string,
  size: number,
  entry: TarEntry,
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const out = createWriteStream(dest, { mode: entry.mode & 0o7777 });
  try {
    await reader.drain(size, async (chunk) => {
      if (!out.write(chunk)) await once(out, "drain");
    });
  } finally {
    out.end();
    await once(out, "close");
  }
  await utimes(dest, entry.mtime, entry.mtime).catch(() => {
    /* timestamps are cosmetic — a filesystem that refuses them is fine */
  });
}

/** The member kinds a Talon snapshot can contain. */
function entryTypeOf(typeflag: string): TarEntryType | null {
  if (typeflag === "0" || typeflag === "\0" || typeflag === "7") return "file";
  if (typeflag === "5") return "dir";
  if (typeflag === "2") return "symlink";
  return null;
}

/**
 * Extract an archive into `destDir`, creating it if needed. Returns the
 * members written, in archive order. Streaming: memory use is one chunk,
 * whatever the archive's size.
 */
export async function extractTar(
  source: AsyncIterable<Buffer | Uint8Array>,
  destDir: string,
): Promise<TarEntry[]> {
  const reader = new BlockReader(source[Symbol.asyncIterator]());
  await mkdir(destDir, { recursive: true });
  const written: TarEntry[] = [];
  let pax = new Map<string, string>();

  for (;;) {
    const block = await reader.take(BLOCK);
    if (!block) break;
    const header = parseHeader(block);
    if (!header) break; // end-of-archive marker

    // Metadata members carry the next member's long path / large size.
    if (header.typeflag === "x" || header.typeflag === "g") {
      const body: Buffer[] = [];
      await reader.drain(header.size, async (chunk) => void body.push(chunk));
      await reader.drain(padding(header.size));
      const parsed = parsePax(Buffer.concat(body).toString("utf8"));
      if (header.typeflag === "x") pax = parsed;
      continue;
    }

    const rawPath =
      pax.get("path") ??
      (header.prefix ? `${header.prefix}/${header.name}` : header.name);
    const size = Number(pax.get("size") ?? header.size);
    const linkTarget = pax.get("linkpath") ?? header.linkname;
    pax = new Map();

    const type = entryTypeOf(header.typeflag);
    if (!type) {
      // Hardlinks, devices, fifos: Talon never writes them, and silently
      // recreating one from an untrusted archive is not worth the surface.
      await reader.drain(size);
      await reader.drain(padding(size));
      continue;
    }

    const dest = resolveMemberPath(destDir, rawPath);
    const entry: TarEntry = {
      path: rawPath.replace(/\/+$/, ""),
      type,
      mode: header.mode & 0o7777,
      mtime: header.mtime,
      size: type === "file" ? size : 0,
      ...(type === "symlink" ? { linkTarget } : {}),
    };

    if (type === "dir") {
      await mkdir(dest, { recursive: true, mode: entry.mode });
    } else if (type === "symlink") {
      checkLinkTarget(destDir, dest, linkTarget);
      await mkdir(dirname(dest), { recursive: true });
      await symlink(linkTarget, dest);
    } else {
      await writeFileMember(reader, dest, size, entry);
      await reader.drain(padding(size));
      written.push(entry);
      continue;
    }
    written.push(entry);
  }
  return written;
}
