/**
 * Tests for the active-model resolver (`src/core/models/active-model.ts`).
 *
 * The resolver is the central read path for "what model is this chat
 * running on?". Each test pins one branch of the 5-step chain so
 * future regressions surface immediately:
 *
 *   1. Per-backend override valid → returned, source `override-valid`.
 *   2. Per-backend override invalid (`missing` / `selectable: false` /
 *      `resolveModel` throws) → falls through with source
 *      `override-invalid-fallback`.
 *   3. No override, backend canonical default → returned, source
 *      `backend-canonical`.
 *   4. No override, no canonical default, `config.backendDefaults[B]`
 *      set → returned, source `config-backend-defaults`.
 *   5. No override, no canonical, no operator default, B is the global
 *      `config.backend`, `config.model` set → returned, source
 *      `config-legacy-global`.
 *   6. None of the above (catalog-driven backend, no operator default,
 *      not the global backend) → `null`, source `none`. UI shows "No
 *      model selected", send guard refuses.
 *
 * Plus edge cases: `getDefaultModel` throws / returns null / returns
 * empty string, `null` backend, `null` backendId, modelByBackend
 * persistence semantics across
 * setChatModelForBackend / clearAllChatModels.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UnifiedModelResolution } from "../core/types.js";
import type {
  Backend,
  ModelCatalog,
} from "../core/agent-runtime/capabilities.js";
import { composeBackend } from "../core/agent-runtime/capabilities.js";
import type { TalonConfig } from "../core/config/index.js";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

const {
  resolveActiveModelForChat,
  resolveExplicitModelRef,
  resetInvalidOverrideWarnings,
} = await import("../core/models/active-model.js");
const { logWarn } = await import("../util/log.js");
const {
  setChatModelForBackend,
  setChatBackend,
  clearAllChatModels,
  setChatModel,
  getChatSettings,
} = await import("../storage/chat-settings.js");

function fakeConfig(opts: Partial<TalonConfig> = {}): TalonConfig {
  return {
    model: "claude-opus-4-7",
    backend: "claude",
    ...opts,
  } as unknown as TalonConfig;
}

function exactResolution(
  id: string,
  selectable = true,
): UnifiedModelResolution {
  return {
    kind: "exact",
    model: {
      id,
      displayName: id,
      provider: "test",
      providerName: "Test",
      selectable,
    },
    storedValue: id,
  };
}

function missingResolution(): UnifiedModelResolution {
  return { kind: "missing" };
}

function fakeBackend(opts: {
  resolveModel?: (q: string) => Promise<UnifiedModelResolution>;
  getDefaultModel?: () =>
    Promise<string | null | undefined> | string | null | undefined;
  backendLabel?: string;
}): Backend {
  const models: Partial<ModelCatalog> = {};
  if (opts.resolveModel) models.resolveModelInfo = opts.resolveModel;
  if (opts.getDefaultModel) models.getDefaultModelId = opts.getDefaultModel;
  return composeBackend({
    id: "claude",
    label: opts.backendLabel ?? "Stub",
    cacheMetrics: "none",
    models:
      Object.keys(models).length > 0 ? (models as ModelCatalog) : undefined,
  });
}

describe("resolveActiveModelForChat — 5-step chain", () => {
  let chatId = 0;
  const nextChatId = () => `active-model-test-${++chatId}`;

  beforeEach(() => {
    vi.clearAllMocks();
    resetInvalidOverrideWarnings();
  });

  /** The invalid-override warnings emitted so far, trimmed to their key. */
  const overrideWarnings = () =>
    vi
      .mocked(logWarn)
      .mock.calls.map((call) => String(call[1]))
      .filter((msg) => msg.includes("is not a selectable model"))
      .map((msg) => msg.slice(0, msg.indexOf('" is not') + 1));

  // ── Step 1: valid override ─────────────────────────────────────────
  it("returns per-backend override when it validates", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "gpt-5.5");
    const be = fakeBackend({
      resolveModel: async () => exactResolution("gpt-5.5"),
      getDefaultModel: () => "gpt-5-codex",
    });
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "codex",
      fakeConfig(),
    );
    expect(result).toMatchObject({
      model: "gpt-5.5",
      source: "override-valid",
    });
  });

  // ── Step 2 reached: override invalid → backend canonical ───────────
  it("falls through to backend canonical when override is missing", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "claude-opus-4-7");
    const be = fakeBackend({
      resolveModel: async () => missingResolution(),
      getDefaultModel: () => "gpt-5.5",
    });
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "codex",
      fakeConfig(),
    );
    expect(result).toMatchObject({
      model: "gpt-5.5",
      source: "override-invalid-fallback",
    });
  });

  it("falls through to backend canonical when override is non-selectable", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "gpt-5-codex");
    const be = fakeBackend({
      resolveModel: async () => exactResolution("gpt-5-codex", false),
      getDefaultModel: () => "gpt-5.5",
    });
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "codex",
      fakeConfig(),
    );
    expect(result.source).toBe("override-invalid-fallback");
    expect(result.model).toBe("gpt-5.5");
  });

  it("warns about an invalid override once per chat until the value changes", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      resolveModel: async () => missingResolution(),
      getDefaultModel: () => "gpt-5.5",
    });
    const resolve = () =>
      resolveActiveModelForChat(cid, be, "codex", fakeConfig());

    // One turn resolves the active model several times; the unchanged
    // bad override must warn exactly once.
    setChatModelForBackend(cid, "codex", "claude-opus-4-7");
    await resolve();
    await resolve();
    await resolve();
    expect(overrideWarnings()).toEqual([
      `chat=${cid} backend=codex: per-chat override "claude-opus-4-7"`,
    ]);

    // A different invalid value re-arms the latch.
    setChatModelForBackend(cid, "codex", "claude-sonnet-4-6");
    await resolve();
    await resolve();
    expect(overrideWarnings()).toEqual([
      `chat=${cid} backend=codex: per-chat override "claude-opus-4-7"`,
      `chat=${cid} backend=codex: per-chat override "claude-sonnet-4-6"`,
    ]);

    // Another chat with the same bad override is its own latch.
    const other = nextChatId();
    setChatModelForBackend(other, "codex", "claude-sonnet-4-6");
    await resolveActiveModelForChat(other, be, "codex", fakeConfig());
    expect(overrideWarnings()).toHaveLength(3);
  });

  it("falls through to backend canonical when resolveModel throws", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "bad-override");
    const be = fakeBackend({
      resolveModel: async () => {
        throw new Error("network down");
      },
      getDefaultModel: () => "safe-default",
    });
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "codex",
      fakeConfig(),
    );
    expect(result.model).toBe("safe-default");
    expect(result.source).toBe("override-invalid-fallback");
  });

  // ── Step 2 reached directly: no override ───────────────────────────
  it("returns backend canonical when no override is set", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      resolveModel: async () => missingResolution(),
      getDefaultModel: () => "gpt-5.5",
    });
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "codex",
      fakeConfig(),
    );
    expect(result).toMatchObject({
      model: "gpt-5.5",
      source: "backend-canonical",
    });
  });

  // ── Step 3: operator override in config.backendDefaults ────────────
  it("returns config.backendDefaults entry when backend has no canonical", async () => {
    const cid = nextChatId();
    const be = fakeBackend({});
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "openai-agents",
      fakeConfig({
        backendDefaults: {
          "openai-agents": "meta-llama/llama-3.3-70b-instruct:free",
        },
      }),
    );
    expect(result).toMatchObject({
      model: "meta-llama/llama-3.3-70b-instruct:free",
      source: "config-backend-defaults",
    });
  });

  it("config.backendDefaults wins when getDefaultModel returns null", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      getDefaultModel: () => null,
    });
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "openai-agents",
      fakeConfig({
        backendDefaults: { "openai-agents": "operator-default" },
      }),
    );
    expect(result.model).toBe("operator-default");
    expect(result.source).toBe("config-backend-defaults");
  });

  // ── Step 4: config.model only on the global chat-role backend ──────
  it("falls through to config.model only when B === config.backend", async () => {
    const cid = nextChatId();
    const be = fakeBackend({});
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "claude",
      fakeConfig({ backend: "claude", model: "claude-opus-4-7" }),
    );
    expect(result).toMatchObject({
      model: "claude-opus-4-7",
      source: "config-legacy-global",
    });
  });

  it("does NOT use config.model when B !== config.backend", async () => {
    const cid = nextChatId();
    const be = fakeBackend({});
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "openai-agents",
      fakeConfig({ backend: "claude", model: "claude-opus-4-7" }),
    );
    // config.model belongs to the claude backend; openai-agents
    // without backendDefaults must NOT inherit it.
    expect(result).toMatchObject({ model: null, source: "none" });
  });

  // ── Step 5: null when chain exhausted ──────────────────────────────
  it("returns null when no source has a usable default", async () => {
    const cid = nextChatId();
    const be = fakeBackend({});
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "openai-agents",
      fakeConfig({ backend: "claude", model: "" }),
    );
    expect(result).toMatchObject({ model: null, source: "none" });
  });
});

