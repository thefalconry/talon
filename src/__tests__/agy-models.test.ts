/**
 * Antigravity model-catalog + effort-mapping tests.
 *
 * `models.tsv` is the verbatim stdout of `agy models` on the real
 * binary, minus the "Fetching available models..." banner the CLI
 * prints first — which the parser must also survive, so it is added
 * back in the preamble test.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

const {
  parseAgyModels,
  synthesizeUnknownModel,
  resolveModel,
  getModelInfo,
  getDefaultModelId,
  getProviders,
  getProviderModels,
  getSettingsPresentation,
  formatModelError,
  listModels,
  refreshModels,
  resetModelCache,
  getCachedModels,
} = await import("../backend/agy/models.js");
const {
  toAgyEffort,
  effortSuffixOf,
  modelIdStem,
  applyEffortToModelId,
  composeAgyModelSelection,
  selectAgyRun,
} = await import("../backend/agy/effort.js");
const { isMissingBinary, catalogForSelection } =
  await import("../backend/agy/models.js");

/** Verbatim `agy models` from agy 1.4.4 (the Gemini 4 Argon release). */
const TSV_144 = readFileSync(
  join(import.meta.dirname, "fixtures", "agy", "models-1.4.4.tsv"),
  "utf-8",
);

const TSV = readFileSync(
  join(import.meta.dirname, "fixtures", "agy", "models.tsv"),
  "utf-8",
);

/** `execFile` promisified by the module under test uses the callback form. */
function stubModelsOutput(stdout: string): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (e: unknown, r: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout, stderr: "" });
    },
  );
}

beforeEach(() => {
  resetModelCache();
  execFileMock.mockReset();
  stubModelsOutput(TSV);
});

