/**
 * Daemon instance discovery — find the running Talon daemon without
 * trusting the pidfile alone.
 *
 * Strategy (cross-platform: HTTP + signal-0 probes, no `ps` parsing):
 *   1. Read the pidfile. If it records a gateway port, probe that
 *      port's /health and verify identity (`app: "talon"`,
 *      `mode: "daemon"`, matching pid).
 *   2. If the pidfile is missing, stale, or portless, scan the
 *      gateway's EADDRINUSE fallback range and identity-match — this
 *      recovers daemons whose pidfile was lost (the pre-fix /restart
 *      handoff bug left exactly that state behind).
 *
 * The identity check distinguishes the daemon from a `talon chat`
 * session (which also runs a gateway, mode "chat") and from unrelated
 * localhost services.
 */

import { readPidRecord, isProcessAlive } from "./pidfile.js";
import { log, logWarn } from "../../util/log.js";
import {
  gatewayAuthHeaders,
  readGatewayToken,
} from "../engine/gateway-auth.js";

export type DaemonHealth = {
  app?: string;
  mode?: string;
  pid?: number;
  port?: number;
  startedAt?: string;
  ok?: boolean;
  uptime?: number;
  memory?: number;
  sessions?: number;
  messages?: number;
  queue?: number;
  errors?: number;
  lastActivity?: string;
  [key: string]: unknown;
};

export type RunningInstance = {
  pid: number;
  port?: number;
  health?: DaemonHealth;
  /**
   * How the instance was found:
   *   - "pidfile": pidfile pid confirmed (via health or liveness+scan)
   *   - "scan": found via port scan; the pidfile was absent or pointed
   *     at a different/dead process
   *   - "pidfile-unverified": pidfile pid is alive but no health
   *     endpoint answered (daemon still booting, or a pre-identity
   *     version)
   */
  source: "pidfile" | "scan" | "pidfile-unverified";
  /** True when the pidfile is missing or disagrees with the live daemon. */
  pidfileStale: boolean;
};

export const GATEWAY_BASE_PORT = 19876;
/** gateway.start() retries port+1 up to 5 times on EADDRINUSE. */
export const GATEWAY_PORT_RANGE = 6;

/**
 * Ports to probe for a daemon gateway. TALON_HEALTH_PORT pins the scan
 * to a single port — tests use it to isolate from a co-tenant daemon.
 */
export function candidateGatewayPorts(): number[] {
  const override = process.env.TALON_HEALTH_PORT;
  if (override) {
    const p = parseInt(override, 10);
    return Number.isInteger(p) && p > 0 ? [p] : [];
  }
  return Array.from(
    { length: GATEWAY_PORT_RANGE },
    (_, i) => GATEWAY_BASE_PORT + i,
  );
}

export async function probeHealth(
  port: number,
  timeoutMs = 800,
): Promise<DaemonHealth | null> {
  try {
    // The token is optional here: identity fields answer without it, the
    // live counters `talon status` shows need it.
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: gatewayAuthHeaders(readGatewayToken()),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as DaemonHealth;
    return typeof body === "object" && body !== null ? body : null;
  } catch {
    return null;
  }
}

function isDaemonHealth(h: DaemonHealth | null): h is DaemonHealth {
  return (
    h !== null &&
    h.app === "talon" &&
    h.mode === "daemon" &&
    typeof h.pid === "number"
  );
}

async function scanForDaemon(): Promise<RunningInstance | null> {
  const ports = candidateGatewayPorts();
  const probes = await Promise.all(
    ports.map(async (port) => ({ port, health: await probeHealth(port) })),
  );
  for (const { port, health } of probes) {
    if (isDaemonHealth(health)) {
      return {
        pid: health.pid as number,
        port,
        health,
        source: "scan",
        pidfileStale: true,
      };
    }
  }
  return null;
}

export async function findRunningInstance(
  pidfilePath?: string,
): Promise<RunningInstance | null> {
  const record = readPidRecord(pidfilePath);

  if (record) {
    if (record.port) {
      const health = await probeHealth(record.port);
      if (isDaemonHealth(health)) {
        const stale = health.pid !== record.pid;
        return {
          pid: health.pid as number,
          port: record.port,
          health,
          source: stale ? "scan" : "pidfile",
          pidfileStale: stale,
        };
      }
      // A /health answered but without identity fields — a pre-identity
      // daemon. Trust it if the recorded pid is alive.
      if (health && isProcessAlive(record.pid)) {
        return {
          pid: record.pid,
          port: record.port,
          health,
          source: "pidfile",
          pidfileStale: false,
        };
      }
    }
    if (isProcessAlive(record.pid)) {
      // Alive but unconfirmed via its recorded port (booting, legacy
      // version, or the port was taken over) — try the scan range.
      const scanned = await scanForDaemon();
      if (scanned?.pid === record.pid) {
        return { ...scanned, source: "pidfile", pidfileStale: false };
      }
      if (scanned) return scanned; // live daemon beats a stale pidfile
      return {
        pid: record.pid,
        port: record.port,
        source: "pidfile-unverified",
        pidfileStale: false,
      };
    }
    // Recorded pid is dead — stale file; fall through to the scan.
  }

  return scanForDaemon();
}