describe("resolveActiveModelForChat — edge cases", () => {
  let chatId = 1000;
  const nextChatId = () => `edge-test-${++chatId}`;

  it("treats empty-string canonical default as 'no default'", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      getDefaultModel: () => "",
    });
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "openai-agents",
      fakeConfig({
        backendDefaults: { "openai-agents": "operator-pick" },
      }),
    );
    expect(result.model).toBe("operator-pick");
    expect(result.source).toBe("config-backend-defaults");
  });

  it("treats getDefaultModel that throws as 'no canonical'", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      getDefaultModel: () => {
        throw new Error("boom");
      },
    });
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "claude",
      fakeConfig({ backend: "claude", model: "fallback-from-config" }),
    );
    expect(result.model).toBe("fallback-from-config");
    expect(result.source).toBe("config-legacy-global");
  });

  it("trusts override verbatim when backend has no resolveModel", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "custom-backend", "weird-model-id");
    const be = fakeBackend({});
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "custom-backend",
      fakeConfig(),
    );
    expect(result.model).toBe("weird-model-id");
    expect(result.source).toBe("override-valid");
  });

  it("awaits async getDefaultModel", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      getDefaultModel: async () => "async-default",
    });
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "codex",
      fakeConfig(),
    );
    expect(result.model).toBe("async-default");
  });

  it("null backend + null backendId falls back to config.model", async () => {
    const cid = nextChatId();
    const result = await resolveActiveModelForChat(
      cid,
      null,
      null,
      fakeConfig({ model: "config-fallback" }),
    );
    expect(result.model).toBe("config-fallback");
    expect(result.source).toBe("config-legacy-global");
  });

  it("null backend with valid override falls back without validation", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "claude", "stored-override");
    // No backend means we can't validate, but we have a backendId
    // pointing at the slot. Per the implementation we still try
    // step 1 (no resolveModel → trust-verbatim path returns true).
    const result = await resolveActiveModelForChat(
      cid,
      null,
      "claude",
      fakeConfig(),
    );
    expect(result.model).toBe("stored-override");
    expect(result.source).toBe("override-valid");
  });
});

