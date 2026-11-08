/**
 * Runtime writes to config.json.
 *
 * The daemon changes its own config in a few places — settings sync and
 * plugin toggles over the bridge, Claude accounts added or removed from
 * /auth — and every one of them merges a patch into the file rather than
 * re-serialising the live config: the live object carries defaults the
 * operator never wrote, and those must not appear in their file.
 *
 * An existing file that can't be read or isn't a JSON object throws and
 * is left untouched: merging into `{}` would replace the operator's whole
 * config (tokens included) with just the patch.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { files as pathFiles } from "../../util/paths.js";
import { TalonError } from "../errors.js";

/** config.json as written on disk; `{}` when there is no file yet. */
export function readConfigRecord(): Record<string, unknown> {
  const file = pathFiles.config;
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new TalonError(
      `Cannot use ${file}: the existing file is unreadable ` +
        `(${err instanceof Error ? err.message : err}). It was left untouched.`,
      { reason: "bad_request", cause: err },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TalonError(
      `Cannot use ${file}: the top level is not a JSON object. ` +
        `It was left untouched.`,
      { reason: "bad_request" },
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Merge a partial update into config.json, preserving everything else.
 * A key set to `undefined` is removed.
 */
export function persistConfigPatch(update: Record<string, unknown>): void {
  const file = pathFiles.config;
  const current = readConfigRecord();
  for (const [k, v] of Object.entries(update)) {
    if (v === undefined) delete current[k];
    else current[k] = v;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic.sync(file, JSON.stringify(current, null, 2) + "\n");
}
