/**
 * Skill store — reusable workflow bundles following Anthropic's Agent
 * Skills (SKILL.md) standard.
 *
 * These are distinct from executable `save_script` scripts. Skills are
 * guidance the agent can load into context when a repeatable workflow
 * needs judgement: review protocols, release checklists, backend-
 * specific debugging procedures, and similar reusable know-how.
 *
 * Layout: each skill is a FOLDER under `workspace/skills/<name>/`
 * containing a `SKILL.md` entry file (YAML frontmatter + markdown body).
 * The folder may also bundle supporting files (scripts, templates,
 * references) alongside SKILL.md; those are preserved across updates and
 * surfaced to the agent on read.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { parseDocument, stringify } from "yaml";
import { logWarn } from "../util/log.js";
import { dirs } from "../util/paths.js";

export type Skill = {
  name: string;
  description: string;
  body: string;
  path: string;
  updatedAt: number;
  /**
   * Disabled skills (a `.disabled` marker file in the folder) drop out of
   * the prompt index and `find_skills`, but stay listable and readable —
   * the toggle hides, it never restricts.
   */
  enabled: boolean;
  /** Relative filenames bundled in the skill folder (excludes SKILL.md). */
  resources: string[];
  /** Frontmatter keys beyond name/description, preserved on read. */
  extra?: Record<string, unknown>;
};

export type SkillSearchResult = {
  skill: Skill;
  score: number;
  snippet: string;
};

const SKILL_FILE = "SKILL.md";
/**
 * Marker file for `talon skill disable`. Lives beside SKILL.md rather than
 * in frontmatter because `save_skill` rewrites SKILL.md wholesale — a
 * sibling file survives every update, and is visible in the filesystem.
 */
const DISABLED_FILE = ".disabled";
/**
 * Provenance `talon skill install` writes for a cloned source (repo URL,
 * commit) — metadata, not a resource the skill offers.
 */
const INSTALL_RECORD_FILE = ".talon-install.json";
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DESCRIPTION_MAX_CHARS = 300;
const BODY_MAX_BYTES = 128 * 1024;
const PROMPT_LIST_LIMIT = 25;
const SEARCH_RESULT_LIMIT = 10;

function skillsDir(): string {
  return dirs.skills;
}

function skillDir(name: string): string {
  return resolve(skillsDir(), name);
}

function skillFilePath(name: string): string {
  return resolve(skillDir(name), SKILL_FILE);
}

/**
 * Path to a skill's SKILL.md entry file. Retained under the historical
 * `skillPath` name for callers that reference it.
 */
export function skillPath(name: string): string {
  return skillFilePath(name);
}

export function validateSkillName(name: string): string | null {
  if (!name) return "Missing name";
  if (!NAME_RE.test(name))
    return "Name must be 1-64 chars of letters, digits, dash, underscore (it becomes the skill folder name)";
  return null;
}

export function validateSkillDescription(description: string): string | null {
  if (!description || !description.trim()) return "Missing description";
  if (description.length > DESCRIPTION_MAX_CHARS)
    return `Description too long (max ${DESCRIPTION_MAX_CHARS} chars)`;
  return null;
}

export function validateSkillBody(body: string): string | null {
  if (!body || !body.trim()) return "Missing instruction body";
  if (Buffer.byteLength(body, "utf-8") > BODY_MAX_BYTES)
    return `Instruction body too large (max ${BODY_MAX_BYTES} bytes)`;
  return null;
}

function serializeSkill(input: {
  name: string;
  description: string;
  body: string;
  extra?: Record<string, unknown>;
}): string {
  const frontmatter: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    ...input.extra,
  };
  // Keep name/description first; stringify preserves insertion order.
  const yaml = stringify(frontmatter).trimEnd();
  return ["---", yaml, "---", "", input.body.trimEnd(), ""].join("\n");
}

/**
 * Frontmatter errors already reported, keyed by path + message: skills
 * are re-read for every prompt, so a broken SKILL.md warns once, not
 * once per turn.
 */
const reportedFrontmatterErrors = new Set<string>();

