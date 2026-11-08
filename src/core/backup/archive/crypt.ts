/**
 * Encryption at rest — the form a part takes before it may leave the box.
 *
 * A part holds config.json (bot tokens, API keys), the secrets folder and
 * private memory, so a remote copy must be unreadable without the
 * operator's passphrase. Node's built-in crypto only:
 *
 *   - Key: scrypt(passphrase, salt) → 32 bytes. N = 2^17, r = 8, p = 1
 *     (~128 MiB and a fraction of a second per part), a fresh random
 *     16-byte salt per part. The parameters live in the header, so they
 *     can be raised later without breaking old parts.
 *   - Cipher: AES-256-GCM over fixed-size chunks (1 MiB by default).
 *     A single GCM stream would only authenticate at the very end, after
 *     every plaintext byte had already been handed to the tar extractor;
 *     chunking means nothing is released until its own tag has verified.
 *
 * Layout (all integers big-endian):
 *
 *   header  "TALONENC1" | kdf=1 (u8) | log2 N (u8) | r (u8) | p (u8)
 *           | chunk size (u32) | salt (16) | base IV (12)          45 bytes
 *   record  flag (u8, 1 = final) | length (u32) | ciphertext | tag (16)
 *
 * Record i is sealed with nonce = base IV XOR i (in the low 64 bits) and
 * with additional data = the whole header | i (u64) | flag. So the header
 * is authenticated by every record, records cannot be reordered or
 * replayed, and the final flag makes truncation at a record boundary
 * detectable. The last record is always present (possibly empty) and
 * nothing may follow it.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline, Transform, type TransformCallback } from "node:stream";
import type { Readable } from "node:stream";
import { TalonError } from "../../errors.js";

/** File signature; the trailing 1 is the format version. */
export const ENCRYPTION_MAGIC = Buffer.from("TALONENC1", "ascii");
/** Suffix appended to the name of an encrypted part. */
export const ENCRYPTED_SUFFIX = ".enc";

const KDF_SCRYPT = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const RECORD_HEAD = 5;
const FLAG_FINAL = 1;
const DEFAULT_LOG2N = 17;
const DEFAULT_CHUNK = 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;

/** Total header length in bytes. */
export const HEADER_BYTES =
  ENCRYPTION_MAGIC.length + 4 + 4 + SALT_BYTES + IV_BYTES;

export type EncryptionHeader = {
  log2N: number;
  r: number;
  p: number;
  chunkSize: number;
  salt: Buffer;
  iv: Buffer;
};

/** Knobs for tests; production always uses the defaults. */
export type EncryptOptions = { log2N?: number; chunkSize?: number };

function formatError(detail: string): TalonError {
  return new TalonError(`Encrypted backup: ${detail}`, {
    reason: "bad_request",
  });
}

function authError(): TalonError {
  return formatError(
    "authentication failed — wrong passphrase, or the file was modified",
  );
}

export function encodeHeader(header: EncryptionHeader): Buffer {
  const buf = Buffer.alloc(HEADER_BYTES);
  let at = ENCRYPTION_MAGIC.copy(buf, 0);
  buf[at++] = KDF_SCRYPT;
  buf[at++] = header.log2N;
  buf[at++] = header.r;
  buf[at++] = header.p;
  at = buf.writeUInt32BE(header.chunkSize, at);
  at += header.salt.copy(buf, at);
  header.iv.copy(buf, at);
  return buf;
}

function hasEncryptionMagic(buf: Uint8Array): boolean {
  return (
    buf.length >= ENCRYPTION_MAGIC.length &&
    Buffer.from(buf.subarray(0, ENCRYPTION_MAGIC.length)).equals(
      ENCRYPTION_MAGIC,
    )
  );
}

