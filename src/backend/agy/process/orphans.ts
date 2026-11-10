/**
 * Orphan subprocess eviction for the Antigravity backend.
 *
 * A one-shot run spawns a real `agy` process. Abort normally kills it,
 * but a child wedged in a syscall — or one whose parent lost the
 * handle across a daemon restart — outlives the run and holds its
 * workspace and memory. The Claude SDK backend solves this by
 * sweeping `/proc` for processes tagged with the run's chat id; the
 * same approach works here, matching on the argv instead of the
 * environment because agy takes its context from flags, not env.
 */

import { readdir, readFile } from "node:fs/promises";
import { log } from "../../../util/log.js";
import { childBelongsToLiveDaemon } from "../../../core/daemon/pidfile.js";
import { AGY_KILL_GRACE_MS } from "../constants.js";
import { childChatIds, getChild } from "./child.js";

/**
 * Kill stray `agy` processes belonging to `contextLabel`.
 *
 * Two passes: the children this process still tracks (authoritative),
 * then a `/proc` argv sweep for anything that escaped the pool. Linux
 * only — `/proc` is where the argv lives; elsewhere the tracked pass
 * still runs and the sweep is a no-op.
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
      /* ESRCH / EPERM — nothing to do */
    }
  }
  if (matched.length > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, AGY_KILL_GRACE_MS);
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
      `agy subprocess sweep (${contextLabel}): found=${result.found} ` +
        `termed=${result.termed} killed=${result.killed}`,
    );
  }
  return result;
}

/** `/proc` pids whose argv is an `agy` run carrying `contextLabel`. */
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
      // Exact-token matching, never a substring scan: this code can
      // SIGKILL, so a chat id that happens to appear inside an
      // unrelated path must not select a victim.
      if (!argv.some((arg) => arg === "agy" || arg.endsWith("/agy"))) continue;
      if (!argv.includes(contextLabel)) continue;
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
