/**
 * `talon skill` — install / list / enable / disable / remove SKILL.md
 * workflow bundles.
 *
 * All lifecycle logic lives in storage/skills.ts; this module only
 * resolves install sources and renders outcomes. Installs accept a local
 * folder, a git URL, or `owner/repo[/subpath]` (so `talon skill install
 * anthropics/skills/skills/pdf` works). A source folder either IS a skill
 * (has SKILL.md) or is a collection whose immediate children are skills —
 * collections install every child.
 *
 * No daemon round-trip needed: the prompt index re-reads the store on the
 * next prompt assembly, so changes apply to new sessions automatically.
 */

import pc from "picocolors";
import { existsSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  deleteSkill,
  installSkillFromDir,
  listSkills,
  setSkillEnabled,
  type Skill,
} from "../storage/skills.js";
import {
  cloneSource,
  resolveSource,
  withCommit,
  writeInstallRecord,
  type GitSource,
} from "./install-sources.js";

const USAGE = [
  `  Usage: ${pc.cyan("talon skill <command>")}`,
  "",
  "  Commands:",
  `    ${pc.cyan("list")}                       Show installed skills`,
  `    ${pc.cyan("install <source> [--force]")} Add skills from a local folder,`,
  "                               git URL, or owner/repo[/subpath]",
  `    ${pc.cyan("  [--commit <sha>]")}         …at this commit (or <source>#<sha>)`,
  `    ${pc.cyan("enable <name>")}              Restore a skill to the prompt index`,
  `    ${pc.cyan("disable <name>")}             Hide a skill from the prompt index`,
  `    ${pc.cyan("remove <name>")}              Delete a skill folder`,
  "",
].join("\n");

function ok(message: string): void {
  console.log(`  ${pc.green("●")} ${message}`);
}

function fail(message: string): void {
  console.log(`  ${pc.red("✖")} ${message}`);
}

// ── list ────────────────────────────────────────────────────────────────────

function cmdList(): void {
  const skills = listSkills();
  if (skills.length === 0) {
    console.log(
      `  ${pc.dim("No skills installed — try")} ${pc.cyan("talon skill install <source>")}\n`,
    );
    return;
  }

  const header = ["NAME", "STATE", "UPDATED", "DESCRIPTION"];
  const cells = skills.map((skill) => [
    skill.name,
    skill.enabled ? "enabled" : "disabled",
    skill.updatedAt
      ? new Date(skill.updatedAt).toISOString().slice(0, 10)
      : "unknown",
    skill.description,
  ]);
  const widths = header.map((h, col) =>
    Math.max(h.length, ...cells.map((r) => r[col]!.length)),
  );
  const pad = (row: string[]) =>
    row.map((cell, col) => cell.padEnd(widths[col]!));

  console.log(`  ${pc.dim(pad(header).join("  "))}`);
  skills.forEach((skill, i) => {
    const padded = pad(cells[i]!);
    const state = cells[i]![1]!;
    padded[1] =
      (skill.enabled ? pc.green(state) : pc.dim(state)) +
      " ".repeat(widths[1]! - state.length);
    console.log(`  ${padded.join("  ")}`);
  });
  console.log();
}

// ── install ─────────────────────────────────────────────────────────────────

/**
 * The folders to install from a source dir: itself when it is a skill,
 * else every immediate child that is one.
 */
function collectSkillDirs(dir: string): string[] {
  if (existsSync(resolve(dir, "SKILL.md"))) return [dir];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(dir, entry.name))
      .filter((child) => existsSync(resolve(child, "SKILL.md")))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function installAll(dirs: string[], force: boolean): Skill[] {
  const installed: Skill[] = [];
  for (const dir of dirs) {
    const outcome = installSkillFromDir(dir, { force });
    if (outcome.ok) {
      installed.push(outcome.skill);
      ok(
        `Installed ${pc.bold(outcome.skill.name)} — ${outcome.skill.description}`,
      );
    } else {
      fail(outcome.error);
    }
  }
  return installed;
}

type SkillInstallArgs = { source: string; force: boolean; commit?: string };

function parseInstallArgs(args: string[]): SkillInstallArgs | null {
  let source: string | undefined;
  let force = false;
  let commit: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--force") force = true;
    else if (arg === "--commit") commit = args[++i];
    else if (!arg.startsWith("-") && source === undefined) source = arg;
    else return null;
  }
  if (!source || (commit !== undefined && !commit)) return null;
  return { source, force, ...(commit !== undefined ? { commit } : {}) };
}

