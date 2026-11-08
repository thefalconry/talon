/**
 * MCP hub — in-process child supervision and cross-chat tool listing.
 *
 * The hub spawns MCP children directly (no per-child supervisor
 * process): stdout filtering happens in HubChildTransport, orphan
 * cleanup in the child guard. And a session's tools/list is answered
 * from a per-server cache, so a new chat / sub-agent / cron run does
 * not spawn the whole plugin fleet just to enumerate tools.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  HubChildTransport,
  StdoutLineFilter,
} from "../core/mcp-hub/child-transport.js";
import {
  acquireChild,
  closeAllChildren,
  getActiveChildKeys,
  listChildTools,
  retireAllChildren,
} from "../core/mcp-hub/children.js";
import {
  _resetChildGuardForTesting,
  childGuardMode,
  enableChildGuard,
  guardedSpec,
} from "../core/mcp-hub/child-guard.js";
import { parseGuardLine, killPids } from "../core/mcp-hub/reaper.js";
import {
  MCP_LAUNCH_SUBCOMMAND,
  parseJsonRpcLine,
  startBridgeWatchdog,
  BRIDGE_FAILURES_BEFORE_EXIT,
  BRIDGE_UNRESPONSIVE_BEFORE_EXIT,
} from "../core/mcp-hub/launcher.js";
import { spawn } from "node:child_process";

// POSIX-only: Windows has no signals/mountinfo semantics these tests rely on.
const isWin = process.platform === "win32";

/**
 * Minimal stdio MCP server that — like tailscale-mcp, ccusage and
 * polymarket in the wild — prints non-protocol lines on STDOUT, both at
 * startup and between responses.
 */
const NOISY_SERVER = {
  command: process.execPath,
  args: [
    "--no-warnings",
    "-e",
    `
    process.stdin.setEncoding("utf-8");
    process.stdin.on("end", () => process.exit(0));
    const out = (s) => process.stdout.write(s);
    const send = (m) => out(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
    out("Server starting up...\\n");
    out("[2026-01-01T00:00:00Z] [INFO] banner line\\n");
    out("{ tip: 'not json' }\\n");
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          send({ id: msg.id, result: {
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "noisy", version: "0" },
          }});
        } else if (msg.method === "tools/list") {
          out("listing tools now\\n");
          send({ id: msg.id, result: { tools: [
            { name: "pid", inputSchema: { type: "object" } },
          ]}});
        } else if (msg.method === "tools/call") {
          send({ id: msg.id, result: { content: [
            { type: "text", text: String(process.pid) },
          ]}});
        } else if (msg.id !== undefined) {
          send({ id: msg.id, result: {} });
        }
      }
    });
    `,
  ],
};

afterEach(async () => {
  await closeAllChildren();
  _resetChildGuardForTesting();
});

describe("stdout filter (in-process)", () => {
  it("parseJsonRpcLine accepts JSON objects only", () => {
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","id":1}\n')).toEqual({
      jsonrpc: "2.0",
      id: 1,
    });
    expect(parseJsonRpcLine('  {"a":1}')).toEqual({ a: 1 });
    expect(parseJsonRpcLine("[1,2]")).toBeNull();
    expect(parseJsonRpcLine("[INFO] started")).toBeNull();
    expect(parseJsonRpcLine("{ tip: 1 }")).toBeNull();
    expect(parseJsonRpcLine("")).toBeNull();
    expect(parseJsonRpcLine("null")).toBeNull();
  });

  it("StdoutLineFilter splits across chunks, reroutes non-JSON, flushes the tail", () => {
    const lines: object[] = [];
    const rejected: string[] = [];
    const f = new StdoutLineFilter(
      (o) => lines.push(o),
      (l) => rejected.push(l),
    );
    f.push(Buffer.from('banner\r\n{"a":'));
    f.push(Buffer.from('1}\n\n[2026] [INFO] x\n{"b":2}'));
    expect(lines).toEqual([{ a: 1 }]);
    expect(rejected).toEqual(["banner", "[2026] [INFO] x"]);
    f.flush();
    expect(lines).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("StdoutLineFilter keeps a multibyte character split across chunks intact", () => {
    const lines: Array<Record<string, string>> = [];
    const f = new StdoutLineFilter(
      (o) => lines.push(o as Record<string, string>),
      () => {},
    );
    const bytes = Buffer.from('{"t":"→ ünï"}\n');
    // Split inside the 3-byte arrow.
    f.push(bytes.subarray(0, 8));
    f.push(bytes.subarray(8));
    expect(lines).toEqual([{ t: "→ ünï" }]);
  });

  it("a server that prints banners on stdout still speaks MCP; banners land in the stderr tail", async () => {
    const transport = new HubChildTransport({
      ...NOISY_SERVER,
      env: process.env as Record<string, string>,
    });
    const errors: Error[] = [];
    const client = new Client({ name: "t", version: "0" });
    client.onerror = (e) => errors.push(e);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["pid"]);
      const tail = transport.stderrLines.join("\n");
      expect(tail).toContain(
        "[mcp-launcher: stdout→stderr] Server starting up...",
      );
      expect(tail).toContain("[INFO] banner line");
      expect(tail).toContain("{ tip: 'not json' }");
      expect(tail).toContain("listing tools now");
      // Nothing surfaced as a protocol parse error.
      expect(errors).toEqual([]);
    } finally {
      await client.close();
    }
  }, 15_000);

  it("reports spawn and exit pids to the guard hooks", async () => {
    const spawned: number[] = [];
    const exited: number[] = [];
    const transport = new HubChildTransport({
      ...NOISY_SERVER,
      env: process.env as Record<string, string>,
      onSpawned: (pid) => spawned.push(pid),
      onExited: (pid) => exited.push(pid),
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);
    expect(spawned).toEqual([transport.pid]);
    await client.close();
    await vi.waitFor(() => expect(exited).toEqual(spawned));
  }, 15_000);
});

