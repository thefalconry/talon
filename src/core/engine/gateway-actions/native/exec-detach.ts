/**
 * A local foreground `bash` that outlived its budget: it keeps running, its
 * output moves to a log file, and the chat is woken when it ends.
 *
 * The output pipes still end in this process, so a daemon restart loses the
 * wake-up and the command may die on its next write. It is a job for this
 * daemon's lifetime, not a service. `background:true` is the path that
 * survives restarts.
 */

import type { ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMeshService } from "../../../mesh/index.js";
import type { Result } from "./results.js";

const LOG_DIR = join(tmpdir(), "talon-bash");
/** Same hard stop as a node's exec job. */
const MAX_JOB_MS = 24 * 60 * 60_000;
/** A chatty runaway must not fill the daemon host's disk. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const TAIL_CHARS = 2_000;

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
};

export function detachLocalRun(input: DetachInput): Result {
  const { child, cmd, killTree } = input;
  const maxLogBytes = input.maxLogBytes ?? MAX_LOG_BYTES;
  mkdirSync(LOG_DIR, { recursive: true });
  const slug =
    cmd
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "job";
  const logPath = join(LOG_DIR, `${Date.now()}-${slug}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  // A failed log write must not take the daemon down with an unhandled error.
  log.on("error", () => {});

  let written = 0;
  let stopReason = "";
  let tail = "";
  const stop = (reason: string) => {
    if (stopReason) return;
    stopReason = reason;
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS).unref();
  };
  const record = (chunk: string | Buffer) => {
    const text = chunk.toString();
    tail = (tail + text).slice(-TAIL_CHARS);
    if (written >= maxLogBytes) return;
    written += Buffer.byteLength(text);
    log.write(text);
    if (written >= maxLogBytes) stop(`log reached ${maxLogBytes} bytes`);
  };

  record(input.stdoutSoFar);
  record(input.stderrSoFar);
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  const hardStop = setTimeout(
    () => stop("hit the 24h limit"),
    input.maxJobMs ?? MAX_JOB_MS,
  );
  hardStop.unref();

  child.once("close", (code, signal) => {
    clearTimeout(hardStop);
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
  });

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
