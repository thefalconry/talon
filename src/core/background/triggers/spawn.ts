/**
 * Trigger spawning — the warden-supervised path (preferred) and the in-process
 * direct path (fallback), plus the per-child env contract, log-stream opening,
 * and the hard-timeout arm.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  getTrigger,
  updateTrigger,
  type Trigger,
} from "../../../storage/triggers.js";
import { log, logError, logWarn } from "../../../util/log.js";
import { spawnWarden, type WardenExitEvent } from "../../../native/warden.js";
import {
  children,
  timeouts,
  logStreams,
  lineBuffers,
  wardened,
  SIGTERM_GRACE_MS,
} from "./state.js";
import { commandForLanguage } from "./command.js";
import { handleStdoutLine, handleStderrLine } from "./output.js";
import { handleTimeout, finalizeExit, failTrigger } from "./exit.js";
import { readPidStarttimeSync } from "../../../core/daemon/pidfile.js";

/**
 * Spawn a trigger's script as a supervised child process.
 *
 * Idempotent: if a child is already alive for this id, returns silently.
 */
export function spawnTrigger(trigger: Trigger): void {
  if (children.has(trigger.id)) return;

  const command = commandForLanguage(trigger.language);
  if (!command) {
    failTrigger(trigger, `Unsupported language: ${trigger.language}`);
    return;
  }

  if (spawnViaWarden(trigger, command)) return;
  spawnDirect(trigger, command);
}

/** Env contract every trigger child sees, on both supervision paths. */
function triggerEnv(trigger: Trigger): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TALON_TRIGGER_ID: trigger.id,
    TALON_TRIGGER_NAME: trigger.name,
    TALON_CHAT_ID: trigger.chatId,
  };
}

function clampedTimeoutMs(timeoutSeconds: number): number {
  return Math.min(Math.max(timeoutSeconds, 1), 7 * 24 * 60 * 60) * 1000;
}

/**
 * Open the trigger's append-mode run log and register it. The error handler
 * prevents a disk/permission failure from crashing the whole Node process —
 * log it instead and let the trigger keep running.
 */
function openLogStream(trigger: Trigger): WriteStream {
  const logStream = createWriteStream(trigger.logPath, {
    flags: "a",
    mode: 0o600,
  });
  logStream.on("error", (err) =>
    logError("triggers", `log stream error [${trigger.id}]`, err),
  );
  logStreams.set(trigger.id, logStream);
  return logStream;
}

/**
 * Hard timeout — persistent triggers run without one. On the warden path the
 * warden enforces the same deadline out-of-process; this timer stays as the
 * status bookkeeper and a second line of defence.
 */
function armTimeout(trigger: Trigger): void {
  if (trigger.persistent) return;
  const timer = setTimeout(
    () => handleTimeout(trigger),
    clampedTimeoutMs(trigger.timeoutSeconds),
  );
  timer.unref();
  timeouts.set(trigger.id, timer);
}

/**
 * Spawn under the Rust warden harness. Returns false when the warden binary is
 * unavailable (npm install, Windows, TALON_NO_WARDEN) so the caller falls back
 * to the direct path.
 */
