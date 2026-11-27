/**
 * Kimi factory tests — `init()` must produce a composed
 * `Backend` whose capability slots match what Talon's core expects,
 * without spawning the real CLI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock, execFile: execFileMock };
});

const { getBackend, hasBackend } =
  await import("../core/agent-runtime/backend-registry.js");
const { BACKEND_IDS, isBackendId } =
  await import("../core/agent-runtime/model-ref.js");
const { resetState, getState } = await import("../backend/kimi/state.js");
const { resetModelCache } = await import("../backend/kimi/models.js");

await import("../backend/kimi/factory.js");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kimi-factory-"));
  resetState();
  resetModelCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const initBackend = () =>
  getBackend("kimi")!.init(
    {
      model: "openrouter/moonshotai/kimi-k3",
      workspace: home,
      systemPrompt: "test",
      frontend: "telegram",
    } as never,
    { getBridgePort: () => 19876, frontendName: "telegram" },
  );

describe("kimi factory — registry presence", () => {
  it("registers under the id `kimi` with the Kimi label", () => {
    expect(hasBackend("kimi")).toBe(true);
    expect(getBackend("kimi")?.label).toBe("Kimi");
  });

  it("is a canonical backend id", () => {
    expect(BACKEND_IDS).toContain("kimi");
    expect(isBackendId("kimi")).toBe(true);
    expect(isBackendId("moonshot")).toBe(false);
  });

  it("exposes doctor checks off the registry", () => {
    expect(typeof getBackend("kimi")?.doctor).toBe("function");
  });
});

describe("kimi factory — composed capability slots", () => {
  it("wires every slot Talon's core reads", async () => {
    const { backend, cleanup } = await initBackend();
    expect(backend.id).toBe("kimi");
    expect(backend.label).toBe("Kimi");
    expect(backend.cacheMetrics).toBe("none");

    expect(typeof backend.chat?.runChatTurn).toBe("function");
    expect(typeof backend.chat?.interruptChatTurn).toBe("function");
    expect(typeof backend.background?.runOneShotAgent).toBe("function");
    expect(typeof backend.background?.evictOrphanSubprocesses).toBe("function");
    expect(typeof backend.models?.resolveModelInfo).toBe("function");
    expect(typeof backend.models?.getRawModelInfo).toBe("function");
    expect(typeof backend.models?.getSettingsPresentation).toBe("function");
    expect(typeof backend.models?.getProviders).toBe("function");
    expect(typeof backend.models?.getProviderModels).toBe("function");
    expect(typeof backend.models?.formatModelError).toBe("function");
    expect(typeof backend.models?.listModels).toBe("function");
    expect(typeof backend.sessions?.resetChat).toBe("function");
    expect(typeof backend.sessions?.warmSession).toBe("function");
    expect(typeof backend.tools?.refreshTools).toBe("function");
    expect(typeof backend.usage?.getSessionSnapshot).toBe("function");
    expect(typeof backend.usage?.getPlanUsage).toBe("function");
    expect(typeof backend.control?.updateSystemPrompt).toBe("function");
    await cleanup?.();
  });

  it("defaults to the kimi-k3 model", async () => {
    const { backend, cleanup } = await initBackend();
    expect(await backend.models?.getDefaultModelId()).toBe(
      "openrouter/moonshotai/kimi-k3",
    );
    await cleanup?.();
  });

  it("has no plan-usage endpoint to report", async () => {
    const { backend, cleanup } = await initBackend();
    await expect(backend.usage!.getPlanUsage!()).resolves.toBeUndefined();
    await cleanup?.();
  });

  it("stores an updated system prompt for the next new conversation", async () => {
    const { backend, cleanup } = await initBackend();
    backend.control!.updateSystemPrompt("fresh prompt");
    expect(getState().systemPromptOverride).toBe("fresh prompt");
    await cleanup?.();
  });

  it("answers getSessionSnapshot from the chat's last usage", async () => {
    const { backend, cleanup } = await initBackend();
    getState().lastUsage.set("-100x", {
      inputTokens: 100,
      outputTokens: 50,
      cacheRead: 20,
      cacheWrite: 0,
      contextModelId: "openrouter/moonshotai/kimi-k3",
    });
    await expect(backend.usage!.getSessionSnapshot!("-100x")).resolves.toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheRead: 20,
      cacheWrite: 0,
      contextModelId: "openrouter/moonshotai/kimi-k3",
    });
    await expect(
      backend.usage!.getSessionSnapshot!("-100nothing"),
    ).resolves.toBeUndefined();
    await cleanup?.();
  });

  it("cleanup clears state and is safe to call twice", async () => {
    const { cleanup } = await initBackend();
    await cleanup?.();
    await cleanup?.();
    expect(getState().config).toBeNull();
  });
});
