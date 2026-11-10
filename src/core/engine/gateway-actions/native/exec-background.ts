/**
 * `native_bash` with background:true — the detached local launch.
 *
 * POSIX-only by contract (own process group, `kill -- -pid` to stop, survives
 * a daemon restart), with a short settle window so a command that dies
 * immediately still reports like a normal foreground run.
 */

import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { openBashLog } from "./bash-log.js";
import { renderExec, type Result } from "./results.js";

/** How long a background launch waits to catch fast failures. */
const BACKGROUND_SETTLE_MS = 1_200;

/**
 * Launch a command detached from the request cycle: its own process group,
 * stdout+stderr appended to a per-job log file, tool returns immediately.
 * This is the sanctioned path for streaming/long-running commands (adb
 * logcat, dev servers, watchers) that would otherwise burn the whole
 * foreground timeout and come back "killed".
 *
 * A short settle window catches fast failures (typo'd binary, instant
 * non-zero exit) so those still surface as a normal error instead of a
 * "started" message pointing at a log with one line in it.
 */
export async function bashBackground(
  cmd: string,
  cwd: string | undefined,
): Promise<Result> {
  // The background contract is POSIX-shaped end to end: detached process
  // group, `kill -- -pid` to stop, survives daemon restarts. Windows has
  // none of those (and the CI legs showed the detached writer's output not
  // reaching the log) — refuse loudly with the native alternative instead
  // of pretending.
  if (process.platform === "win32") {
    return {
      ok: false,
      text:
        "background:true needs POSIX process groups and isn't supported on a Windows " +
        "daemon host. Run it foreground with a bound command (`timeout 30 …`, `head -n 200`) " +
        "or start it yourself: `powershell Start-Process -WindowStyle Hidden` with output redirected to a file.",
    };
  }
  // A private, fresh log file: see bash-log.ts for why.
  let fd: number;
  let logPath: string;
  try {
    ({ fd, path: logPath } = openBashLog(cmd));
  } catch (err) {
    return {
      ok: false,
      text: `Cannot create a log file for the job: ${(err as Error).message}`,
    };
  }
  // Always detached: the win32 guard above returned already, so this only
  // runs on POSIX where the job gets its own process group.
  const child = spawn("bash", ["-c", cmd], {
    ...(cwd ? { cwd } : {}),
    env: process.env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (r: Result) => {
      if (settled) return;
      settled = true;
      try {
        closeSync(fd);
      } catch {
        // parent's dup only; the child keeps its own copy either way
      }
      resolvePromise(r);
    };
    child.on("error", (err) =>
      done({ ok: false, text: `Failed to start: ${err.message}` }),
    );
    // Fast failure inside the settle window → report it like a normal run.
    child.on("close", (code) => {
      void (async () => {
        let logged = "";
        try {
          logged = await readFile(logPath, "utf8");
        } catch {
          // log unreadable — report the exit alone
        }
        done({
          ok: (code ?? 0) === 0,
          text:
            `Background command exited almost immediately (exit ${code ?? 0}).\n` +
            renderExec("local", `exit ${code ?? 0}`, logged, "") +
            `\nFull log: ${logPath}`,
        });
      })();
    });
    setTimeout(() => {
      if (settled) return;
      child.unref();
      done({
        ok: true,
        text: [
          `🚀 Started in background [local] — pid ${child.pid}.`,
          `Output (stdout+stderr) → ${logPath}`,
          `Follow it with read/bash (e.g. \`tail -n 50 ${logPath}\`).`,
          `Stop it with \`kill -- -${child.pid}\` (whole process group).`,
          `Unsupervised: it keeps running until it exits or is killed — it even survives a Talon restart.`,
        ].join("\n"),
      });
    }, BACKGROUND_SETTLE_MS);
  });
}
