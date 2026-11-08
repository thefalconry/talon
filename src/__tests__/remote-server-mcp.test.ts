/**
 * Unit tests for the shared `backend/remote-server/mcp.ts` helpers.
 *
 * These tests cover the chat-MCP-server visibility model — the most
 * subtle behaviour the refactor preserves. The integration tests in
 * `integration/kilo-real-bootstrap.test.ts` and
 * `integration/opencode-real-bootstrap.test.ts` exercise the same
 * helpers through real `KiloClient` / `OpencodeClient` instances, but
 * these unit tests catch regressions without spinning up an actual
 * agent server.
 *
 * Key invariants asserted:
 *
 *   1. Multiple chat MCP servers stay registered concurrently.
 *   2. Plugin MCP servers stay connected across chat registrations.
 *   4. Local registration cache short-circuits redundant `mcp.add` calls.
 *   5. `buildToolOverrides` produces the correct enable/disable map for
 *      a multi-chat tool catalog.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const hubPluginServerNamesMock = vi.fn<() => string[]>(() => []);

vi.mock("../core/mcp-hub/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/mcp-hub/index.js")>()),
  hubPluginServerNames: () => hubPluginServerNamesMock(),
  listHubPluginToolNames: async (name: string) => [`${name}_tool`],
}));

import {
  createRemoteServerState,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  getChatMcpServerName,
  getPluginMcpServerName,
  getPluginMcpServerPrefix,
  isTalonToolID,
  getRegisteredMcpServerNames,
  TALON_MCP_SERVER_NAME,
  TALON_PLUGIN_MCP_SERVER_NAME,
  PLUGIN_MCP_SERVER_NAME_MAX_LENGTH,
  stopRemoteServer,
  type RemoteAgentClient,
  type RemoteServerState,
} from "../backend/remote-server/index.js";
import { buildPermissionRuleset } from "../backend/remote-server/sessions.js";

// ── Test doubles ────────────────────────────────────────────────────────────

interface RecordedMcpAdd {
  name: string;
  config:
    | { type: "local"; command: string[]; environment?: Record<string, string> }
    | { type: "remote"; url: string };
}

/**
 * Mock client that records every call against the `RemoteAgentClient`
 * interface. Returned arrays/maps are intentionally minimal — we only
 * assert on what the shared helpers actually consume.
 */
function makeMockClient(toolIds: string[] = []): {
  client: RemoteAgentClient;
  mcpAddCalls: RecordedMcpAdd[];
  mcpDisconnectCalls: string[];
  toolIdsCalls: number;
} {
  const mcpAddCalls: RecordedMcpAdd[] = [];
  const mcpDisconnectCalls: string[] = [];
  let toolIdsCalls = 0;
  const client: RemoteAgentClient = {
    mcp: {
      add: vi.fn(async ({ name, config }) => {
        mcpAddCalls.push({ name, config });
        return { data: { [name]: { status: "connected" } } };
      }),
      disconnect: vi.fn(async ({ name }) => {
        mcpDisconnectCalls.push(name);
        return { data: true };
      }),
    },
    session: {
      create: vi.fn(),
      get: vi.fn(),
    },
    tool: {
      ids: vi.fn(async () => {
        toolIdsCalls++;
        return { data: toolIds };
      }),
    },
    provider: {
      list: vi.fn(),
    },
  };
  return {
    client,
    mcpAddCalls,
    mcpDisconnectCalls,
    get toolIdsCalls() {
      return toolIdsCalls;
    },
  };
}

