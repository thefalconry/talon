/**
 * MCP supervisor — one universal launch method for every install type.
 *
 * The per-child supervisor process proxies stdio, filters non-JSON
 * stdout lines, and kills the child when Talon dies — no orphans, no
 * /proc scan, no per-plugin signature list.
 *
 * The hub no longer runs one per MCP child by default: it spawns
 * children itself, filters stdout in-process (child-transport.ts, same
 * parseJsonRpcLine rule) and guards them with ONE reaper process per
 * daemon (child-guard.ts / reaper.ts, same stdin-EOF + BridgeWatchdog +
 * SIGTERM→SIGKILL semantics as below). Wrapping a child in this
 * supervisor is the fallback when the reaper can't run, or when
 * `TALON_MCP_SUPERVISOR=per-child` asks for it. `selfInvocation` below
 * is how both helpers are launched.
 *
 * The supervisor is Talon itself: `wrapMcpServer()` re-invokes the
 * current process (`process.execPath` + `process.execArgv` + entry
 * script) with the hidden `_mcp-launch` subcommand, the same
 * self-reinvocation respawn.ts uses for /restart. This is the only
 * shape that works everywhere with no fallbacks:
 *
 *   - tsx / node source runs: the tsx loader flags ride along in
 *     execArgv, so the TS entry resolves in the supervisor too.
 *   - bun source runs: execPath is bun, which runs the entry directly.
 *   - bun-compiled binaries: there is no source tree on disk and
 *     possibly no system JS runtime — the binary re-invokes itself
 *     (argv[1] points into the embedded bundle and is omitted).
 *   - npm installs: `node bin/talon.js _mcp-launch …` via cli.ts.
 *
 * CONTRACT: every entrypoint whose process wraps MCP servers MUST
 * dispatch the subcommand before doing anything else:
 *
 *   if (process.argv[2] === MCP_LAUNCH_SUBCOMMAND) {
 *     await runSupervisor(process.argv.slice(3));
 *   }
 *
 * src/index.ts and src/cli.ts are the two real entrypoints; both
 * dispatch (the reaper's `_mcp-reaper` too), each helper behind its own
 * dynamic import so helper processes load only their own module.
 *
 * Child-shutdown signals (both terminate the child with SIGTERM, then
 * SIGKILL after a grace period):
 *
 *   1. Our own stdin closes — the SDK-side pipe is gone, so the MCP
 *      child's protocol counterpart is dead. Catches "Talon exited",
 *      including SIGKILL.
 *   2. `TALON_BRIDGE_URL/health` stops responding for several
 *      consecutive pings — Talon's gateway is gone. Catches the
 *      "kilo serve / opencode serve outlives Talon" case where those
 *      daemons keep our stdin open across Talon restarts. A ping that only
 *      times out (port still bound, gateway busy) is tolerated for minutes,
 *      not seconds — see BridgeWatchdog.
 */

import crossSpawn from "cross-spawn";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Resolve tsx's ESM loader to an ABSOLUTE file URL.
 *
 * `process.execArgv` carries the bare specifier `tsx` (from the
 * `node --import tsx src/index.ts` entry). Node resolves bare specifiers
 * against the spawn CWD — and the Agent SDK spawns MCP servers from the
 * agent's workspace dir, not the app root, so bare `tsx` raises
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'` and the supervisor
 * crashes before the MCP child ever starts (the model then sees
 * "No such tool available" for every frontend delivery tool). Substituting
 * the absolute path makes the re-invocation CWD-independent.
 */
function absoluteTsxImport(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("tsx/package.json");
    return pathToFileURL(resolve(dirname(pkg), "dist/esm/index.mjs")).href;
  } catch {
    return null;
  }
}

/** Hidden CLI subcommand that turns a Talon process into the supervisor. */
export const MCP_LAUNCH_SUBCOMMAND = "_mcp-launch";

/**
 * Embedder hook. Self-reinvocation assumes the running entry dispatches
 * Talon's hidden subcommands (`_mcp-launch`, `_lua-run`) — true for
 * Talon's own entrypoints, false for processes that embed Talon (vitest
 * harnesses, apps importing it as a library), whose argv[1] is their own
 * entry. Such embedders set this env var to a JSON string array
 * `[command, ...argsPrefix]` that launches an entry which DOES dispatch
 * (e.g. `["node", "--import", "<tsx esm url>",
 * "<abs path to src/cli.ts>"]`).
 *
 * @public — consumed by embedders (and the integration probe), not by
 * Talon's own graph, so knip must not report it.
 */
