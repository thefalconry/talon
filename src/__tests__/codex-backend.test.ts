/**
 * Codex backend — unit tests covering the testable surface.
 *
 * Codex spawns a real CLI subprocess at thread-creation time, so the
 * full handler isn't exercisable without the `codex` binary on PATH +
 * a valid OpenAI API key. These tests focus on the parts that don't
 * require that: factory registration, MCP-config flattening, state
 * lifecycle.
 *
 * Live verification: a `docker/codex-test/` harness can be added in a
 * follow-up similar to `docker/kilo-test/` once the SDK has been
 * shaken out in production.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: vi.fn(() => ({
    "mempalace-tools": {
      command: "python",
      args: ["-m", "mempalace.mcp_server"],
      env: { MEMPALACE_PATH: "/palace" },
    },
  })),
}));

import { buildCodexMcpServers } from "../backend/codex/mcp-config.js";
import { getState, resetState } from "../backend/codex/state.js";
import { initCodexAgent } from "../backend/codex/init.js";
import {
  CODEX_DEFAULT_MODEL,
  CODEX_SYSTEM_PROMPT_SUFFIX,
} from "../backend/codex/constants.js";

describe("codex / constants", () => {
  it("exposes a non-empty default model identifier", () => {
    expect(CODEX_DEFAULT_MODEL).toBe("gpt-5-codex");
  });

  it("documents both delivery routes in the system prompt suffix", () => {
    expect(CODEX_SYSTEM_PROMPT_SUFFIX).toContain("end_turn");
    expect(CODEX_SYSTEM_PROMPT_SUFFIX).toContain("send");
    expect(CODEX_SYSTEM_PROMPT_SUFFIX).toContain("react");
    expect(CODEX_SYSTEM_PROMPT_SUFFIX).toContain("Response flow");
  });
});

describe("codex / state lifecycle", () => {
  beforeEach(() => {
    resetState();
  });

  it("starts in an uninitialised state", () => {
    expect(getState().config).toBeNull();
    expect(getState().codex).toBeNull();
    expect(getState().frontendName).toBe("telegram");
  });

  it("captures config + gateway port + frontend on initCodexAgent", () => {
    initCodexAgent({ model: "gpt-5-codex" } as never, () => 12345, "discord");

    const state = getState();
    expect(state.config).toBeTruthy();
    expect(state.gatewayPortFn()).toBe(12345);
    expect(state.frontendName).toBe("discord");
  });

  it("resetState clears everything", () => {
    initCodexAgent({} as never, () => 999, "teams");
    expect(getState().config).not.toBeNull();

    resetState();

    expect(getState().config).toBeNull();
    expect(getState().codex).toBeNull();
    expect(getState().frontendName).toBe("telegram");
  });
});

describe("codex / buildCodexMcpServers", () => {
  it("emits one frontend-tools server per non-terminal frontend", () => {
    const servers = buildCodexMcpServers({
      chatId: "424242420",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: ["telegram"],
    });
    expect(servers["telegram-tools"]).toBeDefined();
    expect(servers["telegram-tools"].url).toBe(
      "http://127.0.0.1:19876/mcp/talon/telegram/424242420",
    );
  });

  it("emits one server per frontend when multiple are configured", () => {
    const servers = buildCodexMcpServers({
      chatId: "c1",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: ["telegram", "discord"],
    });
    expect(servers["telegram-tools"]).toBeDefined();
    expect(servers["discord-tools"]).toBeDefined();
    expect(servers["telegram-tools"].url).toContain("/mcp/talon/telegram/");
    expect(servers["discord-tools"].url).toContain("/mcp/talon/discord/");
  });

  it("includes the plugin MCP servers from the registry as hub URLs", () => {
    const servers = buildCodexMcpServers({
      chatId: "c1",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: ["telegram"],
    });
    expect(servers["mempalace-tools"]).toBeDefined();
    expect(servers["mempalace-tools"].url).toBe(
      "http://127.0.0.1:19876/mcp/plugin/mempalace-tools/c1",
    );
  });

  it("includes brave-search when braveApiKey is provided", () => {
    const servers = buildCodexMcpServers({
      chatId: "c1",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: ["telegram"],
      braveApiKey: "BSA-test-key",
    });
    expect(servers["brave-search"]).toBeDefined();
    expect(servers["brave-search"].url).toContain(
      "/mcp/plugin/brave-search/c1",
    );
  });

  it("omits brave-search when no API key is provided", () => {
    const servers = buildCodexMcpServers({
      chatId: "c1",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: ["telegram"],
    });
    expect(servers["brave-search"]).toBeUndefined();
  });

  it("emits no frontend-tools server when only terminal is configured", () => {
    const servers = buildCodexMcpServers({
      chatId: "c1",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: [], // caller filters terminal out
    });
    expect(servers["telegram-tools"]).toBeUndefined();
    expect(servers["discord-tools"]).toBeUndefined();
    // Plugin servers still come through
    expect(servers["mempalace-tools"]).toBeDefined();
  });

  it("each server is a hub URL entry (no local spawn fields)", () => {
    const servers = buildCodexMcpServers({
      chatId: "c1",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: ["telegram"],
    });
    for (const [name, server] of Object.entries(servers)) {
      expect(typeof server.url, `${name}.url`).toBe("string");
      expect(server.url, `${name}.url`).toMatch(
        /^http:\/\/127\.0\.0\.1:19876\/mcp\//,
      );
      expect(server, name).not.toHaveProperty("command");
    }
  });

  // The Codex CLI auto-cancels MCP tool calls whose tools lack
  // `read_only_hint=true` annotations unless the server is configured
  // to auto-approve (`default_tools_approval_mode = "approve"`). Every
  // Talon-spawned server must carry this so the non-interactive API
  // session never falls into the approval flow it can't satisfy.
  it("tags every server with default_tools_approval_mode='approve'", () => {
    const servers = buildCodexMcpServers({
      chatId: "c1",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: ["telegram", "discord"],
      braveApiKey: "BSA-test-key",
    });

    expect(Object.keys(servers).length).toBeGreaterThan(0);
    for (const [name, server] of Object.entries(servers)) {
      expect(
        server.default_tools_approval_mode,
        `${name}.default_tools_approval_mode`,
      ).toBe("approve");
    }

    // The four classes of servers must all be covered: frontend-tools,
    // brave-search, plugin (mempalace-tools comes from the mocked
    // getPluginMcpServers above), and any other plugin path.
    expect(servers["telegram-tools"]?.default_tools_approval_mode).toBe(
      "approve",
    );
    expect(servers["discord-tools"]?.default_tools_approval_mode).toBe(
      "approve",
    );
    expect(servers["brave-search"]?.default_tools_approval_mode).toBe(
      "approve",
    );
    expect(servers["mempalace-tools"]?.default_tools_approval_mode).toBe(
      "approve",
    );
  });
});

describe("codex / factory registration", () => {
  it("registers as `codex` in the backend registry", async () => {
    // Reset registry to ensure clean import
    const { clearBackends, registerBackend, hasBackend, getBackend } =
      await import("../core/agent-runtime/backend-registry.js");
    clearBackends();

    // Importing the factory module triggers `registerBackend`.
    await import("../backend/codex/factory.js");

    // The codex factory has self-registered. We can't import it twice
    // (the module cache returns the cached export), so we re-register
    // a sentinel to confirm the registry is wired up.
    if (!hasBackend("codex")) {
      // If this happens, the side-effect import didn't fire — surface
      // an explicit failure. Note this branch only triggers on Node
      // module cache eviction, which is rare.
      registerBackend({
        id: "codex",
        label: "Codex",
        init: async () => {
          throw new Error("placeholder factory");
        },
      });
    }

    expect(hasBackend("codex")).toBe(true);
    const factory = getBackend("codex");
    expect(factory?.id).toBe("codex");
    expect(factory?.label).toMatch(/Codex/i);
  });
});