function parseSkill(
  path: string,
  raw: string,
): Omit<Skill, "resources" | "enabled"> {
  const fallbackName = basename(resolve(path, ".."));
  if (!raw.startsWith("---\n")) {
    return {
      name: fallbackName,
      description: "",
      body: raw.trim(),
      path,
      updatedAt: 0,
    };
  }

  const end = raw.indexOf("\n---", 4);
  if (end < 0) {
    return {
      name: fallbackName,
      description: "",
      body: raw.trim(),
      path,
      updatedAt: 0,
    };
  }

  const header = raw.slice(4, end);
  const body = raw
    .slice(end + "\n---".length)
    .replace(/^\n/, "")
    .trimEnd();

  let parsed: Record<string, unknown> = {};
  try {
    const value = parseDocument(header).toJS();
    if (value && typeof value === "object") {
      parsed = value as Record<string, unknown>;
    }
  } catch (err) {
    // The skill still loads (name falls back to its directory, no
    // description) — which is exactly why the reason must be visible.
    const msg = err instanceof Error ? err.message : String(err);
    const key = `${path}\0${msg}`;
    if (!reportedFrontmatterErrors.has(key)) {
      reportedFrontmatterErrors.add(key);
      logWarn("skills", `Unparseable frontmatter in ${path}: ${msg}`);
    }
    parsed = {};
  }

  const name =
    typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name
      : fallbackName;
  const description =
    typeof parsed.description === "string" ? parsed.description : "";

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "name" || key === "description") continue;
    extra[key] = value;
  }

  return {
    name,
    description,
    body,
    path,
    updatedAt: 0,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

function listResources(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name !== SKILL_FILE &&
          entry.name !== DISABLED_FILE &&
          entry.name !== INSTALL_RECORD_FILE,
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function saveSkill(input: {
  name: string;
  description: string;
  body: string;
  extra?: Record<string, unknown>;
}): Skill {
  const dir = skillDir(input.name);
  // Recursive mkdir preserves any sibling bundled files on update; we
  // only overwrite SKILL.md, never the rest of the folder.
  mkdirSync(dir, { recursive: true });
  const path = skillFilePath(input.name);
  const content = serializeSkill(input);
  // Atomic: a failed replace (ENOSPC) must keep the previous SKILL.md,
  // not leave a truncated one.
  writeFileAtomic.sync(path, content, { encoding: "utf-8", mode: 0o600 });
  return readSkill(input.name)!;
}

export function readSkill(name: string): Skill | undefined {
  // Reject names that fail validation (e.g. "../escape") before they
  // are turned into a filesystem path — guards against path traversal.
  if (validateSkillName(name)) return undefined;
  const dir = skillDir(name);
  const path = skillFilePath(name);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf-8");
  const parsed = parseSkill(path, raw);
  const skill: Skill = {
    ...parsed,
    enabled: !existsSync(resolve(dir, DISABLED_FILE)),
    resources: listResources(dir),
  };
  try {
    skill.updatedAt = Math.floor(statSync(path).mtimeMs);
  } catch {
    skill.updatedAt = 0;
  }
  return skill;
}

export function listSkills(): Skill[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(resolve(dir, entry.name, SKILL_FILE)))
    .map((entry) => readSkill(entry.name))
    .filter((skill): skill is Skill => Boolean(skill))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreSkill(skill: Skill, tokens: string[]): number {
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  const body = skill.body.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name === token) score += 20;
    else if (name.includes(token)) score += 12;
    if (description.includes(token)) score += 6;
    if (body.includes(token)) score += 2;
  }
  return score;
}

function snippetFor(skill: Skill, tokens: string[]): string {
  const body = skill.body.replace(/\s+/g, " ").trim();
  if (!body) return "";
  const lower = body.toLowerCase();
  const hit = tokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (hit ?? 0) - 80);
  const end = Math.min(body.length, start + 220);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < body.length ? "..." : "";
  return `${prefix}${body.slice(start, end)}${suffix}`;
}

export function searchSkills(
  query: string,
  limit = SEARCH_RESULT_LIMIT,
): SkillSearchResult[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  return listSkills()
    .filter((skill) => skill.enabled)
    .map((skill) => ({
      skill,
      score: scoreSkill(skill, tokens),
      snippet: snippetFor(skill, tokens),
    }))
    .filter((result) => result.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
    )
    .slice(0, Math.max(1, Math.min(50, limit)));
}

/**
 * Toggle a skill's enabled state via the `.disabled` marker. Idempotent.
 * Returns false when the skill doesn't exist (or the name is invalid).
 */