export const SUPERVISOR_CMD_ENV = "TALON_MCP_SUPERVISOR_CMD";

export type LauncherInvocation = { command: string; args: string[] };

/**
 * `bun build --compile` rewrites argv[1] into the binary's embedded
 * virtual filesystem (`/$bunfs/` on POSIX, a `~BUN` drive path on
 * Windows). Such paths don't exist on disk and must not be passed to a
 * re-invocation — the binary's entry is baked in.
 */
function isEmbeddedEntry(entry: string): boolean {
  return entry.includes("$bunfs") || entry.includes("~BUN");
}

/**
 * The command prefix that re-invokes the current Talon process with a
 * hidden subcommand, in every install shape (tsx source run, bun source
 * run, bun-compiled binary, npm install). Used for MCP supervision
 * (`_mcp-launch`, `_mcp-reaper`) and the WASM Lua trigger runner
 * (`_lua-run`) — any
 * subcommand passed here must be dispatched by src/index.ts and
 * src/cli.ts before the app graph loads.
 */
export function selfInvocation(subcommand: string): LauncherInvocation {
  const override = process.env[SUPERVISOR_CMD_ENV];
  if (override) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(override);
    } catch {
      parsed = undefined;
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((s) => typeof s === "string")
    ) {
      throw new Error(
        `${SUPERVISOR_CMD_ENV} must be a non-empty JSON string array, got: ${override}`,
      );
    }
    return {
      command: parsed[0],
      args: [...parsed.slice(1), subcommand],
    };
  }

  // Rewrite a bare `tsx` loader spec in execArgv to an absolute path so the
  // re-invocation resolves regardless of the spawn CWD (see absoluteTsxImport).
  const tsxAbs = absoluteTsxImport();
  const execArgv = tsxAbs
    ? process.execArgv.map((a) =>
        a === "tsx"
          ? tsxAbs
          : a.endsWith("=tsx")
            ? `${a.slice(0, -3)}${tsxAbs}`
            : a,
      )
    : process.execArgv;

  const entry = process.argv[1] ?? "";
  const entryArgs = entry && !isEmbeddedEntry(entry) ? [resolve(entry)] : [];
  return {
    command: process.execPath,
    args: [...execArgv, ...entryArgs, subcommand],
  };
}

/**
 * The command prefix that re-invokes this process as the MCP supervisor.
 * Callers append the real MCP command after it.
 */
export function supervisorInvocation(): LauncherInvocation {
  return selfInvocation(MCP_LAUNCH_SUBCOMMAND);
}

type StdioServer = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

/**
 * Rewrite `{command, args}` so the real command runs under the supervisor.
 *
 * Plugin-agnostic: the supervisor doesn't know or care what it's
 * supervising. Platform-agnostic: relies on pipe EOF, which POSIX and
 * Windows both deliver when the parent end of a pipe is closed.
 */
export function wrapMcpServer<T extends StdioServer>(server: T): T {
  const launcher = supervisorInvocation();
  return {
    ...server,
    command: launcher.command,
    args: [...launcher.args, server.command, ...server.args],
  };
}

/**
 * Same wrap, single-array shape used by `@kilocode/sdk` and
 * `@opencode-ai/sdk` `oc.mcp.add({config: {command: [cmd, ...args]}})`.
 */
export function wrapMcpCommand(command: readonly string[]): string[] {
  if (command.length === 0) {
    throw new Error("wrapMcpCommand: command array must not be empty");
  }
  const launcher = supervisorInvocation();
  return [launcher.command, ...launcher.args, ...command];
}

// ── Supervisor implementation ───────────────────────────────────────────────

// Ping cadence and tolerance are sized so a Talon restart that takes ~30s
// doesn't kill MCP children, but a permanent Talon-down state evicts them
// within ~1 minute.
const BRIDGE_PING_INTERVAL_MS = 15_000;
const BRIDGE_PING_TIMEOUT_MS = 2_000;
export const BRIDGE_FAILURES_BEFORE_EXIT = 4;
// A ping that TIMES OUT means the port is still bound — the kernel accepted
// the connection — but the gateway is too busy to answer within 2s (event
// loop saturated by a burst of agents, a big synchronous write, …). That is
// a live Talon, not a dead one, so it gets a much longer budget (~5 min)
// before the child is evicted. Only a truly wedged daemon reaches it.
export const BRIDGE_UNRESPONSIVE_BEFORE_EXIT = 20;

/**
 * Outcome of one bridge health ping:
 *   - "ok": /health answered 2xx.
 *   - "unreachable": nothing healthy behind the port (connection refused or
 *     reset, non-2xx reply) — Talon is gone or restarting.
 *   - "unresponsive": the request timed out — something holds the port but
 *     is slow to answer; Talon is alive but busy.
 */
