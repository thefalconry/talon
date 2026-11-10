/**
 * Codex OAuth-incompat runtime learning store tests.
 *
 * Covers `oauth-incompat.ts` (kv persistence round-trip, fingerprint
 * matching, malformed-payload tolerance, one-shot legacy-file import),
 * `models.isCodexOAuthIncompat` (combined curated + dynamic check),
 * `models.chatGptFallbackFor` (broadened fallback selection), and
 * `auth.isSilentOAuthExitError` (the 2026-05-20 silent-exit regression
 * pattern).
 *
 * The store now rides the shared kv table (test-isolated per worker via
 * TALON_DB_PATH), so scenarios isolate by deleting the kv key in
 * `beforeEach` rather than overriding HOME. The one legacy-import test
 * redirects `files.codexOauthIncompat` into a tmp dir (paths mock) and
 * unsets TALON_DISABLE_LEGACY_IMPORT so the import actually runs.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// Redirect only the legacy-import source path into a per-test tmp dir;
// everything else in `paths` stays real. The getter reads `legacyDir`
// lazily so each test's fresh mkdtemp is picked up.
let legacyDir: string;
vi.mock("../util/paths.js", async () => {
  const real =
    await vi.importActual<typeof import("../util/paths.js")>(
      "../util/paths.js",
    );
  return {
    ...real,
    files: new Proxy(real.files, {
      get(target, prop: string) {
        if (prop === "codexOauthIncompat") {
          return join(legacyDir, "codex-oauth-incompat.json");
        }
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import {
  computeAuthFingerprint,
  isKnownOAuthIncompat,
  loadOAuthIncompatStore,
  markOAuthIncompat,
  listKnownOAuthIncompat,
  resetOAuthIncompatForTests,
} from "../backend/codex/oauth-incompat.js";
import {
  isCodexApiKeyOnlyModel,
  isCodexOAuthIncompat,
  chatGptFallbackFor,
} from "../backend/codex/models.js";
import { CODEX_CHATGPT_DEFAULT_MODEL } from "../backend/codex/constants.js";
import {
  isSilentOAuthExitError,
  isChatGptModelMismatchError,
  type CodexAuthInfo,
} from "../backend/codex/auth.js";
import { kvDelete } from "../storage/kv.js";

const STORE_KEY = "codex.oauth-incompat";

/** Absolute path of the redirected legacy JSON file for the current test. */
function legacyFilePath(): string {
  return join(legacyDir, "codex-oauth-incompat.json");
}

/**
 * Run `fn` with the legacy-JSON import un-gated (the vitest setup pins
 * TALON_DISABLE_LEGACY_IMPORT=1 for every other suite). Restores the
 * prior value so sibling suites in the same worker stay gated.
 */
async function withLegacyImportEnabled(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.TALON_DISABLE_LEGACY_IMPORT;
  delete process.env.TALON_DISABLE_LEGACY_IMPORT;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.TALON_DISABLE_LEGACY_IMPORT;
    else process.env.TALON_DISABLE_LEGACY_IMPORT = prev;
  }
}

beforeEach(() => {
  legacyDir = mkdtempSync(join(tmpdir(), "talon-codex-incompat-"));
  kvDelete(STORE_KEY);
  resetOAuthIncompatForTests();
});

