/**
 * Plugins — what a clone needs to run the same tools.
 *
 * Two kinds of plugin entry in config.json, two ways to carry them:
 *
 *   - Local code (`path`, or an MCP `command` whose argument is a path on
 *     disk): the checkout itself goes into the snapshot as
 *     `plugin-src/<n>-<name>`, minus what an install or build recreates
 *     (node_modules, venvs, dist/, build/, caches — see plan.ts). Lockfiles
 *     and package.json stay, so `npm ci` gets the same tree back.
 *   - Fetched packages (`npx`/`bunx`/`pnpm dlx`, `uvx`/`pipx run`,
 *     `docker run`): nothing to copy, so `plugins-manifest.json` records
 *     the exact spec — package@version or image:tag — to reinstall from.
 *     An unpinned npm package is resolved against the local npx cache and
 *     the version found is written down, marked `pinned: false`.
 *
 * Plugins under the Talon home (`talon plugin install` puts them in
 * ~/.talon/plugins) are already captured with the home and are listed in
 * the manifest only.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isInside } from "../plan.js";
import type { ExternalRoot } from "../types.js";
import { pathExists, type SourceContext } from "./sessions.js";

type PluginEntry = {
  path?: string;
  name?: string;
  command?: string;
  args?: string[];
  enabled?: boolean;
};

/** One line of plugins-manifest.json. */
type PluginRecord = {
  name: string;
  enabled: boolean;
  source:
    | { type: "local"; path: string; archiveRoot?: string; version?: string }
    | { type: "npm"; spec: string; version?: string; pinned: boolean }
    | { type: "python"; spec: string; pinned: boolean }
    | { type: "docker"; image: string; pinned: boolean }
    | { type: "command"; command: string };
};

export type PluginsManifest = { schema: 1; plugins: PluginRecord[] };

const NPM_RUNNERS = new Set(["npx", "bunx"]);
const PY_RUNNERS = new Set(["uvx", "pipx"]);
const DOCKER_RUNNERS = new Set(["docker", "podman"]);
const PACKAGE_MARKERS = ["package.json", "pyproject.toml", "setup.py"];

function pluginEntries(config: Record<string, unknown>): PluginEntry[] {
  const list = config.plugins;
  return Array.isArray(list)
    ? list.filter((e): e is PluginEntry => typeof e === "object" && e !== null)
    : [];
}

function displayName(entry: PluginEntry): string {
  if (entry.name) return entry.name;
  if (entry.path) return basename(entry.path.replace(/[\\/]+$/, ""));
  return entry.command ?? "(invalid entry)";
}

/** Non-flag arguments, in order. */
function positional(args: readonly string[]): string[] {
  return args.filter((arg) => !arg.startsWith("-"));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The package root of a plugin path: the nearest directory at or above
 * it that holds a package.json/pyproject.toml, never climbing past the
 * user's home. A path pointing into `src/` still captures the lockfile.
 */
async function packageRoot(
  path: string,
  userHome: string | null,
): Promise<string> {
  let dir = (await isFile(path)) ? dirname(path) : path;
  const start = dir;
  for (let depth = 0; depth < 4; depth++) {
    for (const marker of PACKAGE_MARKERS) {
      if (await isFile(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir || (userHome && parent === userHome)) break;
    dir = parent;
  }
  return start;
}

async function readVersion(dir: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** `pkg@1.2.3` → pinned; `pkg`, `pkg@latest`, `pkg@^1` → not. */
function npmPinned(spec: string): boolean {
  const at = spec.lastIndexOf("@");
  return at > 0 && /^\d+\.\d+\.\d+/.test(spec.slice(at + 1));
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Highest version of `name` in the npx cache — what `npx` would run. */
async function npxCachedVersion(
  name: string,
  userHome: string | null,
): Promise<string | undefined> {
  if (!userHome) return undefined;
  const cache = join(userHome, ".npm", "_npx");
  let hashes: string[];
  try {
    hashes = await readdir(cache);
  } catch {
    return undefined;
  }
  const versions: string[] = [];
  for (const hash of hashes) {
    const version = await readVersion(join(cache, hash, "node_modules", name));
    if (version) versions.push(version);
  }
  return versions.sort(compareVersions).pop();
}

function npmName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

async function commandSource(
  entry: PluginEntry,
  userHome: string | null,
): Promise<PluginRecord["source"]> {
  const command = basename(entry.command ?? "");
  const args = positional(entry.args ?? []);
  if (NPM_RUNNERS.has(command) || command === "pnpm") {
    const spec = (command === "pnpm" ? args[1] : args[0]) ?? "";
    const pinned = npmPinned(spec);
    const version = pinned
      ? undefined
      : await npxCachedVersion(npmName(spec), userHome);
    return { type: "npm", spec, pinned, ...(version ? { version } : {}) };
  }
  if (PY_RUNNERS.has(command)) {
    const fromIndex = (entry.args ?? []).indexOf("--from");
    const spec =
      fromIndex >= 0
        ? (entry.args?.[fromIndex + 1] ?? "")
        : ((command === "pipx" ? args[1] : args[0]) ?? "");
    return { type: "python", spec, pinned: /==|@/.test(spec) };
  }
  if (DOCKER_RUNNERS.has(command)) {
    // `docker run [flags] image[:tag] [cmd]` — flag values (`-e K=V`,
    // `-v /a:/b`) are the positional args that are not the image.
    const image =
      args.slice(1).find((arg) => !arg.includes("=") && !arg.startsWith("/")) ??
      "";
    return {
      type: "docker",
      image,
      pinned: /:[^/]+$|@sha256:/.test(image),
    };
  }
  const local = (entry.args ?? []).find((arg) => isAbsolute(arg));
  if (local) return { type: "local", path: local };
  return { type: "command", command: entry.command ?? "" };
}

/**
 * Walk config.json's plugins into the manifest and the list of local
 * checkouts to archive. Deterministic: config order, numbered roots.
 */
export async function discoverPlugins(ctx: SourceContext): Promise<{
  manifest: PluginsManifest;
  roots: ExternalRoot[];
}> {
  const plugins: PluginRecord[] = [];
  const roots: ExternalRoot[] = [];
  for (const [index, entry] of pluginEntries(ctx.config).entries()) {
    const source: PluginRecord["source"] = entry.path
      ? { type: "local", path: entry.path }
      : await commandSource(entry, ctx.userHome);
    if (source.type === "local") {
      const root = await packageRoot(source.path, ctx.userHome);
      const version = await readVersion(root);
      if (version) source.version = version;
      if (!isInside(ctx.home, root) && (await pathExists(root))) {
        source.archiveRoot = `plugin-src/${index}-${basename(root)}`;
        roots.push({ root: source.archiveRoot, source: root, kind: "plugin" });
      }
    }
    plugins.push({
      name: displayName(entry),
      enabled: entry.enabled !== false,
      source,
    });
  }
  return { manifest: { schema: 1, plugins }, roots };
}