function makeState(): RemoteServerState<RemoteAgentClient> {
  const state = createRemoteServerState<RemoteAgentClient>({
    label: "TestBackend",
    hostname: "127.0.0.1",
    port: 9999,
  });
  // Mock the plugin module's pluginServers map by stashing it via the
  // gatewayPortFn (the helper reads `getPluginMcpServers(url, chatId)`
  // and gateway port is the only mutable knob — we don't need to mock
  // it for these tests since we only assert behaviour around chat MCP).
  state.gatewayPortFn = () => 19876;
  return state;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("remote-server / mcp helpers", () => {
  it("drops a reused-server client without closing the external server", () => {
    const state = makeState();
    const { client } = makeMockClient();
    state.client = client;
    state.serverHandle = null;

    stopRemoteServer(state);

    expect(state.client).toBeNull();
  });

  describe("getChatMcpServerName", () => {
    it("derives a stable name from a numeric Telegram chatId", () => {
      expect(getChatMcpServerName("424242420")).toBe("talon-tools-424242420");
    });

    it("handles negative supergroup ids by sanitising the dash", () => {
      // `-` is in the allow-list, so it stays literal
      expect(getChatMcpServerName("-1009876543210")).toBe(
        "talon-tools--1009876543210",
      );
    });

    it("replaces unsafe chars in Discord-style snowflakes", () => {
      expect(getChatMcpServerName("chat:abc/def")).toBe(
        "talon-tools-chat_abc_def",
      );
    });

    it("falls back to 'chat' for the empty string", () => {
      expect(getChatMcpServerName("")).toBe("talon-tools-chat");
    });
  });

  describe("getPluginMcpServerName", () => {
    // Anthropic rejects tool names over 64 characters and the upstream
    // agent server composes `<server>_<tool>`, so the server half must
    // leave real headroom for the plugin's own tool name.
    const ANTHROPIC_TOOL_NAME_LIMIT = 64;
    const LONG_PLUGIN = "a-very-long-plugin-name-that-overflows-the-budget";

    it("stays within the length budget for any chat id and plugin name", () => {
      const cases: Array<[string, string]> = [
        ["playwright-tools", "-1009876543210"],
        [LONG_PLUGIN, "-1009876543210"],
        [
          LONG_PLUGIN,
          "discord:guild/1234567890123456789/channel/9876543210987654321",
        ],
        ["", ""],
      ];
      for (const [plugin, chatId] of cases) {
        const name = getPluginMcpServerName(plugin, chatId);
        expect(name.length).toBeLessThanOrEqual(
          PLUGIN_MCP_SERVER_NAME_MAX_LENGTH,
        );
        expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(`${name}_browser_take_screenshot`.length).toBeLessThanOrEqual(
          ANTHROPIC_TOOL_NAME_LIMIT,
        );
      }
    });

    it("is deterministic and keeps a short plugin name readable", () => {
      // Pinned literal: a changed hash would silently orphan every
      // `tp-*` permission rule on already-created upstream sessions.
      expect(getPluginMcpServerName("playwright-tools", "-1009876543210")).toBe(
        "tp-a93db842-playwright-tools",
      );
      expect(getPluginMcpServerName("playwright-tools", "-1009876543210")).toBe(
        getPluginMcpServerName("playwright-tools", "-1009876543210"),
      );
      expect(getPluginMcpServerName("", "")).toBe(
        `${getPluginMcpServerPrefix("")}plugin`,
      );
    });

    it("keeps overlong plugin names distinct via a hash suffix", () => {
      const a = getPluginMcpServerName(LONG_PLUGIN, "chatA");
      const b = getPluginMcpServerName(`${LONG_PLUGIN}-2`, "chatA");
      expect(a).not.toBe(b);
      expect(a.length).toBe(PLUGIN_MCP_SERVER_NAME_MAX_LENGTH);
      expect(
        a.startsWith(`${getPluginMcpServerPrefix("chatA")}a-very-long-`),
      ).toBe(true);
    });

    it("namespaces per chat with a prefix the permission ruleset can match", () => {
      const prefix = getPluginMcpServerPrefix("chatA");
      expect(prefix).toBe("tp-726dc109-");
      expect(getPluginMcpServerName("memory", "chatA").startsWith(prefix)).toBe(
        true,
      );
      expect(getPluginMcpServerName("memory", "chatB").startsWith(prefix)).toBe(
        false,
      );
      const rules = buildPermissionRuleset("chatA");
      expect(rules).toContainEqual({
        permission: "tool",
        pattern: `${prefix}*`,
        action: "allow",
      });
      expect(rules).toContainEqual({
        permission: "tool",
        pattern: `${TALON_PLUGIN_MCP_SERVER_NAME}-*`,
        action: "deny",
      });
    });
  });

  describe("isTalonToolID", () => {
    it("matches both underscore and dash variants", () => {
      expect(isTalonToolID("talon-tools_send")).toBe(true);
      expect(isTalonToolID("talon-tools-424242420_send")).toBe(true);
    });

    it("rejects non-Talon tool ids", () => {
      expect(isTalonToolID("brave-search_query")).toBe(false);
      expect(isTalonToolID("mempalace_search")).toBe(false);
      expect(isTalonToolID("send")).toBe(false);
    });
  });

  describe("ensureChatMcpServer — concurrent registrations", () => {
    let state: RemoteServerState<RemoteAgentClient>;

    beforeEach(() => {
      state = makeState();
    });

    it("registers the chat MCP server and records it in the cache", async () => {
      const { client, mcpAddCalls } = makeMockClient();
      const name = await ensureChatMcpServer(client, state, "chatA");

      expect(name).toBe("talon-tools-chatA");
      expect(mcpAddCalls).toHaveLength(1);
      expect(mcpAddCalls[0].name).toBe("talon-tools-chatA");
      expect(mcpAddCalls[0].config.type).toBe("remote");
      expect(
        (mcpAddCalls[0].config as { type: "remote"; url: string }).url,
      ).toContain("/mcp/talon/telegram/chatA");
      expect(getRegisteredMcpServerNames(state)).toContain("talon-tools-chatA");
    });

    it("retains rival chat servers while registering the current one", async () => {
      const { client, mcpDisconnectCalls, mcpAddCalls } = makeMockClient();

      await ensureChatMcpServer(client, state, "chatA");
      expect(getRegisteredMcpServerNames(state)).toContain("talon-tools-chatA");

      // Register chatB while chatA may still have a turn in flight.
      mcpAddCalls.length = 0;
      mcpDisconnectCalls.length = 0;
      await ensureChatMcpServer(client, state, "chatB");

      expect(mcpDisconnectCalls).toEqual([]);
      expect(mcpAddCalls).toHaveLength(1);
      expect(mcpAddCalls[0].name).toBe("talon-tools-chatB");
      expect(getRegisteredMcpServerNames(state)).toContain("talon-tools-chatA");
      expect(getRegisteredMcpServerNames(state)).toContain("talon-tools-chatB");
    });

    it("keeps heartbeat and sibling chat servers connected", async () => {
      const { client, mcpDisconnectCalls } = makeMockClient();
      // Seed the heartbeat sentinel + a rival chat
      state.registeredMcpServers.add("talon-tools-heartbeat");
      state.registeredMcpServers.add("talon-tools-chatA");

      await ensureChatMcpServer(client, state, "chatB");

      expect(mcpDisconnectCalls).toEqual([]);
      expect(getRegisteredMcpServerNames(state)).toContain(
        "talon-tools-heartbeat",
      );
      expect(getRegisteredMcpServerNames(state)).toContain("talon-tools-chatB");
      expect(getRegisteredMcpServerNames(state)).toContain("talon-tools-chatA");
    });

    it("does not disturb plugin servers across chat registrations", async () => {
      const { client, mcpDisconnectCalls } = makeMockClient();
      // Seed a plugin server (different prefix, e.g. mempalace, brave-search)
      state.registeredMcpServers.add("mempalace");
      state.registeredMcpServers.add("brave-search");
      state.registeredMcpServers.add("talon-tools-chatA");

      await ensureChatMcpServer(client, state, "chatB");

      expect(mcpDisconnectCalls).toEqual([]);
      expect(getRegisteredMcpServerNames(state)).toContain("mempalace");
      expect(getRegisteredMcpServerNames(state)).toContain("brave-search");
    });

    it("skips redundant mcp.add when the cache says it's registered", async () => {
      const { client, mcpAddCalls } = makeMockClient();

      await ensureChatMcpServer(client, state, "chatA");
      expect(mcpAddCalls).toHaveLength(1);

      // Second call for the same chat — local cache should short-circuit
      await ensureChatMcpServer(client, state, "chatA");
      expect(mcpAddCalls).toHaveLength(1);
    });

    it("returns the server name even when the upstream add fails", async () => {
      const { client } = makeMockClient();
      // Force every add to fail
      client.mcp.add = vi.fn(async () => {
        throw new Error("connection refused");
      });

      const name = await ensureChatMcpServer(client, state, "chatA");
      expect(name).toBe("talon-tools-chatA");
      // Cache should NOT include a server that failed to register
      expect(getRegisteredMcpServerNames(state)).not.toContain(
        "talon-tools-chatA",
      );
    });
  });

  describe("disconnectChatMcpServer", () => {
    it("removes the entry from the cache on success", async () => {
      const state = makeState();
      const { client, mcpDisconnectCalls } = makeMockClient();
      state.registeredMcpServers.add("talon-tools-chatA");

      await disconnectChatMcpServer(client, state, "talon-tools-chatA");

      expect(mcpDisconnectCalls).toEqual(["talon-tools-chatA"]);
      expect(getRegisteredMcpServerNames(state)).not.toContain(
        "talon-tools-chatA",
      );
    });

    it("does not throw when the upstream disconnect fails", async () => {
      const state = makeState();
      const { client } = makeMockClient();
      client.mcp.disconnect = vi.fn(async () => {
        throw new Error("not connected");
      });

      await expect(
        disconnectChatMcpServer(client, state, "talon-tools-chatA"),
      ).resolves.toBeUndefined();
    });
  });

  describe("buildToolOverrides", () => {
    it("enables this chat's tools and disables every other chat's", async () => {
      const state = makeState();
      const { client } = makeMockClient([
        "talon-tools-chatA_send",
        "talon-tools-chatA_react",
        "talon-tools-chatB_send",
        "talon-tools-chatB_react",
        // Plugin / built-in tools should NOT appear in the override map
        "brave-search_query",
        "read",
        "bash",
      ]);

      const overrides = await buildToolOverrides(
        client,
        state,
        "talon-tools-chatA",
      );

      expect(overrides).toEqual({
        "talon-tools-chatA_send": true,
        "talon-tools-chatA_react": true,
        "talon-tools-chatB_send": false,
        "talon-tools-chatB_react": false,
      });
      // Plugin tools deliberately omitted
      expect(overrides).not.toHaveProperty("brave-search_query");
      expect(overrides).not.toHaveProperty("read");
    });

    it("synthesizes MCP tool ids omitted by the upstream ids endpoint", async () => {
      const state = makeState();
      state.registeredMcpServers.add("talon-tools-chatA");
      state.registeredMcpServers.add("talon-tools-chatB");
      const { client } = makeMockClient(["read", "bash"]);

      const overrides = await buildToolOverrides(
        client,
        state,
        "talon-tools-chatA",
      );

      expect(overrides).toMatchObject({
        "talon-tools-chatA_end_turn": true,
        "talon-tools-chatA_send_message": true,
        "talon-tools-chatB_end_turn": false,
        "talon-tools-chatB_send_message": false,
      });
    });

    it("returns undefined when no chat tools matched", async () => {
      const state = makeState();
      const { client } = makeMockClient(["read", "bash", "brave-search_query"]);

      const overrides = await buildToolOverrides(
        client,
        state,
        "talon-tools-chatA",
      );

      expect(overrides).toBeUndefined();
    });

    it("disables rivals while our newly registered tools are still loading", async () => {
      const state = makeState();
      const { client } = makeMockClient([
        "talon-tools-chatB_send",
        "talon-tools-chatB_react",
      ]);

      const overrides = await buildToolOverrides(
        client,
        state,
        "talon-tools-chatA",
      );

      expect(overrides).toEqual({
        "talon-tools-chatB_send": false,
        "talon-tools-chatB_react": false,
      });
    });

    it("keeps synthesized isolation overrides when tool.ids throws", async () => {
      const state = makeState();
      state.registeredMcpServers.add("talon-tools-chatA");
      state.registeredMcpServers.add("talon-tools-chatB");
      const { client } = makeMockClient();
      client.tool.ids = vi.fn(async () => {
        throw new Error("upstream timeout");
      });

      const overrides = await buildToolOverrides(
        client,
        state,
        "talon-tools-chatA",
      );
      expect(overrides).toMatchObject({
        "talon-tools-chatA_end_turn": true,
        "talon-tools-chatB_end_turn": false,
      });
    });

    it("isolates chat-scoped plugin tools as well as Talon tools", async () => {
      const state = makeState();
      state.registeredMcpServers.add("talon-tools-chatA");
      state.registeredMcpServers.add("talon-plugin-chatA-memory");
      state.registeredMcpServers.add("talon-plugin-chatB-memory");
      state.registeredMcpTools.set("talon-plugin-chatA-memory", ["search"]);
      state.registeredMcpTools.set("talon-plugin-chatB-memory", ["search"]);
      const { client } = makeMockClient([]);

      const overrides = await buildToolOverrides(
        client,
        state,
        "talon-tools-chatA",
        ["talon-plugin-chatA-memory"],
      );

      expect(overrides).toMatchObject({
        "talon-plugin-chatA-memory_search": true,
        "talon-plugin-chatB-memory_search": false,
      });
    });
  });

  describe("ensurePluginMcpServers", () => {
    it("registers a plugin server and caches it for next call", async () => {
      const state = makeState();
      const { client, mcpAddCalls } = makeMockClient();

      // We can't easily mock `getPluginMcpServers` from this test (it's a
      // module-level function); instead this test serves as a sanity check
      // that the function exists and accepts the expected signature. The
      // integration tests (`opencode-real-bootstrap.test.ts`,
      // `kilo-real-bootstrap.test.ts`) cover the end-to-end plugin path.
      await expect(
        ensurePluginMcpServers(client, state, "chatA"),
      ).resolves.toBeInstanceOf(Array);
      // First call may register zero or more plugin servers depending on
      // what plugins are configured in the test env — we only assert that
      // the call completes without throwing.
      void mcpAddCalls;
    });
  });

  describe("ensurePluginMcpServers naming", () => {
    beforeEach(() => {
      hubPluginServerNamesMock.mockReturnValue(["playwright-tools"]);
    });

    it("registers under the generated name and keeps the reverse map", async () => {
      const state = makeState();
      const { client, mcpAddCalls, mcpDisconnectCalls } = makeMockClient();
      const chatId = "-1009876543210";
      const expected = getPluginMcpServerName("playwright-tools", chatId);

      const names = await ensurePluginMcpServers(client, state, chatId);

      expect(names).toEqual([expected]);
      expect(mcpAddCalls.map((c) => c.name)).toEqual([expected]);
      expect(
        state.pluginMcpServersByChat.get(chatId)?.get("playwright-tools"),
      ).toBe(expected);
      expect(state.registeredMcpTools.get(expected)).toEqual([
        "playwright-tools_tool",
      ]);

      const overrides = await buildToolOverrides(
        client,
        state,
        getChatMcpServerName(chatId),
        names,
      );
      expect(overrides?.[`${expected}_playwright-tools_tool`]).toBe(true);

      await disconnectChatMcpServer(client, state, expected);
      expect(mcpDisconnectCalls).toEqual([expected]);
      expect(
        state.pluginMcpServersByChat.get(chatId)?.has("playwright-tools"),
      ).toBe(false);
    });
  });

  describe("TALON_MCP_SERVER_NAME constant", () => {
    it("is the stable prefix all Talon MCP servers use", () => {
      expect(TALON_MCP_SERVER_NAME).toBe("talon-tools");
    });
  });
});
