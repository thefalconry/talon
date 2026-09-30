import type { TalonConfig } from "../core/config/index.js";
import { describe, it, expect, vi, beforeEach } from "vitest";

// This suite asserts the Node/tsx spawn recipes; pin the runtime
// predicate so the assertions hold when the suite itself runs under bun.
vi.mock("../util/runtime.js", () => ({
  isBunRuntime: () => false,
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

describe("plugin system", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TEST_PLUGIN_")) delete process.env[key];
    }
  });

  function createMockPlugin(overrides: Record<string, unknown> = {}) {
    return {
      name: "test-plugin",
      version: "1.0.0",
      description: "Test plugin",
      mcpServerPath: "/fake/tools.ts",
      getEnvVars: vi.fn(() => ({ TEST_PLUGIN_KEY: "value" })),
      handleAction: vi.fn(async () => null),
      ...overrides,
    };
  }

  function createTestConfig(overrides: Partial<TalonConfig> = {}): TalonConfig {
    return {
      frontend: "terminal",
      backend: "claude",
      devBuild: false,
      model: "default",
      maxMessageLength: 4000,
      concurrency: 1,
      pulse: true,
      pulseIntervalMs: 300000,
      planAlerts: false,
      planAlertThreshold: 80,
      dream: true,
      heartbeat: false,
      heartbeatIntervalMinutes: 60,
      plugins: [],
      botDisplayName: "Talon",
      nativeTools: false,
      fuse: "off",
      teamsWebhookPort: 19878,
      teamsGraphPollMs: 10000,
      systemPrompt: "test prompt",
      workspace: "/tmp/workspace",
      ...overrides,
    };
  }

  /** Import fresh plugin module with fs mocked to find entry + dynamic import returning plugin. */
  async function setup(plugin: ReturnType<typeof createMockPlugin>) {
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    // registerPlugin is loader-internal (builtins call it); the barrel no
    // longer re-exports it, so reach it on the same module instance directly.
    const { registerPlugin } = await import("../core/plugin/loader.js");
    mod._deps.importModule = async () => ({ default: plugin });
    return { ...mod, registerPlugin };
  }

  describe("PluginRegistry", () => {
    it("registers a plugin and retrieves it by name", async () => {
      const plugin = createMockPlugin();
      const { loadPlugins, getPlugin, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginCount()).toBe(1);
      expect(getPlugin("test-plugin")).toBeDefined();
      expect(getPlugin("test-plugin")!.plugin.name).toBe("test-plugin");
    });

    it("prevents duplicate plugin names", async () => {
      const plugin = createMockPlugin();
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }, { path: "/fake/plugin" }]);

      expect(getPluginCount()).toBe(1);
    });

    it("skips plugins with no entry point", async () => {
      vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => false) }));
      const { loadPlugins, getPluginCount } =
        await import("../core/plugin/index.js");
      await loadPlugins([{ path: "/nonexistent/plugin" }]);

      expect(getPluginCount()).toBe(0);
    });

    it("skips plugins missing name", async () => {
      vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
      const mod = await import("../core/plugin/index.js");
      mod._deps.importModule = async () => ({
        default: { handleAction: vi.fn() },
      });
      await mod.loadPlugins([{ path: "/fake/plugin" }]);

      expect(mod.getPluginCount()).toBe(0);
    });
  });

  describe("config validation", () => {
    it("skips plugin when validateConfig returns errors", async () => {
      const plugin = createMockPlugin({
        validateConfig: () => [
          "repoPath is required",
          "jenkinsUrl is required",
        ],
      });
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin", config: {} }]);

      expect(getPluginCount()).toBe(0);
    });

    it("loads plugin when validateConfig returns undefined (valid)", async () => {
      const plugin = createMockPlugin({ validateConfig: () => undefined });
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([
        { path: "/fake/plugin", config: { repoPath: "/tmp" } },
      ]);

      expect(getPluginCount()).toBe(1);
    });
  });

  describe("env vars", () => {
    it("sets env vars from getEnvVars on process.env", async () => {
      const plugin = createMockPlugin({
        getEnvVars: () => ({ TEST_PLUGIN_FOO: "bar", TEST_PLUGIN_BAZ: "qux" }),
      });
      const { loadPlugins } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(process.env.TEST_PLUGIN_FOO).toBe("bar");
      expect(process.env.TEST_PLUGIN_BAZ).toBe("qux");
    });
  });

  describe("action routing", () => {
    it("routes action to the correct plugin", async () => {
      const plugin = createMockPlugin({
        handleAction: vi.fn(async (body: Record<string, unknown>) => {
          if (body.action === "test_action")
            return { ok: true, text: "handled" };
          return null;
        }),
      });
      const { loadPlugins, handlePluginAction } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction(
        { action: "test_action" },
        "chat1",
      );
      expect(result).toEqual({ ok: true, text: "handled" });
    });

    it("returns null when no plugin handles the action", async () => {
      const plugin = createMockPlugin({
        handleAction: vi.fn(async () => null),
      });
      const { loadPlugins, handlePluginAction } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction({ action: "unknown" }, "chat1");
      expect(result).toBeNull();
    });

    it("catches plugin action errors and returns error result", async () => {
      const plugin = createMockPlugin({
        handleAction: vi.fn(async () => {
          throw new Error("plugin crash");
        }),
      });
      const { loadPlugins, handlePluginAction } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction({ action: "boom" }, "chat1");
      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("plugin crash");
    });

    it("skips plugins without handleAction", async () => {
      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).handleAction;
      const { loadPlugins, handlePluginAction } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction({ action: "test" }, "chat1");
      expect(result).toBeNull();
    });
  });

  describe("disabled entries", () => {
    it("skips a disabled path plugin", async () => {
      const plugin = createMockPlugin();
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin", enabled: false }]);
      expect(getPluginCount()).toBe(0);
    });

    it("loads a path plugin with explicit enabled: true", async () => {
      const plugin = createMockPlugin();
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin", enabled: true }]);
      expect(getPluginCount()).toBe(1);
    });

    it("skips a disabled standalone MCP entry", async () => {
      const plugin = createMockPlugin();
      const { loadPlugins, getPluginMcpServers } = await setup(plugin);
      await loadPlugins([
        {
          name: "srv",
          command: "npx",
          args: ["-y", "some-server"],
          enabled: false,
        },
      ]);
      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      expect(Object.keys(servers)).toHaveLength(0);
    });
  });

  describe("MCP server config", () => {
    it("builds MCP server entries for plugins with mcpServerPath", async () => {
      const plugin = createMockPlugin({
        mcpServerPath: "/fake/tools.ts",
        getEnvVars: () => ({ MY_KEY: "val" }),
      });
      const { loadPlugins, getPluginMcpServers } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      expect(servers["test-plugin-tools"]).toBeDefined();
      expect(servers["test-plugin-tools"].env.TALON_BRIDGE_URL).toBe(
        "http://localhost:19876",
      );
      expect(servers["test-plugin-tools"].env.TALON_CHAT_ID).toBe("chat1");
      expect(servers["test-plugin-tools"].env.MY_KEY).toBe("val");
      // Plugins that call POST /action authenticate with the gateway token.
      expect(servers["test-plugin-tools"].env.TALON_GATEWAY_TOKEN).toBe(
        "vitest-gateway-token",
      );
    });

    it("returns raw specs — the hub applies orphan protection at spawn time", async () => {
      const plugin = createMockPlugin({
        mcpServer: { command: "python3", args: ["-m", "srv"] },
      });
      const { loadPlugins, getPluginMcpServers } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const spec = getPluginMcpServers("http://localhost:19876", "chat1")[
        "test-plugin-tools"
      ];
      expect(spec.command).toBe("python3");
      expect(spec.args).toEqual(["-m", "srv"]);
      expect(spec.args).not.toContain("_mcp-launch");
    });

    it("skips plugins without mcpServerPath", async () => {
      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).mcpServerPath;
      const { loadPlugins, getPluginMcpServers } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      expect(Object.keys(servers)).toHaveLength(0);
    });

    it("uses npx command and tsx args on win32 platform (line 418/420 TRUE branch)", async () => {
      const plugin = createMockPlugin({ mcpServerPath: "/fake/tools.ts" });
      const { loadPlugins, getPluginMcpServers } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      // Temporarily override process.platform to simulate Windows
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      try {
        const servers = getPluginMcpServers("http://localhost:19876", "chat1");
        expect(servers["test-plugin-tools"].command).toBe("npx");
        const args = servers["test-plugin-tools"].args as string[];
        expect(args[0]).toBe("tsx");
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    it("builds MCP server entries for plugins with custom mcpServer", async () => {
      const plugin = createMockPlugin({
        mcpServer: {
          command: "/usr/bin/python3",
          args: ["-m", "mempalace.mcp_server", "--palace", "/tmp/palace"],
        },
        getEnvVars: () => ({ PALACE_PATH: "/tmp/palace" }),
      });
      // Remove mcpServerPath so mcpServer is used
      delete (plugin as Record<string, unknown>).mcpServerPath;
      const { loadPlugins, getPluginMcpServers } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      expect(servers["test-plugin-tools"]).toBeDefined();
      expect(servers["test-plugin-tools"].command).toBe("/usr/bin/python3");
      expect(servers["test-plugin-tools"].args).toEqual([
        "-m",
        "mempalace.mcp_server",
        "--palace",
        "/tmp/palace",
      ]);
      expect(servers["test-plugin-tools"].env.PALACE_PATH).toBe("/tmp/palace");
      expect(servers["test-plugin-tools"].env.TALON_BRIDGE_URL).toBe(
        "http://localhost:19876",
      );
    });

    it("does not let plugin env vars override bridge metadata", async () => {
      const plugin = createMockPlugin({
        mcpServer: {
          command: "/usr/bin/python3",
          args: ["-m", "my_server"],
        },
        getEnvVars: () => ({
          TALON_BRIDGE_URL: "http://malicious.example",
          TALON_CHAT_ID: "wrong-chat",
          TALON_GATEWAY_TOKEN: "forged",
          MY_KEY: "val",
        }),
      });
      delete (plugin as Record<string, unknown>).mcpServerPath;
      const { loadPlugins, getPluginMcpServers } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      expect(servers["test-plugin-tools"].env).toMatchObject({
        TALON_BRIDGE_URL: "http://localhost:19876",
        TALON_CHAT_ID: "chat1",
        TALON_GATEWAY_TOKEN: "vitest-gateway-token",
        MY_KEY: "val",
      });
    });

    it("builds standalone MCP server entries from config", async () => {
      const { loadPlugins, getPluginMcpServers } =
        await setup(createMockPlugin());
      await loadPlugins([
        {
          name: "standalone",
          command: "node",
          args: ["/tmp/server.js"],
          env: {
            API_KEY: "secret",
            TALON_BRIDGE_URL: "http://malicious.example",
            TALON_CHAT_ID: "wrong-chat",
          },
        },
      ]);

      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      expect(servers["standalone-tools"].command).toBe("node");
      expect(servers["standalone-tools"].args).toEqual(["/tmp/server.js"]);
      expect(servers["standalone-tools"].env).toMatchObject({
        API_KEY: "secret",
        TALON_BRIDGE_URL: "http://localhost:19876",
        TALON_CHAT_ID: "chat1",
      });
      expect(servers["standalone-tools"].env.TALON_RELOAD_AT).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      );
    });

    it("skips path plugins that collide with standalone MCP names", async () => {
      const initFn = vi.fn();
      const plugin = createMockPlugin({ init: initFn });
      const { loadPlugins, getPluginCount, getPluginMcpServers } =
        await setup(plugin);
      await loadPlugins([
        { name: "test-plugin", command: "node", args: ["/tmp/server.js"] },
        { path: "/fake/plugin" },
      ]);

      expect(getPluginCount()).toBe(0);
      expect(initFn).not.toHaveBeenCalled();
      expect(
        getPluginMcpServers("http://localhost:19876", "chat1"),
      ).toHaveProperty("test-plugin-tools");
    });

    it("mcpServer takes priority over mcpServerPath when both are set", async () => {
      const plugin = createMockPlugin({
        mcpServerPath: "/fake/tools.ts",
        mcpServer: {
          command: "/usr/bin/python3",
          args: ["-m", "my_server"],
        },
      });
      const { loadPlugins, getPluginMcpServers } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      // mcpServer should win over mcpServerPath
      expect(servers["test-plugin-tools"].command).toBe("/usr/bin/python3");
      expect(servers["test-plugin-tools"].args).toEqual(["-m", "my_server"]);
    });

    it("skips plugins without mcpServer or mcpServerPath", async () => {
      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).mcpServerPath;
      delete (plugin as Record<string, unknown>).mcpServer;
      const { loadPlugins, getPluginMcpServers } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      expect(Object.keys(servers)).toHaveLength(0);
    });
  });

  describe("reload", () => {
    it("clears standalone MCP entries on hot reload", async () => {
      vi.resetModules();
      vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
      vi.doMock("../core/config/index.js", () => ({
        loadConfig: () => ({
          frontend: "terminal",
          model: "default",
          plugins: [],
          systemPrompt: "test prompt",
          workspace: "/tmp/workspace",
        }),
        getFrontends: () => ["terminal"],
      }));

      const mod = await import("../core/plugin/index.js");
      await mod.loadPlugins([{ name: "standalone", command: "node" }]);
      expect(
        mod.getPluginMcpServers("http://localhost:19876", "chat1"),
      ).toHaveProperty("standalone-tools");

      await mod.reloadPlugins();

      expect(
        mod.getPluginMcpServers("http://localhost:19876", "chat1"),
      ).toEqual({});
    });
  });

  describe("registerPlugin (built-in)", () => {
    it("registers a built-in plugin directly", async () => {
      const plugin = createMockPlugin({ name: "built-in-test" });
      const { registerPlugin, getPlugin } = await setup(createMockPlugin());

      const loaded = registerPlugin(plugin, { key: "val" });
      expect(loaded?.path).toBe("(built-in)");
      expect(getPlugin("built-in-test")).toBeDefined();
      expect(getPlugin("built-in-test")!.path).toBe("(built-in)");
    });

    it("sets env vars from built-in plugin", async () => {
      const plugin = createMockPlugin({
        name: "builtin-env",
        getEnvVars: () => ({
          TEST_PLUGIN_BUILTIN_FOO: "baz",
        }),
      });
      const { registerPlugin } = await setup(createMockPlugin());

      registerPlugin(plugin);
      expect(process.env.TEST_PLUGIN_BUILTIN_FOO).toBe("baz");
    });

    it("skips registration when validateConfig returns errors", async () => {
      const plugin = createMockPlugin({
        name: "builtin-invalid",
        validateConfig: () => ["missing required field"],
      });
      const { registerPlugin, getPlugin } = await setup(createMockPlugin());

      expect(registerPlugin(plugin, {})).toBeNull();
      expect(getPlugin("builtin-invalid")).toBeUndefined();
    });

    it("does not init a built-in plugin when duplicate registration is skipped", async () => {
      const init = vi.fn();
      const githubPlugin = createMockPlugin({ name: "github", init });

      vi.doMock("../plugins/github/index.js", () => ({
        createGitHubPlugin: () => githubPlugin,
      }));
      // loadBuiltinPlugins provisions enabled native runtimes first; the
      // real github provisioner shells out to docker, which a unit test
      // must never do (and which blows the test timeout on runners
      // where the daemon is slow to answer).
      vi.doMock("../plugins/github/provision.js", () => ({
        provisionGithubMcp: async () => ({
          status: "skipped",
          kind: "docker",
          actions: [],
          warnings: [],
        }),
        inspectGithub: async () => [],
        githubMcpImageRef: (tag?: string) =>
          `ghcr.io/github/github-mcp-server:${tag ?? "test"}`,
        GITHUB_MCP_PINNED_TAG: "test",
      }));

      const mod = await import("../core/plugin/index.js");
      await mod.loadPlugins([{ name: "github", command: "node" }]);
      await mod.loadBuiltinPlugins(
        createTestConfig({ github: { enabled: true } }),
      );

      expect(init).not.toHaveBeenCalled();
      expect(mod.getPlugin("github")).toBeUndefined();
    });
  });

  describe("system prompt additions", () => {
    it("collects prompt additions from plugins", async () => {
      const plugin = createMockPlugin({
        getSystemPromptAddition: () => "## My Plugin\nI add context.",
      });
      const { loadPlugins, getPluginPromptAdditions } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const additions = getPluginPromptAdditions();
      expect(additions).toHaveLength(1);
      expect(additions[0]).toContain("My Plugin");
    });

    it("handles plugins without getSystemPromptAddition", async () => {
      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).getSystemPromptAddition;
      const { loadPlugins, getPluginPromptAdditions } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginPromptAdditions()).toHaveLength(0);
    });
  });

  describe("lifecycle", () => {
    it("calls init with config", async () => {
      const initFn = vi.fn();
      const plugin = createMockPlugin({ init: initFn });
      const { loadPlugins } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin", config: { key: "val" } }]);

      expect(initFn).toHaveBeenCalledWith({ key: "val" });
    });

    it("calls destroy on all plugins", async () => {
      const destroyFn = vi.fn();
      const plugin = createMockPlugin({ destroy: destroyFn });
      const { loadPlugins, destroyPlugins } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);
      await destroyPlugins();

      expect(destroyFn).toHaveBeenCalled();
    });

    it("still registers plugin if init throws", async () => {
      const plugin = createMockPlugin({
        init: () => {
          throw new Error("init failed");
        },
      });
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginCount()).toBe(1);
    });

    it("does not leave an init timeout running for plugins without init", async () => {
      vi.useFakeTimers();
      try {
        const plugin = createMockPlugin();
        const { loadPlugins } = await setup(plugin);

        await loadPlugins([{ path: "/fake/plugin" }]);

        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("catches destroy errors without crashing", async () => {
      const plugin = createMockPlugin({
        destroy: () => {
          throw new Error("destroy crash");
        },
      });
      const { loadPlugins, destroyPlugins } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      await expect(destroyPlugins()).resolves.toBeUndefined();
    });

    it("covers init timeout arrow fn — inner setTimeout reject callback fires after 30s", async () => {
      vi.useFakeTimers();
      // Plugin with init that never resolves — forces the 30s timeout to win the race
      const plugin = createMockPlugin({ init: () => new Promise(() => {}) });
      vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
      const mod = await import("../core/plugin/index.js");
      mod._deps.importModule = async () => ({ default: plugin });

      const loadPromise = mod.loadPlugins([{ path: "/fake/plugin" }]);
      // Advance past INIT_TIMEOUT (30_000ms) so the setTimeout reject callback fires
      await vi.advanceTimersByTimeAsync(30_001);
      await loadPromise;

      vi.useRealTimers();
      // Plugin still registers despite timeout (error is caught)
      expect(mod.getPluginCount()).toBeGreaterThan(0);
    });
  });

  describe("operator alerts", () => {
    async function captureAlerts() {
      const alerts = await import("../core/frontend-runtime/alerts.js");
      const sent: string[] = [];
      alerts.resetAlertsForTest(async (text) => {
        sent.push(text);
      });
      return { sent, keys: () => alerts.activeAlerts().map((a) => a.key) };
    }

    it("alerts when init times out, not before, and clears when a later init succeeds", async () => {
      vi.useFakeTimers();
      try {
        let hang = true;
        const plugin = createMockPlugin({
          init: () => (hang ? new Promise(() => {}) : undefined),
        });
        const mod = await setup(plugin);
        const { sent, keys } = await captureAlerts();

        const loading = mod.loadPlugins([{ path: "/fake/plugin" }]);
        await vi.advanceTimersByTimeAsync(29_000);
        expect(sent).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1_001);
        await loading;
        expect(keys()).toEqual(["plugin.test-plugin"]);
        expect(sent[0]).toMatch(
          /Plugin "test-plugin" failed to initialise: init timed out after 30s/,
        );

        hang = false;
        const { registry } = await import("../core/plugin/registry.js");
        await registry.destroyAndClear();
        await mod.loadPlugins([{ path: "/fake/plugin" }]);
        expect(keys()).toEqual([]);
        expect(sent.at(-1)).toMatch(
          /Plugin "test-plugin" initialised normally/,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("alerts when a native runtime fails to provision and clears when it is usable", async () => {
      let status: "failed" | "ready" = "failed";
      vi.doMock("../plugins/github/index.js", () => ({
        createGitHubPlugin: () => createMockPlugin({ name: "github" }),
      }));
      vi.doMock("../plugins/github/provision.js", () => ({
        provisionGithubMcp: async () => ({
          status,
          kind: "docker",
          actions: [],
          warnings: [],
          ...(status === "failed"
            ? { error: "docker pull: permission denied" }
            : {}),
        }),
        inspectGithub: async () => [],
        githubMcpImageRef: (tag?: string) =>
          `ghcr.io/github/github-mcp-server:${tag ?? "test"}`,
        GITHUB_MCP_PINNED_TAG: "test",
      }));
      const mod = await import("../core/plugin/index.js");
      const { sent, keys } = await captureAlerts();
      const config = createTestConfig({ github: { enabled: true } });

      await mod.loadBuiltinPlugins(config);
      expect(keys()).toContain("provision.github");
      expect(sent[0]).toMatch(
        /Installing the github runtime failed: docker pull: permission denied/,
      );

      status = "ready";
      await mod.loadBuiltinPlugins(config);
      expect(keys()).not.toContain("provision.github");
      expect(sent.at(-1)).toMatch(/github runtime is installed and usable/);
    });
  });

  describe("frontend whitelist", () => {
    it("skips plugin when frontend whitelist doesn't match", async () => {
      const plugin = createMockPlugin({ frontends: ["telegram"] });
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }], ["terminal"]);

      expect(getPluginCount()).toBe(0);
    });

    it("loads plugin when frontend whitelist matches", async () => {
      const plugin = createMockPlugin({ frontends: ["telegram", "terminal"] });
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }], ["terminal"]);

      expect(getPluginCount()).toBe(1);
    });

    it("loads plugin when no frontend whitelist is specified", async () => {
      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).frontends;
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }], ["terminal"]);

      expect(getPluginCount()).toBe(1);
    });
  });

  describe("prompt addition error handling", () => {
    it("catches getSystemPromptAddition errors without crashing", async () => {
      const plugin = createMockPlugin({
        getSystemPromptAddition: () => {
          throw new Error("prompt error");
        },
      });
      const { loadPlugins, getPluginPromptAdditions } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginPromptAdditions()).toHaveLength(0);
    });

    it("skips empty/whitespace prompt additions", async () => {
      const plugin = createMockPlugin({
        getSystemPromptAddition: () => "   \n  ",
      });
      const { loadPlugins, getPluginPromptAdditions } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginPromptAdditions()).toHaveLength(0);
    });
  });
});

