/**
 * Regression: plugin MCP server commands must reach the hub launcher
 * exactly as `getPluginMcpServers()` built them.
 *
 * History: before the MCP hub, every backend flattened plugin specs
 * into its own spawn config, and codex / openai-agents / remote-server
 * once re-applied `wrapMcpCommand(...)` on top of the already-wrapped
 * spec — a `[supervisor, …, supervisor, …, realCmd]` double-wrap that
 * broke plugin MCP servers.
 *
 * With the hub, backends never see commands at all — they emit hub
 * URLs (pinned by codex-backend.test.ts). The pass-through contract
 * now lives in ONE place: the hub's child spawner must consume the
 * spec unchanged. This test pins that: the spec the hub would spawn for
 * a plugin server is byte-identical to what `getPluginMcpServers()`
 * returned. (Specs are raw commands now — orphan protection is applied
 * at spawn time by the child guard, which wraps in supervisor mode
 * only; see mcp-hub-inprocess.test.ts. The fixture below is an
 * already-wrapped command, which must still pass through untouched.)
 */

import { describe, it, expect, vi } from "vitest";

// Stand-in for a getPluginMcpServers() entry: already wrapped by
// wrapMcpServer, i.e. the real command runs under the Talon supervisor.
const LAUNCHER_READY = {
  "mempalace-tools": {
    command: "node",
    args: [
      "--import",
      "/talon/node_modules/tsx/dist/esm/index.mjs",
      "/talon/dist/mcp-launch.js",
      "python",
      "-m",
      "mempalace.mcp_server",
    ],
    env: { MEMPALACE_PATH: "/palace" },
  },
};

vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: vi.fn(() => structuredClone(LAUNCHER_READY)),
}));

import { _pluginSpecForTesting } from "../core/mcp-hub/index.js";

describe("plugin MCP servers are not double-wrapped", () => {
  it("the hub spawns the launcher-ready command/args unchanged", () => {
    const spec = _pluginSpecForTesting(
      "mempalace-tools",
      "c1",
      "http://127.0.0.1:19876",
    );

    const expected = LAUNCHER_READY["mempalace-tools"];
    // Exact pass-through: re-wrapping would replace `command` with the
    // supervisor binary and push the original command down into `args`.
    expect(spec.command).toBe(expected.command);
    expect(spec.args).toEqual(expected.args);
    expect(spec.env).toEqual(expected.env);

    // Belt-and-braces: the launcher entrypoint token must appear exactly
    // once across the final argv — a second wrap would duplicate it.
    const launcherHits = spec.args.filter((a) =>
      a.includes("mcp-launch.js"),
    ).length;
    expect(launcherHits).toBe(1);
  });
});
