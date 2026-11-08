/**
 * Codex model catalog tests.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  CODEX_MODELS,
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
  getEffectiveModels,
  synthesizeUnknownModel,
  filterCatalogForAuthMode,
  getCodexChatGptDefaultModel,
} from "../backend/codex/models.js";
import {
  CODEX_CHATGPT_DEFAULT_MODEL,
  CODEX_CHATGPT_MODEL_ENV,
} from "../backend/codex/constants.js";
import { resetState, getState } from "../backend/codex/state.js";
import * as initModule from "../backend/codex/init.js";

beforeEach(() => {
  // Each test starts with a clean state (no in-flight discovery, empty
  // discovered set, no `discoveryAt`). The async model functions will
  // hit the early-return path in `awaitDiscovery` because no promise
  // is pending, so they resolve synchronously.
  resetState();
});

describe("codex / model catalog", () => {
  it("exposes at least the gpt-5-codex flagship", () => {
    expect(CODEX_MODELS.some((m) => m.id === "gpt-5-codex")).toBe(true);
  });

  it("every model carries the openai provider", () => {
    for (const m of CODEX_MODELS) {
      expect(m.provider).toBe("openai");
      expect(m.providerName).toBe("OpenAI");
      expect(m.selectable).toBe(true);
    }
  });
});

describe("codex / getCodexChatGptDefaultModel", () => {
  const savedEnv = process.env[CODEX_CHATGPT_MODEL_ENV];
  beforeEach(() => {
    delete process.env[CODEX_CHATGPT_MODEL_ENV];
    return () => {
      if (savedEnv === undefined) delete process.env[CODEX_CHATGPT_MODEL_ENV];
      else process.env[CODEX_CHATGPT_MODEL_ENV] = savedEnv;
    };
  });

  it("falls back to the bundled floor with no signal", () => {
    expect(getCodexChatGptDefaultModel()).toBe(CODEX_CHATGPT_DEFAULT_MODEL);
    // The id that 404'd every run in Sep 2026 must not be the floor.
    expect(CODEX_CHATGPT_DEFAULT_MODEL).not.toBe("gpt-5.5");
  });

  it("prefers the Codex CLI's own default from the model cache", () => {
    getState().discoveredDefaultModel = "gpt-6-luna";
    expect(getCodexChatGptDefaultModel()).toBe("gpt-6-luna");
  });

  it("prefers the config key over the CLI default", () => {
    getState().discoveredDefaultModel = "gpt-6-luna";
    getState().config = { codexChatGptDefaultModel: "gpt-5.6-terra" } as never;
    expect(getCodexChatGptDefaultModel()).toBe("gpt-5.6-terra");
  });

  it("prefers the env override over everything", () => {
    getState().discoveredDefaultModel = "gpt-6-luna";
    getState().config = { codexChatGptDefaultModel: "gpt-5.6-terra" } as never;
    process.env[CODEX_CHATGPT_MODEL_ENV] = " gpt-5.6-luna ";
    expect(getCodexChatGptDefaultModel()).toBe("gpt-5.6-luna");
  });
});

describe("codex / resolveModel", () => {
  it("returns exact match for a known model id", async () => {
    const result = await resolveModel("gpt-5-codex");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.model.id).toBe("gpt-5-codex");
      expect(result.storedValue).toBe("gpt-5-codex");
    }
  });

  it("returns missing for an empty query", async () => {
    expect((await resolveModel("")).kind).toBe("missing");
    expect((await resolveModel("   ")).kind).toBe("missing");
  });

  it("returns missing for an unrecognised query", async () => {
    expect((await resolveModel("nonsense-model-1.0")).kind).toBe("missing");
  });

  it("returns exact for `gpt-5` because exact-id wins over prefix", async () => {
    const result = await resolveModel("gpt-5");
    expect(result.kind).toBe("exact");
  });

  it("returns ambiguous when only prefix matches multiple", async () => {
    const result = await resolveModel("gpt");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matches.length).toBeGreaterThan(1);
    }
  });

  it("resolves a discovered-only model id when curated catalog doesn't list it", async () => {
    getState().discoveredModels.add("gpt-6-preview");
    const result = await resolveModel("gpt-6-preview");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.model.id).toBe("gpt-6-preview");
      expect(result.model.displayName).toBe("GPT-6-preview");
    }
  });
});

describe("codex / getModelInfo", () => {
  it("returns the model for a known id", async () => {
    expect((await getModelInfo("gpt-5-codex"))?.id).toBe("gpt-5-codex");
  });

  it("does not invent reasoning levels for curated fallback models", async () => {
    expect(
      (await getModelInfo("gpt-5"))?.supportedReasoningLevels,
    ).toBeUndefined();
  });

  it("returns undefined for unknown ids", async () => {
    expect(await getModelInfo("not-real")).toBeUndefined();
  });

  it("returns a discovered-only id with synthesised metadata", async () => {
    getState().discoveredModels.add("o5-mini");
    const info = await getModelInfo("o5-mini");
    expect(info?.id).toBe("o5-mini");
    expect(info?.reasoning).toBe(true);
  });

  it("uses reasoning levels from Codex discovery metadata", async () => {
    const state = getState();
    state.discoveredModels.add("gpt-5");
    state.discoveredModelMetadata.set("gpt-5", {
      supportedReasoningLevels: ["low", "high"],
      defaultReasoningLevel: "low",
    });

    const info = await getModelInfo("gpt-5");
    expect(info?.supportedReasoningLevels).toEqual(["low", "high"]);
    expect(info?.defaultReasoningLevel).toBe("low");
  });

  it("keeps discovered-only models level-less unless discovery reported levels", async () => {
    getState().discoveredModels.add("o5-mini");
    expect(
      (await getModelInfo("o5-mini"))?.supportedReasoningLevels,
    ).toBeUndefined();
  });
});

describe("codex / getSettingsPresentation", () => {
  it("returns one button per curated model with active marker on the current one", async () => {
    const { modelButtons } = await getSettingsPresentation("gpt-5");
    expect(modelButtons).toHaveLength(CODEX_MODELS.length);

    const active = modelButtons.find((b) => b.callback_data.endsWith("gpt-5"));
    const others = modelButtons.filter(
      (b) => !b.callback_data.endsWith("gpt-5"),
    );
    expect(active?.text).toMatch(/^●/);
    for (const b of others) {
      expect(b.text).not.toMatch(/^●/);
    }
  });

  it("reports a single-page result for the curated fallback", async () => {
    const { page, totalPages, filter, totalCount } =
      await getSettingsPresentation("gpt-5");
    expect(page).toBe(1);
    expect(totalPages).toBe(1);
    expect(filter).toBe("all");
    expect(totalCount).toBe(CODEX_MODELS.length);
  });

  it("uses the supplied callbackPrefix", async () => {
    const { modelButtons } = await getSettingsPresentation("gpt-5", {
      callbackPrefix: "custom:prefix:",
    });
    for (const b of modelButtons) {
      expect(b.callback_data.startsWith("custom:prefix:")).toBe(true);
    }
  });

  it("labels the catalog source as curated when discovery is empty", async () => {
    const { modelDetails } = await getSettingsPresentation("gpt-5");
    expect(modelDetails.join("\n")).toMatch(/curated/);
  });

  it("labels the catalog source as discovered when /v1/models returned ids", async () => {
    const state = getState();
    state.discoveredModels.add("gpt-5.5");
    state.discoveredModels.add("gpt-5");
    state.discoveryAt = Date.now();
    const { modelDetails } = await getSettingsPresentation("gpt-5.5");
    expect(modelDetails.join("\n")).toMatch(/discovered/);
  });
});

describe("codex / getProviders + getProviderModels", () => {
  it("returns OpenAI as the sole provider", async () => {
    const providers = await getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("openai");
    expect(providers[0].modelCount).toBe(CODEX_MODELS.length);
  });

  it("returns paginated models for openai provider", async () => {
    const result = await getProviderModels("openai", 1, 2);
    expect(result.models).toHaveLength(2);
    expect(result.total).toBe(CODEX_MODELS.length);
  });

  it("returns empty for unknown provider", async () => {
    expect(await getProviderModels("anthropic", 1, 50)).toEqual({
      models: [],
      total: 0,
    });
  });
});

describe("codex / formatModelError", () => {
  it("describes ambiguous matches with backtick-quoted ids", () => {
    const msg = formatModelError("gpt", {
      kind: "ambiguous",
      matches: CODEX_MODELS.filter((m) => m.id.startsWith("gpt-5")),
    });
    expect(msg).toContain("Multiple Codex models match");
    expect(msg).toContain("`gpt-5-codex`");
  });

  it("describes a missing query with the effective catalog", () => {
    const msg = formatModelError("xyz", { kind: "missing" });
    expect(msg).toContain("No Codex model matches");
    expect(msg).toContain("gpt-5-codex");
  });
});

describe("codex / listModels", () => {
  it("returns all curated by default when discovery is empty", async () => {
    const { models, total } = await listModels();
    expect(total).toBe(CODEX_MODELS.length);
    expect(models.map((m) => m.id)).toEqual(CODEX_MODELS.map((m) => m.id));
  });

  it("returns nothing for `free` filter — no free Codex models", async () => {
    const { models, total } = await listModels("free");
    expect(models).toEqual([]);
    expect(total).toBe(0);
  });

  it("returns all for the `all` filter", async () => {
    const { total } = await listModels("all");
    expect(total).toBe(CODEX_MODELS.length);
  });
});

describe("codex / getEffectiveModels (merge logic)", () => {
  it("returns the curated catalog when no discovery has happened", () => {
    const catalog = getEffectiveModels();
    expect(catalog.map((m) => m.id)).toEqual(CODEX_MODELS.map((m) => m.id));
  });

  it("filters curated entries by discovered set when discovery succeeded", () => {
    const state = getState();
    state.discoveredModels.add("gpt-5.5");
    state.discoveredModels.add("gpt-5");
    state.discoveryAt = Date.now();

    const catalog = getEffectiveModels();
    expect(catalog.map((m) => m.id).sort()).toEqual(["gpt-5", "gpt-5.5"]);
    // Curated metadata survives — apiKeyOnly remains absent on gpt-5
    expect(catalog.find((m) => m.id === "gpt-5")?.contextWindow).toBe(400_000);
  });

  it("overlays discovered metadata onto curated entries", () => {
    const state = getState();
    state.discoveredModels.add("gpt-5.5");
    state.discoveredModelMetadata.set("gpt-5.5", {
      displayName: "GPT-5.5 Live",
      contextWindow: 272_000,
    });
    state.discoveryAt = Date.now();

    const catalog = getEffectiveModels();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].displayName).toBe("GPT-5.5 Live");
    expect(catalog[0].contextWindow).toBe(272_000);
  });

  it("synthesises entries for discovered ids not in the curated table", () => {
    const state = getState();
    state.discoveredModels.add("gpt-6-preview"); // not in curated
    state.discoveryAt = Date.now();

    const catalog = getEffectiveModels();
    expect(catalog.map((m) => m.id)).toEqual(["gpt-6-preview"]);
    expect(catalog[0].displayName).toBe("GPT-6-preview");
    expect(catalog[0].provider).toBe("openai");
    expect(catalog[0].selectable).toBe(true);
  });

  it("orders curated entries first, then discovered-only entries", () => {
    const state = getState();
    state.discoveredModels.add("gpt-5.5");
    state.discoveredModels.add("gpt-6-preview");
    state.discoveryAt = Date.now();

    const catalog = getEffectiveModels();
    expect(catalog.map((m) => m.id)).toEqual(["gpt-5.5", "gpt-6-preview"]);
  });

  it("preserves apiKeyOnly metadata from curated entries", () => {
    const state = getState();
    state.discoveredModels.add("gpt-5-codex");
    state.discoveryAt = Date.now();

    const catalog = getEffectiveModels();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe("gpt-5-codex");
    // apiKeyOnly is what the recovery ladder reads — must survive the merge
    const codex = catalog[0] as { apiKeyOnly?: boolean };
    expect(codex.apiKeyOnly).toBe(true);
  });
});

describe("codex / synthesizeUnknownModel", () => {
  it("derives a display name from the id", () => {
    expect(synthesizeUnknownModel("gpt-6").displayName).toBe("GPT-6");
    expect(synthesizeUnknownModel("chatgpt-5-latest").displayName).toBe(
      "ChatGPT-5-latest",
    );
  });

  it("flags reasoning models (o3*/o4*/-codex)", () => {
    expect(synthesizeUnknownModel("o5-mini").reasoning).toBe(true);
    expect(synthesizeUnknownModel("o3-pro").reasoning).toBe(true);
    expect(synthesizeUnknownModel("gpt-6-codex").reasoning).toBe(true);
  });

  it("does not flag plain chat models as reasoning", () => {
    expect(synthesizeUnknownModel("gpt-4.1").reasoning).toBe(false);
    expect(synthesizeUnknownModel("chatgpt-4o-latest").reasoning).toBe(false);
  });
});

