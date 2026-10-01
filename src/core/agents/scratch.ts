/**
 * Scratch — a private temp directory per sub-agent.
 *
 * Every agent gets `/tmp/talon-agents/<id>/` (under `os.tmpdir()`), created
 * when its run starts and exported as `TMPDIR` / `TMP` / `TEMP` to the
 * backend run (`OneShotAgentParams.env`), so its shells and tools write
 * their temporary files somewhere no other agent is writing. The directory
 * is named in the agent's system prompt too, for backends that cannot take
 * a per-run environment.
 *
 * Lifecycle: kept across a daemon restart (a resumed agent finds its files
 * where it left them), removed when the agent settles `done`, and **kept**
 * on any other terminal state so whoever picks up a failed, killed or
 * timed-out run can inspect what it left behind.
 */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logWarn } from "../../util/log.js";
import type { AgentState } from "./types.js";

/** Root of every agent's scratch dir. Overridable for tests. */
const root: { dir: string } = { dir: join(tmpdir(), "talon-agents") };

export function setScratchRootForTest(dir: string): void {
  root.dir = dir;
}

/** Absolute path of an agent's scratch dir (whether or not it exists). */
export function agentScratchDir(agentId: string): string {
  return join(root.dir, agentId);
}

/** The env a run with this scratch dir is given. */
export function scratchEnv(dir: string): Record<string, string> {
  return { TMPDIR: dir, TMP: dir, TEMP: dir };
}

/**
 * Create (or reuse, on resume) the agent's scratch dir. Returns its path,
 * or `undefined` when it could not be created — a run is never refused for
 * want of a temp dir; it just shares the system one.
 */
export async function openScratch(
  agentId: string,
): Promise<string | undefined> {
  const dir = agentScratchDir(agentId);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch (err) {
    logWarn(
      "agents",
      `could not create scratch dir ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Clean up after a settled agent: removed on `done`, kept otherwise.
 * Returns whether the directory was removed. Never throws.
 */
export async function closeScratch(
  agentId: string,
  state: AgentState,
): Promise<boolean> {
  if (state !== "done") return false;
  try {
    await rm(agentScratchDir(agentId), { recursive: true, force: true });
    return true;
  } catch (err) {
    logWarn(
      "agents",
      `could not remove scratch dir for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