describe("agy models — TSV parsing", () => {
  it("parses every id/label row", () => {
    const models = parseAgyModels(TSV);
    expect(models).toHaveLength(13);
    expect(models[0]).toMatchObject({
      id: "gemini-3.8-flash-medium",
      displayName: "Gemini 3.8 Flash (Medium)",
      provider: "google",
      providerName: "Google",
      selectable: true,
    });
  });

  it("skips the 'Fetching available models…' preamble and blank lines", () => {
    const withBanner = `Fetching available models...\n\n${TSV}\n\n`;
    expect(parseAgyModels(withBanner)).toEqual(parseAgyModels(TSV));
  });

  it("skips rows with no tab or an empty id", () => {
    expect(parseAgyModels("no tab here\n\tlabel only\nid\tLabel")).toEqual([
      expect.objectContaining({ id: "id", displayName: "Label" }),
    ]);
  });

  it("groups vendors by id prefix", () => {
    const byId = new Map(parseAgyModels(TSV).map((m) => [m.id, m]));
    expect(byId.get("gemini-3.1-pro-high")?.providerName).toBe("Google");
    expect(byId.get("claude-sonnet-4-6")?.providerName).toBe("Anthropic");
    expect(byId.get("gpt-oss-120b-medium")?.providerName).toBe("OpenAI");
  });

  it("derives supported effort levels from the sibling slugs that exist", () => {
    const byId = new Map(parseAgyModels(TSV).map((m) => [m.id, m]));
    // 3.7 Flash ships low/medium/high…
    expect(byId.get("gemini-3.7-flash-high")?.supportedReasoningLevels).toEqual(
      ["low", "medium", "high"],
    );
    // …3.1 Pro only ships low and high, so medium must not be offered.
    expect(byId.get("gemini-3.1-pro-high")?.supportedReasoningLevels).toEqual([
      "low",
      "high",
    ]);
    // A suffix-less id has no siblings; --effort still takes all three.
    expect(byId.get("claude-sonnet-4-6")?.supportedReasoningLevels).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("reports the baked-in suffix as the model's default level", () => {
    const byId = new Map(parseAgyModels(TSV).map((m) => [m.id, m]));
    expect(byId.get("gemini-3.8-flash-low")?.defaultReasoningLevel).toBe("low");
    expect(
      byId.get("claude-sonnet-4-6")?.defaultReasoningLevel,
    ).toBeUndefined();
  });
});

describe("agy models — resolution", () => {
  it("resolves an exact id", async () => {
    const r = await resolveModel("gemini-3.1-pro-high");
    expect(r).toMatchObject({
      kind: "exact",
      storedValue: "gemini-3.1-pro-high",
    });
  });

  it("resolves case-insensitively", async () => {
    const r = await resolveModel("GEMINI-3.1-PRO-HIGH");
    expect(r).toMatchObject({
      kind: "exact",
      storedValue: "gemini-3.1-pro-high",
    });
  });

  it("resolves an unambiguous prefix", async () => {
    const r = await resolveModel("claude-opus");
    expect(r).toMatchObject({
      kind: "exact",
      storedValue: "claude-opus-4-6-thinking",
    });
  });

  it("resolves on display name too", async () => {
    const r = await resolveModel("GPT-OSS");
    expect(r).toMatchObject({
      kind: "exact",
      storedValue: "gpt-oss-120b-medium",
    });
  });

  it("reports ambiguity rather than guessing", async () => {
    const r = await resolveModel("gemini-3.7");
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") throw new Error("unreachable");
    expect(r.matches).toHaveLength(3);
  });

  it("reports a miss for nonsense and for an empty query", async () => {
    expect((await resolveModel("nope-9000")).kind).toBe("missing");
    expect((await resolveModel("   ")).kind).toBe("missing");
  });

  it("synthesises an entry for an id the catalog does not list", async () => {
    expect(synthesizeUnknownModel("gemini-9.9-ultra-high")).toMatchObject({
      id: "gemini-9.9-ultra-high",
      provider: "google",
      selectable: true,
    });
    // getModelInfo never hides a configured model from /status.
    expect(await getModelInfo("something-new")).toMatchObject({
      id: "something-new",
      providerName: "Antigravity",
    });
  });

  it("defaults to the Flash-High Gemini", () => {
    expect(getDefaultModelId()).toBe("gemini-3.8-flash-high");
  });
});

describe("agy models — catalog surface", () => {
  it("groups providers by vendor with counts", async () => {
    const providers = await getProviders();
    expect(providers).toEqual(
      expect.arrayContaining([
        { id: "google", name: "Google", connected: true, modelCount: 10 },
        { id: "anthropic", name: "Anthropic", connected: true, modelCount: 2 },
        { id: "openai", name: "OpenAI", connected: true, modelCount: 1 },
      ]),
    );
  });

  it("pages one provider's models", async () => {
    const page = await getProviderModels("google", 2, 4);
    expect(page.total).toBe(10);
    expect(page.models).toHaveLength(4);
    expect((await getProviderModels("nobody")).models).toEqual([]);
  });

  it("marks the active model in the picker", async () => {
    const view = await getSettingsPresentation("gemini-3.1-pro-low");
    expect(view.totalCount).toBe(13);
    const active = view.modelButtons.find((b) => b.text.startsWith("● "));
    expect(active?.callback_data).toBe("settings:model:gemini-3.1-pro-low");
    expect(view.modelDetails[0]).toContain("gemini-3.1-pro-low");
  });

  it("has no free tier", async () => {
    expect(await listModels("free")).toEqual({ models: [], total: 0 });
    expect((await listModels("all")).total).toBe(13);
  });

  it("formats ambiguous and missing errors", async () => {
    const ambiguous = await resolveModel("gemini-3.7");
    expect(formatModelError("gemini-3.7", ambiguous)).toContain(
      "Multiple Antigravity models match",
    );
    expect(formatModelError("zzz", { kind: "missing" })).toContain(
      "gemini-3.8-flash-medium",
    );
  });
});

describe("agy models — probing and caching", () => {
  it("runs `agy models` once and serves the rest from cache", async () => {
    await refreshModels();
    await refreshModels();
    await resolveModel("claude-sonnet-4-6");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toEqual(["models"]);
    expect(getCachedModels()).toHaveLength(13);
  });

  it("re-probes when forced", async () => {
    await refreshModels();
    await refreshModels(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous catalog when a probe fails", async () => {
    await refreshModels();
    execFileMock.mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) =>
        cb(new Error("boom")),
    );
    expect(await refreshModels(true)).toHaveLength(13);
  });

  it("shares one spawn between concurrent callers", async () => {
    await Promise.all([refreshModels(), refreshModels(), refreshModels()]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("agy effort mapping", () => {
  it("maps only the three levels --effort accepts", () => {
    expect(toAgyEffort("low")).toBe("low");
    expect(toAgyEffort("medium")).toBe("medium");
    expect(toAgyEffort("high")).toBe("high");
    for (const level of [
      "off",
      "minimal",
      "xhigh",
      "max",
      undefined,
    ] as const) {
      expect(toAgyEffort(level)).toBeUndefined();
    }
  });

  it("reads and strips the suffix baked into an id", () => {
    expect(effortSuffixOf("gemini-3.8-flash-high")).toBe("high");
    expect(effortSuffixOf("claude-sonnet-4-6")).toBeUndefined();
    expect(modelIdStem("gemini-3.8-flash-high")).toBe("gemini-3.8-flash");
    expect(modelIdStem("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("re-points a suffixed id at the sibling slug for the wanted effort", () => {
    const ids = parseAgyModels(TSV).map((m) => m.id);
    expect(applyEffortToModelId("gemini-3.7-flash-high", "low", ids)).toBe(
      "gemini-3.7-flash-low",
    );
  });

  it("never invents an id the CLI would reject", () => {
    const ids = parseAgyModels(TSV).map((m) => m.id);
    // 3.1 Pro has no -medium sibling: keep the id (composeAgyModelSelection
    // then drops the level rather than pair it with a conflicting suffix).
    expect(applyEffortToModelId("gemini-3.1-pro-high", "medium", ids)).toBe(
      "gemini-3.1-pro-high",
    );
    // A suffix-less id is never rewritten.
    expect(applyEffortToModelId("claude-sonnet-4-6", "high", ids)).toBe(
      "claude-sonnet-4-6",
    );
    // No effort requested: no rewrite.
    expect(applyEffortToModelId("gemini-3.7-flash-high", undefined, ids)).toBe(
      "gemini-3.7-flash-high",
    );
  });
});

describe("agy model/effort composition (agy >= 1.4 rejects conflicting pairs)", () => {
  const ids = parseAgyModels(TSV_144).map((m) => m.id);

  it("parses the 1.4.4 catalog, Argon included", () => {
    const models = parseAgyModels(TSV_144);
    expect(models).toHaveLength(13);
    const argon = models.find((m) => m.id === "gemini-4-argon-high");
    expect(argon).toMatchObject({
      displayName: "Gemini 4 Argon (High)",
      provider: "google",
      defaultReasoningLevel: "high",
      supportedReasoningLevels: ["low", "medium", "high"],
    });
    expect(
      models.find((m) => m.id === "gpt-oss-120b-medium")
        ?.supportedReasoningLevels,
    ).toEqual(["medium"]);
  });

  it("suffixed id + a different effort → the sibling slug, no --effort", () => {
    // The production failure: --model gemini-3.8-flash-high --effort medium.
    expect(
      composeAgyModelSelection("gemini-3.8-flash-high", "medium", ids),
    ).toEqual({ model: "gemini-3.8-flash-medium", effort: undefined });
    expect(
      composeAgyModelSelection("gemini-4-argon-medium", "low", ids),
    ).toEqual({ model: "gemini-4-argon-low", effort: undefined });
  });

  it("suffixed id + the same effort → the id, no redundant --effort", () => {
    expect(
      composeAgyModelSelection("gemini-3.8-flash-high", "high", ids),
    ).toEqual({ model: "gemini-3.8-flash-high", effort: undefined });
  });

  it("suffixed id whose sibling is not offered → keep the id, drop the level", () => {
    expect(composeAgyModelSelection("gpt-oss-120b-medium", "low", ids)).toEqual(
      { model: "gpt-oss-120b-medium", effort: undefined, dropped: "low" },
    );
    // Cold catalog: never guess — the pair would be rejected.
    expect(
      composeAgyModelSelection("gemini-3.8-flash-high", "medium", []),
    ).toEqual({
      model: "gemini-3.8-flash-high",
      effort: undefined,
      dropped: "medium",
    });
  });

  it("bare id + effort → --effort (the CLI accepts the stem form)", () => {
    expect(composeAgyModelSelection("gemini-3.8-flash", "low", ids)).toEqual({
      model: "gemini-3.8-flash",
      effort: "low",
    });
    expect(composeAgyModelSelection("claude-sonnet-5-5", "high", [])).toEqual({
      model: "claude-sonnet-5-5",
      effort: "high",
    });
  });

  it("no effort → the id untouched, no --effort", () => {
    expect(
      composeAgyModelSelection("gemini-3.8-flash-high", undefined, ids),
    ).toEqual({ model: "gemini-3.8-flash-high", effort: undefined });
  });

  it("never yields a suffixed id with a different --effort, for any input", () => {
    const models = parseAgyModels(TSV_144);
    const levels = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ] as const;
    for (const catalog of [models, []]) {
      for (const id of [...ids, "gemini-3.8-flash", "claude-sonnet-5-5"]) {
        for (const level of [...levels, undefined]) {
          const { model, effort } = selectAgyRun(id, level, catalog);
          const suffix = effortSuffixOf(model);
          if (suffix && effort) expect(effort).toBe(suffix);
        }
      }
    }
  });
});

describe("agy run selection", () => {
  const models = parseAgyModels(TSV_144);

  it("drops a level agy cannot express, and says so", () => {
    expect(selectAgyRun("gemini-4-argon-high", "xhigh", models)).toEqual({
      model: "gemini-4-argon-high",
      effort: undefined,
      dropped: "xhigh",
    });
  });

  it("drops a level the model does not offer", () => {
    expect(selectAgyRun("gpt-oss-120b-medium", "high", models)).toEqual({
      model: "gpt-oss-120b-medium",
      effort: undefined,
      dropped: "high",
    });
  });

  it("treats an id the catalog doesn't list as offering low/medium/high", () => {
    expect(selectAgyRun("claude-sonnet-5-5", "high", models)).toEqual({
      model: "claude-sonnet-5-5",
      effort: "high",
    });
  });

  it("probes a cold catalog for selection, then serves it cached", async () => {
    stubModelsOutput(TSV_144);
    const catalog = await catalogForSelection();
    expect(selectAgyRun("gemini-3.8-flash-high", "low", catalog)).toEqual({
      model: "gemini-3.8-flash-low",
      effort: undefined,
    });
    await catalogForSelection();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("agy missing-binary detection", () => {
  it("recognises node and bun spellings of a missing executable", () => {
    expect(
      isMissingBinary(
        Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }),
      ),
    ).toBe(true);
    expect(
      isMissingBinary(new Error('Executable not found in $PATH: "agy"')),
    ).toBe(true);
    expect(
      isMissingBinary(new Error("exited 1: Eligibility check failed")),
    ).toBe(false);
  });
});
