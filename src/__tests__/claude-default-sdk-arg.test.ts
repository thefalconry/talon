/**
 * "default" must never reach the Claude SDK as-is: the CLI reads it as "no
 * override" and falls back to the account's settings.json `model`, which can
 * name a different model (Fable) from the one the picker showed (Opus).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const { clearModels } = await import("../core/models/catalog.js");
const { convertSdkModels } =
  await import("../backend/claude-sdk/models/convert.js");
const { registerClaudeModelsStatic } =
  await import("../backend/claude-sdk/models/discovery.js");
const { toSdkModelArg } =
  await import("../backend/claude-sdk/models/sdk-arg.js");

const effort = { supportsEffort: true, supportedEffortLevels: ["low", "high"] };

describe("toSdkModelArg", () => {
  beforeEach(() => {
    clearModels();
    registerClaudeModelsStatic(
      convertSdkModels([
        {
          value: "default",
          displayName: "Default (recommended)",
          description: "Opus 5.5 · Best for everyday, complex tasks",
          ...effort,
        },
        { value: "opus", displayName: "Opus 5.5", description: "x", ...effort },
        {
          value: "fable",
          displayName: "Fable 5.2",
          description: "y",
          ...effort,
        },
        { value: "sonnet", displayName: "Sonnet 5.5", description: "z" },
      ]),
    );
  });

  it("pins the default alias to its concrete id", () => {
    expect(toSdkModelArg("default")).toBe("claude-opus-5-5");
    expect(toSdkModelArg(" Default ")).toBe("claude-opus-5-5");
  });

  it("keeps a requested 1M suffix", () => {
    expect(toSdkModelArg("default[1m]")).toBe("claude-opus-5-5[1m]");
  });

  it("leaves every other model untouched", () => {
    expect(toSdkModelArg("fable")).toBe("fable");
    expect(toSdkModelArg("opus[1m]")).toBe("opus[1m]");
    expect(toSdkModelArg("claude-opus-4-7")).toBe("claude-opus-4-7");
    expect(toSdkModelArg(undefined)).toBeUndefined();
  });

  it("passes default through when the catalog cannot name it", () => {
    clearModels();
    expect(toSdkModelArg("default")).toBe("default");
  });
});
