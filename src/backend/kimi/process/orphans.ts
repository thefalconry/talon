/**
 * Orphan subprocess eviction for the Kimi backend.
 *
 * A one-shot run spawns a real `kimi` process. Abort normally kills it,
 * but a child that ignores SIGTERM, or one whose parent lost the handle
 * across a daemon restart, outlives the run and keeps spending tokens.
 * kimi's argv carries only the prompt and flags, never the run's label,
 * so every spawn is tagged with [KIMI_RUN_LABEL_ENV] and the sweep
 * matches on `/proc/<pid>/environ`, the way the Claude SDK backend
 * matches its subprocesses.
 */

import { readdir, readFile } from "node:fs/promises";
import { log } from "../../../util/log.js";
import { childBelongsToLiveDaemon } from "../../../core/daemon/pidfile.js";
import { KIMI_KILL_GRACE_MS, KIMI_RUN_LABEL_ENV } from "../constants.js";
import { childChatIds, getChild } from "./child.js";

/**
 * Kill stray `kimi` processes belonging to `contextLabel`.
 *
 * Two passes: the children this process still tracks (authoritative),
 * then a `/proc` sweep for anything that escaped the pool. Linux only;
 * elsewhere the tracked pass still runs and the sweep is a no-op.
 */
export async function evictOrphanSubprocesses(contextLabel: string): Promise<{
  found: number;
  termed: number;
  killed: number;
}> {
  const result = { found: 0, termed: 0, killed: 0 };

  for (const chatId of childChatIds()) {
    if (chatId !== contextLabel) continue;
    const child = getChild(chatId);
    if (!child?.alive) continue;
    result.found++;
    result.termed++;
    child.kill("orphan-sweep");
  }

  const matched = await findOrphanPids(contextLabel);
  result.found += matched.length;
  for (const pid of matched) {
    try {
      process.kill(pid, "SIGTERM");
      result.termed++;
    } catch {
      /* ESRCH / EPERM */
    }
  }
  if (matched.length > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, KIMI_KILL_GRACE_MS);
      timer.unref();
    });
    for (const pid of matched) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
        result.killed++;
      } catch {
        /* already gone */
      }
    }
  }

  if (result.found > 0) {
    log(
      "heartbeat",
      `kimi subprocess sweep (${contextLabel}): found=${result.found} ` +
        `termed=${result.termed} killed=${result.killed}`,
    );
  }
  return result;
}

/** True when argv is a `kimi` invocation (direct or via its node shebang). */
export function isKimiArgv(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "kimi" || arg.endsWith("/kimi"));
}

/** True when an environ block carries exactly this run's label tag. */
export function environHasRunLabel(
  environ: readonly string[],
  contextLabel: string,
): boolean {
  return environ.includes(`${KIMI_RUN_LABEL_ENV}=${contextLabel}`);
}

/** `/proc` pids of `kimi` processes tagged with `contextLabel`. */
async function findOrphanPids(contextLabel: string): Promise<number[]> {
  if (process.platform !== "linux") return [];
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  const matched: number[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf-8")).split(
        "\0",
      );
      if (!isKimiArgv(argv)) continue;
      // Exact env-entry match, never a substring scan: this code can
      // SIGKILL, so a label that happens to appear inside another value
      // must not select a victim.
      const environ = (await readFile(`/proc/${pid}/environ`, "utf-8")).split(
        "\0",
      );
      if (!environHasRunLabel(environ, contextLabel)) continue;
      // Another running daemon's live run, not an orphan of ours.
      if (childBelongsToLiveDaemon(pid)) continue;
      matched.push(pid);
    } catch {
      // Exited between readdir and readFile, or not ours. Skip.
      continue;
    }
  }
  return matched;
}
