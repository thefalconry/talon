/**
 * Per-chat MCP bundle pool — unit tests.
 *
 * These tests don't spawn real MCP subprocesses (that needs the
 * filesystem + working `node`/`tsx` resolution from the production
 * checkout). They cover the in-process pool semantics: cache reuse,
 * per-chat keying, in-flight dedup, release lifecycle.
 *
 * To keep the tests self-contained the SDK's `connectMcpServers` is
 * mocked at module-import time via `vi.mock`. Each mock invocation
 * resolves to a stub `mcpServers` object the pool wraps into an
 * `OpenAIAgentsMcpBundle`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Track every `connectMcpServers` call so tests can assert call count
// and capture the input server set.
const connectCalls: Array<{ servers: unknown[]; opts: unknown }> = [];

// Per-call close + reconnect counts so tests can verify lifecycle.
let activeBundleCount = 0;
let closeCount = 0;

vi.mock("@openai/agents", () => {
  // Stub MCPServerStreamableHttp so the constructor doesn't open a
  // real HTTP connection. Records the options for later inspection.
  class FakeMCPServerStreamableHttp {
    name: string;
    url: string;
    cacheToolsList: boolean | undefined;
    toolFilter: unknown;
    constructor(opts: {
      name: string;
      url: string;
      cacheToolsList?: boolean;
      toolFilter?: unknown;
    }) {
      this.name = opts.name;
      this.url = opts.url;
      this.cacheToolsList = opts.cacheToolsList;
      this.toolFilter = opts.toolFilter;
    }
    async connect(): Promise<void> {
      /* no-op */
    }
    async close(): Promise<void> {
      /* no-op */
    }
  }

  async function connectMcpServers(
    servers: unknown[],
    opts: unknown,
  ): Promise<{
    active: unknown[];
    failed: unknown[];
    errors: Array<[unknown, Error]>;
    close: () => Promise<void>;
  }> {
    connectCalls.push({ servers, opts });
    activeBundleCount += 1;
    return {
      active: servers,
      failed: [],
      errors: [],
      close: async () => {
        closeCount += 1;
        activeBundleCount -= 1;
      },
    };
  }

  return {
    MCPServerStreamableHttp: FakeMCPServerStreamableHttp,
    connectMcpServers,
    createMCPToolStaticFilter: (o: { allowed?: string[] }) => ({
      allowedToolNames: o.allowed,
    }),
  };
});

// Mock plugin server map so the pool sees a deterministic set.
vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: (_bridgeUrl: string, _chatId: string) => ({
    "fake-plugin-tools": {
      command: "echo",
      args: ["fake"],
      env: { FOO: "bar" },
    },
  }),
}));

// Mock the mcp-launcher to keep wrapMcpCommand simple.
vi.mock("../core/mcp-hub/launcher.js", () => ({
  wrapMcpCommand: (cmd: string[]) => cmd,
}));

// Mock the log module so we don't pollute test output and don't need
// the full pino transport.
vi.mock("../util/log.js", () => ({
  log: () => {},
  logWarn: () => {},
  logError: () => {},
  logDebug: () => {},
}));

import {
  openUnpooledBundle,
  getOrCreateBundle,
  releaseBundle,
  releaseAllBundles,
  getActiveBundleIds,
} from "../backend/openai-agents/mcp-pool.js";

const inputs = (chatId: string) => ({
  chatId,
  bridgeUrl: "http://127.0.0.1:19876",
  frontends: ["telegram"],
  braveApiKey: undefined,
});