afterEach(() => {
  try {
    rmSync(legacyDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  kvDelete(STORE_KEY);
  resetOAuthIncompatForTests();
});

// ── Fingerprint computation ────────────────────────────────────────────────

describe("computeAuthFingerprint", () => {
  it("chatgpt mode uses mode + source only (no token to hash)", () => {
    const info: CodexAuthInfo = {
      mode: "chatgpt",
      source: "file:~/.codex/auth.json",
      authFileParsed: true,
      diagnostics: [],
    };
    expect(computeAuthFingerprint(info)).toBe(
      "chatgpt:file:~/.codex/auth.json",
    );
  });

  it("api-key mode differentiates keys", () => {
    const a: CodexAuthInfo = {
      mode: "api-key",
      source: "env:CODEX_API_KEY",
      apiKey: "sk-key-A-0123456789abcdef-rest-of-secret-here",
      authFileParsed: false,
      diagnostics: [],
    };
    const b: CodexAuthInfo = {
      mode: "api-key",
      source: "env:CODEX_API_KEY",
      apiKey: "sk-key-B-0123456789abcdef-rest-of-secret-here",
      authFileParsed: false,
      diagnostics: [],
    };
    expect(computeAuthFingerprint(a)).not.toBe(computeAuthFingerprint(b));
    expect(computeAuthFingerprint(a)).toContain("api-key:env:CODEX_API_KEY:");
  });

  it("api-key mode carries no key material, only a digest", () => {
    const info: CodexAuthInfo = {
      mode: "api-key",
      source: "env:CODEX_API_KEY",
      apiKey: "sk-key-A-0123456789abcdef-rest-of-secret-here",
      authFileParsed: false,
      diagnostics: [],
    };
    const fp = computeAuthFingerprint(info);
    expect(fp).toMatch(/^api-key:env:CODEX_API_KEY:[0-9a-f]{16}$/);
    expect(fp).not.toContain("sk-key");
  });

  it("none mode returns a deterministic missing fingerprint", () => {
    const info: CodexAuthInfo = {
      mode: "none",
      source: "missing",
      authFileParsed: false,
      diagnostics: [],
    };
    expect(computeAuthFingerprint(info)).toBe("none:missing");
  });
});

// ── Load + mark round-trip ────────────────────────────────────────────────

describe("oauth-incompat / persistence", () => {
  it("returns empty when nothing is persisted", async () => {
    await loadOAuthIncompatStore("chatgpt:file:~/.codex/auth.json");
    expect(isKnownOAuthIncompat("gpt-5.4-mini")).toBe(false);
    expect(listKnownOAuthIncompat()).toEqual([]);
  });

  it("mark + reload round-trips the set through kv", async () => {
    const fingerprint = "chatgpt:file:~/.codex/auth.json";
    await loadOAuthIncompatStore(fingerprint);

    expect(await markOAuthIncompat("gpt-5.4-mini")).toBe(true);
    expect(await markOAuthIncompat("gpt-5.4")).toBe(true);
    // Second mark of same id is a no-op:
    expect(await markOAuthIncompat("gpt-5.4-mini")).toBe(false);

    expect(isKnownOAuthIncompat("gpt-5.4-mini")).toBe(true);
    expect(isKnownOAuthIncompat("gpt-5.4")).toBe(true);
    expect(isKnownOAuthIncompat("gpt-5.5")).toBe(false);
    expect(listKnownOAuthIncompat()).toEqual(["gpt-5.4", "gpt-5.4-mini"]);

    // Simulate restart: blow away in-memory state and reload from kv.
    resetOAuthIncompatForTests();
    await loadOAuthIncompatStore(fingerprint);
    expect(listKnownOAuthIncompat()).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
  });

  it("fingerprint mismatch discards the loaded set", async () => {
    await loadOAuthIncompatStore("chatgpt:file:~/.codex/auth.json");
    await markOAuthIncompat("gpt-5.4-mini");
    expect(listKnownOAuthIncompat()).toEqual(["gpt-5.4-mini"]);

    // Simulate `codex login` with a different account / mode.
    resetOAuthIncompatForTests();
    await loadOAuthIncompatStore("api-key:env:CODEX_API_KEY:sk-different");
    expect(listKnownOAuthIncompat()).toEqual([]);
  });

  it("markOAuthIncompat is a safe no-op when no store is loaded", async () => {
    resetOAuthIncompatForTests();
    expect(await markOAuthIncompat("gpt-5.4-mini")).toBe(false);
    expect(isKnownOAuthIncompat("gpt-5.4-mini")).toBe(false);
  });

  it("imports the legacy bare document into kv and renames the file", async () => {
    // Pre-SQLite on-disk shape: { version, fingerprint, updatedAt, models }.
    writeFileSync(
      legacyFilePath(),
      JSON.stringify({
        version: 1,
        fingerprint: "chatgpt:test",
        updatedAt: new Date().toISOString(),
        models: ["gpt-5.4-mini", "gpt-5.4"],
      }),
    );

    await withLegacyImportEnabled(async () => {
      await loadOAuthIncompatStore("chatgpt:test");
    });

    expect(listKnownOAuthIncompat()).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
    // The value now lives in kv and the legacy file was renamed so the
    // import never re-runs.
    expect(existsSync(legacyFilePath())).toBe(false);
    expect(existsSync(`${legacyFilePath()}.imported`)).toBe(true);
  });

  it("imports the JsonStore envelope shape into kv", async () => {
    writeFileSync(
      legacyFilePath(),
      JSON.stringify({
        schemaVersion: 1,
        savedAt: Date.now(),
        data: {
          fingerprint: "chatgpt:test",
          updatedAt: new Date().toISOString(),
          models: ["gpt-5.4-mini", "gpt-5.2"],
        },
      }),
    );

    await withLegacyImportEnabled(async () => {
      await loadOAuthIncompatStore("chatgpt:test");
    });

    expect(listKnownOAuthIncompat()).toEqual(["gpt-5.2", "gpt-5.4-mini"]);
    expect(existsSync(`${legacyFilePath()}.imported`)).toBe(true);
  });

  it("filters non-string entries when importing (defensive)", async () => {
    writeFileSync(
      legacyFilePath(),
      JSON.stringify({
        version: 1,
        fingerprint: "chatgpt:test",
        updatedAt: new Date().toISOString(),
        models: ["gpt-5.4-mini", null, 42, "", "gpt-5.2"],
      }),
    );

    await withLegacyImportEnabled(async () => {
      await loadOAuthIncompatStore("chatgpt:test");
    });

    expect(listKnownOAuthIncompat()).toEqual(["gpt-5.2", "gpt-5.4-mini"]);
  });

  it("starts empty on an unknown legacy schema version", async () => {
    writeFileSync(
      legacyFilePath(),
      JSON.stringify({
        version: 999,
        fingerprint: "chatgpt:test",
        updatedAt: new Date().toISOString(),
        models: ["gpt-5.4-mini"],
      }),
    );

    await withLegacyImportEnabled(async () => {
      await loadOAuthIncompatStore("chatgpt:test");
    });

    expect(listKnownOAuthIncompat()).toEqual([]);
  });

  it("tolerates a malformed legacy file gracefully", async () => {
    writeFileSync(legacyFilePath(), "not json at all { } {");

    await withLegacyImportEnabled(async () => {
      await loadOAuthIncompatStore("chatgpt:test");
    });

    expect(listKnownOAuthIncompat()).toEqual([]);
  });
});

// ── Combined predicate: curated ∪ dynamic ────────────────────────────────

describe("isCodexOAuthIncompat — combined curated + dynamic", () => {
  beforeEach(async () => {
    await loadOAuthIncompatStore("chatgpt:test");
  });

  it("returns true for curated apiKeyOnly entries even without learning", () => {
    expect(isCodexApiKeyOnlyModel("gpt-5-codex")).toBe(true);
    expect(isCodexOAuthIncompat("gpt-5-codex")).toBe(true);
  });

  it("returns true for runtime-learned ids even when not curated", async () => {
    expect(isCodexApiKeyOnlyModel("gpt-5.4-mini")).toBe(false);
    expect(isCodexOAuthIncompat("gpt-5.4-mini")).toBe(false);

    await markOAuthIncompat("gpt-5.4-mini");
    expect(isCodexOAuthIncompat("gpt-5.4-mini")).toBe(true);
    // Curated check stays narrow:
    expect(isCodexApiKeyOnlyModel("gpt-5.4-mini")).toBe(false);
  });

  it("returns false for known-good models (gpt-5.5)", async () => {
    expect(isCodexOAuthIncompat("gpt-5.5")).toBe(false);
    await markOAuthIncompat("gpt-5.4-mini"); // unrelated mark
    expect(isCodexOAuthIncompat("gpt-5.5")).toBe(false);
  });
});

// ── chatGptFallbackFor — broadened ────────────────────────────────────────

describe("chatGptFallbackFor — broadened fallback selection", () => {
  beforeEach(async () => {
    await loadOAuthIncompatStore("chatgpt:test");
  });

  it("returns undefined for non-incompat ids (no fallback needed)", () => {
    expect(chatGptFallbackFor("gpt-5.5")).toBeUndefined();
    expect(chatGptFallbackFor("brand-new-future-model")).toBeUndefined();
  });

  // The fallback target is the resolved ChatGPT default
  // (`getCodexChatGptDefaultModel`), not a hardcoded id: `gpt-5.5` was
  // retired for ChatGPT accounts. With no env override, config key or
  // discovered CLI default in play, that resolves to the bundled floor.
  it("returns the ChatGPT default for curated apiKeyOnly ids", () => {
    expect(chatGptFallbackFor("gpt-5-codex")).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
  });

  it("returns the ChatGPT default for runtime-learned incompat ids", async () => {
    await markOAuthIncompat("gpt-5.4-mini");
    expect(chatGptFallbackFor("gpt-5.4-mini")).toBe(
      CODEX_CHATGPT_DEFAULT_MODEL,
    );

    await markOAuthIncompat("gpt-5.5");
    expect(chatGptFallbackFor("gpt-5.5")).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
  });

  it("returns undefined for the ChatGPT default itself even if marked (no further fallback)", async () => {
    // Pathological case — if even the default fails, the credential is
    // the problem and there's no model we can swap to. The handler should
    // surface this as an error rather than loop.
    await markOAuthIncompat(CODEX_CHATGPT_DEFAULT_MODEL);
    expect(chatGptFallbackFor(CODEX_CHATGPT_DEFAULT_MODEL)).toBeUndefined();
  });
});

// ── isSilentOAuthExitError — the 2026-05-20 23:13Z regression ──────────────

describe("isSilentOAuthExitError", () => {
  it("detects the canonical silent exit-1 wrapper from codex-sdk", () => {
    expect(
      isSilentOAuthExitError(
        "Codex Exec exited with code 1: Reading prompt from stdin...\n",
      ),
    ).toBe(true);
  });

  it("matches when the SDK uses exit code 2 (observed variation)", () => {
    expect(
      isSilentOAuthExitError(
        "Codex Exec exited with code 2: Reading prompt from stdin...",
      ),
    ).toBe(true);
  });

  it("is whitespace-tolerant and case-insensitive", () => {
    expect(
      isSilentOAuthExitError(
        "codex   exec  exited  with  code  1: reading PROMPT from stdin...",
      ),
    ).toBe(true);
  });

  it("does NOT match when the explicit mismatch text is present (other detector handles it)", () => {
    expect(
      isSilentOAuthExitError(
        "Codex Exec exited with code 1: not supported when using Codex with a ChatGPT account",
      ),
    ).toBe(false);
  });

  it("does NOT match generic exit-1 errors (false positive guard)", () => {
    expect(
      isSilentOAuthExitError(
        "Codex Exec exited with code 1: connection refused",
      ),
    ).toBe(false);
    expect(
      isSilentOAuthExitError("Codex Exec exited with code 1: ENOENT"),
    ).toBe(false);
  });

  it("does NOT match an empty or undefined message", () => {
    expect(isSilentOAuthExitError("")).toBe(false);
    expect(isSilentOAuthExitError(undefined as unknown as string)).toBe(false);
  });

  it("does NOT match unrelated text containing one keyword", () => {
    expect(isSilentOAuthExitError("Reading prompt from stdin")).toBe(false);
    expect(isSilentOAuthExitError("Codex Exec exited with code 0")).toBe(false);
  });

  it("isChatGptModelMismatchError still matches the explicit form", () => {
    expect(
      isChatGptModelMismatchError(
        "400 Bad Request: not supported when using Codex with a ChatGPT account",
      ),
    ).toBe(true);
  });
});