export function setSkillEnabled(name: string, enabled: boolean): boolean {
  if (validateSkillName(name)) return false;
  if (!existsSync(skillFilePath(name))) return false;
  const marker = resolve(skillDir(name), DISABLED_FILE);
  if (enabled) {
    if (existsSync(marker)) unlinkSync(marker);
  } else {
    writeFileSync(marker, "", { encoding: "utf-8", mode: 0o600 });
  }
  return true;
}

export type SkillInstallResult =
  { ok: true; skill: Skill } | { ok: false; error: string };

/**
 * Install a skill from a folder containing SKILL.md (plus any bundled
 * resources) — the store half of `talon skill install`. The target folder
 * name is the frontmatter `name`, so a checkout's directory name never
 * leaks into the store. Refuses to overwrite an existing skill unless
 * `force`, in which case the old folder (including its `.disabled` marker)
 * is replaced wholesale.
 */
export function installSkillFromDir(
  sourceDir: string,
  options: { force?: boolean } = {},
): SkillInstallResult {
  const sourceFile = resolve(sourceDir, SKILL_FILE);
  if (!existsSync(sourceFile)) {
    return { ok: false, error: `No ${SKILL_FILE} in ${sourceDir}` };
  }

  let raw: string;
  try {
    raw = readFileSync(sourceFile, "utf-8");
  } catch (err) {
    return {
      ok: false,
      error: `Could not read ${sourceFile}: ${err instanceof Error ? err.message : err}`,
    };
  }

  const parsed = parseSkill(sourceFile, raw);
  const invalid =
    validateSkillName(parsed.name) ??
    validateSkillDescription(parsed.description) ??
    validateSkillBody(parsed.body);
  if (invalid) return { ok: false, error: `Invalid skill: ${invalid}` };

  const target = skillDir(parsed.name);
  // Installing the store's own folder onto itself would delete the source
  // before the copy (rmSync + cpSync) — refuse rather than lose the skill.
  if (resolve(sourceDir) === target) {
    return {
      ok: false,
      error: `"${parsed.name}" is already the installed copy (${target})`,
    };
  }
  if (existsSync(target)) {
    if (!options.force) {
      return {
        ok: false,
        error: `Skill "${parsed.name}" already exists (use --force to replace)`,
      };
    }
    rmSync(target, { recursive: true, force: true });
  }

  mkdirSync(skillsDir(), { recursive: true });
  cpSync(sourceDir, target, { recursive: true });
  const skill = readSkill(parsed.name);
  if (!skill) {
    return {
      ok: false,
      error: `Install of "${parsed.name}" failed to read back`,
    };
  }
  return { ok: true, skill };
}

export function deleteSkill(name: string): boolean {
  // Reject names that fail validation (e.g. "../escape") before they
  // are turned into a filesystem path — guards against path traversal.
  if (validateSkillName(name)) return false;
  const dir = skillDir(name);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function formatSkill(skill: Skill): string {
  const updated = skill.updatedAt
    ? new Date(skill.updatedAt).toISOString().slice(0, 10)
    : "unknown";
  const state = skill.enabled ? "" : " [disabled]";
  return `- ${skill.name} (updated ${updated})${state} — ${skill.description}`;
}

export function formatSkillSearchResult(result: SkillSearchResult): string {
  const base = `${formatSkill(result.skill)} (score ${result.score})`;
  if (!result.snippet) return base;
  return `${base}\n  ${result.snippet}`;
}

export function renderSkillsPrompt(): string {
  // Disabled skills stay out of the index; `list_skills` still shows them.
  const skills = listSkills().filter((skill) => skill.enabled);
  if (skills.length === 0) return "";
  const visible = skills.slice(0, PROMPT_LIST_LIMIT);
  const hidden = skills.length - visible.length;
  const lines = [
    "## Available Skills",
    "",
    "Skills are reusable workflow bundles (a `SKILL.md` per skill folder, optionally with bundled supporting files). Use `find_skills` when the relevant workflow is not obvious, then load the full body with `read_skill` before following one; do not guess from the description alone.",
    "",
    ...visible.map(formatSkill),
  ];
  if (hidden > 0) {
    lines.push(`- ... ${hidden} more hidden; use list_skills`);
  }
  return lines.join("\n");
}
