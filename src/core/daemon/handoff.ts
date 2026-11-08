/**
 * Handoff watcher — the process that proves a `/restart` or `/update`
 * actually landed.
 *
 * The outgoing daemon spawns its successor and then calls
 * `process.exit()`. Until 2026-09-18 that was the whole handoff, which
 * means nothing in the system knew whether the successor had come up.
 * On that day one didn't: it was spawned, lived about twenty seconds,
 * never bound its gateway, and died — and because the dying parent was
 * the only party to the handoff, Talon simply stayed down until a human
 * noticed forty-five minutes later.
 *
 * So the handoff gets a witness. `spawnSuccessor()` (./respawn.ts)
 * starts this watcher detached, sharing the successor's respawn.log fd.
 * It polls identity-verified discovery (./discovery.ts — `app: "talon"`,
 * `mode: "daemon"`, matching pid) until the successor answers /health or
 * the window closes. Only a /health answer counts: discovery will also
 * report a daemon whose pid is merely alive, and "the process exists" is
 * exactly the claim that was false for 20 seconds on 2026-09-18. If the
 * successor never serves, the watcher starts the daemon exactly
 * the way `talon start` does (./control.ts — same spawn, same boot
 * verification) and says why in the log. The watcher is tiny on purpose:
 * `src/index.ts` dispatches its subcommand before the app graph loads,
 * so it costs a bare runtime and these three modules.
 */

import { dirname, resolve } from "node:path";
import { log, logError, logWarn } from "../../util/log.js";
import { startDaemon, type StartOutcome } from "./control.js";
import { writeCrashMarker } from "./crash-marker.js";
import { findRunningInstance, type RunningInstance } from "./discovery.js";
import { isProcessAlive } from "./pidfile.js";

/** Hidden subcommand: `talon _handoff-watch <successor-pid>`. */
export const HANDOFF_WATCH_SUBCOMMAND = "_handoff-watch";

/**
 * How long a successor gets to answer /health. Generous on purpose: a
 * cold boot with every plugin and MCP server takes ~10s on the reference
 * host, and `startDaemon()` itself waits 30s before calling a boot late.
 */
const HANDOFF_WINDOW_MS = 90_000;
const POLL_MS = 500;

export type HandoffOutcome =
  | { ok: true; via: "successor" | "restart"; pid: number; port?: number }
  | { ok: false; reason: string };

