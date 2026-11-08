import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const resetSessionMock = vi.fn();
const setSessionIdMock = vi.fn();
const getPluginMcpServersMock = vi.fn();

vi.mock("../storage/sessions.js", () => ({
  getSession: getSessionMock,
  resetSession: resetSessionMock,
  setSessionId: setSessionIdMock,
}));

vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: getPluginMcpServersMock,
}));

vi.mock("../core/mcp-hub/index.js", () => ({
  talonHubUrl: (bridgeUrl: string, frontend: string, chatId: string) =>
    `${bridgeUrl}/mcp/talon/${encodeURIComponent(frontend)}/${encodeURIComponent(chatId)}`,
  pluginHubUrl: (bridgeUrl: string, name: string, chatId: string) =>
    `${bridgeUrl}/mcp/plugin/${encodeURIComponent(name)}/${encodeURIComponent(chatId)}`,
  hubPluginServerNames: () =>
    Object.keys(getPluginMcpServersMock("", "hub-enum")),
  listHubPluginToolNames: async (name: string) => [`${name}_tool`],
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

// The Kilo driver is a profile bound over the shared remote-server
// helpers; the bound object is the surface that used to be
// `backend/kilo/server.ts`.
const { kiloProfile } =
  await import("../backend/remote-server/profiles/kilo.js");
const {
  init: initKiloAgent,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  ensureSession,
  resolveProviderID,
  parseModelSelection: parseStoredKiloModelSelection,
  stop: stopKiloServer,
  getConfig,
  updateSystemPrompt,
} = kiloProfile;
const { getPluginMcpServerName, getPluginMcpServerPrefix } =
  await import("../backend/remote-server/mcp.js");
const { ensureRemoteSession, isRemoteSessionNotFound } =
  await import("../backend/remote-server/sessions.js");

type MockKiloClient = {
  mcp: {
    status: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  tool: { ids: ReturnType<typeof vi.fn> };
  session: { get: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  provider: { list: ReturnType<typeof vi.fn> };
  permission: { allowEverything: ReturnType<typeof vi.fn> };
};

function makeClient(): MockKiloClient {
  return {
    mcp: { status: vi.fn(), add: vi.fn(), disconnect: vi.fn() },
    tool: { ids: vi.fn() },
    session: { get: vi.fn(), create: vi.fn() },
    provider: { list: vi.fn() },
    permission: { allowEverything: vi.fn().mockResolvedValue({}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stopKiloServer();
  getSessionMock.mockReturnValue({});
  getPluginMcpServersMock.mockReturnValue({});
  initKiloAgent({} as never, () => 17777, "discord");
});

describe("kilo server helpers", () => {
  it("buildToolOverrides enables only tools from the active chat server", async () => {
    const oc = makeClient();
    oc.tool.ids.mockResolvedValue({
      data: [
        "talon-tools-chat_1_send_message",
        "talon-tools-other_send_message",
        "not-talon-tool",
        123,
      ],
    });

    const overrides = await buildToolOverrides(
      oc as never,
      "talon-tools-chat_1",
    );

    expect(overrides).toEqual({
      "talon-tools-chat_1_send_message": true,
      "talon-tools-other_send_message": false,
    });
  });

  it("buildToolOverrides disables a rival while current tools are loading", async () => {
    const oc = makeClient();
    oc.tool.ids.mockResolvedValue({ data: ["talon-tools-other_send_message"] });
    await expect(
      buildToolOverrides(oc as never, "talon-tools-chat_1"),
    ).resolves.toEqual({ "talon-tools-other_send_message": false });
  });

  it("ensureChatMcpServer registers the chat server with the hub URL", async () => {
    const oc = makeClient();

    const serverName = await ensureChatMcpServer(oc as never, "chat/1");

    expect(serverName).toBe("talon-tools-chat_1");
    expect(oc.mcp.add).toHaveBeenCalledTimes(1);
    expect(oc.mcp.add.mock.calls[0][0]).toMatchObject({
      name: "talon-tools-chat_1",
      config: {
        type: "remote",
        url: "http://127.0.0.1:17777/mcp/talon/discord/chat%2F1",
      },
    });
  });

  it("ensureChatMcpServer skips the add when the server is already cached locally", async () => {
    const oc = makeClient();

    await ensureChatMcpServer(oc as never, "chat/1");
    expect(oc.mcp.add).toHaveBeenCalledTimes(1);

    // Second call uses the local cache — no new add. Kilo's GET /mcp
    // returns {} regardless of state, so we trust our own record of what
    // we registered earlier in this process.
    await ensureChatMcpServer(oc as never, "chat/1");
    expect(oc.mcp.add).toHaveBeenCalledTimes(1);
  });

  it("disconnectChatMcpServer clears the cache so a future ensure re-registers", async () => {
    const oc = makeClient();

    await ensureChatMcpServer(oc as never, "chat/1");
    await disconnectChatMcpServer(oc as never, "talon-tools-chat_1");
    await ensureChatMcpServer(oc as never, "chat/1");

    // Two adds: the initial registration and the post-disconnect one.
    expect(oc.mcp.add).toHaveBeenCalledTimes(2);
    expect(oc.mcp.disconnect).toHaveBeenCalledTimes(1);
  });

  it("ensureChatMcpServer retains other chat MCP servers for concurrent turns", async () => {
    const oc = makeClient();

    await ensureChatMcpServer(oc as never, "chat-a");
    await ensureChatMcpServer(oc as never, "heartbeat");
    expect(oc.mcp.add).toHaveBeenCalledTimes(2);

    // Registering chat-b must not disrupt chat-a if its turn is still live.
    await ensureChatMcpServer(oc as never, "chat-b");

    expect(oc.mcp.disconnect).not.toHaveBeenCalled();
    // chat-b registered now.
    expect(oc.mcp.add).toHaveBeenCalledTimes(3);
  });

  it("ensureChatMcpServer leaves heartbeat MCP server connected", async () => {
    const oc = makeClient();

    await ensureChatMcpServer(oc as never, "heartbeat");
    await ensureChatMcpServer(oc as never, "chat-a");
    await ensureChatMcpServer(oc as never, "chat-b");

    // No chat registration disconnects any sibling. Per-prompt tool
    // overrides provide visibility isolation instead.
    const disconnectNames = (
      oc.mcp.disconnect.mock.calls as Array<[{ name: string }]>
    ).map((c) => c[0].name);
    expect(disconnectNames).not.toContain("talon-tools-heartbeat");
    expect(disconnectNames).not.toContain("talon-tools-chat-a");
  });

  it("ensurePluginMcpServers registers all named servers on first call", async () => {
    const oc = makeClient();
    getPluginMcpServersMock.mockReturnValue({
      alpha: { command: "node", args: ["alpha.js"], env: { A: "1" } },
      beta: { command: "node", args: ["beta.js"], env: { B: "1" } },
    });

    const registered = await ensurePluginMcpServers(oc as never, "chat-1");

    expect(registered).toEqual([
      getPluginMcpServerName("alpha", "chat-1"),
      getPluginMcpServerName("beta", "chat-1"),
    ]);
    expect(oc.mcp.add).toHaveBeenCalledTimes(2);
  });

  it("ensurePluginMcpServers skips already-cached servers on subsequent calls", async () => {
    const oc = makeClient();
    getPluginMcpServersMock.mockReturnValue({
      alpha: { command: "node", args: ["alpha.js"], env: { A: "1" } },
      beta: { command: "node", args: ["beta.js"], env: { B: "1" } },
    });

    await ensurePluginMcpServers(oc as never, "chat-1");
    expect(oc.mcp.add).toHaveBeenCalledTimes(2);

    // Second call: both alpha and beta are cached from the first call,
    // so no new adds. This is the path that recovers the ~12s/turn we
    // were burning before the cache existed.
    const reRegistered = await ensurePluginMcpServers(oc as never, "chat-1");
    expect(reRegistered).toEqual([
      getPluginMcpServerName("alpha", "chat-1"),
      getPluginMcpServerName("beta", "chat-1"),
    ]);
    expect(oc.mcp.add).toHaveBeenCalledTimes(2);
  });

  it("updates the live system prompt used after plugin reload", () => {
    updateSystemPrompt("fresh prompt");
    expect(getConfig().systemPrompt).toBe("fresh prompt");
  });

  it("ensureSession reuses a valid existing session and creates a new one when expired", async () => {
    const oc = makeClient();

    getSessionMock.mockReturnValueOnce({ sessionId: "existing-1" });
    oc.session.get.mockResolvedValueOnce({ data: { id: "existing-1" } });
    await expect(ensureSession(oc as never, "chat-a")).resolves.toBe(
      "existing-1",
    );
    expect(oc.session.create).not.toHaveBeenCalled();

    getSessionMock.mockReturnValueOnce({ sessionId: "expired-1" });
    // What the SDK's error interceptor throws for a 404.
    oc.session.get.mockRejectedValueOnce(
      new Error("Session not found", {
        cause: { body: { name: "NotFoundError" }, status: 404 },
      }),
    );
    oc.session.create.mockResolvedValueOnce({ data: { id: "new-1" } });
    await expect(ensureSession(oc as never, "chat-a")).resolves.toBe("new-1");
    expect(resetSessionMock).toHaveBeenCalledWith(
      "chat-a",
      "remote_session_not_found",
    );
    expect(setSessionIdMock).toHaveBeenCalledWith("chat-a", "new-1");
  });

  describe("ensureRemoteSession on a failing session.get", () => {
    const state = { label: "Kilo" } as never;

    it("keeps the session and fails the turn on a transient error", async () => {
      const oc = makeClient();
      getSessionMock.mockReturnValue({ sessionId: "keep-me" });
      // The server is still starting: connection refused, then a 503.
      oc.session.get
        .mockRejectedValueOnce(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), {
              code: "ECONNREFUSED",
            }),
          }),
        )
        .mockRejectedValueOnce(
          new Error("Service Unavailable", { cause: { status: 503 } }),
        )
        .mockRejectedValueOnce(new Error("timeout"));

      await expect(
        ensureRemoteSession(oc as never, state, "chat-t", [0, 0]),
      ).rejects.toMatchObject({ reason: "network" });
      expect(oc.session.get).toHaveBeenCalledTimes(3);
      expect(resetSessionMock).not.toHaveBeenCalled();
      expect(oc.session.create).not.toHaveBeenCalled();
      expect(setSessionIdMock).not.toHaveBeenCalled();
    });

    it("resumes when a retry after a transient error succeeds", async () => {
      const oc = makeClient();
      getSessionMock.mockReturnValue({ sessionId: "keep-me" });
      oc.session.get
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce({ data: { id: "keep-me" } });

      await expect(
        ensureRemoteSession(oc as never, state, "chat-t", [0]),
      ).resolves.toBe("keep-me");
      expect(resetSessionMock).not.toHaveBeenCalled();
      expect(oc.session.create).not.toHaveBeenCalled();
    });

    it("resets on the server's NotFoundError body, with no retry", async () => {
      const oc = makeClient();
      getSessionMock.mockReturnValue({ sessionId: "gone" });
      // Without the error interceptor the client throws the parsed body.
      oc.session.get.mockRejectedValueOnce({
        name: "NotFoundError",
        data: { message: "Resource not found: session gone" },
      });
      oc.session.create.mockResolvedValueOnce({ data: { id: "fresh" } });

      await expect(
        ensureRemoteSession(oc as never, state, "chat-t", [0, 0]),
      ).resolves.toBe("fresh");
      expect(oc.session.get).toHaveBeenCalledTimes(1);
      expect(resetSessionMock).toHaveBeenCalledWith(
        "chat-t",
        "remote_session_not_found",
      );
    });
  });

  it("isRemoteSessionNotFound only accepts a definite not-found", () => {
    expect(isRemoteSessionNotFound({ status: 404 })).toBe(true);
    expect(
      isRemoteSessionNotFound(new Error("x", { cause: { status: 404 } })),
    ).toBe(true);
    expect(isRemoteSessionNotFound({ name: "NotFoundError" })).toBe(true);
    expect(isRemoteSessionNotFound(new Error("fetch failed"))).toBe(false);
    expect(
      isRemoteSessionNotFound(new Error("x", { cause: { status: 500 } })),
    ).toBe(false);
    expect(isRemoteSessionNotFound(new Error("expired"))).toBe(false);
    expect(isRemoteSessionNotFound(undefined)).toBe(false);
  });

  it("ensureSession scopes the new session's permission ruleset to this chat's MCP server", async () => {
    // Per-session permission rules do two jobs:
    //   1. Hide other chats' MCP tools so a model in chat A can't call
    //      `talon-tools-<chatB>_send` (cross-chat leak / "No active
    //      chat context" gateway error).
    //   2. Auto-allow Kilo's built-ins (`read`, `bash`, `edit`) so
    //      they don't sit in `permission.asked` waiting for a reply
    //      that never comes — Talon's question watchdog only handles
    //      `question.*` events, not `permission.*`.
    // The deprecated per-prompt `tools` map and the previous
    // `permission.allowEverything` workaround are subsumed by this.
    const oc = makeClient();
    getSessionMock.mockReturnValueOnce({});
    oc.session.create.mockResolvedValueOnce({ data: { id: "new-perm-1" } });

    await ensureSession(oc as never, "chat/a");

    expect(oc.session.create).toHaveBeenCalledTimes(1);
    const args = oc.session.create.mock.calls[0][0] as {
      title?: string;
      permission?: Array<{
        permission: string;
        pattern: string;
        action: string;
      }>;
    };
    expect(args.title).toBe("Chat chat/a");
    expect(args.permission).toEqual([
      { permission: "tool", pattern: "talon-tools-chat_a_*", action: "allow" },
      { permission: "tool", pattern: "talon-tools-*", action: "deny" },
      {
        permission: "tool",
        pattern: `${getPluginMcpServerPrefix("chat/a")}*`,
        action: "allow",
      },
      { permission: "tool", pattern: "tp-*", action: "deny" },
      { permission: "tool", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ]);
  });

  it("disconnectChatMcpServer swallows disconnect errors", async () => {
    const oc = makeClient();
    oc.mcp.disconnect.mockRejectedValueOnce("boom");
    await expect(
      disconnectChatMcpServer(oc as never, "talon-tools-chat_1"),
    ).resolves.toBeUndefined();
  });

  it("resolveProviderID prefers matched providers and caches the result", async () => {
    const oc = makeClient();
    oc.provider.list.mockResolvedValue({
      data: {
        connected: [
          { id: "openai", models: { "gpt-5": { providerID: "openai" } } },
          { id: "fallback", models: { "gpt-5": {} } },
        ],
        configured: [{ id: "openai", models: { "gpt-5": {} } }],
        ignored: "not-an-array",
      },
    });

    await expect(resolveProviderID(oc as never, "gpt-5")).resolves.toBe(
      "openai",
    );
    await expect(resolveProviderID(oc as never, "gpt-5")).resolves.toBe(
      "openai",
    );
    expect(oc.provider.list).toHaveBeenCalledTimes(1);
  });

  it("resolveProviderID prefers the connected provider when model ids collide", async () => {
    const oc = makeClient();
    oc.provider.list.mockResolvedValue({
      data: {
        all: [
          {
            id: "openrouter",
            models: {
              "nvidia/nemotron:free": { providerID: "openrouter" },
            },
          },
          {
            id: "kilo",
            models: { "nvidia/nemotron:free": { providerID: "kilo" } },
          },
        ],
        connected: ["kilo"],
      },
    });

    await expect(
      resolveProviderID(oc as never, "nvidia/nemotron:free"),
    ).resolves.toBe("kilo");
  });

  it("resolveProviderID falls back to guessed provider when catalog has no model match", async () => {
    const oc = makeClient();
    oc.provider.list.mockResolvedValue({
      data: {
        connected: [{ id: "anthropic", models: { "claude-opus-4-7": {} } }],
      },
    });

    await expect(
      resolveProviderID(oc as never, "gemini-2.5-pro"),
    ).resolves.toBe("google");
  });

  it("parseStoredKiloModelSelection keeps non-kilo slug and trims whitespace", () => {
    expect(
      parseStoredKiloModelSelection("  openrouter/qwen3-235b-a22b:free  "),
    ).toEqual({
      providerID: undefined,
      modelID: "openrouter/qwen3-235b-a22b:free",
    });
  });

  it("parseStoredKiloModelSelection strips the leading kilo/ prefix and pins providerID", () => {
    // Talon stored `kilo/...` as a hint that the model is kilo-routed.
    // The Kilo upstream router doesn't want that prefix in the model id —
    // passing it through produces the bug surfaced in prod as
    // `Model not found: opencode/kilo/deepseek/deepseek-v4-flash:free`.
    expect(
      parseStoredKiloModelSelection(" kilo/deepseek/deepseek-v4-flash:free "),
    ).toEqual({
      providerID: "kilo",
      modelID: "deepseek/deepseek-v4-flash:free",
    });
  });
});
