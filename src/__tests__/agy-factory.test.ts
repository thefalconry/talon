/**
 * Antigravity factory tests — `init()` must produce a composed
 * `Backend` whose capability slots match what Talon's core expects,
 * without spawning the real CLI.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock, execFile: execFileMock };
});
vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
  getPluginPromptAdditions: vi.fn(() => []),
}));

const { getBackend, hasBackend } =
  await import("../core/agent-runtime/backend-registry.js");
const { BACKEND_IDS, isBackendId } =
  await import("../core/agent-runtime/model-ref.js");
const { resetState, getState } = await import("../backend/agy/state.js");
const { resetModelCache } = await import("../backend/agy/models.js");
const { resetOwnership } = await import("../backend/agy/mcp/register.js");

await import("../backend/agy/factory.js");

let home: string;

/**
 * Sink the MCP-config env points at between tests, so nothing can ever
 * fall back to the real `~/.gemini/config/mcp_config.json`.
 */
const SINK = mkdtempSync(join(tmpdir(), "agy-sink-"));
process.env.TALON_AGY_MCP_CONFIG = join(SINK, "mcp_config.json");
process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(SINK, "snapshots");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agy-factory-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    join(home, "config", "mcp_config.json"),
    JSON.stringify({ mcpServers: {} }),
  );
  process.env.TALON_AGY_MCP_CONFIG = join(home, "config", "mcp_config.json");
  process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(home, "snapshots");
  execFileMock.mockImplementation(
    (
      _c: string,
      _a: string[],
      _o: unknown,
      cb: (e: unknown, r: { stdout: string; stderr: string }) => void,
    ) => cb(null, { stdout: "gemini-3.8-flash-high\tGemini\n", stderr: "" }),
  );
  resetState();
  resetModelCache();
  resetOwnership();
});

afterEach(() => {
  // Never unset the injection env: a late async write (a retry ladder
  // resolving after the test returned) would otherwise land in the
  // developer's REAL ~/.gemini/config/mcp_config.json. Point it at a
  // per-file sink instead.
  process.env.TALON_AGY_MCP_CONFIG = join(SINK, "mcp_config.json");
  process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(SINK, "snapshots");
  rmSync(home, { recursive: true, force: true });
});

const initBackend = () =>
  getBackend("agy")!.init(
    {
      model: "gemini-3.8-flash-high",
      workspace: home,
      systemPrompt: "test",
      frontend: "telegram",
    } as never,
    { getBridgePort: () => 19876, frontendName: "telegram" },
  );

describe("agy factory — registry presence", () => {
  it("registers under the id `agy` with the Antigravity label", () => {
    expect(hasBackend("agy")).toBe(true);
    expect(getBackend("agy")?.label).toBe("Antigravity");
  });

  it("is a canonical backend id — and `antigravity` is not", () => {
    expect(BACKEND_IDS).toContain("agy");
    expect(isBackendId("agy")).toBe(true);
    expect(isBackendId("antigravity")).toBe(false);
  });

  it("exposes doctor checks off the registry", () => {
    expect(typeof getBackend("agy")?.doctor).toBe("function");
  });
});

describe("agy factory — composed capability slots", () => {
  it("wires every slot Talon's core reads", async () => {
    const { backend, cleanup } = await initBackend();
    expect(backend.id).toBe("agy");
    expect(backend.label).toBe("Antigravity");
    // agy reports cache reads but never cache writes.
    expect(backend.cacheMetrics).toBe("read");

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

  it("defaults to the Flash-High Gemini", async () => {
    const { backend, cleanup } = await initBackend();
    expect(await backend.models?.getDefaultModelId()).toBe(
      "gemini-3.8-flash-high",
    );
    await cleanup?.();
  });

  it("reads plan windows from `agy -p /usage`", async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
        stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
        kill: () => true,
      });
      setTimeout(() => {
        child.stdout.emit(
          "data",
          "Gemini Models\tFive Hour Limit Remaining\t75%\t2026-09-23T21:23:05Z\n",
        );
        child.emit("close", 0);
      }, 1);
      return child;
    });
    const { backend, cleanup } = await initBackend();
    const usage = await backend.usage!.getPlanUsage!();
    expect(spawnMock).toHaveBeenCalledWith(
      "agy",
      ["-p", "/usage", "--output-format", "text"],
      expect.anything(),
    );
    expect(usage?.windows).toEqual([
      {
        label: "Gemini · 5h",
        percent: 25,
        resetsAt: "2026-09-23T21:23:05Z",
      },
    ]);
    await cleanup?.();
  });

  it("stores an updated system prompt for the next new conversation", async () => {
    const { backend, cleanup } = await initBackend();
    backend.control!.updateSystemPrompt("fresh prompt");
    expect(getState().systemPromptOverride).toBe("fresh prompt");
    await cleanup?.();
  });

  it("answers getSessionSnapshot from the chat's last cumulative usage", async () => {
    const { backend, cleanup } = await initBackend();
    getState().lastUsage.set("-100x", {
      inputTokens: 7,
      outputTokens: 3,
      cacheRead: 1,
      cacheWrite: 0,
      contextModelId: "gemini-3.8-flash-high",
    });
    await expect(backend.usage!.getSessionSnapshot!("-100x")).resolves.toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheRead: 1,
      cacheWrite: 0,
      contextModelId: "gemini-3.8-flash-high",
    });
    await expect(
      backend.usage!.getSessionSnapshot!("-100nothing"),
    ).resolves.toBeUndefined();
    await cleanup?.();
  });

  it("never spawns the CLI just to initialise", async () => {
    const { cleanup } = await initBackend();
    expect(spawnMock).not.toHaveBeenCalled();
    await cleanup?.();
  });

  it("cleanup clears state and is safe to call twice", async () => {
    const { cleanup } = await initBackend();
    await cleanup?.();
    await cleanup?.();
    expect(getState().config).toBeNull();
  });
});
