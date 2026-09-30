/**
 * Storage layout at boot: keep Claude transcripts reachable across a
 * Talon-home move, and (in a container) warn when a backend's session
 * store is not on a persistent volume. See docs/docker.md.
 *
 * Neither step throws: both are advisory, and a boot must never fail
 * because a check could not read a directory.
 */

import { readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { claudeProjectsDir } from "../backup/sources/sessions.js";
import { raiseAlert } from "../frontend-runtime/alerts.js";
import { dirs } from "../../util/paths.js";
import { log, logWarn } from "../../util/log.js";
import { relinkClaudeProjects, type RelinkResult } from "./claude-relink.js";
import { readMountTable, type MountEntry } from "./mounts.js";
import {
  describeFindings,
  findEphemeralStores,
  inContainer,
  type StorageFinding,
} from "./persistence.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Talon homes the published image has used. In a container either may
 * hold the transcripts of a deployment that moved to the other.
 */
const CONTAINER_HOMES = ["/home/bun/.talon", "/data/.talon"] as const;
/** The pre-/data image's HOME, where an old `~/.claude` may still be mounted. */
const LEGACY_USER_HOME = "/home/bun";

/** What the last boot recorded: the home it ran in, dirs already copied. */
type RelinkState = { home: string; merged: string[] };

async function readState(file: string): Promise<RelinkState | null> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const { home, merged } = raw as Record<string, unknown>;
    if (typeof home !== "string") return null;
    return {
      home,
      merged: Array.isArray(merged)
        ? merged.filter((m): m is string => typeof m === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Carry Claude transcripts over from a previous Talon home's project slug.
 * The previous home comes from the state file (which travels with a copied
 * `.talon`, so it names the old path after a migration) and, in a
 * container, from the image's known homes.
 */
export async function relinkAfterHomeMove(opts: {
  home: string;
  userHome: string;
  env: Env;
  container: boolean;
  stateFile: string;
}): Promise<RelinkResult[]> {
  const state = await readState(opts.stateFile);
  const previousHomes = [
    ...(state ? [state.home] : []),
    ...(opts.container ? CONTAINER_HOMES : []),
  ].filter((h) => h !== opts.home);
  const projectsDir = claudeProjectsDir(opts.userHome, opts.env);
  const legacyProjects = join(LEGACY_USER_HOME, ".claude", "projects");
  const results = await relinkClaudeProjects({
    home: opts.home,
    projectsDir,
    previousHomes,
    extraSources:
      opts.container && legacyProjects !== projectsDir ? [legacyProjects] : [],
    skip: new Set(state?.merged ?? []),
    onError: (from, err) =>
      logWarn(
        "sessions",
        `Could not copy Claude transcripts from ${from}: ${String(err)} (will retry next boot)`,
      ),
  });
  for (const r of results) {
    log(
      "sessions",
      `Talon home moved: copied ${r.copied} Claude transcript file(s) from ${r.from} to ${r.to} (the original is kept)`,
    );
  }
  if (state?.home !== opts.home || results.length > 0) {
    const merged = [...(state?.merged ?? []), ...results.map((r) => r.from)];
    await mkdir(dirname(opts.stateFile), { recursive: true });
    await writeFileAtomic(
      opts.stateFile,
      JSON.stringify({ home: opts.home, merged: [...new Set(merged)] }) + "\n",
      { mode: 0o600 },
    );
  }
  return results;
}

/**
 * In a container, raise one admin alert listing every store that would
 * not survive a recreate. Returns the findings (empty outside a container
 * or when the check is switched off with TALON_STORAGE_CHECK=0).
 */
export function checkContainerStorage(opts: {
  talonHome: string;
  userHome: string;
  env: Env;
  config: Record<string, unknown>;
  container: boolean;
  mounts?: readonly MountEntry[];
  raise?: typeof raiseAlert;
}): StorageFinding[] {
  if (!opts.container || opts.env.TALON_STORAGE_CHECK === "0") return [];
  const findings = findEphemeralStores({
    ...opts,
    mounts: opts.mounts ?? readMountTable(),
  });
  if (findings.length === 0) return [];
  // Losing only Claude's account file costs a re-onboarding; losing a
  // session store costs every conversation.
  const onlyAccountFile = findings.every((f) =>
    f.path.endsWith(".claude.json"),
  );
  (opts.raise ?? raiseAlert)(
    "storage.ephemeral",
    describeFindings(findings, opts.env),
    { severity: onlyAccountFile ? "warn" : "error" },
  );
  return findings;
}

/** Both steps, with this process's paths. Never throws. */
export async function runStorageLayoutChecks(
  config: Record<string, unknown>,
): Promise<void> {
  const env = process.env;
  const container = inContainer(env);
  const userHome = homedir();
  try {
    await relinkAfterHomeMove({
      home: dirs.root,
      userHome,
      env,
      container,
      stateFile: join(dirs.data, "claude-relink.json"),
    });
  } catch (err) {
    logWarn("sessions", `Claude transcript relink failed: ${String(err)}`);
  }
  try {
    checkContainerStorage({
      talonHome: dirs.root,
      userHome,
      env,
      config,
      container,
    });
  } catch (err) {
    logWarn("bot", `Container storage check failed: ${String(err)}`);
  }
}
