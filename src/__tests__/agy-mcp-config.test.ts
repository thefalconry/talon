/**
 * Antigravity MCP-config tests.
 *
 * agy reads its MCP servers from ONE shared file that also holds the
 * user's own entries, so the behaviour under test is mostly about what
 * Talon must NOT do: never lose a foreign entry, never truncate the
 * file, never leave a schema-snapshot directory behind.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../core/mcp-hub/index.js", () => ({
  talonHubUrl: (bridge: string, frontend: string, chatId: string) =>
    `${bridge}/mcp/talon/${frontend}/${chatId}`,
  pluginHubUrl: (bridge: string, server: string, chatId: string) =>
    `${bridge}/mcp/plugin/${server}/${chatId}`,
  hubPluginServerNames: () => ["extras-tools"],
}));
vi.mock("../backend/runtime/frontends.js", () => ({
  frontendsForChat: (_chatId: string, configured: readonly string[]) =>
    configured,
  nonTerminalFrontends: (f: unknown) => (Array.isArray(f) ? f : f ? [f] : []),
}));

const {
  agyScopeSlug,
  agyServerKey,
  isTalonAgyKey,
  buildAgyMcpServers,
  readAgyMcpServers,
  writeAgyMcpServers,
  removeAgyMcpServers,
  pruneStaleTalonEntries,
  removeSnapshotDirs,
} = await import("../backend/agy/mcp/config.js");

let dir: string;
let configPath: string;
let snapshotDir: string;

const readRaw = () => readFileSync(configPath, "utf-8");
const readJson = () => JSON.parse(readRaw()) as Record<string, unknown>;

const FOREIGN = {
  "my-own-server": { disabled: false, serverUrl: "http://example.test/mcp" },
  "stdio-thing": { command: "node", args: ["x.js"], env: { A: "1" } },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agy-mcp-"));
  configPath = join(dir, "config", "mcp_config.json");
  snapshotDir = join(dir, "snapshots");
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { ...FOREIGN }, someOtherKey: 42 }, null, 2),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const opts = () => ({ configPath, snapshotDir });

const servers = (chatId = "-1009876543210") =>
  buildAgyMcpServers({
    chatId,
    bridgeUrl: "http://127.0.0.1:19876",
    frontends: ["telegram"],
    braveApiKey: "brave-key",
  });

describe("agy mcp-config — naming", () => {
  it("slugs a chat id into one safe token", () => {
    expect(agyScopeSlug("-1009876543210")).toBe("1009876543210");
    expect(agyScopeSlug("wa_dm_353871234567")).toBe("wa-dm-353871234567");
    expect(agyScopeSlug("!!!")).toBe("chat");
  });

  it("only claims keys under the Talon prefix", () => {
    expect(isTalonAgyKey(agyServerKey("abc", "telegram-tools"))).toBe(true);
    expect(isTalonAgyKey("my-own-server")).toBe(false);
    expect(isTalonAgyKey("talon-ish")).toBe(false);
  });
});

describe("agy mcp-config — building", () => {
  // Every entry authenticates to the hub with the gateway token.
  const AUTH = { Authorization: "Bearer vitest-gateway-token" };

  it("builds the same membership codex builds, as http entries", () => {
    expect(servers()).toEqual({
      "__talon__1009876543210__telegram-tools": {
        disabled: false,
        headers: AUTH,
        serverUrl: "http://127.0.0.1:19876/mcp/talon/telegram/-1009876543210",
      },
      "__talon__1009876543210__brave-search": {
        disabled: false,
        headers: AUTH,
        serverUrl:
          "http://127.0.0.1:19876/mcp/plugin/brave-search/-1009876543210",
      },
      "__talon__1009876543210__extras-tools": {
        disabled: false,
        headers: AUTH,
        serverUrl:
          "http://127.0.0.1:19876/mcp/plugin/extras-tools/-1009876543210",
      },
    });
  });

  it("omits brave when no key is configured", () => {
    const built = buildAgyMcpServers({
      chatId: "-100",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: ["telegram"],
    });
    expect(Object.keys(built)).not.toContain("__talon__100__brave-search");
  });

  it("honours an explicit scope so a one-shot can't collide with a chat", () => {
    const built = buildAgyMcpServers({
      chatId: "heartbeat",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: ["telegram"],
      scope: "oneshot-heartbeat",
    });
    expect(Object.keys(built)).toEqual([
      "__talon__oneshot-heartbeat__telegram-tools",
      "__talon__oneshot-heartbeat__extras-tools",
    ]);
  });
});

describe("agy mcp-config — writing", () => {
  it("adds Talon entries and preserves every foreign entry byte-for-byte", () => {
    const before = readJson();
    const { added, removed } = writeAgyMcpServers(
      "1009876543210",
      servers(),
      opts(),
    );
    expect(added).toHaveLength(3);
    expect(removed).toEqual([]);

    const after = readJson();
    const afterServers = after.mcpServers as Record<string, unknown>;
    expect(afterServers["my-own-server"]).toEqual(FOREIGN["my-own-server"]);
    expect(afterServers["stdio-thing"]).toEqual(FOREIGN["stdio-thing"]);
    // Top-level keys that are not ours survive too.
    expect(after.someOtherKey).toBe(42);
    expect(Object.keys((before.mcpServers as object) ?? {})).toHaveLength(2);
  });

  it("writes through a temp file and leaves no .tmp behind", () => {
    writeAgyMcpServers("1009876543210", servers(), opts());
    const leftovers = readdirSync(join(dir, "config")).filter((f) =>
      f.includes(".tmp"),
    );
    expect(leftovers).toEqual([]);
    // The result is always parseable — a truncated write would not be.
    expect(() => readJson()).not.toThrow();
    expect(readRaw().endsWith("\n")).toBe(true);
  });

  it("creates the config directory when the file has never existed", () => {
    const fresh = join(dir, "nope", "mcp_config.json");
    writeAgyMcpServers("s", servers(), { configPath: fresh, snapshotDir });
    expect(existsSync(fresh)).toBe(true);
    expect(Object.keys(readAgyMcpServers(fresh))).toHaveLength(3);
  });

  it("drops entries of its own scope that are no longer wanted", () => {
    writeAgyMcpServers("1009876543210", servers(), opts());
    const trimmed = Object.fromEntries(
      Object.entries(servers()).filter(([k]) => !k.endsWith("extras-tools")),
    );
    const { removed } = writeAgyMcpServers("1009876543210", trimmed, opts());
    expect(removed).toEqual(["__talon__1009876543210__extras-tools"]);
    expect(Object.keys(readAgyMcpServers(configPath))).not.toContain(
      "__talon__1009876543210__extras-tools",
    );
  });

  it("leaves another chat's scope alone", () => {
    writeAgyMcpServers(
      "chatA",
      buildAgyMcpServers({
        chatId: "a",
        bridgeUrl: "http://h",
        frontends: ["telegram"],
        scope: "chatA",
      }),
      opts(),
    );
    writeAgyMcpServers(
      "chatB",
      buildAgyMcpServers({
        chatId: "b",
        bridgeUrl: "http://h",
        frontends: ["telegram"],
        scope: "chatB",
      }),
      opts(),
    );
    const keys = Object.keys(readAgyMcpServers(configPath));
    expect(keys).toContain("__talon__chatA__telegram-tools");
    expect(keys).toContain("__talon__chatB__telegram-tools");
  });
});

describe("agy mcp-config — removal and snapshots", () => {
  const snapshotFor = (key: string) => join(snapshotDir, key);

  it("removes a scope's entries and their schema snapshot dirs", () => {
    writeAgyMcpServers("1009876543210", servers(), opts());
    for (const key of Object.keys(servers())) {
      mkdirSync(snapshotFor(key), { recursive: true });
      writeFileSync(join(snapshotFor(key), "check_time.json"), "{}");
    }
    const removed = removeAgyMcpServers("1009876543210", opts());
    expect(removed).toHaveLength(3);
    for (const key of Object.keys(servers())) {
      expect(existsSync(snapshotFor(key)), key).toBe(false);
    }
    expect(Object.keys(readAgyMcpServers(configPath))).toEqual([
      "my-own-server",
      "stdio-thing",
    ]);
  });

  it("never deletes a snapshot dir outside the Talon prefix", () => {
    const foreign = join(snapshotDir, "minimal");
    mkdirSync(foreign, { recursive: true });
    removeSnapshotDirs(["minimal", "../escape", "__talon__x/y"], snapshotDir);
    expect(existsSync(foreign)).toBe(true);
  });
});

describe("agy mcp-config — pruning stale Talon entries", () => {
  it("removes __talon__ entries this boot did not write", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          ...FOREIGN,
          "__talon__0_telegram-tools": { command: "node", args: [] },
          "__talon__ccusage-tools": { command: "node", args: [] },
          "__talon__live__telegram-tools": {
            disabled: false,
            serverUrl: "http://h",
          },
        },
      }),
    );
    const stale = pruneStaleTalonEntries(
      ["__talon__live__telegram-tools"],
      opts(),
    );
    expect(stale.sort()).toEqual([
      "__talon__0_telegram-tools",
      "__talon__ccusage-tools",
    ]);
    const keys = Object.keys(readAgyMcpServers(configPath));
    expect(keys).toContain("my-own-server");
    expect(keys).toContain("stdio-thing");
    expect(keys).toContain("__talon__live__telegram-tools");
  });

  it("is a no-op — and does not rewrite the file — when nothing is stale", () => {
    const before = readRaw();
    expect(pruneStaleTalonEntries([], opts())).toEqual([]);
    expect(readRaw()).toBe(before);
  });
});

describe("agy mcp-config — hostile inputs", () => {
  it("treats a missing file as an empty server map", () => {
    expect(readAgyMcpServers(join(dir, "absent.json"))).toEqual({});
  });

  it("does not throw on a corrupt file", () => {
    writeFileSync(configPath, "{ not json");
    expect(readAgyMcpServers(configPath)).toEqual({});
    expect(() => writeAgyMcpServers("s", servers(), opts())).not.toThrow();
    expect(Object.keys(readAgyMcpServers(configPath))).toHaveLength(3);
  });

  it("ignores a non-object mcpServers value", () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: [1, 2] }));
    expect(readAgyMcpServers(configPath)).toEqual({});
  });
});