// ── Single-instance guard ───────────────────────────────────────────────────

/**
 * Single-instance guard — a daemon refuses to boot while another one runs.
 *
 * `talon start` already checked for a running instance, but only the CLI
 * did. The daemon entry wrote its pidfile unconditionally. Anything that
 * started the entry directly (systemd, a stray `bun src/index.ts`, the
 * handoff watcher's fallback racing a slow successor) got a second daemon.
 * On 2026-09-27 that ran for 13 minutes:
 *   - the newcomer overwrote the pidfile;
 *   - its gateway and bridge fell back to 19877/19881;
 *   - both polled Telegram, and every getUpdates answered 409;
 *   - the newcomer's trigger resume killed the running daemon's watchers
 *     as "orphans".
 *
 * This guard runs first thing in `app.ts`, before any side effect. It
 * refuses when an identity-checked `/health` answers as a daemon (or a
 * live pidfile pid turns into one while we wait for it to finish booting).
 *
 * The one daemon allowed to overlap is our own predecessor. A `/restart`
 * successor is spawned in the last moments of the old process's graceful
 * shutdown, so the guard waits for that pid to exit and then carries on.
 */

/**
 * Set by `spawnSuccessor()` on the child it spawns: the pid of the daemon
 * handing over. The guard waits that process out instead of refusing.
 */
export const PREDECESSOR_PID_ENV = "TALON_PREDECESSOR_PID";

/** How long a successor waits for its predecessor to exit. */
const PREDECESSOR_WAIT_MS = 20_000;
/** How long a live-but-silent pidfile pid gets to answer /health. */
const UNVERIFIED_WAIT_MS = 15_000;
const GUARD_POLL_MS = 250;

export type InstanceCheck =
  { ok: true } | { ok: false; instance: RunningInstance };

export interface InstanceCheckDeps {
  find?: (pidfilePath?: string) => Promise<RunningInstance | null>;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  pidfilePath?: string;
  predecessorWaitMs?: number;
  unverifiedWaitMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function predecessorPid(env: NodeJS.ProcessEnv): number | undefined {
  const pid = Number(env[PREDECESSOR_PID_ENV]);
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid
    ? pid
    : undefined;
}

/** Poll until `done()` or the deadline; resolves whether `done()` held. */
async function waitFor(
  done: () => boolean | Promise<boolean>,
  ms: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<boolean> {
  const deadline = now() + ms;
  for (;;) {
    if (await done()) return true;
    if (now() >= deadline) return false;
    await sleep(GUARD_POLL_MS);
  }
}

/**
 * Decide whether this process may boot as the daemon. Never throws: a
 * discovery failure answers "ok" (a guard that keeps the only daemon down
 * is worse than the duplicate it prevents).
 */
export async function checkSingleInstance(
  deps: InstanceCheckDeps = {},
): Promise<InstanceCheck> {
  const find = deps.find ?? findRunningInstance;
  const isAlive = deps.isAlive ?? isProcessAlive;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;

  try {
    const predecessor = predecessorPid(env);
    // Consumed: children of this daemon must not inherit it.
    delete env[PREDECESSOR_PID_ENV];
    if (predecessor !== undefined && isAlive(predecessor)) {
      log("bot", `Waiting for predecessor daemon ${predecessor} to exit`);
      const gone = await waitFor(
        () => !isAlive(predecessor),
        deps.predecessorWaitMs ?? PREDECESSOR_WAIT_MS,
        sleep,
        now,
      );
      if (!gone) {
        // It is past its own 15s force-exit timer and has already let go of
        // the frontends. Staying down would leave nothing running.
        logWarn(
          "bot",
          `Predecessor daemon ${predecessor} is still alive — booting anyway`,
        );
      }
    }

    let instance = await find(deps.pidfilePath);
    if (instance?.source === "pidfile-unverified") {
      // A live pid with no /health: a daemon still booting, or a recycled
      // pid. Give it time to answer before deciding.
      const pid = instance.pid;
      await waitFor(
        async () => {
          if (!isAlive(pid)) return true;
          instance = await find(deps.pidfilePath);
          return instance?.source !== "pidfile-unverified";
        },
        deps.unverifiedWaitMs ?? UNVERIFIED_WAIT_MS,
        sleep,
        now,
      );
      if (instance?.source === "pidfile-unverified") {
        logWarn(
          "bot",
          `pidfile names live pid ${instance.pid} but no daemon answers — ` +
            `treating it as a recycled pid`,
        );
        return { ok: true };
      }
    }
    if (!instance) return { ok: true };
    if (instance.pid === process.pid || instance.pid === predecessor) {
      return { ok: true };
    }
    return { ok: false, instance };
  } catch (err) {
    logWarn(
      "bot",
      `single-instance check failed (${err instanceof Error ? err.message : String(err)}) — booting`,
    );
    return { ok: true };
  }
}

/** One line for the log and stderr when the guard refuses. */
export function describeRefusal(instance: RunningInstance): string {
  const where = instance.port ? ` on :${instance.port}` : "";
  return (
    `another Talon daemon is already running (pid ${instance.pid}${where}). ` +
    "Refusing to start a second one — use `talon restart` to replace it."
  );
}
