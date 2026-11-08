/**
 * MCP hub — child exit diagnostics.
 *
 * A hub child that dies used to surface as a bare "MCP error -32000:
 * Connection closed" with no exit code, no signal and no stderr (it was
 * inherited into the daemon's own stderr, never talon.log). These tests
 * pin the diagnosability contract:
 *
 *   - the stderr ring buffer keeps only the last N lines, split-safe
 *   - a child that dies during the initialize handshake is logged with
 *     code/signal/stderr tail and recorded for getLastChildExit
 *   - a child that dies after registration rejects in-flight calls
 *     (the SDK's close handler must stay chained) and is recorded too
 *   - the backend registration warning quotes the recorded exit
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/mcp-hub/index.js", () => ({
  talonHubUrl: (bridgeUrl: string, frontend: string, chatId: string) =>
    `${bridgeUrl}/mcp/talon/${frontend}/${chatId}`,
  pluginHubUrl: (bridgeUrl: string, name: string, chatId: string) =>
    `${bridgeUrl}/mcp/plugin/${name}/${chatId}`,
  hubPluginServerNames: () => ["playwright-tools"],
  listHubPluginToolNames: vi.fn(async () => {
    throw new Error("MCP error -32000: Connection closed");
  }),
  describeHubChildExit: vi.fn(
    () => "code=1 signal=null 0s ago; stderr: browser endpoint refused",
  ),
}));

import { logWarn } from "../util/log.js";
import {
  StderrTail,
  STDERR_TAIL_LINES,
} from "../core/mcp-hub/child-transport.js";
import {
  acquireChild,
  closeAllChildren,
  getActiveChildKeys,
  getLastChildExit,
  formatChildExit,
} from "../core/mcp-hub/children.js";
import {
  createRemoteServerState,
  ensurePluginMcpServers,
  type RemoteAgentClient,
} from "../backend/remote-server/index.js";

// `--no-warnings`: the children inherit the parent's env (children.ts merges
// process.env under the spec), so on a proxy-configured box Node would print
// its `NODE_USE_ENV_PROXY` notice + `--trace-warnings` hint to stderr and the
// exact-stderr assertions below would see two lines the scripts never wrote.
const nodeScript = (source: string) => ({
  command: process.execPath,
  args: ["--no-warnings", "-e", source],
  env: {},
});

/** Dies before answering initialize: 25 stderr lines, then exit 3. */
const DIES_IN_HANDSHAKE = nodeScript(`
  for (let i = 0; i < 25; i++) process.stderr.write("line-" + i + "\\n");
  process.stderr.write("fatal: browser endpoint refused");
  process.exit(3);
`);

const KILLS_ITSELF = nodeScript(`process.kill(process.pid, "SIGTERM");`);

/** Answers initialize, then exits 5 on the first tools/list. */
const DIES_ON_TOOLS_LIST = nodeScript(`
  process.stdin.setEncoding("utf-8");
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "dying", version: "0" },
        } }) + "\\n");
      } else if (msg.method === "tools/list") {
        process.stderr.write("boom: lost the browser\\n");
        process.exit(5);
      }
    }
  });
`);

const warnings = () =>
  vi.mocked(logWarn).mock.calls.map(([, message]) => message);

beforeEach(() => {
  vi.mocked(logWarn).mockClear();
});

afterAll(async () => {
  await closeAllChildren();
});

describe("StderrTail ring buffer", () => {
  it("keeps only the last N lines, across chunk boundaries", () => {
    const tail = new StderrTail(3);
    tail.push("a\nb\nc");
    tail.push("c-rest\nd\n");
    expect(tail.snapshot()).toEqual(["b", "cc-rest", "d"]);
  });

  it("includes an unterminated trailing fragment and skips blank lines", () => {
    const tail = new StderrTail();
    tail.push("one\n\n   \ntwo");
    expect(tail.snapshot()).toEqual(["one", "two"]);
  });

  it("clips runaway lines and defaults to STDERR_TAIL_LINES", () => {
    const tail = new StderrTail();
    for (let i = 0; i < STDERR_TAIL_LINES + 5; i++) tail.push(`${i}\n`);
    tail.push(`${"x".repeat(1000)}\n`);
    const lines = tail.snapshot();
    expect(lines).toHaveLength(STDERR_TAIL_LINES);
    expect(lines[0]).toBe("6");
    expect(lines.at(-1)).toHaveLength(401);
    expect(lines.at(-1)?.endsWith("…")).toBe(true);
  });
});

