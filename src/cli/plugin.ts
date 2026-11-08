/**
 * `talon plugin` — install / list / enable / disable / remove plugins.
 *
 * Plugins live in two places, and this command manages both:
 *   - built-ins toggled by their own config sections (`github.enabled`, …);
 *   - the `plugins` array: path-based modules and standalone MCP servers.
 *
 * Every mutation edits config.json, then asks a running daemon to hot-reload
 * via `POST /plugins/reload`; when the daemon is down the change simply
 * applies on the next start.
 *
 * Install sources (see cli/install-sources.ts for the shared grammar):
 * local path and git checkouts become module entries under ~/.talon/plugins;
 * an npm spec installs there too, or registers an `npx` MCP entry with
 * `--mcp`. A cloned source installs at a given commit with `#<sha>` or
 * `--commit <sha>`. Windows-safe throughout — tools are spawned via
 * cross-spawn.
 */

import pc from "picocolors";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { dirs } from "../util/paths.js";
import { ENTRY_CANDIDATES } from "../core/plugin/loader.js";
import { findRunningInstance } from "../core/daemon/discovery.js";
import { fetchGateway } from "./daemon-api.js";
import { loadConfig, saveConfig, type Config } from "./config.js";
import {
  cloneSource,
  writeInstallRecord,
  resolveSource,
  withCommit,
  runTool,
  type GitSource,
} from "./install-sources.js";
import {
  BUILTIN_PLUGINS,
  entryDisplayName,
  findConflictIndex,
  findEntryIndex,
  isBuiltinPlugin,
  npmSpecName,
  withEnabled,
  type PluginEntryJson,
} from "../core/plugin/entries.js";

/** Plugin init can legitimately take ~30s (MemPalace) — outlive it. */
const RELOAD_TIMEOUT_MS = 60_000;

const USAGE = [
  `  Usage: ${pc.cyan("talon plugin <command>")}`,
  "",
  "  Commands:",
  `    ${pc.cyan("list")}                       Show built-ins and configured plugins`,
  `    ${pc.cyan("install <source>")}           Add a plugin (local path, git URL,`,
  "                               owner/repo, or npm spec); a git source",
  "                               may end in #<commit>",
  `    ${pc.cyan("enable <name>")}              Enable a plugin`,
  `    ${pc.cyan("disable <name>")}             Disable a plugin (kept in config)`,
  `    ${pc.cyan("remove <name>")}              Remove a plugin entry (and its install)`,
  "",
  "  Install flags:",
  `    ${pc.cyan("--mcp")}                      Register an npm spec as a standalone`,
  "                               MCP server (npx) instead of a module",
  `    ${pc.cyan("--name <name>")}              Override the derived plugin name`,
  `    ${pc.cyan("--force")}                    Replace an existing install/entry`,
  `    ${pc.cyan("--commit <sha>")}             Install a git source at this commit`,
  "",
].join("\n");

function entries(config: Config): PluginEntryJson[] {
  if (!Array.isArray(config.plugins)) config.plugins = [];
  return config.plugins as PluginEntryJson[];
}

function builtinSection(
  config: Config,
  name: string,
): Record<string, unknown> | undefined {
  const section = (config as unknown as Record<string, unknown>)[name];
  return section && typeof section === "object"
    ? (section as Record<string, unknown>)
    : undefined;
}

function ok(message: string): void {
  console.log(`  ${pc.green("●")} ${message}`);
}

function fail(message: string): void {
  console.log(`  ${pc.red("✖")} ${message}`);
}

/**
 * Ask a running daemon to hot-reload. Daemon down is not an error — the
 * config change applies on next start.
 */
