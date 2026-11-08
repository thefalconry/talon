/**
 * The encrypted part format (core/backup/archive/crypt.ts): the header,
 * chunked AES-256-GCM round trips, and every way a file can be wrong —
 * wrong passphrase, a flipped byte, a truncated or extended file. The
 * scrypt cost is lowered via the header (log2N = 10) so the suite stays
 * fast; the parameters travel with the file, so decryption is unchanged.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ENCRYPTION_MAGIC,
  HEADER_BYTES,
  createEncryptor,
  encodeHeader,
  isEncryptedFile,
  openDecrypted,
  parseHeader,
  passphraseOpens,
  verifyDecryptable,
} from "../core/backup/archive/crypt.js";

const PASS = "correct horse battery staple";
const FAST = { log2N: 10, chunkSize: 1024 };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "talon-crypt-"));
}

async function encryptTo(
  path: string,
  data: Buffer,
  options = FAST,
): Promise<void> {
  // Feed in odd-sized pieces so chunk boundaries never line up with input.
  const pieces: Buffer[] = [];
  for (let at = 0; at < data.length; at += 777) {
    pieces.push(data.subarray(at, at + 777));
  }
  await pipeline(
    Readable.from(pieces),
    await createEncryptor(PASS, options),
    createWriteStream(path),
  );
}

async function decrypt(path: string, passphrase = PASS): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await openDecrypted(path, passphrase)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe("the header", () => {
  const header = {
    log2N: 17,
    r: 8,
    p: 1,
    chunkSize: 1024 * 1024,
    salt: randomBytes(16),
    iv: randomBytes(12),
  };

  it("round-trips and starts with the magic", () => {
    const bytes = encodeHeader(header);
    expect(bytes.length).toBe(HEADER_BYTES);
    expect(bytes.subarray(0, 9).toString("ascii")).toBe("TALONENC1");
    expect(parseHeader(bytes)).toEqual(header);
  });

  it("rejects a wrong magic, a short buffer and out-of-range parameters", () => {
    const bytes = encodeHeader(header);
    const badMagic = Buffer.from(bytes);
    badMagic[0] = 0x58;
    expect(() => parseHeader(badMagic)).toThrow(/bad header/);
    expect(() => parseHeader(bytes.subarray(0, 20))).toThrow(/bad header/);

    const badKdf = Buffer.from(bytes);
    badKdf[9] = 7;
    expect(() => parseHeader(badKdf)).toThrow(/key derivation/);

    const hugeN = Buffer.from(bytes);
    hugeN[10] = 40;
    expect(() => parseHeader(hugeN)).toThrow(/scrypt/);

    const hugeChunk = Buffer.from(bytes);
    hugeChunk.writeUInt32BE(1024 * 1024 * 1024, 13);
    expect(() => parseHeader(hugeChunk)).toThrow(/chunk size/);
  });
});

describe("round trips", () => {
  it("encrypts and decrypts a small payload", async () => {
    const path = join(scratch(), "small.enc");
    const data = Buffer.from("config.json with a bot token in it");
    await encryptTo(path, data);
    const onDisk = readFileSync(path);
    expect(onDisk.subarray(0, 9).equals(ENCRYPTION_MAGIC)).toBe(true);
    expect(onDisk.includes(Buffer.from("bot token"))).toBe(false);
    expect(await isEncryptedFile(path)).toBe(true);
    expect((await decrypt(path)).equals(data)).toBe(true);
  });

  it("round-trips an empty payload and one exactly one chunk long", async () => {
    const dir = scratch();
    await encryptTo(join(dir, "empty.enc"), Buffer.alloc(0));
    expect((await decrypt(join(dir, "empty.enc"))).length).toBe(0);
    const exact = randomBytes(1024);
    await encryptTo(join(dir, "exact.enc"), exact);
    expect((await decrypt(join(dir, "exact.enc"))).equals(exact)).toBe(true);
  });

  it("round-trips a large multi-chunk payload", async () => {
    const path = join(scratch(), "large.enc");
    const data = randomBytes(300 * 1024 + 123); // ~300 chunks of 1 KiB
    await encryptTo(path, data);
    expect((await decrypt(path)).equals(data)).toBe(true);
    await verifyDecryptable(path, PASS);
  });

  it("uses a fresh salt and IV every time", async () => {
    const dir = scratch();
    const data = Buffer.from("same plaintext");
    await encryptTo(join(dir, "a.enc"), data);
    await encryptTo(join(dir, "b.enc"), data);
    expect(
      readFileSync(join(dir, "a.enc")).equals(readFileSync(join(dir, "b.enc"))),
    ).toBe(false);
  });

  it("does not mistake a plain archive for an encrypted one", async () => {
    const path = join(scratch(), "plain.tar.zst");
    writeFileSync(path, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]));
    expect(await isEncryptedFile(path)).toBe(false);
    await expect(openDecrypted(path, PASS)).rejects.toThrow(/bad header/);
  });
});

describe("failures", () => {
  async function sample(): Promise<{ path: string; bytes: Buffer }> {
    const path = join(scratch(), "part.enc");
    await encryptTo(path, randomBytes(5000));
    return { path, bytes: readFileSync(path) };
  }

  it("refuses a wrong passphrase", async () => {
    const { path } = await sample();
    await expect(decrypt(path, "not the passphrase")).rejects.toThrow(
      /wrong passphrase/,
    );
    expect(await passphraseOpens(path, "not the passphrase")).toBe(false);
    expect(await passphraseOpens(path, PASS)).toBe(true);
  });

  it("detects a flipped ciphertext byte in any record", async () => {
    const { path, bytes } = await sample();
    const tampered = Buffer.from(bytes);
    tampered[bytes.length - 40] ^= 0x01; // inside the last record
    writeFileSync(path, tampered);
    await expect(verifyDecryptable(path, PASS)).rejects.toThrow(
      /authentication failed/,
    );
  });

  it("detects a modified header (the salt, the IV, the chunk size)", async () => {
    for (const offset of [HEADER_BYTES - 1, HEADER_BYTES - 20, 16]) {
      const { path, bytes } = await sample();
      const tampered = Buffer.from(bytes);
      tampered[offset] ^= 0x01;
      writeFileSync(path, tampered);
      await expect(verifyDecryptable(path, PASS)).rejects.toThrow(
        /Encrypted backup/,
      );
    }
  });

  it("detects truncation at a record boundary and trailing bytes", async () => {
    const { path, bytes } = await sample();
    // Drop the final record entirely: 5000 bytes = 4 full + 1 final record.
    const finalRecord = 5 + (5000 - 4 * 1024) + 16;
    writeFileSync(path, bytes.subarray(0, bytes.length - finalRecord));
    await expect(verifyDecryptable(path, PASS)).rejects.toThrow(/truncated/);

    writeFileSync(path, Buffer.concat([bytes, Buffer.from("extra!")]));
    await expect(verifyDecryptable(path, PASS)).rejects.toThrow(/final record/);
  });

  it("detects swapped records", async () => {
    const { path, bytes } = await sample();
    const record = 5 + 1024 + 16;
    const first = bytes.subarray(HEADER_BYTES, HEADER_BYTES + record);
    const second = bytes.subarray(
      HEADER_BYTES + record,
      HEADER_BYTES + 2 * record,
    );
    writeFileSync(
      path,
      Buffer.concat([
        bytes.subarray(0, HEADER_BYTES),
        second,
        first,
        bytes.subarray(HEADER_BYTES + 2 * record),
      ]),
    );
    await expect(verifyDecryptable(path, PASS)).rejects.toThrow(
      /authentication failed/,
    );
  });
});