/**
 * Record, in each skill folder of the clone, which repo and commit it came
 * from — before it is copied into the store.
 */
function recordProvenance(
  source: GitSource,
  root: string,
  dirs: string[],
  commit: string | undefined,
): void {
  for (const dir of dirs) {
    const subpath = relative(root, dir).split(sep).join("/");
    const inRepo = [source.subpath, subpath].filter(Boolean).join("/");
    writeInstallRecord(dir, {
      source: source.url,
      ...(inRepo ? { subpath: inRepo } : {}),
      ...(commit ? { commit } : {}),
      ...(source.commit ? { pinned: true } : {}),
    });
  }
}

async function cmdInstall(args: string[]): Promise<void> {
  const parsed = parseInstallArgs(args);
  if (!parsed) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const { source, force } = parsed;

  const pinned = withCommit(resolveSource(source), parsed.commit);
  if (!pinned.ok) {
    fail(pinned.error);
    process.exitCode = 1;
    return;
  }
  const resolved = pinned.source;
  if (resolved.kind === "other") {
    fail(
      `"${source}" is not a folder, git URL, or owner/repo — skills install from SKILL.md folders.`,
    );
    process.exitCode = 1;
    return;
  }

  let installed: Skill[];
  if (resolved.kind === "local") {
    const dirs = collectSkillDirs(resolved.dir);
    if (dirs.length === 0) {
      fail(`No SKILL.md found in ${resolved.dir} (or its immediate children).`);
      process.exitCode = 1;
      return;
    }
    installed = installAll(dirs, force);
  } else {
    const clone = cloneSource(resolved);
    if (!clone.ok) {
      fail(clone.error);
      process.exitCode = 1;
      return;
    }
    try {
      const root = resolved.subpath
        ? resolve(clone.dir, resolved.subpath)
        : clone.dir;
      if (!existsSync(root)) {
        fail(`Path "${resolved.subpath}" not found in ${resolved.url}`);
        process.exitCode = 1;
        return;
      }
      const dirs = collectSkillDirs(root);
      if (dirs.length === 0) {
        fail(
          `No SKILL.md found under ${resolved.subpath ?? "the repository root"} (or its immediate children).`,
        );
        process.exitCode = 1;
        return;
      }
      recordProvenance(resolved, root, dirs, clone.commit);
      installed = installAll(dirs, force);
      if (clone.commit) {
        console.log(`  ${pc.dim(`From ${resolved.url} @ ${clone.commit}`)}`);
      }
    } finally {
      clone.cleanup();
    }
  }

  if (installed.length === 0) {
    process.exitCode = 1;
  } else {
    console.log(
      `  ${pc.dim("Skills appear in the prompt index from the next session.")}`,
    );
  }
  console.log();
}

// ── enable / disable / remove ───────────────────────────────────────────────

function cmdSetEnabled(name: string | undefined, enabled: boolean): void {
  const verb = enabled ? "enable" : "disable";
  if (!name) {
    fail(`Usage: ${pc.cyan(`talon skill ${verb} <name>`)}`);
    process.exitCode = 1;
    return;
  }
  if (!setSkillEnabled(name, enabled)) {
    fail(`No skill named "${name}" — see ${pc.cyan("talon skill list")}.`);
    process.exitCode = 1;
    return;
  }
  ok(
    enabled
      ? `Skill ${pc.bold(name)} enabled — back in the prompt index next session.`
      : `Skill ${pc.bold(name)} disabled — hidden from the prompt index (still readable via read_skill).`,
  );
  console.log();
}

function cmdRemove(name: string | undefined): void {
  if (!name) {
    fail(`Usage: ${pc.cyan("talon skill remove <name>")}`);
    process.exitCode = 1;
    return;
  }
  if (!deleteSkill(name)) {
    fail(`No skill named "${name}" — see ${pc.cyan("talon skill list")}.`);
    process.exitCode = 1;
    return;
  }
  ok(`Removed skill ${pc.bold(name)} (folder deleted).`);
  console.log();
}

// ── dispatch ────────────────────────────────────────────────────────────────

export async function runSkillCommand(args: string[]): Promise<void> {
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
      cmdSetEnabled(rest[0], true);
      break;
    case "disable":
      cmdSetEnabled(rest[0], false);
      break;
    case "remove":
      cmdRemove(rest[0]);
      break;
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}