describe("per-backend storage semantics", () => {
  let chatId = 2000;
  const nextChatId = () => `storage-test-${++chatId}`;

  it("setChatModelForBackend writes to the right slot only", () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "gpt-5.5");
    setChatModelForBackend(cid, "openai-agents", "claude-via-or-shenanigans");
    expect({ ...getChatSettings(cid).modelByBackend }).toEqual({
      codex: "gpt-5.5",
      "openai-agents": "claude-via-or-shenanigans",
    });
  });

  it("clearing one backend's slot leaves others alone", () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "gpt-5.5");
    setChatModelForBackend(cid, "claude", "default");
    setChatModelForBackend(cid, "codex", undefined);
    expect({ ...getChatSettings(cid).modelByBackend }).toEqual({
      claude: "default",
    });
  });

  it("clearAllChatModels wipes every per-backend slot AND legacy field", () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "gpt-5.5");
    setChatModelForBackend(cid, "claude", "default");
    clearAllChatModels(cid);
    expect({ ...getChatSettings(cid).modelByBackend }).toEqual({});
    expect(getChatSettings(cid).model).toBeUndefined();
  });

  it("legacy setChatModel writes through to the bound backend's slot", () => {
    const cid = nextChatId();
    setChatBackend(cid, "codex");
    setChatModel(cid, "gpt-5.5");
    expect({ ...getChatSettings(cid).modelByBackend }).toEqual({
      codex: "gpt-5.5",
    });
    // Legacy `model` field should NOT be set when bound to a backend.
    expect(getChatSettings(cid).model).toBeUndefined();
  });

  it("legacy setChatModel writes to legacy slot when chat has no backend binding", () => {
    const cid = nextChatId();
    setChatModel(cid, "fresh-chat-model");
    expect({ ...getChatSettings(cid).modelByBackend }).toEqual({});
    expect(getChatSettings(cid).model).toBe("fresh-chat-model");
  });

  it("resolver picks up legacy `model` field when modelByBackend slot is empty", async () => {
    // This is the back-compat path the migration aims to eliminate
    // — pre-migration stores hold a `model` field and no backend
    // binding. The resolver still finds it via the
    // getChatModelForBackend legacy-fallback branch.
    const cid = nextChatId();
    setChatModel(cid, "legacy-store-value");
    const be = fakeBackend({
      resolveModel: async () => exactResolution("legacy-store-value"),
    });
    // No backend binding stored, so the legacy fallback in
    // getChatModelForBackend triggers for any backendId queried.
    const result = await resolveActiveModelForChat(
      cid,
      be,
      "claude",
      fakeConfig(),
    );
    expect(result.model).toBe("legacy-store-value");
    expect(result.source).toBe("override-valid");
  });
});