describe("openai-agents / mcp-pool", () => {
  beforeEach(async () => {
    // Wipe pool state between tests.
    await releaseAllBundles();
    connectCalls.length = 0;
    activeBundleCount = 0;
    closeCount = 0;
  });

  it("builds a bundle on first get for a chat", async () => {
    const bundle = await getOrCreateBundle(inputs("chat-A"));

    expect(bundle.servers.length).toBeGreaterThan(0);
    expect(connectCalls.length).toBe(1);
    expect(getActiveBundleIds()).toEqual(["chat-A"]);
  });

  it("reuses the cached bundle on subsequent gets for the same chat", async () => {
    const first = await getOrCreateBundle(inputs("chat-A"));
    const second = await getOrCreateBundle(inputs("chat-A"));
    const third = await getOrCreateBundle(inputs("chat-A"));

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(connectCalls.length).toBe(1); // built once, reused twice
  });

  it("builds independent bundles for different chats", async () => {
    const a = await getOrCreateBundle(inputs("chat-A"));
    const b = await getOrCreateBundle(inputs("chat-B"));

    expect(a).not.toBe(b);
    expect(connectCalls.length).toBe(2);
    expect([...getActiveBundleIds()].sort()).toEqual(["chat-A", "chat-B"]);
  });

  it("dedupes concurrent gets for the same chat (in-flight build)", async () => {
    const [a, b, c] = await Promise.all([
      getOrCreateBundle(inputs("chat-A")),
      getOrCreateBundle(inputs("chat-A")),
      getOrCreateBundle(inputs("chat-A")),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(connectCalls.length).toBe(1); // single build despite three concurrent gets
  });

  it("releaseBundle closes the subprocesses and evicts the entry", async () => {
    await getOrCreateBundle(inputs("chat-A"));
    expect(getActiveBundleIds()).toEqual(["chat-A"]);
    expect(activeBundleCount).toBe(1);

    await releaseBundle("chat-A");

    expect(getActiveBundleIds()).toEqual([]);
    expect(closeCount).toBe(1);
    expect(activeBundleCount).toBe(0);
  });

  it("rebuilds after release (next get spawns fresh)", async () => {
    await getOrCreateBundle(inputs("chat-A"));
    await releaseBundle("chat-A");
    await getOrCreateBundle(inputs("chat-A"));

    expect(connectCalls.length).toBe(2); // built, released, built again
    expect(getActiveBundleIds()).toEqual(["chat-A"]);
  });

  it("releaseBundle on unknown chat is a no-op", async () => {
    await expect(releaseBundle("never-existed")).resolves.toBeUndefined();
    expect(closeCount).toBe(0);
  });

  it("releaseAllBundles closes every live bundle", async () => {
    await getOrCreateBundle(inputs("chat-A"));
    await getOrCreateBundle(inputs("chat-B"));
    await getOrCreateBundle(inputs("chat-C"));

    expect(getActiveBundleIds().length).toBe(3);
    expect(activeBundleCount).toBe(3);

    await releaseAllBundles();

    expect(getActiveBundleIds()).toEqual([]);
    expect(closeCount).toBe(3);
    expect(activeBundleCount).toBe(0);
  });

  it("releaseBundle while build is in-flight waits then closes", async () => {
    // Kick off a build but don't await it.
    const buildPromise = getOrCreateBundle(inputs("chat-A"));
    // Race a release against it (release must NOT precede the build).
    const releasePromise = releaseBundle("chat-A");

    await buildPromise;
    await releasePromise;

    // Net effect: built once + closed once + no leftover entry.
    expect(connectCalls.length).toBe(1);
    expect(closeCount).toBe(1);
    expect(getActiveBundleIds()).toEqual([]);
  });

  it("each MCPServerStreamableHttp is constructed with cacheToolsList=true", async () => {
    await getOrCreateBundle(inputs("chat-A"));
    expect(connectCalls.length).toBe(1);

    const servers = connectCalls[0].servers as Array<{
      cacheToolsList?: boolean;
      name: string;
    }>;
    for (const server of servers) {
      expect(server.cacheToolsList).toBe(true);
    }
  });

  it("connectMcpServers is called with connectInParallel=true", async () => {
    await getOrCreateBundle(inputs("chat-A"));

    const opts = connectCalls[0].opts as { connectInParallel?: boolean };
    expect(opts.connectInParallel).toBe(true);
  });

  it("includes the frontend tool server + plugin servers", async () => {
    await getOrCreateBundle(inputs("chat-A"));

    const names = (connectCalls[0].servers as Array<{ name: string }>).map(
      (s) => s.name,
    );
    expect(names).toContain("telegram-tools"); // from frontends array
    expect(names).toContain("fake-plugin-tools"); // from mocked plugin map
  });

  it("includes brave-search server when braveApiKey is set", async () => {
    await getOrCreateBundle({
      ...inputs("chat-A"),
      braveApiKey: "test-key",
    });

    const names = (connectCalls[0].servers as Array<{ name: string }>).map(
      (s) => s.name,
    );
    expect(names).toContain("brave-search");
  });

  it("omits brave-search server when braveApiKey is undefined", async () => {
    await getOrCreateBundle(inputs("chat-A"));

    const names = (connectCalls[0].servers as Array<{ name: string }>).map(
      (s) => s.name,
    );
    expect(names).not.toContain("brave-search");
  });

  describe("lean bundles (isolated runs)", () => {
    type FakeServer = {
      name: string;
      url: string;
      cacheToolsList?: boolean;
      toolFilter?: { allowedToolNames?: string[] };
    };
    const lastServers = () =>
      connectCalls[connectCalls.length - 1]!.servers as FakeServer[];

    it("the full surface is every frontend, brave and every plugin", async () => {
      const bundle = await openUnpooledBundle({
        chatId: "agent:agt_1",
        bridgeUrl: "http://127.0.0.1:19876",
        frontends: ["telegram", "native"],
        braveApiKey: "k",
      });
      expect(lastServers().map((s) => s.name)).toEqual([
        "telegram-tools",
        "native-tools",
        "brave-search",
        "fake-plugin-tools",
      ]);
      await bundle.close();
    });

    it("a lean bundle is one filtered frontend server and no plugins", async () => {
      const bundle = await openUnpooledBundle({
        chatId: "agent:agt_1",
        bridgeUrl: "http://127.0.0.1:19876",
        frontends: ["telegram", "native"],
        braveApiKey: "k",
        lean: { tools: ["report_result", "check_inbox"], plugins: [] },
      });
      const servers = lastServers();
      expect(servers.map((s) => s.name)).toEqual(["telegram-tools"]);
      expect(servers[0]!.toolFilter?.allowedToolNames).toEqual([
        "report_result",
        "check_inbox",
      ]);
      // The SDK's tool-list cache is global and keyed by server name: a
      // filtered listing must never be stored for (or read from) the chat
      // path's same-named server.
      expect(servers[0]!.cacheToolsList).toBe(false);
      await bundle.close();
    });

    it("a lean bundle adds only the plugin servers it names", async () => {
      const bundle = await openUnpooledBundle({
        chatId: "agent:agt_1",
        bridgeUrl: "http://127.0.0.1:19876",
        frontends: ["telegram"],
        braveApiKey: "k",
        lean: {
          tools: ["report_result"],
          plugins: ["fake-plugin-tools", "not-loaded"],
        },
      });
      expect(lastServers().map((s) => s.name)).toEqual([
        "telegram-tools",
        "fake-plugin-tools",
      ]);
      await bundle.close();
    });
  });
});
