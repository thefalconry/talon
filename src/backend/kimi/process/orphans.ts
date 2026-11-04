/**
 * Orphan subprocess eviction for the Kimi backend.
 */

import { readdir, readFile } from "node:fs/promises";
import { log } from "../../../util/log.js";
import { KIMI_KILL_GRACE_MS } from "../constants.js";
import { childChatIds, getChild } from "./child.js";

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
      if (!argv.some((arg) => arg === "kimi" || arg.endsWith("/kimi"))) continue;
      if (argv.includes(contextLabel)) matched.push(pid);
    } catch {
      continue;
    }
  }
  return matched;
}