describe("cross-chat tool listing", () => {
  const key = (chat: string) => `noisy-tools\u0000${chat}`;

  it("a second chat's tools/list is served from cache without spawning its child", async () => {
    const first = await listChildTools(key("A"), () => NOISY_SERVER);
    expect(first.map((t) => t.name)).toEqual(["pid"]);
    expect(getActiveChildKeys()).toEqual([key("A")]);

    const second = await listChildTools(key("B"), () => NOISY_SERVER);
    expect(second).toEqual(first);
    expect(getActiveChildKeys()).toEqual([key("A")]);

    // The chat's own child spawns on its first actual call — still
    // chat-scoped, a different process from chat A's.
    const b = await acquireChild(key("B"), () => NOISY_SERVER);
    const a = await acquireChild(key("A"), () => NOISY_SERVER);
    const pidOf = async (h: typeof a) =>
      ((await h.callTool("pid", {})).content as Array<{ text: string }>)[0]
        .text;
    expect(await pidOf(b)).not.toBe(await pidOf(a));
    expect(getActiveChildKeys().sort()).toEqual([key("A"), key("B")].sort());
  }, 20_000);

  it("plugin reload clears the cache, so the next listing spawns fresh code", async () => {
    await listChildTools(key("A"), () => NOISY_SERVER);
    retireAllChildren();
    expect(getActiveChildKeys()).toEqual([]);
    await listChildTools(key("C"), () => NOISY_SERVER);
    expect(getActiveChildKeys()).toEqual([key("C")]);
  }, 20_000);

  it("a key inside its spawn-failure backoff fails its listing instead of advertising dead tools", async () => {
    await listChildTools(key("A"), () => NOISY_SERVER);
    const broken = {
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
    };
    // No failure recorded yet for D: the cached list is served…
    await expect(listChildTools(key("D"), () => broken)).resolves.toHaveLength(
      1,
    );
    // …its first real use fails and enters backoff…
    await expect(acquireChild(key("D"), () => broken)).rejects.toThrow();
    // …after which listing reports the failure like before.
    await expect(listChildTools(key("D"), () => broken)).rejects.toThrow();
  }, 20_000);
});

describe("child guard modes", () => {
  const spec = { command: "python", args: ["-m", "srv"], env: { A: "1" } };

  it("is off until the daemon enables it: specs spawn unchanged", () => {
    expect(childGuardMode()).toBe("off");
    expect(guardedSpec(spec)).toBe(spec);
  });

  it("reaper mode spawns the raw command (no per-child supervisor)", () => {
    enableChildGuard();
    expect(childGuardMode()).toBe("reaper");
    expect(guardedSpec(spec)).toBe(spec);
  });

  it("TALON_MCP_SUPERVISOR=per-child restores the supervisor wrap", () => {
    vi.stubEnv("TALON_MCP_SUPERVISOR", "per-child");
    try {
      enableChildGuard();
      expect(childGuardMode()).toBe("supervisor");
      const wrapped = guardedSpec(spec);
      expect(wrapped.args).toContain(MCP_LAUNCH_SUBCOMMAND);
      expect(wrapped.args.slice(-3)).toEqual(["python", "-m", "srv"]);
      expect(wrapped.env).toEqual(spec.env);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("reaper protocol", () => {
  it("parses register/release lines and ignores garbage", () => {
    expect(parseGuardLine("+123")).toEqual({ op: "+", pid: 123 });
    expect(parseGuardLine("-9\r")).toEqual({ op: "-", pid: 9 });
    expect(parseGuardLine("+0")).toBeNull();
    expect(parseGuardLine("+abc")).toBeNull();
    expect(parseGuardLine("123")).toBeNull();
    expect(parseGuardLine("")).toBeNull();
  });

  it.skipIf(isWin)(
    "killPids tolerates pids that are already gone",
    async () => {
      const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"]);
      const gone = new Promise((r) => c.once("exit", r));
      await killPids([c.pid!, 2 ** 22 + 12345], 500);
      await gone;
      expect(c.signalCode).toBe("SIGTERM");
    },
  );
});

describe("startBridgeWatchdog (shared by supervisor and reaper)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function runTicks(outcome: "refused" | "timeout", ticks: number) {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error(outcome);
        err.name = outcome === "timeout" ? "TimeoutError" : "TypeError";
        throw err;
      }),
    );
    const trips: number[] = [];
    startBridgeWatchdog(
      "http://127.0.0.1:1",
      () => false,
      (_o, secs) => trips.push(secs),
    );
    // First tick is staggered within one interval; then one per 15s.
    await vi.advanceTimersByTimeAsync(15_000 * ticks);
    return trips;
  }

  it("trips after BRIDGE_FAILURES_BEFORE_EXIT unreachable pings", async () => {
    const trips = await runTicks("refused", BRIDGE_FAILURES_BEFORE_EXIT);
    expect(trips.length).toBeGreaterThanOrEqual(1);
  });

  it("tolerates timeouts far longer than refusals", async () => {
    const early = await runTicks("timeout", BRIDGE_FAILURES_BEFORE_EXIT + 2);
    expect(early).toEqual([]);
    vi.useRealTimers();
    const late = await runTicks("timeout", BRIDGE_UNRESPONSIVE_BEFORE_EXIT + 1);
    expect(late.length).toBeGreaterThanOrEqual(1);
  });
});