export type WatchHandoffOptions = {
  /** The pid `spawnSuccessor()` created. */
  childPid: number;
  /** Repo/package root, for the `talon start` equivalent. */
  pkgRoot: string;
  windowMs?: number;
  pollMs?: number;
  pidfilePath?: string;
  /** Injection seams for tests. */
  find?: typeof findRunningInstance;
  alive?: (pid: number) => boolean;
  start?: typeof startDaemon;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Why the wait ended without a live daemon. */
type WaitFailure = "successor-exited" | "window-expired";

/** Discovery found a process; only a /health answer proves it serves. */
function isServing(instance: RunningInstance | null): boolean {
  return instance?.health !== undefined;
}

/**
 * Poll until a serving daemon answers, the successor process
 * disappears, or the window closes. A daemon that isn't our child still
 * counts: the goal is a live Talon, not a particular pid.
 */
async function awaitDaemon(
  opts: WatchHandoffOptions,
): Promise<RunningInstance | WaitFailure> {
  const find = opts.find ?? findRunningInstance;
  const alive = opts.alive ?? isProcessAlive;
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollMs ?? POLL_MS;
  const deadline = Date.now() + (opts.windowMs ?? HANDOFF_WINDOW_MS);

  while (Date.now() < deadline) {
    const instance = await find(opts.pidfilePath);
    if (instance && isServing(instance)) return instance;
    if (!alive(opts.childPid)) return "successor-exited";
    await sleep(pollMs);
  }
  return "window-expired";
}

const FAILURE_DETAIL: Record<WaitFailure, string> = {
  "successor-exited": "the successor exited before serving /health",
  "window-expired": "the successor never answered /health in time",
};

function describeStart(outcome: StartOutcome): string {
  if (outcome.ok) return `started (pid ${outcome.pid})`;
  if (outcome.reason === "already-running") {
    return `already running (pid ${outcome.instance.pid})`;
  }
  if (outcome.reason === "boot-timeout") return "spawned but not yet healthy";
  return `${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""}`;
}

function toOutcome(started: StartOutcome, why: string): HandoffOutcome {
  if (started.ok) {
    return { ok: true, via: "restart", pid: started.pid, port: started.port };
  }
  if (started.reason === "already-running") {
    const inst = started.instance;
    // `talon start` refuses while a pid is alive — right, since a second
    // daemon would fight the first for Telegram's getUpdates. But an
    // alive pid that has never served /health is the failure, not the
    // recovery, so it is reported as one.
    if (!isServing(inst)) {
      return {
        ok: false,
        reason: `${why}; pid ${inst.pid} is alive but not serving — kill it and run \`talon start\``,
      };
    }
    return { ok: true, via: "restart", pid: inst.pid, port: inst.port };
  }
  return { ok: false, reason: `${why}; restart ${describeStart(started)}` };
}

/**
 * Leave a crash marker so whichever daemon comes up next tells the
 * operator the restart failed. A successor that crashed on its own left
 * a more specific marker already; that one is kept.
 */
function markHandoffFailure(why: string): void {
  try {
    writeCrashMarker("handoff", why, { keepExisting: true });
  } catch {
    /* EEXIST (the successor's own marker) or a full disk — nothing to add */
  }
}

/**
 * Verify the handoff, and repair it if it failed. Never throws: this
 * process exists only to make the outcome known.
 */
export async function watchHandoff(
  opts: WatchHandoffOptions,
): Promise<HandoffOutcome> {
  const result = await awaitDaemon(opts);
  if (typeof result !== "string") {
    const via = result.pid === opts.childPid ? "successor" : "restart";
    log(
      "shutdown",
      `Handoff verified — daemon pid ${result.pid} serving on ` +
        `:${result.port ?? "?"} (${via})`,
    );
    return { ok: true, via, pid: result.pid, port: result.port };
  }

  const why = FAILURE_DETAIL[result];
  logWarn(
    "shutdown",
    `Handoff failed — ${why}; starting Talon the way \`talon start\` does`,
  );
  markHandoffFailure(why);
  const start = opts.start ?? startDaemon;
  const started = await start({
    pkgRoot: opts.pkgRoot,
    pidfilePath: opts.pidfilePath,
  });
  const outcome = toOutcome(started, why);
  if (outcome.ok)
    log("shutdown", `Handoff recovered — ${describeStart(started)}`);
  else logError("shutdown", `Handoff unrecoverable — ${outcome.reason}`);
  return outcome;
}

/** src/core/daemon/ → the package root. */
function packageRoot(): string {
  const here = import.meta.dirname ?? process.cwd();
  return here.includes("$bunfs") || here.includes("~BUN")
    ? dirname(process.execPath)
    : resolve(here, "..", "..", "..");
}

/** Entry point for `talon _handoff-watch <pid>` (src/index.ts). */
export async function runHandoffWatch(argv: readonly string[]): Promise<void> {
  const childPid = Number.parseInt(argv[0] ?? "", 10);
  if (!Number.isInteger(childPid) || childPid <= 0) {
    logError("shutdown", `Handoff watcher got no successor pid (${argv[0]})`);
    process.exitCode = 2;
    return;
  }
  log("shutdown", `Handoff watcher armed for pid ${childPid}`);
  try {
    const outcome = await watchHandoff({ childPid, pkgRoot: packageRoot() });
    process.exitCode = outcome.ok ? 0 : 1;
  } catch (err) {
    logError("shutdown", "Handoff watcher crashed", err);
    process.exitCode = 1;
  }
}