describe("extractPlugin — invalid optional field types", () => {
  // All tests use _deps.importModule injection (same pattern as the main describe block)
  beforeEach(() => {
    vi.resetModules();
  });

  it("rejects plugin when init is not a function", async () => {
    const plugin = { name: "bad-init", init: "not-a-function" };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/bad-init" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("rejects plugin when getSystemPromptAddition is not a function", async () => {
    const plugin = { name: "bad-gsp", getSystemPromptAddition: 42 };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/bad-gsp" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("rejects plugin when mcpServerPath is not a string", async () => {
    const plugin = { name: "bad-mcp", mcpServerPath: 99 };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/bad-mcp" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("rejects plugin when frontends is not an array", async () => {
    const plugin = { name: "bad-frontends", frontends: "telegram" };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/bad-frontends" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("rejects plugin when handleAction is defined but not a function", async () => {
    const plugin = { name: "bad-handle", handleAction: "not-a-function" };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/bad-handle" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("rejects plugin when mcpServer is not an object", async () => {
    const plugin = { name: "bad-mcp-server", mcpServer: "not-an-object" };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/bad-mcp-server" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("rejects plugin when mcpServer is null", async () => {
    const plugin = { name: "null-mcp-server", mcpServer: null };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/null-mcp-server" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("rejects plugin when mcpServer.command is not a string", async () => {
    const plugin = {
      name: "bad-mcp-cmd",
      mcpServer: { command: 123, args: [] },
    };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/bad-mcp-cmd" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("rejects plugin when mcpServer.args is not an array", async () => {
    const plugin = {
      name: "bad-mcp-args",
      mcpServer: { command: "/usr/bin/python3", args: "not-an-array" },
    };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/bad-mcp-args" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("rejects plugin when mcpServer.command is empty string", async () => {
    const plugin = {
      name: "empty-mcp-cmd",
      mcpServer: { command: "", args: ["-m", "server"] },
    };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/empty-mcp-cmd" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("rejects plugin when mcpServer.args contains non-string elements", async () => {
    const plugin = {
      name: "bad-mcp-args-types",
      mcpServer: { command: "/usr/bin/python3", args: ["-m", 42] },
    };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/bad-mcp-args-types" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("accepts plugin with valid mcpServer object", async () => {
    const plugin = {
      name: "good-mcp-server",
      mcpServer: { command: "/usr/bin/python3", args: ["-m", "server"] },
    };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/good-mcp-server" }]);
    expect(mod.getPluginCount()).toBe(1);
  });

  it("catches and logs error when importModule throws", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    const mod = await import("../core/plugin/index.js");
    const { logError } = (await import("../util/log.js")) as unknown as {
      logError: ReturnType<typeof vi.fn>;
    };
    mod._deps.importModule = async () => {
      throw new Error("module load failed");
    };
    await mod.loadPlugins([{ path: "/fake/throw-plugin" }]);
    expect(mod.getPluginCount()).toBe(0);
    expect(logError).toHaveBeenCalledWith(
      "plugin",
      expect.stringContaining("Failed to load plugin"),
    );
  });

  it("default _deps.importModule can import real modules", async () => {
    vi.resetModules();
    const mod = await import("../core/plugin/index.js");
    // Exercise the default importModule implementation (line 159) by importing a built-in
    const result = await mod._deps.importModule("node:path");
    expect(result).toBeDefined();
    expect(typeof (result as Record<string, unknown>).join).toBe("function");
  });

  it("catches importModule non-Error throw with String(err) (line 188 FALSE branch)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    const mod = await import("../core/plugin/index.js");
    const { logError } = (await import("../util/log.js")) as unknown as {
      logError: ReturnType<typeof vi.fn>;
    };
    // Throw a plain string (non-Error) — covers String(err) branch
    mod._deps.importModule = async () => {
      throw "plain string load error";
    };
    await mod.loadPlugins([{ path: "/fake/non-error-throw" }]);
    expect(logError).toHaveBeenCalledWith(
      "plugin",
      expect.stringContaining("plain string load error"),
    );
  });

  it("init non-Error throw uses String(err) (line 269 FALSE branch)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    const mod = await import("../core/plugin/index.js");
    const { logError } = (await import("../util/log.js")) as unknown as {
      logError: ReturnType<typeof vi.fn>;
    };
    const plugin = {
      name: "init-non-error",
      init: () => {
        throw "plain string init error";
      },
    };
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/init-non-error" }]);
    expect(logError).toHaveBeenCalledWith(
      "plugin",
      expect.stringContaining("plain string init error"),
    );
  });

  it("extractPlugin uses mod directly when default is absent (line 289 FALSE??branch)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    const mod = await import("../core/plugin/index.js");
    // No `default` export — `mod.default ?? mod` falls back to mod itself
    const pluginMod = { name: "mod-as-plugin", handleAction: async () => null };
    mod._deps.importModule = async () =>
      pluginMod as unknown as Record<string, unknown>;
    await mod.loadPlugins([{ path: "/fake/no-default" }]);
    expect(mod.getPlugin("mod-as-plugin")).toBeDefined();
  });

  it("extractPlugin returns null when candidate is not an object (line 290 TRUE branch)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    const mod = await import("../core/plugin/index.js");
    // default export is a number — candidate = 42, typeof 42 !== "object" → return null
    // Note: { default: null } would NOT work because null ?? mod evaluates to mod (not null)
    mod._deps.importModule = async () =>
      ({ default: 42 }) as unknown as Record<string, unknown>;
    await mod.loadPlugins([{ path: "/fake/non-object-default" }]);
    expect(mod.getPluginCount()).toBe(0);
  });

  it("destroy non-Error throw uses String(err) (line 145 FALSE branch)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    const mod = await import("../core/plugin/index.js");
    const { logError } = (await import("../util/log.js")) as unknown as {
      logError: ReturnType<typeof vi.fn>;
    };
    const plugin = {
      name: "destroy-non-error",
      destroy: () => {
        throw "plain string destroy error";
      },
    };
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/destroy-non-error" }]);
    await mod.destroyPlugins();
    expect(logError).toHaveBeenCalledWith(
      "plugin",
      expect.stringContaining("plain string destroy error"),
    );
  });

  it("getSystemPromptAddition non-Error throw uses String(err) (line 352 FALSE branch)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    const mod = await import("../core/plugin/index.js");
    const { logError } = (await import("../util/log.js")) as unknown as {
      logError: ReturnType<typeof vi.fn>;
    };
    const plugin = {
      name: "prompt-non-error",
      getSystemPromptAddition: () => {
        throw "plain string prompt error";
      },
    };
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/prompt-non-error" }]);
    mod.getPluginPromptAdditions();
    expect(logError).toHaveBeenCalledWith(
      "plugin",
      expect.stringContaining("plain string prompt error"),
    );
  });

  it("handlePluginAction non-Error throw uses String(err) (lines 378+382 FALSE branches)", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    const mod = await import("../core/plugin/index.js");
    const { logError } = (await import("../util/log.js")) as unknown as {
      logError: ReturnType<typeof vi.fn>;
    };
    const plugin = {
      name: "action-non-error",
      handleAction: async () => {
        throw "plain string action error";
      },
    };
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/action-non-error" }]);
    const result = await mod.handlePluginAction({ action: "test" }, "123");
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toContain("plain string action error");
    expect(logError).toHaveBeenCalledWith(
      "plugin",
      expect.stringContaining("plain string action error"),
    );
  });

  it("getLoadedPlugins returns all loaded plugins", async () => {
    const plugin = {
      name: "good-plugin",
      handleAction: async () => null,
    };
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin/index.js");
    mod._deps.importModule = async () => ({ default: plugin });
    await mod.loadPlugins([{ path: "/fake/good-p" }]);
    const loaded = mod.getLoadedPlugins();
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    expect(loaded.some((l) => l.plugin.name === "good-plugin")).toBe(true);
  });
});