describe("resolveExplicitModelRef — per-job model override", () => {
  beforeEach(() => vi.clearAllMocks());

  it("materialises a ref for a selectable model on the backend", async () => {
    const be = fakeBackend({
      resolveModel: async () => exactResolution("claude-haiku-4-5"),
    });
    const ref = await resolveExplicitModelRef("claude-haiku-4-5", be, "claude");
    expect(ref).not.toBeNull();
    expect(ref?.id).toBe("claude-haiku-4-5");
    expect(ref?.backend).toBe("claude");
  });

  it("returns null for a model that is missing on the backend", async () => {
    const be = fakeBackend({ resolveModel: async () => missingResolution() });
    expect(await resolveExplicitModelRef("nope-1", be, "claude")).toBeNull();
  });

  it("returns null for a non-selectable model", async () => {
    const be = fakeBackend({
      resolveModel: async () => exactResolution("legacy-x", false),
    });
    expect(await resolveExplicitModelRef("legacy-x", be, "claude")).toBeNull();
  });

  it("returns null for an empty model id", async () => {
    const be = fakeBackend({
      resolveModel: async () => exactResolution("x"),
    });
    expect(await resolveExplicitModelRef("", be, "claude")).toBeNull();
  });

  it("trusts the id when the backend has no catalog to validate against", async () => {
    const be = fakeBackend({}); // no models catalog
    const ref = await resolveExplicitModelRef("some-model", be, "claude");
    expect(ref).not.toBeNull();
    expect(ref?.id).toBe("some-model");
  });
});
