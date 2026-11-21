/**
 * Backend registry parity tests.
 *
 * Verifies that all built-in backends (Claude SDK, Kilo, OpenCode,
 * Codex, Antigravity, OpenAI Agents) register themselves into the registry with
 * the same composed `Backend` surface — so the dispatcher can swap
 * backends without leaking backend-specific behaviour upstream.
 *
 * Each backend factory's `init(config, ctx)` returns a `Backend`
 * with the capability slots Talon's core relies on. This file
 * doesn't actually CALL `init` (it would spawn real subprocesses);
 * instead it verifies registry presence + factory shape.
 */

import { describe, it, expect, beforeAll } from "vitest";

import {
  clearBackends,
  getBackend,
  listBackends,
  hasBackend,
  registerBackend,
} from "../core/agent-runtime/backend-registry.js";
import { createRemoteBackendFactory } from "../backend/remote-server/factory.js";
import {
  kiloProfile,
  opencodeProfile,
} from "../backend/remote-server/profiles/index.js";

const ALL_BACKENDS = [
  "claude",
  "kilo",
  "opencode",
  "codex",
  "agy",
  "openai-agents",
  "kimi",
] as const;

beforeAll(async () => {
  // Reset registry for a clean import. Each factory module's
  // side-effect import re-registers it; the remote-server family has no
  // factory module — a profile plus the shared factory is the driver, so
  // it registers the same way `backend/builtins.ts` does.
  clearBackends();
  await import("../backend/claude-sdk/factory.js");
  registerBackend(createRemoteBackendFactory(kiloProfile));
  registerBackend(createRemoteBackendFactory(opencodeProfile));
  await import("../backend/codex/factory.js");
  await import("../backend/agy/factory.js");
  await import("../backend/openai-agents/factory.js");
  await import("../backend/kimi/factory.js");
}, 30_000);

describe("backend registry parity — all built-in backends present", () => {
  it("registers Claude, Kilo, OpenCode, Codex, Antigravity, OpenAI Agents and Kimi", () => {
    for (const id of ALL_BACKENDS) {
      expect(hasBackend(id), `expected backend "${id}" registered`).toBe(true);
    }
  });

  it("listBackends returns them sorted by id", () => {
    const ids = listBackends().map((b) => b.id);
    expect(ids).toContain("agy");
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("kilo");
    expect(ids).toContain("kimi");
    expect(ids).toContain("opencode");
    expect(ids).toContain("openai-agents");
    // Sorted property: ids should equal their sorted-copy
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("every backend has a non-empty label", () => {
    for (const id of ALL_BACKENDS) {
      const factory = getBackend(id);
      expect(factory, `factory for ${id}`).toBeDefined();
      expect(factory!.label.length).toBeGreaterThan(0);
    }
  });

  it("every backend factory has an init function", () => {
    for (const id of ALL_BACKENDS) {
      const factory = getBackend(id);
      expect(typeof factory!.init).toBe("function");
    }
  });

  it("expected labels", () => {
    expect(getBackend("claude")?.label).toBe("Anthropic");
    expect(getBackend("kilo")?.label).toBe("Kilo");
    expect(getBackend("opencode")?.label).toBe("OpenCode");
    expect(getBackend("codex")?.label).toBe("Codex");
    expect(getBackend("agy")?.label).toBe("Antigravity");
    expect(getBackend("openai-agents")?.label).toBe("OpenAI Agents");
    expect(getBackend("kimi")?.label).toBe("Kimi");
  });

  it("gives OpenCode and Kilo live tool-refresh and prompt-control slots", async () => {
    for (const id of ["opencode", "kilo"] as const) {
      const instance = await getBackend(id)!.init({} as never, {
        getBridgePort: () => 19876,
        frontendName: "telegram",
      });
      expect(instance.backend.tools?.refreshTools).toBeTypeOf("function");
      expect(instance.backend.control?.updateSystemPrompt).toBeTypeOf(
        "function",
      );
      await instance.cleanup?.();
    }
  });

  it("gives OpenCode and Kilo the same session-warm hook as Claude", async () => {
    // `performSessionReset` calls `backend.sessions.warmSession` right
    // after a reset. Without the slot the remote-server backends silently
    // skipped it and the first turn on a fresh session serially paid
    // session creation plus a full plugin-MCP registration sweep — the
    // dominant cold-start cost on OpenCode/Kilo.
    for (const id of ["claude", "opencode", "kilo"] as const) {
      const instance = await getBackend(id)!.init({} as never, {
        getBridgePort: () => 19876,
        frontendName: "telegram",
      });
      expect(
        instance.backend.sessions?.warmSession,
        `expected ${id} to expose sessions.warmSession`,
      ).toBeTypeOf("function");
      await instance.cleanup?.();
    }
  });

  it("warms without throwing when the remote server is unreachable", async () => {
    // Contract: a warm-up is best-effort. `/reset` has already succeeded
    // by the time it runs, so a server that won't spawn must degrade to a
    // slow first turn — never reject and surface as a failed reset.
    for (const id of ["opencode", "kilo"] as const) {
      const instance = await getBackend(id)!.init({} as never, {
        getBridgePort: () => 19876,
        frontendName: "telegram",
      });
      await expect(
        instance.backend.sessions!.warmSession!("-100parity"),
      ).resolves.toBeUndefined();
      await instance.cleanup?.();
    }
  }, 60_000);
});

describe("backend registry parity — duplicate registration is rejected", () => {
  it("re-registering an existing id throws", async () => {
    const { registerBackend } =
      await import("../core/agent-runtime/backend-registry.js");
    expect(() =>
      registerBackend({
        id: "claude",
        label: "Duplicate",
        init: async () => ({ backend: {} as never }),
      }),
    ).toThrow(/already registered/);
  });
});
