/**
 * Daemon management — renders the outcomes of start/stop/restart.
 *
 * Lifecycle logic lives in core/daemon/ (pidfile, discovery, control);
 * this module only renders the outcomes.
 */

import pc from "picocolors";
import {
  startDaemon,
  stopDaemon,
  restartDaemon,
  type StartOutcome,
  type StopOutcome,
} from "../core/daemon/control.js";
import {
  runWatchdogOnce,
  type WatchdogOutcome,
} from "../core/daemon/watchdog/watchdog.js";
import { PKG_ROOT } from "./context.js";

function renderStartOutcome(result: StartOutcome): void {
  if (result.ok) {
    const port = result.port ? `, gateway :${result.port}` : "";
    console.log(`  ${pc.green("●")} Talon started (PID ${result.pid}${port})`);
    console.log(`  ${pc.dim("Logs:")} talon logs`);
    console.log(`  ${pc.dim("Stop:")} talon stop\n`);
    return;
  }
  switch (result.reason) {
    case "already-running": {
      const inst = result.instance;
      const port = inst.port ? `, gateway :${inst.port}` : "";
      console.log(
        `  ${pc.yellow("!")} Talon is already running (PID ${inst.pid}${port})`,
      );
      if (inst.pidfileStale) {
        console.log(
          `  ${pc.dim("The PID file was stale — repaired from the live instance.")}`,
        );
      }
      console.log(
        `  Use ${pc.cyan("talon restart")} to restart, or ${pc.cyan("talon stop")} to stop.\n`,
      );
      return;
    }
    case "spawn-failed":
      console.log(
        `  ${pc.red("✖")} Failed to start Talon${result.detail ? pc.dim(` — ${result.detail}`) : ""}\n`,
      );
      return;
    case "exited-early":
      console.log(`  ${pc.red("✖")} Talon ${result.detail} during startup`);
      console.log(`  Check ${pc.cyan("talon logs")} for details.\n`);
      return;
    case "boot-timeout":
      console.log(
        `  ${pc.yellow("!")} Talon was spawned but has not reported healthy yet.`,
      );
      console.log(
        `  It may still be starting — check ${pc.cyan("talon status")} and ${pc.cyan("talon logs")}.\n`,
      );
      return;
  }
}

function renderStopOutcome(result: StopOutcome): void {
  if (result.stopped) {
    const how =
      result.method === "http"
        ? "graceful"
        : result.method === "sigterm"
          ? "SIGTERM"
          : "SIGKILL";
    console.log(`  ${pc.red("●")} Talon stopped (PID ${result.pid}, ${how})\n`);
    return;
  }
  if (result.reason === "not-running") {
    console.log(`  ${pc.dim("●")} Talon is not running\n`);
    return;
  }
  console.log(
    `  ${pc.red("✖")} Could not stop Talon (PID ${result.pid}) — the process did not exit\n`,
  );
}

export async function daemonStart(): Promise<void> {
  renderStartOutcome(await startDaemon({ pkgRoot: PKG_ROOT }));
}

export async function daemonStop(): Promise<void> {
  renderStopOutcome(await stopDaemon({ intentional: true }));
}

export async function daemonRestart(): Promise<void> {
  const { stop, start } = await restartDaemon({ pkgRoot: PKG_ROOT });
  renderStopOutcome(stop);
  renderStartOutcome(start);
}

/** One line per run: it lands in the journal of the timer's unit. */
function describeWatchdogOutcome(result: WatchdogOutcome): string {
  switch (result.action) {
    case "started":
      return `watchdog: Talon was down; started it (PID ${result.pid}${result.port ? `, gateway :${result.port}` : ""})`;
    case "start-failed":
      return `watchdog: Talon is down and could not be started: ${result.detail}`;
    case "none":
      switch (result.reason) {
        case "running":
          return `watchdog: Talon is running (PID ${result.pid})`;
        case "stopped-on-purpose":
          return `watchdog: Talon was stopped on purpose (${result.by}, ${result.at}); leaving it down until \`talon start\``;
        case "busy":
          return "watchdog: another watchdog run is in progress";
        case "waiting":
          return `watchdog: no daemon found (${result.misses} check(s), ${Math.round(result.downForMs / 1000)}s); waiting before starting it`;
      }
  }
}

/**
 * `talon watchdog`: one supervision check, for a timer or cron. Exits 1
 * only when it tried to start Talon and couldn't.
 */
export async function daemonWatchdog(): Promise<void> {
  const result = await runWatchdogOnce({ pkgRoot: PKG_ROOT });
  console.log(describeWatchdogOutcome(result));
  if (result.action === "start-failed") process.exitCode = 1;
}