// ── Auth-mode-aware catalog filter ──────────────────────────────────────────
//
// `filterCatalogForAuthMode` is the seam that hides apiKeyOnly models
// (and runtime-learned-incompat models) from the picker when the active
// credential is ChatGPT OAuth. The model resolution path stays
// unfiltered — a chat with an explicit stored OAuth-incompat id still
// recognises that id, the runtime guard in `handler.ts` does the swap.

describe("codex / filterCatalogForAuthMode", () => {
  it("keeps every model when auth mode is api-key", () => {
    const filtered = filterCatalogForAuthMode(CODEX_MODELS, "api-key");
    expect(filtered.length).toBe(CODEX_MODELS.length);
    expect(filtered.find((m) => m.id === "gpt-5-codex")).toBeDefined();
  });

  it("keeps every model when auth mode is none / undefined", () => {
    expect(filterCatalogForAuthMode(CODEX_MODELS, "none").length).toBe(
      CODEX_MODELS.length,
    );
    expect(filterCatalogForAuthMode(CODEX_MODELS, undefined).length).toBe(
      CODEX_MODELS.length,
    );
  });

  it("drops apiKeyOnly: true models when auth mode is chatgpt", () => {
    const filtered = filterCatalogForAuthMode(CODEX_MODELS, "chatgpt");
    // gpt-5-codex is curated apiKeyOnly: true and should disappear.
    expect(filtered.find((m) => m.id === "gpt-5-codex")).toBeUndefined();
    // gpt-5.5 is the OAuth flagship and should stay.
    expect(filtered.find((m) => m.id === "gpt-5.5")).toBeDefined();
    // No model in the filtered set should be apiKeyOnly.
    expect(filtered.every((m) => m.apiKeyOnly !== true)).toBe(true);
  });

  it("preserves the relative order of the curated catalog", () => {
    const filtered = filterCatalogForAuthMode(CODEX_MODELS, "chatgpt");
    const filteredIds = filtered.map((m) => m.id);
    const originalIds = CODEX_MODELS.filter((m) => m.apiKeyOnly !== true).map(
      (m) => m.id,
    );
    expect(filteredIds).toEqual(originalIds);
  });
});

