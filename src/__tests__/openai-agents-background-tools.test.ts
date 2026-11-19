/** Background-run tool scope for the openai-agents backend. */

import { describe, it, expect } from "vitest";
import {
  AGENT_PLUMBING_TOOLS,
  estimateToolSchemaTokens,
  resolveBackgroundToolScope,
  toolSurfaceWarning,
  TOOL_SCHEMA_WARN_TOKENS,
} from "../backend/openai-agents/guards/tool-surface.js";

const PLUGINS = ["github-tools", "playwright-tools"];

describe("openai-agents / background tool scope", () => {
  it("defaults to the lean plumbing set with no plugins", () => {
    for (const setting of [undefined, "lean"] as const) {
      expect(resolveBackgroundToolScope(setting, PLUGINS)).toEqual({
        tools: [...AGENT_PLUMBING_TOOLS],
        plugins: [],
      });
    }
    expect(AGENT_PLUMBING_TOOLS).toEqual([
      "report_result",
      "check_inbox",
      "message_parent",
      "message_peer",
      "list_peers",
    ]);
  });

  it('"full" means no lean scope at all', () => {
    expect(resolveBackgroundToolScope("full", PLUGINS)).toBeUndefined();
  });

  it("splits a list into extra Talon tools and whole plugin servers", () => {
    expect(
      resolveBackgroundToolScope(
        ["send", "github-tools", "brave-search", " ", "report_result"],
        PLUGINS,
      ),
    ).toEqual({
      tools: [...AGENT_PLUMBING_TOOLS, "send"],
      plugins: ["github-tools", "brave-search"],
    });
  });
});

describe("openai-agents / tool schema estimate", () => {
  it("counts name, description and parameters", () => {
    const small = estimateToolSchemaTokens([
      { name: "a", description: "", parameters: {} } as never,
    ]);
    const big = estimateToolSchemaTokens([
      { name: "a", description: "x".repeat(4000), parameters: {} } as never,
    ]);
    expect(small).toBeGreaterThan(0);
    expect(big - small).toBe(1000);
  });

  it("warns past the fixed budget, or past half a known context window", () => {
    expect(
      toolSurfaceWarning({ tokens: 2000, toolCount: 11, lean: true }),
    ).toBeNull();
    expect(
      toolSurfaceWarning({
        tokens: TOOL_SCHEMA_WARN_TOKENS + 1,
        toolCount: 300,
        lean: false,
      }),
    ).toMatch(/openaiBackgroundTools.*"lean"/);
    expect(
      toolSurfaceWarning({
        tokens: 20_000,
        toolCount: 50,
        contextWindow: 32_768,
        lean: true,
      }),
    ).toMatch(/over half the model's 32768-token context/);
    expect(
      toolSurfaceWarning({
        tokens: 20_000,
        toolCount: 50,
        contextWindow: 200_000,
        lean: false,
      }),
    ).toBeNull();
  });
});