describe("hub child exit diagnostics", () => {
  it("records code + stderr tail for a child that dies in the handshake", async () => {
    const key = "dies-in-handshake chat";
    await expect(acquireChild(key, () => DIES_IN_HANDSHAKE)).rejects.toThrow(
      /Connection closed/,
    );

    const exit = getLastChildExit(key);
    expect(exit).toMatchObject({ code: 3, signal: null });
    expect(exit?.stderr).toHaveLength(STDERR_TAIL_LINES);
    expect(exit?.stderr[0]).toBe("line-6");
    expect(exit?.stderr.at(-1)).toBe("fatal: browser endpoint refused");
    expect(getActiveChildKeys()).not.toContain(key);

    const warning = warnings().find((m) => m.includes(key));
    expect(warning).toMatch(/died before registration \(pid \d+\)/);
    expect(warning).toContain("code=3 signal=null");
    expect(warning).toContain("fatal: browser endpoint refused");
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "records the signal for a signal-killed child",
    async () => {
      const key = "kills-itself chat";
      await expect(acquireChild(key, () => KILLS_ITSELF)).rejects.toThrow();
      expect(getLastChildExit(key)).toMatchObject({
        code: null,
        signal: "SIGTERM",
      });
      expect(warnings().find((m) => m.includes(key))).toContain(
        "code=null signal=SIGTERM",
      );
    },
    20_000,
  );

  it("rejects in-flight calls and drops the entry when a live child dies", async () => {
    const key = "dies-on-tools-list chat";
    const child = await acquireChild(key, () => DIES_ON_TOOLS_LIST);
    expect(getActiveChildKeys()).toContain(key);

    // Hangs forever if the SDK's close handler were clobbered.
    await expect(child.listTools()).rejects.toThrow(/Connection closed/);

    expect(getActiveChildKeys()).not.toContain(key);
    const exit = getLastChildExit(key);
    expect(exit).toMatchObject({ code: 5, signal: null });
    expect(exit?.stderr).toEqual(["boom: lost the browser"]);
    const warning = warnings().find((m) => m.includes(key));
    expect(warning).toContain("will respawn on demand");
    expect(warning).toContain("code=5 signal=null");
    expect(warning).toContain("boom: lost the browser");
  }, 20_000);

  it("formatChildExit bounds the quoted stderr lines", () => {
    const exit = {
      code: 1,
      signal: null,
      at: Date.now(),
      stderr: ["a", "b", "c", "d"],
    };
    expect(formatChildExit(exit, 2)).toMatch(
      /^code=1 signal=null \ds ago; stderr: c \| d$/,
    );
    expect(formatChildExit({ ...exit, stderr: [] })).toMatch(
      /^code=1 signal=null \ds ago$/,
    );
  });
});

describe("plugin MCP registration warning", () => {
  it("quotes the hub child's last exit next to the upstream error", async () => {
    const state = createRemoteServerState<RemoteAgentClient>({
      label: "TestBackend",
      hostname: "127.0.0.1",
      port: 9999,
    });
    state.gatewayPortFn = () => 19876;
    const client = {
      mcp: { add: vi.fn(), disconnect: vi.fn() },
      session: { create: vi.fn(), get: vi.fn() },
      tool: { ids: vi.fn(async () => ({ data: [] })) },
      provider: { list: vi.fn() },
    } as unknown as RemoteAgentClient;

    await expect(
      ensurePluginMcpServers(client, state, "chatA"),
    ).resolves.toEqual([]);

    expect(warnings()).toContainEqual(
      expect.stringMatching(
        /^Plugin MCP registration failed for .*playwright-tools: MCP error -32000: Connection closed \(hub child code=1 signal=null 0s ago; stderr: browser endpoint refused\)$/,
      ),
    );
    expect(client.mcp.add).not.toHaveBeenCalled();
  });
});

describe("hub child spawn-failure alert", () => {
  it("logs each failed spawn, alerts on the third in a row, resolves on the next good spawn", async () => {
    const { resetAlertsForTest, activeAlerts } =
      await import("../core/frontend-runtime/alerts.js");
    const sent: string[] = [];
    resetAlertsForTest(async (text) => {
      sent.push(text);
    });
    // Only Date is faked: the children are real processes on real timers,
    // the negative-cache window is measured with Date.now().
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const key = "flaky\u0000c1";
      const fail = async () =>
        expect(acquireChild(key, () => DIES_IN_HANDSHAKE)).rejects.toThrow();

      await fail();
      const line = warnings().find((m) =>
        m.startsWith("hub child spawn failed flaky chat=c1"),
      );
      expect(line).toContain("attempt=1 backoff_ms=30000");
      expect(line).toContain('stderr="fatal: browser endpoint refused"');

      vi.setSystemTime(Date.now() + 31_000);
      await fail();
      expect(activeAlerts().map((a) => a.key)).not.toContain("mcp.child.flaky");

      vi.setSystemTime(Date.now() + 61_000);
      await fail();
      expect(activeAlerts().map((a) => a.key)).toContain("mcp.child.flaky");
      expect(sent[0]).toMatch(
        /MCP server "flaky" has failed to start 3 times in a row: .*fatal: browser endpoint refused/,
      );

      vi.setSystemTime(Date.now() + 121_000);
      await acquireChild(key, () => DIES_ON_TOOLS_LIST);
      expect(activeAlerts().map((a) => a.key)).not.toContain("mcp.child.flaky");
      expect(sent.at(-1)).toMatch(
        /MCP server "flaky" is starting normally again/,
      );
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
