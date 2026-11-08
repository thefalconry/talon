/**
 * `<alias-or-id>[1m]` on the claude backend.
 *
 * Claude Code accepts a `[1m]` suffix on any alias or id to select the
 * 1M-context variant, but the SDK's `supportedModels()` no longer lists the
 * suffixed forms — so a config pinned to "opus[1m]" resolved as `missing`,
 * the boot audit warned, and every turn ran "default". These tests pin:
 *   - the catalog resolves `[1m]` queries against the base model while
 *     keeping the suffix in the id handed to the SDK;
 *   - the active-model chain honours a pinned `config.model` over the
 *     claude backend's canonical "default".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
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

const { clearModels } = await import("../core/models/catalog.js");
const { convertSdkModels } =
  await import("../backend/claude-sdk/models/convert.js");
const { registerClaudeModelsStatic } =
  await import("../backend/claude-sdk/models/discovery.js");
const { resolveModel, getModelInfo } =
  await import("../backend/claude-sdk/model-provider.js");
const { resolveActiveModelForChat } =
  await import("../core/models/active-model.js");
const { auditConfiguredModels } = await import("../core/engine/model-audit.js");
const { composeBackend } =
  await import("../core/agent-runtime/capabilities.js");
import type { ModelCatalog } from "../core/agent-runtime/capabilities.js";
import type { TalonConfig } from "../core/config/index.js";

const effort = {
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
};

/** Verbatim shape of `supportedModels()` from the live SDK (2026-09). */
const LIVE_SDK_MODELS = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
    ...effort,
  },
  {
    value: "opus",
    displayName: "Opus 5.5",
    description: "For complex work and everyday tasks",
    ...effort,
  },
  {
    value: "sonnet",
    displayName: "Sonnet 5.5",
    description: "Most efficient for simpler tasks",
    ...effort,
  },
  {
    value: "haiku",
    displayName: "Haiku 4.5",
    description: "Fastest for quick answers",
  },
  {
    value: "claude-opus-4-7",
    displayName: "Opus 4.7",
    description: "Best for everyday, complex tasks",
    ...effort,
  },
];

function claudeBackend() {
  const models = {
    resolveModelInfo: (q: string) => resolveModel(q),
    getDefaultModelId: () => "default",
    getRawModelInfo: (id: string) => getModelInfo(id),
  } as unknown as ModelCatalog;
  return composeBackend({
    id: "claude",
    label: "Anthropic",
    cacheMetrics: "readwrite",
    models,
  });
}

function config(model: string | undefined): TalonConfig {
  return { backend: "claude", model } as unknown as TalonConfig;
}

beforeEach(() => {
  clearModels();
  registerClaudeModelsStatic(convertSdkModels(LIVE_SDK_MODELS));
});

describe("claude catalog — [1m] suffix", () => {
  it("resolves opus[1m] exactly, keeping the suffix for the SDK", async () => {
    const res = await resolveModel("opus[1m]");
    expect(res.kind).toBe("exact");
    if (res.kind !== "exact") return;
    expect(res.storedValue).toBe("opus[1m]");
    expect(res.model.id).toBe("opus[1m]");
    expect(res.model.displayName).toContain("1M context");
    expect(res.model.contextWindow).toBe(1_000_000);
    expect(res.model.supportedReasoningLevels).toContain("max");
  });

  it("resolves sonnet[1m] and a full id with the suffix", async () => {
    const sonnet = await resolveModel("sonnet[1m]");
    expect(sonnet).toMatchObject({ kind: "exact", storedValue: "sonnet[1m]" });
    const pinned = await resolveModel("claude-opus-4-7[1m]");
    expect(pinned).toMatchObject({
      kind: "exact",
      storedValue: "claude-opus-4-7[1m]",
    });
    // A version alias canonicalises to the concrete id, suffix preserved.
    const versioned = await resolveModel("opus-4.7[1m]");
    expect(versioned).toMatchObject({
      kind: "exact",
      storedValue: "claude-opus-4-7[1m]",
    });
  });

  it("getModelInfo (ref materialisation) keeps the [1m] id", async () => {
    expect((await getModelInfo("opus[1m]"))?.id).toBe("opus[1m]");
  });

  it("still reports unknown bases and default[1m] as missing", async () => {
    expect((await resolveModel("nonexistent[1m]")).kind).toBe("missing");
    expect((await resolveModel("default[1m]")).kind).toBe("missing");
  });

  it("an SDK-listed [1m] variant still resolves to its own entry", async () => {
    clearModels();
    registerClaudeModelsStatic(
      convertSdkModels([
        ...LIVE_SDK_MODELS,
        {
          value: "sonnet[1m]",
          displayName: "Sonnet (1M context)",
          description: "Sonnet 5.5 with 1M context · Large context window",
          ...effort,
        },
      ]),
    );
    const res = await resolveModel("sonnet[1m]");
    expect(res).toMatchObject({ kind: "exact", storedValue: "sonnet[1m]" });
  });

  it("the boot model audit no longer flags opus[1m]", async () => {
    const be = claudeBackend();
    const findings = await auditConfiguredModels(config("opus[1m]"), () => be);
    expect(findings).toEqual([]);
  });
});

describe("active model — pinned config.model beats the claude default", () => {
  it("runs the pinned opus[1m] instead of the canonical default", async () => {
    const result = await resolveActiveModelForChat(
      "chat-1m-a",
      claudeBackend(),
      "claude",
      config("opus[1m]"),
    );
    expect(result.model).toBe("opus[1m]");
    expect(result.source).toBe("config-legacy-global");
    // The ref id is what the weaver hands the backend as the SDK model.
    expect(result.ref?.id).toBe("opus[1m]");
  });

  it("falls back to the canonical default when the pin is unknown", async () => {
    const result = await resolveActiveModelForChat(
      "chat-1m-b",
      claudeBackend(),
      "claude",
      config("claude-withdrawn-9"),
    );
    expect(result).toMatchObject({
      model: "default",
      source: "backend-canonical",
    });
  });

  it("uses the canonical default when no model is pinned", async () => {
    const result = await resolveActiveModelForChat(
      "chat-1m-c",
      claudeBackend(),
      "claude",
      config(undefined),
    );
    expect(result).toMatchObject({
      model: "default",
      source: "backend-canonical",
    });
  });
});
