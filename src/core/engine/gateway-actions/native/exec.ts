/**
 * `native_bash` — the entry point and the local foreground run.
 *
 * The handler picks one of three paths: a detached background launch
 * (exec-background.ts), a teleported on-device run (exec-remote.ts), or the
 * local spawn below, which owns the timeout escalation (SIGTERM the process
 * group, SIGKILL the survivors) so a runaway pipeline can still flush what
 * it produced.
 */

import { spawn } from "node:child_process";
import { stat as fsStat } from "node:fs/promises";
import { getTeleport } from "../../../mesh/devices/teleport.js";
import { createOutputCapture } from "../../../../util/exec-output.js";
import { bashBackground } from "./exec-background.js";
import { bashTeleported } from "./exec-remote.js";
import { resolvePathParam } from "./params.js";
import { renderExec, type Result } from "./results.js";
import type { SharedActionHandlers } from "../types.js";

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const MAX_EXEC_TIMEOUT_MS = 300_000;
/** Grace between SIGTERM and SIGKILL on timeout, so pipelines can flush. */
const KILL_GRACE_MS = 2_000;
/** Appended to a timed-out bash result so the model self-corrects. */
const TIMEOUT_HINT =
  "(Streaming/never-ending commands — adb logcat, tail -f, dev servers, watchers — " +
  "will always hit this wall. Re-run with background:true to launch it detached with " +
  "output captured to a log file, or bound the command itself: `adb logcat -d`, " +
  "`timeout 30 …`, `head -n 200`.)";

export const execHandlers: SharedActionHandlers = {
  native_bash: (body, chatId) =>
    bash(chatId, body.command, body.cwd, body.timeout_sec, body.background),
};

async function bash(
  chatId: number,
  command: unknown,
  cwd: unknown,
  timeoutSec: unknown,
  background?: unknown,
): Promise<Result> {
  const cmd = typeof command === "string" ? command : "";
  if (!cmd.trim()) return { ok: false, text: "No command given." };
  const timeoutMs = clampTimeout(timeoutSec);
  const active = await getTeleport(chatId);

  let dir = typeof cwd === "string" && cwd.trim() ? cwd.trim() : undefined;
  if (dir !== undefined && !active) {
    dir = resolvePathParam(dir, undefined);
    // Validate here: a bad cwd makes spawn fail with "spawn bash ENOENT",
    // which reads as "bash is missing" and sends the model down the wrong
    // path. Name the actual problem instead.
    try {
      const st = await fsStat(dir);
      if (!st.isDirectory())
        return { ok: false, text: `cwd is not a directory: ${dir}` };
    } catch {
      return { ok: false, text: `Working directory does not exist: ${dir}` };
    }
  }

  if (background === true) {
    if (active) {
      return {
        ok: false,
        text:
          "background:true runs on the daemon host only. On a teleported device, " +
          "background it in-shell instead: `cmd > /tmp/out.log 2>&1 &`, then poll " +
          "the log with read.",
      };
    }
    return bashBackground(cmd, dir);
  }
  if (active) return bashTeleported(chatId, active.deviceId, cmd, timeoutMs);
  return bashLocal(cmd, dir, timeoutMs);
}

function bashLocal(
  cmd: string,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<Result> {
  return new Promise((resolvePromise) => {
    // detached → own process group on POSIX, so a timeout can kill the whole
    // tree (bash's children included), not just the shell itself.
    const detached = process.platform !== "win32";
    const child = spawn("bash", ["-c", cmd], {
      ...(cwd ? { cwd } : {}),
      env: process.env,
      detached,
    });
    const stdout = createOutputCapture();
    const stderr = createOutputCapture();
    let killed = false;
    // Timeout escalation: SIGTERM the whole process group first (lets
    // pipelines flush + children clean up), SIGKILL any survivors after a
    // short grace. Straight-to-SIGKILL used to eat buffered output.
    const killTree = (signal: NodeJS.Signals) => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // group already gone — fall through to the direct kill
        }
      }
      try {
        child.kill(signal);
      } catch {
        // already dead
      }
    };
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = (r: Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      resolvePromise(r);
    };
    const timedOutResult = () => {
      const body = renderExec(
        "local",
        `⏱️ timed out after ${timeoutMs / 1000}s — killed; partial output kept below`,
        stdout.value(),
        stderr.value(),
      );
      return { ok: false, text: `${body}\n${TIMEOUT_HINT}` };
    };
    const timer = setTimeout(() => {
      killed = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      // `close` waits for the stdio pipes to drain — a surviving grandchild
      // that inherited stdout (Windows has no process groups; a detached
      // POSIX grandchild can escape the group kill) would otherwise hold
      // this promise open long past the timeout. Force-resolve with the
      // partial output once the escalation window has passed.
      forceTimer = setTimeout(
        () => finish(timedOutResult()),
        KILL_GRACE_MS + 1_000,
      );
    }, timeoutMs);
    child.stdout.on("data", stdout.push);
    child.stderr.on("data", stderr.push);
    child.on("error", (err) => {
      finish({ ok: false, text: `Failed to run: ${err.message}` });
    });
    child.on("close", (code) => {
      if (killed) {
        finish(timedOutResult());
        return;
      }
      finish({
        ok: (code ?? 0) === 0,
        text: renderExec(
          "local",
          `exit ${code ?? 0}`,
          stdout.value(),
          stderr.value(),
        ),
      });
    });
  });
}

function clampTimeout(value: unknown): number {
  const sec = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_EXEC_TIMEOUT_MS;
  return Math.min(
    MAX_EXEC_TIMEOUT_MS,
    Math.max(1_000, Math.round(sec * 1_000)),
  );
}