describe("codex / presentation paths apply the auth-mode filter", () => {
  // These tests mock `getCodexAuthInfo` because the real one reads
  // module-private state set up by `initCodexAgent`. The presentation
  // path under test consumes ONLY the `mode` field, so a minimal stub
  // is enough.

  beforeEach(() => {
    resetState();
    vi.restoreAllMocks();
  });

  it("getSettingsPresentation hides apiKeyOnly models on ChatGPT OAuth", async () => {
    vi.spyOn(initModule, "getCodexAuthInfo").mockReturnValue({
      mode: "chatgpt",
      source: "config:codexApiKey",
      authFileParsed: false,
      diagnostics: [],
    });
    const result = await getSettingsPresentation("gpt-5.5");
    const buttonIds = result.modelButtons.map((b) =>
      b.callback_data.replace("settings:model:", ""),
    );
    expect(buttonIds.includes("gpt-5-codex")).toBe(false);
    expect(buttonIds.includes("gpt-5.5")).toBe(true);
    // Detail line should advertise the hidden count.
    expect(result.modelDetails.some((d) => d.includes("hidden on OAuth"))).toBe(
      true,
    );
  });

  it("getSettingsPresentation flags an active OAuth-incompat model as not selectable", async () => {
    vi.spyOn(initModule, "getCodexAuthInfo").mockReturnValue({
      mode: "chatgpt",
      source: "config:codexApiKey",
      authFileParsed: false,
      diagnostics: [],
    });
    // Chat is stored on gpt-5-codex but we're on OAuth — picker should
    // still show "Active: GPT-5-Codex … — not selectable on current
    // ChatGPT OAuth credentials" in the header.
    const result = await getSettingsPresentation("gpt-5-codex");
    expect(result.modelDetails.some((d) => d.includes("not selectable"))).toBe(
      true,
    );
  });

  it("getSettingsPresentation shows the full catalog on api-key auth", async () => {
    vi.spyOn(initModule, "getCodexAuthInfo").mockReturnValue({
      mode: "api-key",
      source: "config:codexApiKey",
      authFileParsed: false,
      diagnostics: [],
      apiKey: "sk-test",
    });
    const result = await getSettingsPresentation("gpt-5.5");
    const buttonIds = result.modelButtons.map((b) =>
      b.callback_data.replace("settings:model:", ""),
    );
    expect(buttonIds.includes("gpt-5-codex")).toBe(true);
    expect(result.modelDetails.some((d) => d.includes("hidden on OAuth"))).toBe(
      false,
    );
  });

  it("getProviders modelCount reflects the filtered catalog on OAuth", async () => {
    vi.spyOn(initModule, "getCodexAuthInfo").mockReturnValue({
      mode: "chatgpt",
      source: "config:codexApiKey",
      authFileParsed: false,
      diagnostics: [],
    });
    const providers = await getProviders();
    const filteredCount = filterCatalogForAuthMode(
      CODEX_MODELS,
      "chatgpt",
    ).length;
    expect(providers[0].modelCount).toBe(filteredCount);
  });

  it("listModels returns the filtered catalog on OAuth", async () => {
    vi.spyOn(initModule, "getCodexAuthInfo").mockReturnValue({
      mode: "chatgpt",
      source: "config:codexApiKey",
      authFileParsed: false,
      diagnostics: [],
    });
    const result = await listModels("all");
    expect(result.models.find((m) => m.id === "gpt-5-codex")).toBeUndefined();
    expect(result.models.find((m) => m.id === "gpt-5.5")).toBeDefined();
  });

  it("formatModelError lists only OAuth-compatible models on OAuth", () => {
    vi.spyOn(initModule, "getCodexAuthInfo").mockReturnValue({
      mode: "chatgpt",
      source: "config:codexApiKey",
      authFileParsed: false,
      diagnostics: [],
    });
    const msg = formatModelError("gpt-typo", { kind: "missing" });
    expect(msg.includes("gpt-5-codex")).toBe(false);
    expect(msg.includes("gpt-5.5")).toBe(true);
  });

  it("resolveModel still resolves apiKeyOnly ids on OAuth (handler-side guard does the swap)", async () => {
    vi.spyOn(initModule, "getCodexAuthInfo").mockReturnValue({
      mode: "chatgpt",
      source: "config:codexApiKey",
      authFileParsed: false,
      diagnostics: [],
    });
    // The picker hides it, but a chat with `gpt-5-codex` already stored
    // shouldn't see "model not found" — the pre-emptive guard in
    // handler.ts handles the runtime swap.
    const result = await resolveModel("gpt-5-codex");
    expect(result.kind).toBe("exact");
  });
});