export type BridgePingOutcome = "ok" | "unreachable" | "unresponsive";

/** Classify a rejected health fetch. Timeouts/aborts mean "busy", not "gone". */
export function classifyBridgePingError(
  err: unknown,
): Exclude<BridgePingOutcome, "ok"> {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError"
    ? "unresponsive"
    : "unreachable";
}

/** Ping `${bridgeUrl}/health` once. Never throws. */
export async function pingBridge(
  bridgeUrl: string,
  timeoutMs: number = BRIDGE_PING_TIMEOUT_MS,
): Promise<BridgePingOutcome> {
  try {
    const resp = await fetch(`${bridgeUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the body so the socket is released promptly.
    await resp.arrayBuffer().catch(() => undefined);
    return resp.ok ? "ok" : "unreachable";
  } catch (err) {
    return classifyBridgePingError(err);
  }
}

/**
 * Consecutive-failure bookkeeping for the bridge watchdog. `record()`
 * returns true once the child should be shut down: after
 * BRIDGE_FAILURES_BEFORE_EXIT failures ending in an "unreachable" ping (the
 * port is really closed), or after BRIDGE_UNRESPONSIVE_BEFORE_EXIT failures
 * of any kind (the daemon is wedged, not just busy).
 */
export class BridgeWatchdog {
  consecutiveFailures = 0;

  record(outcome: BridgePingOutcome): boolean {
    if (outcome === "ok") {
      this.consecutiveFailures = 0;
      return false;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BRIDGE_UNRESPONSIVE_BEFORE_EXIT)
      return true;
    return (
      outcome === "unreachable" &&
      this.consecutiveFailures >= BRIDGE_FAILURES_BEFORE_EXIT
    );
  }
}

/** Tag prefixed to child stdout lines that were re-routed to stderr. */
export const STDOUT_REROUTE_TAG = "[mcp-launcher: stdout→stderr] ";

/**
 * Parse one line of MCP child stdout under the stdio filter rule: a
 * JSON-RPC line must be a JSON OBJECT (starts with `{`, parses). Returns
 * the parsed value, or null for anything else — banners, log lines,
 * `[timestamp] [INFO] …`, a stray `{ tip: "…" }` that isn't JSON. Both
 * the per-child supervisor and the hub's in-process transport use this,
 * so the two filtering paths cannot drift apart.
 */
export function parseJsonRpcLine(line: string): object | null {
  const s = line.trimStart();
  if (s.length === 0 || s[0] !== "{") return null;
  try {
    const parsed: unknown = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Run the bridge-health watchdog: ping `${bridgeUrl}/health` every
 * BRIDGE_PING_INTERVAL_MS (first tick staggered randomly), and call
 * `onTrip` once BridgeWatchdog says the daemon is gone. `isStopping`
 * short-circuits ticks after shutdown began. Shared by the per-child
 * supervisor and the hub's reaper so both keep identical semantics.
 */
export function startBridgeWatchdog(
  bridgeUrl: string,
  isStopping: () => boolean,
  onTrip: (outcome: BridgePingOutcome, downForSec: number) => void,
): void {
  const watchdog = new BridgeWatchdog();
  const tick = async (): Promise<void> => {
    if (isStopping()) return;
    const outcome = await pingBridge(bridgeUrl);
    if (isStopping()) return;
    if (watchdog.record(outcome)) {
      onTrip(
        outcome,
        watchdog.consecutiveFailures * (BRIDGE_PING_INTERVAL_MS / 1000),
      );
    }
  };
  // Stagger first tick so a process-wide restart doesn't have every
  // watchdog pinging the bridge in lockstep.
  const initialDelay = Math.floor(Math.random() * BRIDGE_PING_INTERVAL_MS);
  const startTimer = setTimeout(() => {
    void tick();
    const interval = setInterval(() => void tick(), BRIDGE_PING_INTERVAL_MS);
    interval.unref?.();
  }, initialDelay);
  startTimer.unref?.();
}

/**
 * Run the supervisor over `argvTail` = [cmd, ...args].
 *
 * Never resolves: the process exits from the child-exit / stdin-EOF /
 * bridge-watchdog handlers. Entrypoints `await` it so nothing after
 * the dispatch ever runs.
 */
export function runSupervisor(argvTail: string[]): Promise<never> {
  const [cmd, ...args] = argvTail;
  if (!cmd) {
    process.stderr.write("mcp-launcher: missing command\n");
    process.exit(2);
  }

  const BRIDGE_URL = process.env.TALON_BRIDGE_URL;

  // cross-spawn handles .cmd/.bat scripts on Windows correctly — it resolves
  // the executable and sets up the shell wrapper only when needed, preserving
  // the process tree so SIGTERM/SIGKILL propagation and orphan cleanup work.
  // stdio is always 'pipe' so stdin/stdout/stderr are guaranteed non-null.
  const child = crossSpawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  }) as ChildProcessWithoutNullStreams;

  // Any pipe end-point can throw EPIPE if the other side closes mid-write.
  // We silence those; the exit and close paths already drive shutdown.
  const swallow = () => {};
  child.stdin.on("error", swallow);
  child.stdout.on("error", swallow);
  child.stderr.on("error", swallow);
  process.stdin.on("error", swallow);
  process.stdout.on("error", swallow);
  process.stderr.on("error", swallow);

  process.stdin.pipe(child.stdin);

  // Stdout filter: MCP stdio convention says child stdout carries one
  // JSON-RPC message per line and nothing else. Some plugins violate
  // this and print log/banner lines (tailscale-mcp, ccusage, polymarket
  // at startup). Strict MCP clients can hit those lines, raise a parse
  // error, and crash the task group that owns the session — taking down
  // every other MCP server connection in the process.
  //
  // Filter line-by-line: anything that parses as a JSON object goes
  // through to stdout; everything else is re-routed to stderr with a
  // tag so it's still visible in logs. Tolerant MCP clients (e.g. the
  // claude binary) see exactly what they did before — this is a no-op
  // for clean servers.
  //
  // A JSON-RPC line must start with `{` (objects). The MCP spec permits
  // array batches (`[`) but our plugins only emit objects, and several
  // plugins log lines that START with `[` (e.g. tailscale-mcp's
  // `[ISO-timestamp] [INFO] …`). Restrict to `{` and verify it's
  // parseable JSON before forwarding, so a stray `{ tip: "..." }`
  // shell-style line that isn't valid JSON still goes to stderr.
  const looksJson = (line: string): boolean => parseJsonRpcLine(line) !== null;
  let buf = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl + 1);
      buf = buf.slice(nl + 1);
      if (looksJson(line)) {
        process.stdout.write(line);
      } else if (line.trim().length > 0) {
        process.stderr.write(`${STDOUT_REROUTE_TAG}${line}`);
      }
    }
  });
  child.stdout.on("end", () => {
    if (buf.length === 0) return;
    if (looksJson(buf)) {
      process.stdout.write(buf);
    } else {
      process.stderr.write(`${STDOUT_REROUTE_TAG}${buf}`);
    }
    buf = "";
  });

  child.stderr.pipe(process.stderr);

  let terminating = false;

  function terminate(exitCode: number): void {
    if (terminating) return;
    terminating = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const force = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 1000);
    force.unref?.();
    child.once("exit", () => {
      clearTimeout(force);
      process.exit(exitCode);
    });
  }

  process.stdin.on("end", () => terminate(0));
  process.stdin.on("close", () => terminate(0));

  child.once("exit", (code, signal) => {
    if (terminating) return;
    process.exit(code ?? (signal ? 1 : 0));
  });
  child.once("error", (err) => {
    process.stderr.write(`mcp-launcher: spawn error: ${err.message}\n`);
    process.exit(1);
  });

  const signals: NodeJS.Signals[] =
    process.platform === "win32"
      ? ["SIGTERM", "SIGINT"]
      : ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const sig of signals) {
    process.on(sig, () => terminate(0));
  }

  // Bridge-health watchdog. Only enabled when TALON_BRIDGE_URL is set
  // (every Talon-spawned MCP server has it; ad-hoc supervisor uses
  // without the env var keep the stdin-EOF-only behavior).
  if (BRIDGE_URL) {
    startBridgeWatchdog(
      BRIDGE_URL,
      () => terminating,
      (outcome, downForSec) => {
        // Talon's gateway is gone (or wedged for minutes). The MCP child
        // has nothing useful to serve — bridge calls would 404 against a
        // dead port — so shut down. Kilo/OpenCode notice the stdio close
        // on the next interaction and drop the registration on their side.
        process.stderr.write(
          `mcp-launcher: bridge ${BRIDGE_URL} ${outcome} for ${downForSec}s; shutting down child\n`,
        );
        terminate(0);
      },
    );
  }

  // The child + stdin pipe keep the event loop alive; exit happens via
  // the handlers above.
  return new Promise<never>(() => {});
}
