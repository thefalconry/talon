/**
 * Just enough of the ZIP format to read named entries out of an Office
 * Open XML file (docx, pptx), which is a zip of XML parts. Stored and
 * deflated entries only — the two methods Office writes. Every inflate
 * is capped, so a hostile archive can't balloon memory.
 */

import { inflateRawSync } from "node:zlib";
import { TalonError } from "../errors.js";

/** A file that isn't the archive it claims to be — bad input, not a fault. */
export function malformedDocument(message: string): TalonError {
  return new TalonError(message, { reason: "bad_request" });
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** EOCD is 22 bytes plus a comment of at most 64 KiB. */
const EOCD_SEARCH = 22 + 0xffff;

/** Largest single entry we will inflate. */
const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;

type CentralEntry = {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
};

function findEocd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - EOCD_SEARCH);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function centralEntries(buf: Buffer): CentralEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw malformedDocument("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw malformedDocument("corrupt zip central directory");
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      localOffset: buf.readUInt32LE(p + 42),
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, entry: CentralEntry): Buffer {
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL_SIG) {
    throw malformedDocument(`corrupt zip entry ${entry.name}`);
  }
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    return inflateRawSync(data, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
  }
  throw malformedDocument(`unsupported zip compression method ${entry.method}`);
}

/**
 * The entries of `buf` whose names `match` accepts, in archive order,
 * as UTF-8 text. Throws on anything that isn't a readable zip.
 */
export function readZipTextEntries(
  buf: Buffer,
  match: (name: string) => boolean,
): Array<{ name: string; text: string }> {
  return centralEntries(buf)
    .filter((e) => match(e.name))
    .map((e) => ({ name: e.name, text: readEntry(buf, e).toString("utf8") }));
}