function spawnViaWarden(
  trigger: Trigger,
  command: { cmd: string; args: string[] },
): boolean {
  const warden = spawnWarden({
    command: command.cmd,
    args: [...command.args, trigger.scriptPath],
    timeoutMs: trigger.persistent
      ? 0
      : clampedTimeoutMs(trigger.timeoutSeconds),
    graceMs: SIGTERM_GRACE_MS,
    env: triggerEnv(trigger),
    onStart: (event) => {
      // The child's pid arrives one event later than the direct path learns
      // it; the maps below were registered synchronously so cancel/shutdown
      // already work during this window.
      updateTrigger(trigger.id, {
        pid: event.pid,
        pidStarttime: event.pidStarttime ?? undefined,
      });
      log(
        "triggers",
        `Spawned "${trigger.name}" [${trigger.id}] pid=${event.pid} (${trigger.language}, warden)`,
      );
      logStreams
        .get(trigger.id)
        ?.write(
          `--- spawn ${new Date().toISOString()} pid=${event.pid} (warden) ---\n`,
        );
    },
    onLine: (event) =>
      event.stream === "stdout"
        ? handleStdoutLine(trigger.id, event.text)
        : handleStderrLine(trigger.id, event.text),
    onExit: (event) => handleWardenExit(trigger, event),
    onSpawnError: (message) => {
      // The warden can die before reporting a child start when a
      // cancel/shutdown/timeout TERM races its process startup. If a status
      // other than "running" was already recorded, this is not a spawn
      // failure — settle through finalizeExit so cleanup, persistence, and
      // wake fires stay on the one path.
      const t = getTrigger(trigger.id);
      if (t && t.status !== "running") {
        finalizeExit(trigger.id, null, null).catch((err) =>
          logError("triggers", `finalizeExit failed [${trigger.id}]`, err),
        );
        return;
      }
      // Mirror the direct path's fail-before-start: unwind the maps so the
      // trigger doesn't look alive, then record the failure.
      const timer = timeouts.get(trigger.id);
      if (timer) clearTimeout(timer);
      timeouts.delete(trigger.id);
      children.delete(trigger.id);
      wardened.delete(trigger.id);
      lineBuffers.delete(trigger.id);
      const stream = logStreams.get(trigger.id);
      if (stream) {
        stream.end();
        logStreams.delete(trigger.id);
      }
      failTrigger(trigger, message);
    },
  });
  if (!warden) return false;

  children.set(trigger.id, warden);
  wardened.add(trigger.id);
  lineBuffers.set(trigger.id, []);
  updateTrigger(trigger.id, { status: "running", startedAt: Date.now() });
  openLogStream(trigger);
  armTimeout(trigger);
  return true;
}

function handleWardenExit(trigger: Trigger, event: WardenExitEvent): void {
  if (event.timedOut) {
    // The warden's out-of-process deadline fired before the TS timer — record
    // the same terminal status handleTimeout would have.
    const t = getTrigger(trigger.id);
    if (t && (t.status === "running" || t.status === "pending")) {
      updateTrigger(trigger.id, {
        status: "timed_out",
        lastError: `Timed out after ${trigger.timeoutSeconds}s`,
      });
    }
  }
  finalizeExit(
    trigger.id,
    event.code,
    (event.signal as NodeJS.Signals | null) ?? null,
  ).catch((err) =>
    logError("triggers", `finalizeExit failed [${trigger.id}]`, err),
  );
}

/** The original in-process supervision path — no warden binary needed. */
function spawnDirect(
  trigger: Trigger,
  command: { cmd: string; args: string[] },
): void {
  let child: ChildProcess;
  try {
    child = spawn(command.cmd, [...command.args, trigger.scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      // detached:false → child is in our process group → killed if we crash
      env: triggerEnv(trigger),
    });
  } catch (err) {
    failTrigger(
      trigger,
      `spawn failed: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  let started = false;
  let failedBeforeStart = false;
  const failBeforeStart = (message: string) => {
    if (failedBeforeStart) return;
    failedBeforeStart = true;
    failTrigger(trigger, message);
  };

  child.on("error", (err) => {
    if (!started) {
      failBeforeStart(
        `spawn failed: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
    logError("triggers", `Child error [${trigger.id}]`, err);
  });

  if (!child.pid) {
    failBeforeStart("spawn returned without a PID");
    return;
  }

  started = true;
  children.set(trigger.id, child);
  lineBuffers.set(trigger.id, []);

  const startedAt = Date.now();
  updateTrigger(trigger.id, {
    status: "running",
    pid: child.pid,
    startedAt,
    pidStarttime: readPidStarttimeSync(child.pid),
  });
  log(
    "triggers",
    `Spawned "${trigger.name}" [${trigger.id}] pid=${child.pid} (${trigger.language})`,
  );

  const logStream = openLogStream(trigger);
  logStream.write(
    `--- spawn ${new Date(startedAt).toISOString()} pid=${child.pid} ---\n`,
  );

  // Stream stdout line-by-line so we can intercept TALON_FIRE: signals
  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => handleStdoutLine(trigger.id, line));
    rl.on("error", (err) =>
      logWarn("triggers", `stdout reader error [${trigger.id}]: ${err}`),
    );
  }
  if (child.stderr) {
    const rlErr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    rlErr.on("line", (line) => handleStderrLine(trigger.id, line));
    rlErr.on("error", (err) =>
      logWarn("triggers", `stderr reader error [${trigger.id}]: ${err}`),
    );
  }

  child.on("exit", (code, signal) => {
    finalizeExit(trigger.id, code, signal).catch((err) =>
      logError("triggers", `finalizeExit failed [${trigger.id}]`, err),
    );
  });

  armTimeout(trigger);
}
