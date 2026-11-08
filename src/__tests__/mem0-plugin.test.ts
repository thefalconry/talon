import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const PROMPT_TEMPLATE = `# mem0 — Long-term Memory

mem0_search_memory mem0_add_memory mem0_list_memories mem0_delete_memory
Entity id: \`{{userId}}\`
`;

const envBackup = process.env.MEM0_API_KEY;

describe("mem0 plugin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.MEM0_API_KEY;
  });

  afterEach(() => {
    if (envBackup === undefined) delete process.env.MEM0_API_KEY;
    else process.env.MEM0_API_KEY = envBackup;
  });

  async function makePlugin(config: {
    apiKey?: string;
    host?: string;
    userId?: string;
  }) {
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    const { createMem0Plugin } = await import("../plugins/mem0/index.js");
    return createMem0Plugin(config);
  }

  it("creates a plugin pointing at the stdio MCP server script", async () => {
    const plugin = await makePlugin({ apiKey: "m0-test" });
    expect(plugin.name).toBe("mem0");
    expect(plugin.mcpServerPath).toMatch(/plugins[\\/]mem0[\\/]server\.ts$/);
    expect(plugin.mcpServer).toBeUndefined();
  });

  it("validateConfig fails without an API key or host", async () => {
    const plugin = await makePlugin({});
    const errors = plugin.validateConfig?.({});
    expect(errors).toHaveLength(1);
    expect(errors?.[0]).toContain("MEM0_API_KEY");
  });

  it("validateConfig passes with an API key", async () => {
    const plugin = await makePlugin({ apiKey: "m0-test" });
    expect(plugin.validateConfig?.({})).toBeUndefined();
  });

  it("validateConfig passes with a self-hosted host and no key", async () => {
    const plugin = await makePlugin({ host: "http://localhost:8888" });
    expect(plugin.validateConfig?.({})).toBeUndefined();
  });

  it("falls back to the MEM0_API_KEY env var", async () => {
    process.env.MEM0_API_KEY = "m0-env";
    const plugin = await makePlugin({});
    expect(plugin.validateConfig?.({})).toBeUndefined();
    expect(plugin.getEnvVars?.({})).toMatchObject({ MEM0_API_KEY: "m0-env" });
  });

  it("exposes env vars for the MCP subprocess", async () => {
    const plugin = await makePlugin({
      apiKey: "m0-test",
      host: "http://localhost:8888",
      userId: "ada",
    });
    expect(plugin.getEnvVars?.({})).toEqual({
      MEM0_API_KEY: "m0-test",
      MEM0_HOST: "http://localhost:8888",
      MEM0_USER_ID: "ada",
    });
  });

  it("defaults the entity id to talon", async () => {
    const plugin = await makePlugin({ apiKey: "m0-test" });
    expect(plugin.getEnvVars?.({})).toEqual({
      MEM0_API_KEY: "m0-test",
      MEM0_USER_ID: "talon",
    });
  });

  it("substitutes {{userId}} in the system prompt template", async () => {
    const plugin = await makePlugin({ apiKey: "m0-test", userId: "ada" });
    const addition = plugin.getSystemPromptAddition?.({});
    expect(addition).toContain("Entity id: `ada`");
    expect(addition).not.toContain("{{userId}}");
  });

  it("falls back to a minimal prompt when the template is missing", async () => {
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => {
        throw new Error("ENOENT");
      }),
    }));
    const { createMem0Plugin } = await import("../plugins/mem0/index.js");
    const plugin = createMem0Plugin({ apiKey: "m0-test" });
    const addition = plugin.getSystemPromptAddition?.({});
    expect(addition).toContain("mem0 — Long-term Memory");
    expect(addition).toContain("`talon`");
  });
});
