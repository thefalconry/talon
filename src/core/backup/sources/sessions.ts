/**
 * Backend session stores — the conversations themselves.
 *
 * Talon's database knows which session a chat is on; the transcript that
 * session resumes from lives with the backend that ran it, outside the
 * Talon home. A snapshot without these restores every chat to a session
 * id that points at nothing, so they are captured here:
 *
 *   - Claude Agent SDK: `~/.claude/projects/<slug>/` for every cwd Talon
 *     runs sessions in — the workspace and agent-workspace/, plus any
 *     directory beneath them (the slug is the path with every
 *     non-alphanumeric character turned into `-`, so a subdirectory's
 *     slug extends its parent's).
 *   - Codex: `$CODEX_HOME/sessions` (default `~/.codex`).
 *   - OpenCode / Kilo: `$XDG_DATA_HOME/<name>/storage` plus the session
 *     database, copied through SQLite rather than byte-wise.
 *   - Antigravity (agy): the CLI's conversations, brain and summaries.
 *
 * Only stores of backends the config enables are captured — a Codex
 * install used for unrelated work is not Talon's state. Claude is always
 * considered: it is the default backend and its store is scoped by cwd.
 *
 * Pure discovery: this reads directory listings, never file contents.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalRoot } from "../types.js";

/** What discovery needs to know about this machine. */
export type SourceContext = {
  /** Talon home (`~/.talon`). */
  home: string;
  /** The OS user's home; null = do not look outside the Talon home. */
  userHome: string | null;
  env: Readonly<Record<string, string | undefined>>;
  /** Parsed config.json (untyped: the snapshot reads what it archives). */
  config: Record<string, unknown>;
};

/** Claude Code's project directory name for a cwd. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Where Claude Code keeps per-cwd transcripts. */
export function claudeProjectsDir(
  userHome: string,
  env: SourceContext["env"],
): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(configDir || join(userHome, ".claude"), "projects");
}

/** The cwds Talon starts Claude sessions in. */
export function sessionCwds(home: string): string[] {
  return [join(home, "workspace"), join(home, "agent-workspace")];
}

/** Every backend id the config can route a turn to. */
function enabledBackends(config: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const key of [
    "backend",
    "defaultBackend",
    "heartbeatBackend",
    "dreamBackend",
  ]) {
    const value = config[key];
    if (typeof value === "string") ids.add(value);
  }
  const list = config.enabledBackends;
  if (Array.isArray(list)) {
    for (const id of list) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Claude project directories for the Talon cwds, sorted for a stable plan. */
async function claudeRoots(
  userHome: string,
  ctx: SourceContext,
): Promise<ExternalRoot[]> {
  const projects = claudeProjectsDir(userHome, ctx.env);
  let names: string[];
  try {
    names = await readdir(projects);
  } catch {
    return [];
  }
  const slugs = sessionCwds(ctx.home).map(claudeProjectSlug);
  return names
    .filter((name) =>
      slugs.some((slug) => name === slug || name.startsWith(`${slug}-`)),
    )
    .sort()
    .map((name) => ({
      root: `sessions/claude/${name}`,
      source: join(projects, name),
      kind: "claude-project" as const,
    }));
}

/** One backend's store: directories plus (optionally) SQLite files. */
type StoreSpec = {
  backend: string;
  dir: (userHome: string, env: SourceContext["env"]) => string;
  dirs: readonly string[];
  databases: readonly string[];
};

const xdgData = (userHome: string, env: SourceContext["env"]): string =>
  env.XDG_DATA_HOME?.trim() || join(userHome, ".local", "share");

const STORES: readonly StoreSpec[] = [
  {
    backend: "codex",
    dir: (userHome, env) => env.CODEX_HOME?.trim() || join(userHome, ".codex"),
    dirs: ["sessions"],
    databases: [],
  },
  {
    backend: "opencode",
    dir: (userHome, env) => join(xdgData(userHome, env), "opencode"),
    dirs: ["storage"],
    databases: ["opencode.db"],
  },
  {
    backend: "kilo",
    dir: (userHome, env) => join(xdgData(userHome, env), "kilo"),
    dirs: ["storage"],
    databases: ["kilo.db"],
  },
  {
    backend: "agy",
    dir: (userHome) => join(userHome, ".gemini", "antigravity-cli"),
    dirs: ["conversations", "brain", "annotations", "implicit"],
    databases: ["conversation_summaries.db"],
  },
];

async function storeRoots(
  spec: StoreSpec,
  userHome: string,
  env: SourceContext["env"],
): Promise<ExternalRoot[]> {
  const base = spec.dir(userHome, env);
  const roots: ExternalRoot[] = [];
  for (const name of spec.dirs) {
    const source = join(base, name);
    if (await pathExists(source)) {
      roots.push({
        root: `sessions/${spec.backend}/${name}`,
        source,
        kind: "session-store",
      });
    }
  }
  for (const name of spec.databases) {
    const source = join(base, name);
    if (await pathExists(source)) {
      roots.push({
        root: `sessions/${spec.backend}/${name}`,
        source,
        kind: "session-store",
        sqlite: true,
      });
    }
  }
  return roots;
}

/**
 * The directory each configured backend keeps its sessions (and sign-in)
 * under, whether or not it exists yet. Claude is always listed: it is the
 * default backend. The container storage check uses this to tell which
 * of them would vanish with the container.
 */
export function backendStoreDirs(
  userHome: string,
  env: SourceContext["env"],
  config: Record<string, unknown>,
): { backend: string; path: string }[] {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const out = [
    { backend: "claude", path: configDir || join(userHome, ".claude") },
  ];
  const backends = enabledBackends(config);
  for (const spec of STORES) {
    if (!backends.has(spec.backend)) continue;
    const dir = spec.dir(userHome, env);
    // agy's store is one level inside ~/.gemini, which also holds its
    // sign-in: check the whole directory.
    out.push({
      backend: spec.backend,
      path: spec.backend === "agy" ? join(userHome, ".gemini") : dir,
    });
  }
  return out;
}

/**
 * Every session root this machine has for the configured backends, in a
 * deterministic order. Nothing outside the Talon home is looked at when
 * `userHome` is null (tests that only fake a Talon home).
 */
export async function discoverSessionRoots(
  ctx: SourceContext,
): Promise<ExternalRoot[]> {
  if (!ctx.userHome) return [];
  const roots = await claudeRoots(ctx.userHome, ctx);
  const backends = enabledBackends(ctx.config);
  for (const spec of STORES) {
    if (!backends.has(spec.backend)) continue;
    roots.push(...(await storeRoots(spec, ctx.userHome, ctx.env)));
  }
  return roots;
}