/** Parse and bound-check a header. Throws on anything unexpected. */
export function parseHeader(buf: Buffer): EncryptionHeader {
  if (buf.length < HEADER_BYTES || !hasEncryptionMagic(buf)) {
    throw formatError("not an encrypted Talon backup (bad header)");
  }
  let at = ENCRYPTION_MAGIC.length;
  const kdf = buf[at++];
  const [log2N, r, p] = [buf[at++], buf[at++], buf[at++]];
  const chunkSize = buf.readUInt32BE(at);
  at += 4;
  if (kdf !== KDF_SCRYPT) throw formatError(`unknown key derivation ${kdf}`);
  if (!scryptParamsInRange({ log2N, r, p })) {
    throw formatError("scrypt parameters out of range");
  }
  if (chunkSize < 1 || chunkSize > MAX_CHUNK) {
    throw formatError("chunk size out of range");
  }
  const salt = Buffer.from(buf.subarray(at, at + SALT_BYTES));
  const iv = Buffer.from(
    buf.subarray(at + SALT_BYTES, at + SALT_BYTES + IV_BYTES),
  );
  return { log2N, r, p, chunkSize, salt, iv };
}

/** scrypt cost parameters, as recorded next to whatever they protect. */
export type ScryptParams = { log2N: number; r: number; p: number };

/** The scrypt parameters every new part and manifest is written with. */
export const DEFAULT_SCRYPT: ScryptParams = {
  log2N: DEFAULT_LOG2N,
  r: 8,
  p: 1,
};

/** True when stored parameters are inside the range this build accepts. */
export function scryptParamsInRange({ log2N, r, p }: ScryptParams): boolean {
  return log2N >= 10 && log2N <= 20 && r >= 1 && r <= 32 && p >= 1 && p <= 16;
}

/** scrypt → 32-byte key, with enough maxmem for the given parameters. */
export function deriveScryptKey(
  passphrase: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  const N = 2 ** params.log2N;
  const maxmem = 2 * 128 * N * params.r * params.p + 1024 * 1024;
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_BYTES,
      { N, r: params.r, p: params.p, maxmem },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

function deriveKey(
  passphrase: string,
  header: EncryptionHeader,
): Promise<Buffer> {
  return deriveScryptKey(passphrase, header.salt, header);
}

function nonceFor(iv: Buffer, counter: number): Buffer {
  const nonce = Buffer.from(iv);
  nonce.writeBigUInt64BE(nonce.readBigUInt64BE(4) ^ BigInt(counter), 4);
  return nonce;
}

function aadFor(header: Buffer, counter: number, flag: number): Buffer {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(BigInt(counter), 0);
  tail[8] = flag;
  return Buffer.concat([header, tail]);
}

/** A FIFO of buffers that concatenates only when a caller takes bytes. */
class ByteQueue {
  private parts: Buffer[] = [];
  length = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.parts.push(chunk);
    this.length += chunk.length;
  }

  peek(n: number): Buffer {
    const first = this.parts[0];
    if (first && first.length >= n) return first.subarray(0, n);
    return this.flatten().subarray(0, n);
  }

  take(n: number): Buffer {
    const all = this.flatten();
    const rest = all.subarray(n);
    this.parts = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return all.subarray(0, n);
  }

  private flatten(): Buffer {
    if (this.parts.length !== 1) {
      this.parts = [Buffer.concat(this.parts, this.length)];
    }
    return this.parts[0];
  }
}

/** Plaintext in, header + sealed records out. */
class EncryptStream extends Transform {
  private readonly queue = new ByteQueue();
  private readonly headerBytes: Buffer;
  private counter = 0;
  private started = false;

  constructor(
    private readonly key: Buffer,
    private readonly header: EncryptionHeader,
  ) {
    super();
    this.headerBytes = encodeHeader(header);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    this.start();
    this.queue.push(chunk);
    // Strictly greater: at least one byte stays behind for the final record.
    while (this.queue.length > this.header.chunkSize) {
      this.seal(this.queue.take(this.header.chunkSize), 0);
    }
    done();
  }

  override _flush(done: TransformCallback): void {
    this.start();
    this.seal(this.queue.take(this.queue.length), FLAG_FINAL);
    done();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.push(this.headerBytes);
  }

