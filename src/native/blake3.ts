/**
 * BLAKE3 content hashing — TypeScript boundary over two Rust builds of
 * the same crate, fastest available first:
 *
 *   1. blake3-napi (native/blake3-napi): an in-process napi-rs addon
 *      (`bin/talon-blake3.node`). Native SIMD + rayon, hashes JS
 *      buffers in place, and memory-maps files on the libuv thread
 *      pool — a 50 MB video hashes in ~10 ms without touching the
 *      event loop. Per-arch artifact, present on binary-channel and
 *      source installs; `TALON_BLAKE3_NODE` overrides the location,
 *      `TALON_NO_BLAKE3_NATIVE=1` disables it.
 *   2. blake3-wasm (native/blake3-wasm): the embedded wasm module that
 *      ships inside the npm package and bun single binaries. Portable
 *      scalar kernel, staged through linear memory — the fallback that
 *      keeps every install working with zero native artifacts.
 *
 * The addon is verified against a known digest at load time; any
 * load/verify failure silently selects wasm. The wasm path keeps its
 * raw C ABI — alloc / dealloc / blake3_hash for one-shot hashing plus
 * hasher_new / hasher_update / hasher_finalize / hasher_free for
 * streaming — no wasm-bindgen, no JS glue. See each crate's README for
 * its contract, and src/native/runtime.ts for the embedding and memory
 * conventions shared by every wasm module.
 *
 * Memory discipline (wasm path): every call allocates its own regions
 * (and, for files, its own hasher handle), and releases them before
 * returning — on the error path too. One-shot hashes have no awaits
 * between alloc and dealloc; streaming hashes await file reads but
 * their state is per-handle, so concurrent callers stay independent
 * and nothing leaks across calls (verified by the repeated-call and
 * interleaving tests in src/__tests__/blake3-wasm.test.ts).
 */

import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { logDebug, logWarn } from "../util/log.js";
import { BLAKE3_WASM_BASE64 } from "./blake3-wasm-bytes.js";
import {
  allocRegion,
  embeddedWasm,
  toBytes,
  writeRegion,
  type WasmCoreExports,
} from "./runtime.js";

/** BLAKE3 digest length in bytes (fixed by the wasm ABI). */
const HASH_LEN = 32;

/** blake3("") — the load-time self-verify vector for the native addon. */
const EMPTY_DIGEST =
  "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";

/**
 * Streaming chunk size for the wasm file path. One scratch region of
 * this size is allocated per call, so peak wasm memory is bounded by
 * the chunk size — not the file size — no matter how large the file.
 */
const FILE_CHUNK_BYTES = 1024 * 1024;

// ── Native addon (blake3-napi) ───────────────────────────────────────────────

/** The N-API surface exported by native/blake3-napi. */
export interface NativeBlake3 {
  version(): string;
  hashHex(data: Buffer): string;
  hashFileHex(path: string): Promise<string>;
}

let nativeAddon: NativeBlake3 | null | undefined;

/**
 * Resolve and verify the native addon, or null when hashing must use
 * the wasm path. Memoized — the addon stays loaded for the process
 * lifetime, like any require()d native module.
 */
export function nativeBlake3(): NativeBlake3 | null {
  if (nativeAddon === undefined) nativeAddon = loadNativeBlake3();
  return nativeAddon;
}

function loadNativeBlake3(): NativeBlake3 | null {
  if (process.env.TALON_NO_BLAKE3_NATIVE === "1") return null;

  let candidate = process.env.TALON_BLAKE3_NODE;
  if (!candidate) {
    try {
      // Beside bin/talon.js — where build:napi and packaging put it.
      // Throws under bun single-binary builds (no real fs URL): those
      // ship through channels that set TALON_BLAKE3_NODE, or fall back.
      candidate = fileURLToPath(
        new URL("../../bin/talon-blake3.node", import.meta.url),
      );
    } catch {
      return null;
    }
  }
  try {
    const requireAddon = createRequire(import.meta.url);
    const addon = requireAddon(candidate) as NativeBlake3;
    // Trust nothing that can't produce a known digest — a truncated or
    // wrong-arch artifact fails here and wasm silently takes over.
    if (addon.hashHex(Buffer.alloc(0)) !== EMPTY_DIGEST) {
      reportAddonRejected(candidate, "digest mismatch");
      return null;
    }
    return addon;
  } catch (err) {
    reportAddonRejected(candidate, err);
    return null;
  }
}

/**
 * Wasm takes over either way; the log says why. An absent default
 * artifact is the normal npm install; an explicit TALON_BLAKE3_NODE
 * that fails to load is operator config silently not taking effect.
 */
function reportAddonRejected(candidate: string, reason: unknown): void {
  const code = (reason as { code?: unknown } | null)?.code;
  const why = reason instanceof Error ? reason.message : String(reason);
  if (process.env.TALON_BLAKE3_NODE) {
    logWarn(
      "native",
      `TALON_BLAKE3_NODE addon rejected, using wasm path=${candidate}: ${why}`,
    );
  } else if (code !== "MODULE_NOT_FOUND") {
    logDebug(
      "native",
      `blake3 addon rejected, using wasm path=${candidate}: ${why}`,
    );
  }
}