async function requestReload(): Promise<void> {
  const instance = await findRunningInstance();
  if (!instance?.port) {
    console.log(
      `  ${pc.dim("Talon is not running — the change applies on next start.")}`,
    );
    return;
  }
  try {
    const body = (await fetchGateway(
      instance.port,
      "/plugins/reload",
      { method: "POST" },
      RELOAD_TIMEOUT_MS,
    )) as { ok?: boolean; loaded?: string[]; error?: string };
    if (body.ok) {
      const loaded = body.loaded ?? [];
      ok(
        `Daemon reloaded plugins (${loaded.length} loaded${
          loaded.length > 0 ? `: ${loaded.join(", ")}` : ""
        }).`,
      );
    } else {
      fail(`Daemon reload failed: ${body.error ?? "unknown error"}`);
    }
  } catch (err) {
    fail(
      `Could not reach the daemon to reload: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function hasModuleEntryPoint(dir: string): boolean {
  return ENTRY_CANDIDATES.some((candidate) =>
    existsSync(resolve(dir, candidate)),
  );
}

/**
 * Is `path` inside the managed ~/.talon/plugins tree? Cross-drive Windows
 * paths make `relative()` return an absolute path, hence the isAbsolute
 * guard alongside the usual `..` escape check.
 */
function isManagedPath(path: string): boolean {
  const rel = relative(dirs.plugins, resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// ── list ────────────────────────────────────────────────────────────────────

type Row = { name: string; kind: string; state: string; source: string };

function listRows(config: Config): Row[] {
  const builtins: Row[] = BUILTIN_PLUGINS.map((name) => ({
    name,
    kind: "built-in",
    state:
      builtinSection(config, name)?.enabled === true ? "enabled" : "disabled",
    source: `config.${name}`,
  }));
  const configured: Row[] = entries(config).map((entry) => ({
    name: entryDisplayName(entry),
    kind: entry.path !== undefined ? "module" : "mcp",
    state: entry.enabled === false ? "disabled" : "enabled",
    source:
      entry.path ??
      `${entry.command ?? "?"}${entry.args ? ` ${entry.args.join(" ")}` : ""}`,
  }));
  return [...builtins, ...configured];
}

function cmdList(): void {
  const rows = listRows(loadConfig());
  const header = ["NAME", "KIND", "STATE", "SOURCE"];
  const cells = rows.map((r) => [r.name, r.kind, r.state, r.source]);
  const widths = header.map((h, col) =>
    Math.max(h.length, ...cells.map((r) => r[col]!.length)),
  );
  const pad = (row: string[]) =>
    row.map((cell, col) => cell.padEnd(widths[col]!));

  console.log(`  ${pc.dim(pad(header).join("  "))}`);
  rows.forEach((row, i) => {
    const padded = pad(cells[i]!);
    padded[2] =
      (row.state === "enabled" ? pc.green(row.state) : pc.dim(row.state)) +
      " ".repeat(widths[2]! - row.state.length);
    console.log(`  ${padded.join("  ")}`);
  });
  console.log();
}

// ── install ─────────────────────────────────────────────────────────────────

type InstallFlags = {
  mcp: boolean;
  force: boolean;
  name?: string;
  commit?: string;
};

function parseInstallArgs(
  args: string[],
): { source: string; flags: InstallFlags } | null {
  const flags: InstallFlags = { mcp: false, force: false };
  let source: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--mcp") flags.mcp = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--name") flags.name = args[++i];
    else if (arg === "--commit") flags.commit = args[++i];
    else if (!arg.startsWith("-") && source === undefined) source = arg;
    else return null;
  }
  if (!source || (flags.name !== undefined && !flags.name)) return null;
  if (flags.commit !== undefined && !flags.commit) return null;
  return { source, flags };
}

type EntryOutcome =
  { ok: true; entry: PluginEntryJson } | { ok: false; error: string };

function installFromLocalDir(dir: string): EntryOutcome {
  if (existsSync(resolve(dir, "SKILL.md"))) {
    return {
      ok: false,
      error: `${dir} looks like a skill — use ${pc.cyan("talon skill install")}`,
    };
  }
  if (!hasModuleEntryPoint(dir)) {
    return {
      ok: false,
      error: `No plugin entry point in ${dir} (expected one of: ${ENTRY_CANDIDATES.join(", ")})`,
    };
  }
  return { ok: true, entry: { path: dir } };
}

/**
 * Clone (or copy a clone subpath) into ~/.talon/plugins/<name>. The
 * checkout is staged and validated (deps installed, entry point present)
 * entirely inside the temp clone; an existing install is only replaced
 * once the staged copy is known-good, so a failed install never destroys
 * a working one.
 */
function installFromGit(source: GitSource, flags: InstallFlags): EntryOutcome {
  const derived = source.subpath
    ? basename(source.subpath)
    : basename(source.url, ".git");
  const name = flags.name ?? derived;
  const target = join(dirs.plugins, name);
  if (existsSync(target) && !flags.force) {
    return {
      ok: false,
      error: `${target} already exists (use --force to replace)`,
    };
  }

  const clone = cloneSource(source);
  if (!clone.ok) return { ok: false, error: clone.error };
  try {
    const stage = source.subpath
      ? resolve(clone.dir, source.subpath)
      : clone.dir;
    if (!existsSync(stage)) {
      return {
        ok: false,
        error: `Path "${source.subpath}" not found in ${source.url}`,
      };
    }
    // An install is a snapshot, not a checkout — updates go through
    // `install --force`, so the clone's history has no business here.
    // What it WAS a snapshot of is kept, so the exact commit is auditable.
    rmSync(join(stage, ".git"), { recursive: true, force: true });
    writeInstallRecord(stage, {
      source: source.url,
      ...(source.subpath ? { subpath: source.subpath } : {}),
      ...(clone.commit ? { commit: clone.commit } : {}),
      ...(source.commit ? { pinned: true } : {}),
    });
    if (clone.commit) {
      console.log(`  ${pc.dim(`Commit ${clone.commit}`)}`);
    }

    if (existsSync(join(stage, "package.json"))) {
      console.log(`  ${pc.dim("Installing dependencies…")}`);
      const deps = runTool("npm", ["install", "--omit=dev"], {
        cwd: stage,
        inherit: true,
      });
      if (!deps.ok) {
        return { ok: false, error: `Dependency install failed: ${deps.error}` };
      }
    }
    if (!hasModuleEntryPoint(stage)) {
      return {
        ok: false,
        error: `No plugin entry point in the checkout (expected one of: ${ENTRY_CANDIDATES.join(", ")})`,
      };
    }

    mkdirSync(dirs.plugins, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    cpSync(stage, target, { recursive: true });
    return { ok: true, entry: { path: target } };
  } finally {
    clone.cleanup();
  }
}

function installFromNpm(spec: string, flags: InstallFlags): EntryOutcome {
  if (flags.mcp) {
    const pkg = npmSpecName(spec);
    const name = flags.name ?? pkg.split("/").pop()!;
    // npx resolves the package at daemon start; the mcp-launcher wraps the
    // spawn, so `.cmd` shims work on Windows.
    return {
      ok: true,
      entry: { name, command: "npx", args: ["-y", spec] },
    };
  }

  mkdirSync(dirs.plugins, { recursive: true });
  console.log(`  ${pc.dim(`Installing ${spec} from npm…`)}`);
  const install = runTool("npm", ["install", "--prefix", dirs.plugins, spec], {
    inherit: true,
  });
  if (!install.ok) return { ok: false, error: install.error };

  const pkg = npmSpecName(spec);
  const moduleDir = join(dirs.plugins, "node_modules", ...pkg.split("/"));
  if (!hasModuleEntryPoint(moduleDir)) {
    runTool("npm", ["uninstall", "--prefix", dirs.plugins, pkg]);
    return {
      ok: false,
      error:
        `${pkg} has no Talon plugin entry point — if it is a standalone ` +
        `MCP server, install it with ${pc.cyan(`talon plugin install ${spec} --mcp`)}`,
    };
  }
  return { ok: true, entry: { path: moduleDir } };
}

async function cmdInstall(args: string[]): Promise<void> {
  const parsed = parseInstallArgs(args);
  if (!parsed) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const { source, flags } = parsed;

  const pinned = withCommit(resolveSource(source), flags.commit);
  if (!pinned.ok) {
    fail(pinned.error);
    process.exitCode = 1;
    return;
  }
  const resolved = pinned.source;
  let outcome: EntryOutcome;
  switch (resolved.kind) {
    case "local":
      outcome = installFromLocalDir(resolved.dir);
      break;
    case "git":
      outcome = installFromGit(resolved, flags);
      break;
    case "other":
      outcome = installFromNpm(resolved.raw, flags);
      break;
  }
  if (!outcome.ok) {
    fail(outcome.error);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const list = entries(config);
  const conflict = findConflictIndex(list, outcome.entry);
  if (conflict >= 0) {
    if (!flags.force) {
      fail(
        `"${entryDisplayName(outcome.entry)}" is already configured (use --force to replace).`,
      );
      process.exitCode = 1;
      return;
    }
    list[conflict] = outcome.entry;
  } else {
    list.push(outcome.entry);
  }
  saveConfig(config);

  const name = entryDisplayName(outcome.entry);
  ok(
    outcome.entry.path !== undefined
      ? `Installed module plugin ${pc.bold(name)} (${outcome.entry.path}).`
      : `Registered MCP server ${pc.bold(name)} (${outcome.entry.command} ${outcome.entry.args?.join(" ") ?? ""}).`,
  );
  await requestReload();
  console.log();
}

// ── enable / disable ────────────────────────────────────────────────────────

async function cmdSetEnabled(
  name: string | undefined,
  enabled: boolean,
): Promise<void> {
  const verb = enabled ? "enable" : "disable";
  if (!name) {
    fail(`Usage: ${pc.cyan(`talon plugin ${verb} <name>`)}`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  if (isBuiltinPlugin(name)) {
    const section = builtinSection(config, name) ?? {};
    (config as unknown as Record<string, unknown>)[name] = {
      ...section,
      enabled,
    };
    saveConfig(config);
    ok(`Built-in ${pc.bold(name)} ${verb}d.`);
    if (enabled && Object.keys(section).length === 0) {
      console.log(
        `  ${pc.dim(`${name} may need additional config — see the README's plugin section.`)}`,
      );
    }
  } else {
    const list = entries(config);
    const index = findEntryIndex(list, name);
    if (index < 0) {
      fail(`No plugin named "${name}" — see ${pc.cyan("talon plugin list")}.`);
      process.exitCode = 1;
      return;
    }
    list[index] = withEnabled(list[index]!, enabled);
    saveConfig(config);
    ok(`Plugin ${pc.bold(entryDisplayName(list[index]!))} ${verb}d.`);
  }
  await requestReload();
  console.log();
}

// ── remove ──────────────────────────────────────────────────────────────────

async function cmdRemove(name: string | undefined): Promise<void> {
  if (!name) {
    fail(`Usage: ${pc.cyan("talon plugin remove <name>")}`);
    process.exitCode = 1;
    return;
  }
  if (isBuiltinPlugin(name)) {
    fail(
      `${name} is built-in — use ${pc.cyan(`talon plugin disable ${name}`)} instead.`,
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const list = entries(config);
  const index = findEntryIndex(list, name);
  if (index < 0) {
    fail(`No plugin named "${name}" — see ${pc.cyan("talon plugin list")}.`);
    process.exitCode = 1;
    return;
  }
  const [removed] = list.splice(index, 1);
  saveConfig(config);

  // Clean up installs this CLI owns (~/.talon/plugins); never touch
  // user-managed paths elsewhere on disk.
  const path = removed!.path;
  if (path && isManagedPath(path)) {
    if (path.split(/[\\/]/).includes("node_modules")) {
      runTool("npm", [
        "uninstall",
        "--prefix",
        dirs.plugins,
        entryDisplayName(removed!),
      ]);
    } else {
      rmSync(path, { recursive: true, force: true });
    }
  }

  ok(`Removed plugin ${pc.bold(entryDisplayName(removed!))}.`);
  await requestReload();
  console.log();
}

// ── dispatch ────────────────────────────────────────────────────────────────

export async function runPluginCommand(args: string[]): Promise<void> {
  console.log();
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list":
    case undefined:
      cmdList();
      break;
    case "install":
      await cmdInstall(rest);
      break;
    case "enable":
      await cmdSetEnabled(rest[0], true);
      break;
    case "disable":
      await cmdSetEnabled(rest[0], false);
      break;
    case "remove":
      await cmdRemove(rest[0]);
      break;
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}
