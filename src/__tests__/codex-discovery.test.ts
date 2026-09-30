/**
 * Codex model-discovery tests.
 *
 * Two discovery paths:
 *   - **OAuth** — read `~/.codex/models_cache.json` (codex CLI populates
 *     this from ChatGPT's backend API). Mocked via a tmpfile + HOME
 *     override per test.
 *   - **api-key** — fetch OpenAI's `/v1/models`. Mocked via
 *     `vi.spyOn(globalThis, "fetch")`.
 *
 * Both paths share the lifecycle plumbing (`startDiscovery` /
 * `awaitDiscovery` / `refreshDiscovery`), so the lifecycle tests don't
 * need to be duplicated per path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  startDiscovery,
  awaitDiscovery,
  refreshDiscovery,
  fetchOpenAiModels,
  loadCodexCacheModels,
  isCodexCompatibleModel,
  hasDiscoveredCatalog,
  hasAttemptedDiscovery,
  getCodexCachePath,
} from "../backend/codex/discovery.js";
import { getState, resetState } from "../backend/codex/state.js";
import type { CodexAuthInfo } from "../backend/codex/auth.js";

// ── Auth-info builders for tests ──────────────────────────────────────

function apiKeyAuth(apiKey = "sk-test-key", baseUrl?: string): CodexAuthInfo {
  return {
    mode: "api-key",
    source: "env:CODEX_API_KEY",
    apiKey,
    baseUrl,
    authFileParsed: false,
    diagnostics: [],
  };
}

function chatgptAuth(): CodexAuthInfo {
  return {
    mode: "chatgpt",
    source: "file:~/.codex/auth.json",
    authFileParsed: true,
    diagnostics: [],
  };
}

function noneAuth(): CodexAuthInfo {
  return {
    mode: "none",
    source: "missing",
    authFileParsed: false,
    diagnostics: [],
  };
}

// ── Test home directory for the OAuth cache-file path ────────────────
//
// `os.homedir()` consults `$HOME` on POSIX but `%USERPROFILE%` on Windows.
// We override BOTH so the test passes on every CI matrix row regardless
// of which env var the runtime is actually reading.

let tmpHome: string | null = null;

interface OriginalHomeEnv {
  HOME: string | undefined;
  USERPROFILE: string | undefined;
  CODEX_HOME: string | undefined;
}

function withTempHome(): OriginalHomeEnv {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-disc-"));
  const orig: OriginalHomeEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // Bun's os.homedir() ignores both env vars, so the cache path is
  // pinned explicitly — the override discovery.ts honors first.
  process.env.CODEX_HOME = path.join(tmpHome, ".codex");
  return orig;
}

function restoreHome(orig: OriginalHomeEnv): void {
  if (orig.HOME !== undefined) process.env.HOME = orig.HOME;
  else delete process.env.HOME;
  if (orig.USERPROFILE !== undefined)
    process.env.USERPROFILE = orig.USERPROFILE;
  else delete process.env.USERPROFILE;
  if (orig.CODEX_HOME !== undefined) process.env.CODEX_HOME = orig.CODEX_HOME;
  else delete process.env.CODEX_HOME;
  if (tmpHome) {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmpHome = null;
  }
}

function writeCacheFile(content: unknown): void {
  if (!tmpHome) throw new Error("call withTempHome first");
  const dir = path.join(tmpHome, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "models_cache.json"),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── isCodexCompatibleModel — id-filter unit tests ─────────────────────

describe("codex / isCodexCompatibleModel", () => {
  it("keeps gpt-5 family", () => {
    expect(isCodexCompatibleModel("gpt-5")).toBe(true);
    expect(isCodexCompatibleModel("gpt-5-mini")).toBe(true);
    expect(isCodexCompatibleModel("gpt-5.5")).toBe(true);
    expect(isCodexCompatibleModel("gpt-5-codex")).toBe(true);
  });

  it("keeps gpt-4 family", () => {
    expect(isCodexCompatibleModel("gpt-4o")).toBe(true);
    expect(isCodexCompatibleModel("gpt-4.1")).toBe(true);
    expect(isCodexCompatibleModel("gpt-4o-mini")).toBe(true);
  });

  it("keeps o3 and o4 reasoning families", () => {
    expect(isCodexCompatibleModel("o3")).toBe(true);
    expect(isCodexCompatibleModel("o3-pro")).toBe(true);
    expect(isCodexCompatibleModel("o4-mini")).toBe(true);
  });

  it("keeps chatgpt-* aliases", () => {
    expect(isCodexCompatibleModel("chatgpt-4o-latest")).toBe(true);
  });

  it("drops embeddings", () => {
    expect(isCodexCompatibleModel("text-embedding-3-small")).toBe(false);
    expect(isCodexCompatibleModel("text-embedding-ada-002")).toBe(false);
  });

  it("drops image-gen", () => {
    expect(isCodexCompatibleModel("dall-e-3")).toBe(false);
    expect(isCodexCompatibleModel("dall-e-2")).toBe(false);
  });

  it("drops audio / tts / whisper", () => {
    expect(isCodexCompatibleModel("whisper-1")).toBe(false);
    expect(isCodexCompatibleModel("tts-1")).toBe(false);
    expect(isCodexCompatibleModel("tts-1-hd")).toBe(false);
    expect(isCodexCompatibleModel("gpt-4o-audio-preview")).toBe(false);
  });

  it("drops moderation + legacy completions", () => {
    expect(isCodexCompatibleModel("text-moderation-latest")).toBe(false);
    expect(isCodexCompatibleModel("babbage-002")).toBe(false);
    expect(isCodexCompatibleModel("davinci-002")).toBe(false);
  });

  it("drops empty / non-string ids", () => {
    expect(isCodexCompatibleModel("")).toBe(false);
    expect(isCodexCompatibleModel(undefined as unknown as string)).toBe(false);
  });

  it("drops realtime + search variants (not chat-completion compatible)", () => {
    expect(isCodexCompatibleModel("gpt-4o-realtime-preview")).toBe(false);
    expect(isCodexCompatibleModel("gpt-4o-search-preview")).toBe(false);
  });
});

// ── startDiscovery / lifecycle (auth-mode branching) ─────────────────

describe("codex / startDiscovery with no auth", () => {
  it("resolves immediately and marks discovery attempted", async () => {
    await startDiscovery(noneAuth());
    expect(getState().discoveryAt).not.toBeNull();
    expect(getState().discoveryPromise).toBeNull();
    expect(hasAttemptedDiscovery()).toBe(true);
    expect(hasDiscoveredCatalog()).toBe(false);
  });

  it("does not call fetch or read the cache file", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    await startDiscovery(noneAuth());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tolerates undefined / null authInfo by treating as no-auth", async () => {
    await startDiscovery(undefined);
    expect(hasAttemptedDiscovery()).toBe(true);
    await startDiscovery(null);
    expect(hasAttemptedDiscovery()).toBe(true);
  });
});

// ── api-key path ──────────────────────────────────────────────────────

describe("codex / startDiscovery on api-key auth — happy path", () => {
  it("populates discoveredModels from a /v1/models response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-5.5", object: "model" },
            { id: "gpt-5", object: "model" },
            { id: "gpt-5-codex", object: "model" },
            { id: "text-embedding-3-small", object: "model" }, // dropped
            { id: "whisper-1", object: "model" }, // dropped
            { id: "o4-mini", object: "model" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await startDiscovery(apiKeyAuth());

    const ids = Array.from(getState().discoveredModels).sort();
    expect(ids).toEqual(["gpt-5", "gpt-5-codex", "gpt-5.5", "o4-mini"]);
    expect(hasDiscoveredCatalog()).toBe(true);
    expect(hasAttemptedDiscovery()).toBe(true);
  });

  it("sends the api key as a bearer token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    await startDiscovery(apiKeyAuth("sk-bearer-test"));
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-bearer-test");
  });

  it("respects a custom baseUrl override", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    await startDiscovery(apiKeyAuth("sk-key", "https://my-proxy.example/v1"));
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://my-proxy.example/v1/models");
  });

  it("strips trailing slashes from baseUrl", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    await startDiscovery(apiKeyAuth("sk-key", "https://api.openai.com/v1///"));
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/models");
  });
});

describe("codex / startDiscovery on api-key auth — failure paths", () => {
  it("swallows 401 / 403 silently, leaves catalog empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    await startDiscovery(apiKeyAuth("sk-bad"));
    expect(getState().discoveredModels.size).toBe(0);
    expect(hasAttemptedDiscovery()).toBe(true);
  });

  it("swallows network errors silently", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED 127.0.0.1:443"),
    );
    await startDiscovery(apiKeyAuth());
    expect(getState().discoveredModels.size).toBe(0);
    expect(hasAttemptedDiscovery()).toBe(true);
  });

  it("clears the in-flight promise even on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    await startDiscovery(apiKeyAuth());
    expect(getState().discoveryPromise).toBeNull();
  });
});

// ── OAuth path (~/.codex/models_cache.json) ──────────────────────────

describe("codex / startDiscovery on chatgpt OAuth — cache-file path", () => {
  let originalHome: OriginalHomeEnv = {
    HOME: undefined,
    USERPROFILE: undefined,
    CODEX_HOME: undefined,
  };

  beforeEach(() => {
    originalHome = withTempHome();
  });

  afterEach(() => {
    restoreHome(originalHome);
  });

  it("populates discoveredModels from a real-shaped cache file", async () => {
    writeCacheFile({
      fetched_at: "2026-05-20T19:34:23.017243965Z",
      etag: 'W/"abc"',
      client_version: "0.131.0",
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          visibility: "list",
          supported_in_api: true,
          context_window: 272000,
        },
        {
          slug: "gpt-5.4",
          display_name: "GPT-5.4",
          visibility: "list",
          supported_in_api: true,
          context_window: 272000,
        },
        {
          slug: "codex-auto-review",
          display_name: "Codex Auto Review",
          visibility: "hide", // must be dropped
          supported_in_api: true,
          context_window: 272000,
        },
        {
          slug: "gpt-internal-x",
          visibility: "list",
          supported_in_api: false, // must be dropped
        },
      ],
    });

    await startDiscovery(chatgptAuth());

    const ids = Array.from(getState().discoveredModels).sort();
    expect(ids).toEqual(["gpt-5.4", "gpt-5.5"]);
    expect(hasDiscoveredCatalog()).toBe(true);
  });

  it("populates metadata from the cache file for synthesised entries", async () => {
    writeCacheFile({
      models: [
        {
          slug: "gpt-5.4-mini",
          display_name: "GPT-5.4-Mini",
          visibility: "list",
          supported_in_api: true,
          context_window: 272000,
        },
      ],
    });

    await startDiscovery(chatgptAuth());

    const meta = getState().discoveredModelMetadata.get("gpt-5.4-mini");
    expect(meta?.displayName).toBe("GPT-5.4-Mini");
    expect(meta?.contextWindow).toBe(272000);
  });

  it("does not touch HTTP fetch on chatgpt mode", async () => {
    writeCacheFile({ models: [] });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    await startDiscovery(chatgptAuth());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("swallows a missing cache file silently, leaves catalog empty", async () => {
    // No cache file written → ENOENT
    await startDiscovery(chatgptAuth());
    expect(getState().discoveredModels.size).toBe(0);
    expect(hasAttemptedDiscovery()).toBe(true);
  });

  it("swallows a malformed cache file silently", async () => {
    writeCacheFile("{ not json");
    await startDiscovery(chatgptAuth());
    expect(getState().discoveredModels.size).toBe(0);
    expect(hasAttemptedDiscovery()).toBe(true);
  });

  it("tolerates entries with missing/invalid slug fields", async () => {
    writeCacheFile({
      models: [
        { display_name: "no slug here" },
        { slug: 42, display_name: "non-string slug" },
        { slug: "gpt-5.5", visibility: "list", supported_in_api: true },
      ],
    });
    await loadCodexCacheModels();
    expect(Array.from(getState().discoveredModels)).toEqual(["gpt-5.5"]);
  });

  it("records the lowest-priority listed model as the CLI default", async () => {
    writeCacheFile({
      models: [
        {
          slug: "gpt-5.5",
          visibility: "list",
          supported_in_api: true,
          priority: 13,
        },
        {
          slug: "gpt-reserve",
          visibility: "hide",
          supported_in_api: true,
          priority: 1,
        },
        {
          slug: "gpt-6-luna",
          visibility: "list",
          supported_in_api: true,
          priority: 4,
        },
        {
          slug: "gpt-5.6-terra",
          visibility: "list",
          supported_in_api: true,
          priority: 8,
        },
      ],
    });
    await loadCodexCacheModels();
    // Hidden entries never become the default, however high they sort.
    expect(getState().discoveredDefaultModel).toBe("gpt-6-luna");
  });

  it("leaves the CLI default unset when no entry is usable", async () => {
    writeCacheFile({
      models: [{ slug: "gpt-reserve", visibility: "hide", priority: 1 }],
    });
    await loadCodexCacheModels();
    expect(getState().discoveredDefaultModel).toBeNull();
  });
});

// ── startDiscovery idempotency ────────────────────────────────────────

describe("codex / startDiscovery idempotency", () => {
  it("returns the same promise when called twice in flight (api-key)", async () => {
    let resolveOuter!: (v: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolveOuter = r;
    });
    vi.spyOn(globalThis, "fetch").mockReturnValue(pending);

    const p1 = startDiscovery(apiKeyAuth());
    const p2 = startDiscovery(apiKeyAuth());
    expect(p1).toBe(p2);

    resolveOuter(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await p1;
  });
});

// ── awaitDiscovery ────────────────────────────────────────────────────

describe("codex / awaitDiscovery", () => {
  it("returns immediately when no discovery is pending", async () => {
    const start = Date.now();
    await awaitDiscovery(5_000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("waits for an in-flight discovery to settle", async () => {
    let resolveOuter!: (v: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolveOuter = r;
    });
    vi.spyOn(globalThis, "fetch").mockReturnValue(pending);

    const discovery = startDiscovery(apiKeyAuth());
    const awaiter = awaitDiscovery(5_000);

    // Give the awaiter a tick to attach
    await new Promise((r) => setImmediate(r));

    resolveOuter(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-5.5", object: "model" }] }),
        { status: 200 },
      ),
    );
    await discovery;
    await awaiter;
    expect(getState().discoveredModels.has("gpt-5.5")).toBe(true);
  });

  it("times out after the soft window without blocking forever", async () => {
    // Never-resolving fetch
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    void startDiscovery(apiKeyAuth());

    const start = Date.now();
    await awaitDiscovery(20);
    const elapsed = Date.now() - start;
    // Setting a 20ms timer can resolve a millisecond early on busy
    // systems (Node's timer wheel drift) — allow 18ms as the floor.
    expect(elapsed).toBeGreaterThanOrEqual(18);
    expect(elapsed).toBeLessThan(500);
  });
});

// ── refreshDiscovery ──────────────────────────────────────────────────

describe("codex / refreshDiscovery", () => {
  it("clears the previous result and re-fetches", async () => {
    // First fetch: returns gpt-5.5
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-5.5", object: "model" }] }),
        { status: 200 },
      ),
    );
    await startDiscovery(apiKeyAuth());
    expect(Array.from(getState().discoveredModels)).toEqual(["gpt-5.5"]);

    // Second fetch (after refresh): gpt-5 only — old gpt-5.5 must be cleared
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-5", object: "model" }] }),
        { status: 200 },
      ),
    );
    await refreshDiscovery(apiKeyAuth());
    expect(Array.from(getState().discoveredModels)).toEqual(["gpt-5"]);
  });
});

// ── fetchOpenAiModels — malformed responses ──────────────────────────

describe("codex / fetchOpenAiModels malformed responses", () => {
  it("tolerates non-array `data`", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "not an array" }), { status: 200 }),
    );
    await fetchOpenAiModels("sk-key");
    expect(getState().discoveredModels.size).toBe(0);
  });

  it("tolerates entries missing `id`", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { object: "model" }, // no id
            { id: 42 }, // non-string id
            { id: "gpt-5.5", object: "model" },
          ],
        }),
        { status: 200 },
      ),
    );
    await fetchOpenAiModels("sk-key");
    expect(Array.from(getState().discoveredModels)).toEqual(["gpt-5.5"]);
  });

  it("throws on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Server Error", { status: 500 }),
    );
    await expect(fetchOpenAiModels("sk-key")).rejects.toThrow(/500/);
  });
});

// ── getCodexCachePath ─────────────────────────────────────────────────

describe("codex / getCodexCachePath", () => {
  it("points to ~/.codex/models_cache.json", () => {
    const p = getCodexCachePath();
    expect(p).toMatch(/[\\/]\.codex[\\/]models_cache\.json$/);
  });
});
