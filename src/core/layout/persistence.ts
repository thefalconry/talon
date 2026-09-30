/**
 * Boot check: in a container, is every backend's session store on a
 * volume that outlives the container?
 *
 * The image keeps everything under one data root (HOME=/data). A setup
 * that maps only part of it — commonly just `~/.talon` in a NAS "custom
 * app" — runs fine until the first image update, which silently takes
 * every Claude/Codex/OpenCode transcript with it: the database still
 * names those sessions, but nothing is left to resume. This check turns
 * that into one admin alert at boot, naming each path and the fix.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { backendStoreDirs } from "../backup/sources/sessions.js";
import { persistenceOf, type MountEntry, type Persistence } from "./mounts.js";

export type StorageFinding = {
  path: string;
  /** What the operator loses with it. */
  label: string;
  persistence: Exclude<Persistence, "persistent">;
};

type Env = Readonly<Record<string, string | undefined>>;

/** Whether this process runs inside a container (Docker, Podman, the image). */
export function inContainer(
  env: Env,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return (
    env.TALON_CONTAINER === "1" ||
    exists("/.dockerenv") ||
    exists("/run/.containerenv")
  );
}

const LABELS: Record<string, string> = {
  claude: "Claude Code transcripts and sign-in",
  codex: "Codex sessions and sign-in",
  opencode: "OpenCode sessions",
  kilo: "Kilo sessions",
  agy: "Antigravity sign-in and conversations",
};

/** Every path whose loss costs the operator something, with what it holds. */
function storagePaths(input: {
  talonHome: string;
  userHome: string;
  env: Env;
  config: Record<string, unknown>;
}): { path: string; label: string }[] {
  const paths = [
    {
      path: input.talonHome,
      label: "Talon home: config, chat history, memory, keys",
    },
  ];
  for (const store of backendStoreDirs(
    input.userHome,
    input.env,
    input.config,
  )) {
    paths.push({
      path: store.path,
      label: LABELS[store.backend] ?? `${store.backend} sessions`,
    });
  }
  // Claude Code keeps its account/onboarding state next to ~/.claude,
  // not inside it — unless CLAUDE_CONFIG_DIR moves both.
  if (!input.env.CLAUDE_CONFIG_DIR?.trim()) {
    paths.push({
      path: join(input.userHome, ".claude.json"),
      label: "Claude Code account state",
    });
  }
  return paths;
}

/**
 * The stores that would not survive a container recreate. Empty when the
 * mount table is unknown: no table, no claim either way.
 */
export function findEphemeralStores(input: {
  talonHome: string;
  userHome: string;
  env: Env;
  config: Record<string, unknown>;
  mounts: readonly MountEntry[];
}): StorageFinding[] {
  if (input.mounts.length === 0) return [];
  const findings: StorageFinding[] = [];
  const seen = new Set<string>();
  for (const { path, label } of storagePaths(input)) {
    if (seen.has(path)) continue;
    seen.add(path);
    const persistence = persistenceOf(path, input.mounts);
    if (persistence !== "persistent")
      findings.push({ path, label, persistence });
  }
  return findings;
}

const WHERE: Record<StorageFinding["persistence"], string> = {
  ephemeral: "container filesystem, lost on every image update",
  anonymous: "anonymous Docker volume, lost when the container is removed",
};

/** The admin alert text for a set of findings. */
export function describeFindings(
  findings: readonly StorageFinding[],
  env: Env,
): string {
  const lines = findings.map(
    (f) => `• ${f.path}: ${f.label} (${WHERE[f.persistence]})`,
  );
  const legacy =
    env.TALON_LAYOUT === "legacy"
      ? "\nThis container runs the old /home/bun layout (only some paths mounted)."
      : "";
  return (
    "Some of Talon's state is not on a persistent volume and will be lost " +
    "when this container is recreated:\n" +
    lines.join("\n") +
    legacy +
    "\n\nFix: mount one volume at /data and run with HOME=/data (the image " +
    "default), after copying the paths above into it. Nothing is moved for " +
    'you. Steps: docs/docker.md, "Upgrading from the old layout".' +
    "\nSilence this check with TALON_STORAGE_CHECK=0."
  );
}
