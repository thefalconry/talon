/**
 * Script store — reusable, agent-authored scripts.
 *
 * A script is a procedure the agent worked out once and saved for
 * reuse: an API call chain, a report generator, a data transform.
 * Unlike triggers (long-running watchers that wake the agent), a
 * script is run-to-completion on demand via the `run_script` tool and
 * its output is returned to the calling turn — local execution, zero
 * inference cost.
 *
 * Scripts are global capabilities, not chat data: any chat can run a
 * script saved in another. Metadata lives in SQLite (see
 * repositories/scripts-repo.ts); the script body lives on disk at
 * ~/.talon/workspace/scripts/<name>.<ext> so the agent can also Read
 * and Edit a script like a normal workspace file (the workspace
 * listing in the system prompt makes the directory discoverable).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { logWarn } from "../util/log.js";
import { dirs } from "../util/paths.js";
import * as repo from "./repositories/scripts-repo.js";

export type { Script, ScriptLanguage } from "./repositories/scripts-repo.js";
import type { Script, ScriptLanguage } from "./repositories/scripts-repo.js";

const SCRIPT_LANGUAGES: readonly ScriptLanguage[] = ["bash", "python", "node"];

/**
 * Stricter than the trigger name rule: a script name doubles as its
 * script filename, so no spaces or dots.
 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SCRIPT_MAX_BYTES = 64 * 1024;
const DESCRIPTION_MAX_CHARS = 300;

const EXTENSIONS: Record<ScriptLanguage, string> = {
  bash: "sh",
  python: "py",
  // .mjs so agent-written ESM runs as-is — the scripts dir has no
  // package.json, so a bare .js would default to CommonJS.
  node: "mjs",
};

// ── Validation ──────────────────────────────────────────────────────────────

export function validateScriptLanguage(
  value: unknown,
): value is ScriptLanguage {
  return (
    typeof value === "string" &&
    (SCRIPT_LANGUAGES as readonly string[]).includes(value)
  );
}

export function validateScriptName(name: string): string | null {
  if (!name) return "Missing name";
  if (!NAME_RE.test(name))
    return "Name must be 1-64 chars of letters, digits, dash, underscore (it becomes the script filename)";
  return null;
}

export function validateScriptBody(script: string): string | null {
  if (!script || !script.trim()) return "Missing script body";
  if (Buffer.byteLength(script, "utf-8") > SCRIPT_MAX_BYTES)
    return `Script too large (max ${SCRIPT_MAX_BYTES} bytes)`;
  return null;
}

export function validateScriptDescription(description: string): string | null {
  if (!description || !description.trim()) return "Missing description";
  if (description.length > DESCRIPTION_MAX_CHARS)
    return `Description too long (max ${DESCRIPTION_MAX_CHARS} chars)`;
  return null;
}

// ── Script files ────────────────────────────────────────────────────────────

function scriptsDir(): string {
  return dirs.scripts;
}

function scriptFilePath(name: string, lang: ScriptLanguage): string {
  return resolve(scriptsDir(), `${name}.${EXTENSIONS[lang]}`);
}

/** Write a script's body, creating the scripts dir as needed. */
function writeScriptFile(
  name: string,
  lang: ScriptLanguage,
  body: string,
): string {
  const path = scriptFilePath(name, lang);
  mkdirSync(dirname(path), { recursive: true });
  // 0o700: only the user running Talon should be able to read/exec scripts.
  // Atomic: a failed replace (ENOSPC) must keep the previous body.
  writeFileAtomic.sync(path, body, { encoding: "utf-8", mode: 0o700 });
  return path;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

function generateScriptId(): string {
  return `script_${randomUUID()}`;
}

/**
 * Create or replace a script: writes the script file, then upserts the
 * metadata row. On replace, the previous script file is removed first
 * when the language (and therefore extension) changed.
 */
export function saveScript(input: {
  name: string;
  description: string;
  language: ScriptLanguage;
  script: string;
}): Script {
  const existing = repo.getByName(input.name);
  if (existing && existing.language !== input.language) {
    removeScriptFile(existing.scriptPath, input.name);
  }
  const scriptPath = writeScriptFile(input.name, input.language, input.script);
  const now = Date.now();
  const script: Script = {
    id: existing?.id ?? generateScriptId(),
    name: input.name,
    description: input.description,
    language: input.language,
    scriptPath,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    useCount: existing?.useCount ?? 0,
    lastUsedAt: existing?.lastUsedAt,
  };
  repo.upsert(script);
  return script;
}

export function getScript(name: string): Script | undefined {
  return repo.getByName(name);
}

export function getAllScripts(): Script[] {
  return repo.all();
}

export function recordScriptUse(name: string): void {
  repo.recordUse(name, Date.now());
}

/** Delete a script and best-effort clean up its on-disk file. */
/**
 * Best-effort unlink. `force` already absorbs a missing file, so any
 * throw here is a real fault (permissions, a directory in the way) that
 * leaves an orphan script on disk.
 */
function removeScriptFile(path: string, name: string): void {
  try {
    rmSync(path, { force: true });
  } catch (err) {
    logWarn(
      "scripts",
      `Could not remove script file name=${name} path=${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function deleteScript(name: string): boolean {
  const script = repo.getByName(name);
  if (!script) return false;
  repo.removeByName(name);
  removeScriptFile(script.scriptPath, name);
  return true;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** One-line listing entry shared by `list_scripts` and prompt surfaces. */
export function formatScript(script: Script): string {
  const used =
    script.useCount > 0
      ? `used ${script.useCount}×${script.lastUsedAt ? `, last ${new Date(script.lastUsedAt).toISOString().slice(0, 10)}` : ""}`
      : "never used";
  return `- ${script.name} (${script.language}, ${used}) — ${script.description}`;
}
