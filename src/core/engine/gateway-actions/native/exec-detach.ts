/**
 * A local foreground `bash` that outlived its budget: it keeps running, its
 * output moves to a log file, and the chat is woken when it ends.
 *
 * The output pipes still end in this process, so a daemon restart loses the
 * wake-up and the command may die on its next write. It is a job for this
 * daemon's lifetime, not a service. `background:true` is the path that
 * survives restarts.
 *
 * Bounded like a node's job table: at most [MAX_LOCAL_JOBS] at once, each
 * stopped at 24h or when its log reaches 64 MiB. A job always finishes:
 * normally when its pipes close, but if something outside the process
 * group keeps them open (`ssh -fN`, `setsid foo &` inherit stdout), it is
 * finished from the process's own exit after a short drain window, and a
 * hard stop that cannot reach the holder finishes it anyway.
 */

import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { getMeshService } from "../../../mesh/index.js";
import { openBashLog } from "./bash-log.js";
import type { Result } from "./results.js";

/** Same hard stop as a node's exec job. */
const MAX_JOB_MS = 24 * 60 * 60_000;
/** A chatty runaway must not fill the daemon host's disk. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
/** Same cap as a node's job table (maxRunningExecJobs). */
const MAX_LOCAL_JOBS = 16;
const KILL_GRACE_MS = 2_000;
/**
 * After the shell exits, how long its pipes may stay open before the job is
 * finished anyway. Normal output drains in milliseconds; only an escaped
 * holder keeps them open this long.
 */
const DRAIN_GRACE_MS = 2_000;
const TAIL_CHARS = 2_000;

let liveJobs = 0;

/** How many detached local jobs are running — exposed for tests. */
export function liveLocalJobs(): number {
  return liveJobs;
}

/** Thrown when a run can't be detached; the caller kills it instead. */
export class DetachRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetachRefused";
  }
}

type DetachInput = {
  child: ChildProcess & { pid: number };
  cmd: string;
  /** The dispatcher string id, so the wake lands in the chat that ran it. */
  chatKey: string;
  budgetMs: number;
  /** Everything captured before the budget ran out. */
  stdoutSoFar: string;
  stderrSoFar: string;
  killTree: (signal: NodeJS.Signals) => void;
  maxLogBytes?: number;
  maxJobMs?: number;
  maxJobs?: number;
  drainGraceMs?: number;
};

export function detachLocalRun(input: DetachInput): Result {
  const { child, cmd, killTree } = input;
  const maxLogBytes = input.maxLogBytes ?? MAX_LOG_BYTES;
  const maxJobs = input.maxJobs ?? MAX_LOCAL_JOBS;
  const drainGraceMs = input.drainGraceMs ?? DRAIN_GRACE_MS;
  if (liveJobs >= maxJobs) {
    throw new DetachRefused(
      `${liveJobs} detached commands are already running (limit ${maxJobs})`,
    );
  }
  const { fd, path: logPath } = openBashLog(cmd);
  const log = createWriteStream(logPath, { fd });
  // A failed log write must not take the daemon down with an unhandled error.
  log.on("error", () => {});
  liveJobs++;

  let written = 0;
  let stopReason = "";
  let tail = "";
  let finished = false;
  let drainTimer: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;

  const record = (chunk: string | Buffer) => {
    const text = chunk.toString();
    tail = (tail + text).slice(-TAIL_CHARS);
    if (written >= maxLogBytes) return;
    written += Buffer.byteLength(text);
    log.write(text);
    if (written >= maxLogBytes) stop(`log reached ${maxLogBytes} bytes`);
  };

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return;
    finished = true;
    liveJobs--;
    clearTimeout(hardStop);
    if (drainTimer) clearTimeout(drainTimer);
    if (forceTimer) clearTimeout(forceTimer);
    child.stdout?.off("data", record);
    child.stderr?.off("data", record);
    // Drop our ends of the pipes: a holder outside the group must not keep
    // this job's listeners (and the daemon's fds) alive.
    child.stdout?.destroy();
    child.stderr?.destroy();
    log.end();
    const outcome = stopReason
      ? `was killed: ${stopReason}`
      : `finished, exit ${code ?? signal ?? "?"}`;
    const trimmed = tail.trimEnd();
    getMeshService().execJobs.notify(
      input.chatKey,
      [
        `Background bash pid ${child.pid} ${outcome}: ${cmd}`,
        ...(trimmed ? [`--- output tail ---\n${trimmed}`] : []),
        `Full log: ${logPath}`,
      ].join("\n"),
    );
  };

  function stop(reason: string): void {
    if (stopReason) return;
    stopReason = reason;
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS).unref();
    // The group kill can't reach a process that left the group, and that
    // process may hold the pipes open forever: finish regardless.
    forceTimer = setTimeout(
      () => finish(child.exitCode, child.signalCode),
      KILL_GRACE_MS + drainGraceMs,
    );
    forceTimer.unref();
  }

  record(input.stdoutSoFar);
  record(input.stderrSoFar);
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  const hardStop = setTimeout(
    () => stop("hit the 24h limit"),
    input.maxJobMs ?? MAX_JOB_MS,
  );
  hardStop.unref();

  // `close` waits for every holder of the pipes; `exit` is the shell itself.
  child.once("close", (code, signal) => finish(code, signal));
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (finished) return;
    drainTimer = setTimeout(() => finish(code, signal), drainGraceMs);
    drainTimer.unref();
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    onExit(child.exitCode, child.signalCode);
  } else {
    child.once("exit", onExit);
  }

  // Don't let a leftover job hold the daemon open at shutdown.
  child.unref();
  for (const stream of [child.stdout, child.stderr]) {
    (stream as unknown as { unref?: () => void } | null)?.unref?.();
  }

  const woken = getMeshService().execJobs.canNotify(input.chatKey);
  return {
    ok: true,
    text: [
      `⏱️ Still running after ${input.budgetMs / 1000}s, so it was not killed — pid ${child.pid}.`,
      `Output so far and from now on → ${logPath}`,
      woken
        ? "This chat gets a wake-up when it finishes."
        : "No chat to wake from this run: poll the log.",
      `Stop it with \`kill -- -${child.pid}\`. A Talon restart loses the wake-up and may end the command; for that use background:true. Pass on_timeout:"kill" for a command that should just die at its budget.`,
    ].join("\n"),
  };
}