/** Tests swap addons via TALON_BLAKE3_NODE and need the memo dropped. */
export function _resetNativeBlake3ForTesting(): void {
  nativeAddon = undefined;
}

// ── Public surface (native first, wasm fallback) ─────────────────────────────

/**
 * Hash bytes (or the UTF-8 encoding of a string) with BLAKE3.
 * Returns the 64-char lowercase hex digest.
 */
export async function blake3Hex(data: Uint8Array | string): Promise<string> {
  const input = toBytes(data);
  const native = nativeBlake3();
  if (native) {
    // Buffer view over the same bytes — the addon hashes in place.
    return native.hashHex(
      Buffer.from(input.buffer, input.byteOffset, input.byteLength),
    );
  }
  return blake3HexWasm(input);
}

/**
 * Hash a file's contents with BLAKE3. Native path: memory-mapped,
 * multi-threaded, off the event loop. Wasm path: streamed through the
 * incremental ABI in FILE_CHUNK_BYTES bites.
 */
export async function blake3HexFile(path: string): Promise<string> {
  const native = nativeBlake3();
  if (native) return native.hashFileHex(path);
  return blake3HexFileWasm(path);
}

// ── Wasm implementation ──────────────────────────────────────────────────────

/** The C-ABI surface exported by native/blake3-wasm. */
interface Blake3Exports extends WasmCoreExports {
  blake3_hash(inputPtr: number, len: number, outPtr: number): void;
  /** Returns an opaque handle (0 on exhaustion); consume with finalize/free. */
  hasher_new(): number;
  hasher_update(handle: number, inputPtr: number, len: number): void;
  /** Writes the 32-byte digest and consumes the handle. */
  hasher_finalize(handle: number, outPtr: number): void;
  /** Consumes the handle without a digest (error cleanup). */
  hasher_free(handle: number): void;
}

const blake3Wasm = embeddedWasm<Blake3Exports>(BLAKE3_WASM_BASE64);

/**
 * One-shot hash through the embedded wasm module. Exported (rather
 * than folded into blake3Hex) so the native registry's self-test keeps
 * proving the EMBEDDED bytes work — routing the self-test through the
 * addon would mask a corrupted wasm artifact on machines that have the
 * native addon installed.
 */
export async function blake3HexWasm(
  data: Uint8Array | string,
): Promise<string> {
  const input = toBytes(data);
  const wasm = await blake3Wasm.load();

  // Allocate both regions BEFORE taking any memory views (runtime.ts
  // convention: alloc may grow linear memory and detach views).
  const inputPtr = allocRegion(wasm, input.length, "blake3Hex");
  let outPtr = 0;
  try {
    outPtr = allocRegion(wasm, HASH_LEN, "blake3Hex digest");
    writeRegion(wasm, inputPtr, input);
    wasm.blake3_hash(inputPtr, input.length, outPtr);
    // Copy the digest out of linear memory before dealloc reclaims it.
    return Buffer.from(wasm.memory.buffer, outPtr, HASH_LEN).toString("hex");
  } finally {
    wasm.dealloc(inputPtr, input.length);
    wasm.dealloc(outPtr, HASH_LEN);
  }
}

/**
 * Hash a file's contents through the incremental wasm ABI (hasher_new /
 * hasher_update / hasher_finalize). Peak memory is one FILE_CHUNK_BYTES
 * scratch region regardless of file size.
 *
 * Interleaving safety: file reads await between updates, but each call
 * owns its hasher handle and its scratch region, so concurrent hashes
 * cannot corrupt each other. The scratch view into linear memory is
 * re-created per chunk because another caller's alloc may grow memory
 * and detach existing views; hasher_update itself never allocates.
 */
export async function blake3HexFileWasm(path: string): Promise<string> {
  const wasm = await blake3Wasm.load();
  const handle = wasm.hasher_new();
  if (handle === 0) {
    throw new Error("blake3HexFile: wasm hasher allocation failed");
  }
  let finalized = false;
  let scratch = 0;
  try {
    scratch = allocRegion(wasm, FILE_CHUNK_BYTES, "blake3HexFile scratch");
    const stream = createReadStream(path, {
      highWaterMark: FILE_CHUNK_BYTES,
    });
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      // Chunks arrive ≤ highWaterMark, but slice defensively so a
      // larger-than-expected buffer can never overrun the scratch region.
      for (let off = 0; off < bytes.length; off += FILE_CHUNK_BYTES) {
        const slice = bytes.subarray(off, off + FILE_CHUNK_BYTES);
        new Uint8Array(wasm.memory.buffer, scratch, slice.length).set(slice);
        wasm.hasher_update(handle, scratch, slice.length);
      }
    }
    const outPtr = allocRegion(wasm, HASH_LEN, "blake3HexFile digest");
    try {
      wasm.hasher_finalize(handle, outPtr);
      finalized = true;
      return Buffer.from(wasm.memory.buffer, outPtr, HASH_LEN).toString("hex");
    } finally {
      wasm.dealloc(outPtr, HASH_LEN);
    }
  } finally {
    wasm.dealloc(scratch, FILE_CHUNK_BYTES);
    if (!finalized) wasm.hasher_free(handle);
  }
}
