/**
 * MCP reaper process — the `_mcp-reaper` side of the hub's child guard
 * (see child-guard.ts for the design). Kept in its own module with no
 * imports beyond launcher.ts so the reaper process stays small: the
 * entry shims dispatch it before the app graph loads.
 */

import { startBridgeWatchdog } from "./launcher.js";

/** Hidden CLI subcommand that turns a Talon process into the reaper. */
export const MCP_REAPER_SUBCOMMAND = "_mcp-reaper";

/** SIGTERM → SIGKILL grace, matching the per-child supervisor. */
const REAPER_KILL_GRACE_MS = 1_000;

/** One parsed control line: register (`+`) or release (`-`) a pid. */
export function parseGuardLine(
  line: string,
): { op: "+" | "-"; pid: number } | null {
  const m = /^([+-])(\d+)$/.exec(line.trim());
  if (!m) return null;
  const pid = Number(m[2]);
  return Number.isSafeInteger(pid) && pid > 0
    ? { op: m[1] as "+" | "-", pid }
    : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but is not ours to signal — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * SIGTERM every pid, wait up to `graceMs` for them to exit, then SIGKILL
 * whatever is left. Resolves once the SIGKILLs are sent.
 */
export async function killPids(
  pids: readonly number[],
  graceMs: number = REAPER_KILL_GRACE_MS,
): Promise<void> {
  for (const pid of pids) signalPid(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  let alive = pids.filter(pidAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    alive = alive.filter(pidAlive);
  }
  for (const pid of alive) signalPid(pid, "SIGKILL");
}

/**
 * Reaper main. Never resolves: the process exits once it has reaped, which
 * happens on stdin EOF/close, a termination signal, or a bridge-watchdog
 * trip (only when TALON_BRIDGE_URL is set).
 */
export function runReaper(): Promise<never> {
  const pids = new Set<number>();
  let reaping = false;
  let buf = "";

  const reap = (): void => {
    if (reaping) return;
    reaping = true;
    void killPids([...pids]).finally(() => process.exit(0));
  };

  // The daemon's end of stdin/stderr may vanish at any moment (that is
  // the point); an EPIPE must not take the reaper down before it reaps.
  process.stdin.on("error", () => {});
  process.stderr.on("error", () => {});
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const parsed = parseGuardLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (!parsed) continue;
      if (parsed.op === "+") pids.add(parsed.pid);
      else pids.delete(parsed.pid);
    }
  });
  process.stdin.on("end", reap);
  process.stdin.on("close", reap);

  const signals: NodeJS.Signals[] =
    process.platform === "win32"
      ? ["SIGTERM", "SIGINT"]
      : ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const sig of signals) process.on(sig, reap);

  const bridgeUrl = process.env.TALON_BRIDGE_URL;
  if (bridgeUrl) {
    startBridgeWatchdog(
      bridgeUrl,
      () => reaping,
      (outcome, downForSec) => {
        process.stderr.write(
          `mcp-reaper: bridge ${bridgeUrl} ${outcome} for ${downForSec}s; reaping ${pids.size} MCP child(ren)\n`,
        );
        reap();
      },
    );
  }

  return new Promise<never>(() => {});
}
