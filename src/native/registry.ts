/**
 * Native module registry — the declarative manifest of Talon's
 * polyglot native plane.
 *
 * Every embedded module registers here once: provenance (language,
 * target, source dir), artifact size, and a live self-test that proves
 * the embedded bytes instantiate and compute a known answer. Doctor
 * (src/core/doctor/index.ts) iterates this list, so a new native module
 * shows up in `talon doctor` AND the Telegram /doctor command by
 * adding one entry — no per-surface wiring.
 *
 * Everything is lazy: specs hold thunks, not imports, so loading the
 * registry costs nothing until a self-test runs.
 */

import { base64ByteLength } from "./runtime.js";

export interface NativeModuleSpec {
  name: string;
  /** Source language ("Rust", "Zig", "C", "C++", "Gleam"). */
  language: string;
  /** Compile target ("wasm32-unknown-unknown", "wasm32-freestanding", "JavaScript"). */
  target: string;
  /** Where the source lives, relative to the repo root. */
  sourceDir: string;
  /** Embedded artifact size, when the module ships as wasm bytes. */
  sizeBytes?: () => Promise<number>;
  /** Throws (with a reason) unless the module computes a known answer. */
  selfTest: () => Promise<void>;
}

function expect(condition: boolean, note: string): void {
  if (!condition) throw new Error(note);
}

const BLAKE3_EMPTY_DIGEST =
  "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";

export const NATIVE_MODULES: readonly NativeModuleSpec[] = [
  {
    name: "blake3",
    language: "Rust",
    target: "wasm32-unknown-unknown",
    sourceDir: "native/blake3-wasm",
    sizeBytes: async () =>
      base64ByteLength(
        (await import("./blake3-wasm-bytes.js")).BLAKE3_WASM_BASE64,
      ),
    selfTest: async () => {
      // Pinned to the wasm export: this entry vouches for the EMBEDDED
      // bytes. blake3Hex() would route through the napi addon when
      // bin/talon-blake3.node is installed and mask wasm corruption.
      const { blake3HexWasm } = await import("./blake3.js");
      const digest = await blake3HexWasm("");
      expect(digest === BLAKE3_EMPTY_DIGEST, "self-test digest mismatch");
    },
  },
  {
    name: "textops",
    language: "Zig",
    target: "wasm32-freestanding",
    sourceDir: "native/textops-wasm",
    sizeBytes: async () =>
      base64ByteLength(
        (await import("./textops-wasm-bytes.js")).TEXTOPS_WASM_BASE64,
      ),
    selfTest: async () => {
      const { splitMessage } = await import("./textops.js");
      const chunks = splitMessage("doctor check ".repeat(4), 16);
      expect(
        chunks.length > 1 && chunks.every((c) => c.length <= 16),
        "self-test split out of bounds",
      );
    },
  },
  {
    name: "strsim",
    language: "Rust",
    target: "wasm32-unknown-unknown",
    sourceDir: "native/strsim-wasm",
    sizeBytes: async () =>
      base64ByteLength(
        (await import("./strsim-wasm-bytes.js")).STRSIM_WASM_BASE64,
      ),
    selfTest: async () => {
      const { levenshtein } = await import("./strsim.js");
      const distance = levenshtein("kitten", "sitting");
      expect(distance === 3, `self-test distance ${distance}, expected 3`);
    },
  },
  {
    name: "sqlguard",
    language: "Rust",
    target: "wasm32-unknown-unknown",
    sourceDir: "native/sqlguard-wasm",
    sizeBytes: async () =>
      base64ByteLength(
        (await import("./sqlguard-wasm-bytes.js")).SQLGUARD_WASM_BASE64,
      ),
    selfTest: async () => {
      const { escapeLike, ftsQuote } = await import("./sqlguard.js");
      const escaped = escapeLike("100%_data");
      expect(escaped === "100\\%\\_data", "escape_like self-test mismatch");
      const quoted = ftsQuote("hello world");
      expect(quoted === '"hello" "world"', "fts_quote self-test mismatch");
    },
  },
  {
    name: "htmlents",
    language: "Rust",
    target: "wasm32-unknown-unknown",
    sourceDir: "native/htmlents-wasm",
    sizeBytes: async () =>
      base64ByteLength(
        (await import("./htmlents-wasm-bytes.js")).HTMLENTS_WASM_BASE64,
      ),
    selfTest: async () => {
      const { escapeHtml } = await import("./htmlents.js");
      const escaped = escapeHtml(`<&>"'`);
      expect(
        escaped === "&lt;&amp;&gt;&quot;&#39;",
        "self-test escape mismatch",
      );
    },
  },
  {
    name: "scheduler-core",
    language: "Gleam",
    target: "JavaScript",
    sourceDir: "native/scheduler-core",
    // Compiles to plain JS — there is no embedded wasm artifact.
    selfTest: async () => {
      const { backoffDelayMs } = await import("./scheduler-core.js");
      const delayMs = backoffDelayMs(1, { baseMs: 1000, capMs: 2000, seed: 1 });
      // Attempt 1 at base 1000ms with ±25% jitter must land in [750, 1250].
      expect(
        delayMs >= 750 && delayMs <= 1250,
        `self-test delay ${delayMs}ms outside jitter window`,
      );
    },
  },
];