  private seal(plain: Buffer, flag: number): void {
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.key,
      nonceFor(this.header.iv, this.counter),
    );
    cipher.setAAD(aadFor(this.headerBytes, this.counter, flag));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const head = Buffer.alloc(RECORD_HEAD);
    head[0] = flag;
    head.writeUInt32BE(body.length, 1);
    this.push(Buffer.concat([head, body, cipher.getAuthTag()]));
    this.counter += 1;
  }
}

/** Records in (header already consumed), verified plaintext out. */
class DecryptStream extends Transform {
  private readonly queue = new ByteQueue();
  private readonly headerBytes: Buffer;
  private counter = 0;
  private finished = false;

  constructor(
    private readonly key: Buffer,
    private readonly header: EncryptionHeader,
  ) {
    super();
    this.headerBytes = encodeHeader(header);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    this.queue.push(chunk);
    try {
      this.drain();
      done();
    } catch (err) {
      done(err as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    if (!this.finished || this.queue.length > 0) {
      done(formatError("truncated or has trailing bytes"));
      return;
    }
    done();
  }

  private drain(): void {
    while (this.queue.length >= RECORD_HEAD) {
      if (this.finished) throw formatError("data after the final record");
      const head = this.queue.peek(RECORD_HEAD);
      const flag = head[0];
      const length = head.readUInt32BE(1);
      if (flag > FLAG_FINAL || length > this.header.chunkSize) {
        throw authError();
      }
      const total = RECORD_HEAD + length + TAG_BYTES;
      if (this.queue.length < total) return;
      const record = this.queue.take(total);
      this.open(
        record.subarray(RECORD_HEAD, RECORD_HEAD + length),
        record.subarray(RECORD_HEAD + length),
        flag,
      );
    }
  }

  private open(body: Buffer, tag: Buffer, flag: number): void {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      nonceFor(this.header.iv, this.counter),
    );
    decipher.setAAD(aadFor(this.headerBytes, this.counter, flag));
    decipher.setAuthTag(tag);
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw authError();
    }
    this.counter += 1;
    if (flag === FLAG_FINAL) this.finished = true;
    if (plain.length > 0) this.push(plain);
  }
}

/** An encrypting transform with a fresh salt, IV and derived key. */
export async function createEncryptor(
  passphrase: string,
  options: EncryptOptions = {},
): Promise<Transform> {
  const header: EncryptionHeader = {
    log2N: options.log2N ?? DEFAULT_LOG2N,
    r: 8,
    p: 1,
    chunkSize: options.chunkSize ?? DEFAULT_CHUNK,
    salt: randomBytes(SALT_BYTES),
    iv: randomBytes(IV_BYTES),
  };
  return new EncryptStream(await deriveKey(passphrase, header), header);
}

/** The first bytes of a file — enough to recognise the format. */
async function readPrefix(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** True when the file starts with the encryption signature. */
export async function isEncryptedFile(path: string): Promise<boolean> {
  return hasEncryptionMagic(await readPrefix(path, ENCRYPTION_MAGIC.length));
}

/**
 * Stream the verified plaintext of an encrypted file. Errors (wrong
 * passphrase, tampering, truncation) surface on the returned stream.
 */
export async function openDecrypted(
  path: string,
  passphrase: string,
): Promise<Readable> {
  const header = parseHeader(await readPrefix(path, HEADER_BYTES));
  const key = await deriveKey(passphrase, header);
  return pipeline(
    createReadStream(path, { start: HEADER_BYTES }),
    new DecryptStream(key, header),
    () => {
      /* errors are delivered to whoever reads the returned stream */
    },
  );
}

/** Decrypt the whole file and discard it: throws unless every record verifies. */
export async function verifyDecryptable(
  path: string,
  passphrase: string,
): Promise<void> {
  const stream = await openDecrypted(path, passphrase);
  for await (const _chunk of stream) {
    /* authentication is the point; the bytes are not needed */
  }
}

/** Whether this passphrase opens the file's first record. */
export async function passphraseOpens(
  path: string,
  passphrase: string,
): Promise<boolean> {
  try {
    const stream = await openDecrypted(path, passphrase);
    for await (const _chunk of stream) break;
    return true;
  } catch {
    return false;
  }
}
