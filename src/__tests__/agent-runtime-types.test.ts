/**
 * Pure type helpers under `src/core/agent-runtime/`.
 */

import { describe, it, expect } from "vitest";
import { emptyUsage } from "../core/agent-runtime/events.js";
import {
  BACKEND_IDS,
  isBackendId,
  makeBareModelRef,
} from "../core/agent-runtime/model-ref.js";
import { composeBackend } from "../core/agent-runtime/capabilities.js";

// ── events ──────────────────────────────────────────────────────────────────

describe("agent-runtime/events", () => {
  it("emptyUsage returns zeros with no modelId", () => {
    const usage = emptyUsage();
    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect("modelId" in usage).toBe(false);
  });
});

// ── model-ref ───────────────────────────────────────────────────────────────

describe("agent-runtime/model-ref", () => {
  it("BACKEND_IDS pins the seven current backends", () => {
    expect([...BACKEND_IDS].sort()).toEqual([
      "agy",
      "claude",
      "codex",
      "kilo",
      "kimi",
      "openai-agents",
      "opencode",
    ]);
  });

  it("isBackendId narrows valid ids", () => {
    // The Antigravity backend's id is `agy`, not `antigravity` — the
    // rejection of the latter is asserted below and is load-bearing:
    // config files and chat overrides are validated through this guard.
    expect(isBackendId("agy")).toBe(true);
    expect(isBackendId("claude")).toBe(true);
    expect(isBackendId("codex")).toBe(true);
    expect(isBackendId("kimi")).toBe(true);
    expect(isBackendId("openai-agents")).toBe(true);
    expect(isBackendId("kilo")).toBe(true);
    expect(isBackendId("opencode")).toBe(true);
  });

  it("isBackendId rejects unknown ids and non-strings", () => {
    expect(isBackendId("antigravity")).toBe(false);
    expect(isBackendId("CLAUDE")).toBe(false);
    expect(isBackendId("")).toBe(false);
    expect(isBackendId(undefined)).toBe(false);
    expect(isBackendId(null)).toBe(false);
    expect(isBackendId(42)).toBe(false);
    expect(isBackendId({ id: "claude" })).toBe(false);
  });

  it("makeBareModelRef sets sensible defaults", () => {
    const ref = makeBareModelRef("codex", "gpt-5.5");
    expect(ref).toEqual({
      backend: "codex",
      id: "gpt-5.5",
      displayName: "gpt-5.5",
      source: "unknown",
      cacheSupport: "none",
      selectable: true,
    });
  });

  it("makeBareModelRef respects the source override", () => {
    const ref = makeBareModelRef("kilo", "kilo/qwen-2.5-coder", "discovered");
    expect(ref.source).toBe("discovered");
  });
});

// ── capabilities ────────────────────────────────────────────────────────────

describe("agent-runtime/capabilities", () => {
  it("composeBackend leaves omitted slots undefined", () => {
    const backend = composeBackend({
      id: "claude",
      label: "Test",
      chat: { runChatTurn: async function* () {} },
      background: { runOneShotAgent: async () => undefined },
    });
    expect(backend.chat).toBeDefined();
    expect(backend.background).toBeDefined();
    expect(backend.models).toBeUndefined();
    expect(backend.sessions).toBeUndefined();
    expect(backend.tools).toBeUndefined();
    expect(backend.usage).toBeUndefined();
    expect(backend.control).toBeUndefined();
  });

  it("composeBackend defaults cacheMetrics to none", () => {
    const backend = composeBackend({
      id: "claude",
      label: "Test",
      chat: { runChatTurn: async function* () {} },
    });
    expect(backend.cacheMetrics).toBe("none");
  });
});
