/**
 * Codex auth-detection unit tests.
 *
 * Covers `detectCodexAuth` (priority order, file-parse edge cases),
 * `isChatGptModelMismatchError` (substring matching tolerance), and
 * the catalog helpers `isCodexApiKeyOnlyModel` / `chatGptFallbackFor`.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { CODEX_CHATGPT_DEFAULT_MODEL } from "../backend/codex/constants.js";
import {
  detectCodexAuth,
  resolveCodexApiKey,
  isChatGptModelMismatchError,
  isCodexModelNotFoundError,
  isCodexRefreshTokenError,
  isSilentOAuthExitError,
  codexLoginExpiredError,
} from "../backend/codex/auth.js";
import {
  isCodexApiKeyOnlyModel,
  chatGptFallbackFor,
} from "../backend/codex/models.js";

/**
 * Build a frozen env map that overrides HOME so the file-check path
 * resolves to a test-controlled directory.
 */
function envWith(
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  // Don't inherit the host's OPENAI_API_KEY etc — start from a clean
  // slate so test outcomes don't depend on the caller's shell.
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base;
}

function makeFakeHome(authJson: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "talon-codex-auth-"));
  if (authJson !== null) {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "auth.json"), authJson);
  }
  return dir;
}

describe("codex / detectCodexAuth — priority order", () => {
  it("CODEX_API_KEY wins over every other explicit key", () => {
    const fakeHome = makeFakeHome(`{"auth_mode":"chatgpt"}`);
    try {
      const info = detectCodexAuth({
        codexApiKey: "config-codex-key",
        openaiApiKey: "config-openai-key",
        openaiBaseUrl: "https://proxy.example/v1",
        env: envWith({
          CODEX_API_KEY: "env-upstream-codex-key",
          TALON_CODEX_KEY: "env-codex-key",
          OPENAI_API_KEY: "env-openai-key",
          HOME: fakeHome,
        }),
      });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("env:CODEX_API_KEY");
      expect(info.apiKey).toBe("env-upstream-codex-key");
      expect(info.baseUrl).toBe("https://proxy.example/v1");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("TALON_CODEX_KEY wins over config keys and OPENAI_API_KEY", () => {
    const fakeHome = makeFakeHome(`{"auth_mode":"chatgpt"}`);
    try {
      const info = detectCodexAuth({
        codexApiKey: "config-codex-key",
        openaiApiKey: "config-openai-key",
        env: envWith({
          TALON_CODEX_KEY: "env-codex-key",
          OPENAI_API_KEY: "env-openai-key",
          HOME: fakeHome,
        }),
      });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("env:TALON_CODEX_KEY");
      expect(info.apiKey).toBe("env-codex-key");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("config codexApiKey wins over OPENAI_API_KEY and the auth file", () => {
    const fakeHome = makeFakeHome(`{"auth_mode":"chatgpt"}`);
    try {
      const info = detectCodexAuth({
        codexApiKey: "from-codex-config",
        openaiApiKey: "from-openai-config",
        env: envWith({ OPENAI_API_KEY: "env-openai-key", HOME: fakeHome }),
      });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("config:codexApiKey");
      expect(info.apiKey).toBe("from-codex-config");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("ChatGPT OAuth wins over generic OPENAI_API_KEY and openaiApiKey", () => {
    const fakeHome = makeFakeHome(`{"auth_mode":"chatgpt"}`);
    try {
      const info = detectCodexAuth({
        openaiApiKey: "from-openai-config",
        env: envWith({ OPENAI_API_KEY: "env-openai-key", HOME: fakeHome }),
      });
      expect(info.mode).toBe("chatgpt");
      expect(info.source).toBe("file:~/.codex/auth.json");
      expect(info.apiKey).toBeUndefined();
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("uses OPENAI_API_KEY when no Codex auth file exists", () => {
    const fakeHome = makeFakeHome(null);
    try {
      const info = detectCodexAuth({
        openaiApiKey: "from-openai-config",
        env: envWith({ OPENAI_API_KEY: "env-openai-key", HOME: fakeHome }),
      });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("env:OPENAI_API_KEY");
      expect(info.apiKey).toBe("env-openai-key");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("uses legacy config openaiApiKey only when no Codex auth file exists", () => {
    const fakeHome = makeFakeHome(`{"auth_mode":"chatgpt"}`);
    try {
      const info = detectCodexAuth({
        openaiApiKey: "from-openai-config",
        openaiBaseUrl: "https://api.openai.com/v1",
        env: envWith({ HOME: fakeHome }),
      });
      expect(info.mode).toBe("chatgpt");
      expect(info.source).toBe("file:~/.codex/auth.json");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("pairs legacy config openaiApiKey with base URL when used as fallback", () => {
    const fakeHome = makeFakeHome(null);
    try {
      const info = detectCodexAuth({
        openaiApiKey: "openrouter-key",
        openaiBaseUrl: "https://openrouter.ai/api/v1",
        env: envWith({ HOME: fakeHome }),
      });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("config:openaiApiKey");
      expect(info.apiKey).toBe("openrouter-key");
      expect(info.baseUrl).toBe("https://openrouter.ai/api/v1");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("falls back to ~/.codex/auth.json chatgpt mode", () => {
    const fakeHome = makeFakeHome(
      `{"auth_mode":"chatgpt","OPENAI_API_KEY":null}`,
    );
    try {
      const info = detectCodexAuth({ env: envWith({ HOME: fakeHome }) });
      expect(info.mode).toBe("chatgpt");
      expect(info.source).toBe("file:~/.codex/auth.json");
      expect(info.authFilePath).toBe(join(fakeHome, ".codex", "auth.json"));
      expect(info.authFileParsed).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("auth.json with non-null OPENAI_API_KEY → api-key mode", () => {
    // The codex CLI ships auth.json with `OPENAI_API_KEY` as a
    // top-level field; when non-null it takes precedence over
    // `auth_mode`. This mirrors what the CLI does internally.
    const fakeHome = makeFakeHome(
      `{"auth_mode":"chatgpt","OPENAI_API_KEY":"sk-from-file"}`,
    );
    try {
      const info = detectCodexAuth({ env: envWith({ HOME: fakeHome }) });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("file:~/.codex/auth.json");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns `none` when no auth source is available", () => {
    const fakeHome = makeFakeHome(null);
    try {
      const info = detectCodexAuth({ env: envWith({ HOME: fakeHome }) });
      expect(info.mode).toBe("none");
      expect(info.source).toBe("missing");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns `none` when auth.json exists but doesn't carry a recognised mode", () => {
    const fakeHome = makeFakeHome(`{"some_other_field":"value"}`);
    try {
      const info = detectCodexAuth({ env: envWith({ HOME: fakeHome }) });
      expect(info.mode).toBe("none");
      expect(info.authFileParsed).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("surfaces a parse error when auth.json is malformed JSON", () => {
    const fakeHome = makeFakeHome(`{not valid json`);
    try {
      const info = detectCodexAuth({ env: envWith({ HOME: fakeHome }) });
      expect(info.mode).toBe("none");
      expect(info.authFileParsed).toBe(false);
      expect(info.parseError).toBeTruthy();
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns `none` when HOME is unset and no other auth is configured", () => {
    const info = detectCodexAuth({ env: envWith({}) });
    expect(info.mode).toBe("none");
    expect(info.authFilePath).toBeUndefined();
  });
});

describe("codex / resolveCodexApiKey", () => {
  it("does not treat shared openaiApiKey config as Codex-specific auth", () => {
    const resolved = resolveCodexApiKey({
      openaiApiKey: "openrouter-key",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      env: envWith({}),
    });
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.baseUrl).toBeUndefined();
    expect(resolved.source).toBeUndefined();
    expect(resolved.diagnostics).toEqual([]);
  });

  it("accepts explicit Codex key regardless of OpenAI Agents base URL", () => {
    const resolved = resolveCodexApiKey({
      codexApiKey: "codex-key",
      openaiApiKey: "openrouter-key",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      env: envWith({}),
    });
    expect(resolved.apiKey).toBe("codex-key");
    expect(resolved.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(resolved.source).toBe("config:codexApiKey");
    expect(resolved.diagnostics).toEqual([]);
  });
});

describe("codex / isCodexModelNotFoundError", () => {
  const retired =
    "unexpected status 404 Not Found: The model `gpt-5.5` does not exist " +
    "or you do not have access to it.";

  it("matches the 404 a retired model returns", () => {
    expect(isCodexModelNotFoundError(retired)).toBe(true);
  });

  it("is folded into isChatGptModelMismatchError", () => {
    expect(isChatGptModelMismatchError(retired)).toBe(true);
  });

  it("does not match an unrelated 404", () => {
    expect(
      isCodexModelNotFoundError("unexpected status 404 Not Found: /v1/foo"),
    ).toBe(false);
    expect(
      isChatGptModelMismatchError("404 resource does not exist on the server"),
    ).toBe(false);
  });

  it("requires the 404 status", () => {
    expect(
      isCodexModelNotFoundError("The model `x` does not exist in my notes"),
    ).toBe(false);
  });
});

describe("codex / isChatGptModelMismatchError", () => {
  it("matches the canonical OpenAI 400 message", () => {
    expect(
      isChatGptModelMismatchError(
        "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
      ),
    ).toBe(true);
  });

  it("matches a JSON-wrapped payload", () => {
    const payload = JSON.stringify({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message:
          "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
      },
    });
    expect(isChatGptModelMismatchError(payload)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isChatGptModelMismatchError(
        "NOT SUPPORTED WHEN USING CODEX WITH A CHATGPT ACCOUNT",
      ),
    ).toBe(true);
  });

  it("tolerates extra whitespace", () => {
    expect(
      isChatGptModelMismatchError(
        "not\tsupported  when    using\ncodex   with a chatgpt account",
      ),
    ).toBe(true);
  });

  it("does not match an unrelated 400 error", () => {
    expect(
      isChatGptModelMismatchError(
        "context_length_exceeded: too many tokens in the prompt",
      ),
    ).toBe(false);
  });

  it("does not match a network error", () => {
    expect(isChatGptModelMismatchError("fetch failed — ECONNRESET")).toBe(
      false,
    );
  });
});

/**
 * Verbatim SDK error from the daemon log (2026-08-24): the CLI banner
 * followed by the stderr dump of the refresh failure.
 */
const REFRESH_FAILURE =
  "Codex Exec exited with code 1: Reading prompt from stdin...\n" +
  "2026-08-24T15:54:53.665546Z ERROR codex_login::auth::manager: " +
  "Failed to refresh token: 401 Unauthorized: {\n" +
  '  "error": {\n' +
  '    "message": "Your session has ended. Please log in again.",\n' +
  '    "type": "invalid_request_error",\n' +
  '    "param": null,\n' +
  '    "code": "refresh_token_invalidated"\n' +
  "  }\n}\n";

const SILENT_EXIT =
  "Codex Exec exited with code 1: Reading prompt from stdin...\n";

describe("codex / isCodexRefreshTokenError", () => {
  it("matches the CLI's refresh failure dump", () => {
    expect(isCodexRefreshTokenError(REFRESH_FAILURE)).toBe(true);
  });

  it("matches either signal on its own", () => {
    expect(isCodexRefreshTokenError("Failed to refresh token: 401")).toBe(true);
    expect(
      isCodexRefreshTokenError('"code": "refresh_token_invalidated"'),
    ).toBe(true);
  });

  it("ignores the bare silent exit and unrelated errors", () => {
    expect(isCodexRefreshTokenError(SILENT_EXIT)).toBe(false);
    expect(isCodexRefreshTokenError("fetch failed — ECONNRESET")).toBe(false);
    expect(isCodexRefreshTokenError("")).toBe(false);
  });
});

describe("codex / isSilentOAuthExitError", () => {
  it("still matches the bare banner exit", () => {
    expect(isSilentOAuthExitError(SILENT_EXIT)).toBe(true);
  });

  it("does not treat an expired login as a silent OAuth-incompat exit", () => {
    expect(isSilentOAuthExitError(REFRESH_FAILURE)).toBe(false);
  });

  it("defers the explicit mismatch to the other detector", () => {
    expect(
      isSilentOAuthExitError(
        SILENT_EXIT +
          "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
      ),
    ).toBe(false);
  });
});

describe("codex / codexLoginExpiredError", () => {
  it("is a non-retryable auth error that names the fix", () => {
    const cause = new Error(REFRESH_FAILURE);
    const err = codexLoginExpiredError(cause);
    expect(err.reason).toBe("auth");
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(401);
    expect(err.message).toContain("codex login");
    expect(err.cause).toBe(cause);
  });
});

describe("codex / api-key-only catalog helpers", () => {
  it("isCodexApiKeyOnlyModel returns true for gpt-5-codex", () => {
    expect(isCodexApiKeyOnlyModel("gpt-5-codex")).toBe(true);
  });

  it("returns false for chatgpt-compatible models", () => {
    expect(isCodexApiKeyOnlyModel("gpt-5.5")).toBe(false);
    expect(isCodexApiKeyOnlyModel("gpt-5")).toBe(false);
    expect(isCodexApiKeyOnlyModel("gpt-5-mini")).toBe(false);
  });

  it("returns false for unknown models (no over-correction)", () => {
    expect(isCodexApiKeyOnlyModel("totally-made-up-model")).toBe(false);
    expect(isCodexApiKeyOnlyModel("")).toBe(false);
  });

  it("chatGptFallbackFor returns the ChatGPT default for gpt-5-codex", () => {
    expect(chatGptFallbackFor("gpt-5-codex")).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
  });

  it("chatGptFallbackFor returns undefined for non-api-key-only models", () => {
    expect(chatGptFallbackFor("gpt-5.5")).toBeUndefined();
    expect(chatGptFallbackFor("gpt-5")).toBeUndefined();
    expect(chatGptFallbackFor("unknown-model")).toBeUndefined();
  });
});
