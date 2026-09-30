/**
 * Keep Claude transcripts resumable when the Talon home moves.
 *
 * Claude Code files a session's transcript under
 * `~/.claude/projects/<slug>/`, where the slug IS the absolute cwd with
 * every non-alphanumeric character turned into `-`. Talon's cwd is
 * `<TALON_HOME>/workspace`, so moving the home — `/home/bun/.talon` to
 * `/data/.talon` when a container switches to the single data root, or a
 * new TALON_HOME on a host — changes the slug, and every stored session
 * id then points at a transcript Claude can no longer find.
 *
 * This copies the old slug directories' files under the new slug. It
 * never overwrites a file that already exists there and never moves or
 * deletes the originals: the old directories stay as they were.
 */

import { constants } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { relocateClaudeSlug } from "../backup/sources/relocate.js";
import { claudeProjectSlug, sessionCwds } from "../backup/sources/sessions.js";

export type RelinkResult = {
  /** The old slug directory, left in place. */
  from: string;
  /** The directory the current home's sessions are looked up in. */
  to: string;
  /** Files copied (existing ones are skipped, never replaced). */
  copied: number;
};

function matchesSlugOf(name: string, home: string): boolean {
  return sessionCwds(home)
    .map(claudeProjectSlug)
    .some((slug) => name === slug || name.startsWith(`${slug}-`));
}

/** Copy `src` into `dst` recursively; existing files win. Returns files copied. */
export async function mergeCopy(src: string, dst: string): Promise<number> {
  await mkdir(dst, { recursive: true });
  let copied = 0;
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      copied += await mergeCopy(from, to);
    } else if (entry.isFile()) {
      try {
        await copyFile(from, to, constants.COPYFILE_EXCL);
        copied++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }
  return copied;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Old-slug directories to carry over: every project dir, in any of the
 * `sources` projects directories, that belongs to one of `previousHomes`
 * and not to `home`.
 */
async function findOldSlugDirs(input: {
  home: string;
  previousHomes: readonly string[];
  sources: readonly string[];
}): Promise<{ from: string; name: string; previousHome: string }[]> {
  const found: { from: string; name: string; previousHome: string }[] = [];
  for (const dir of new Set(input.sources)) {
    const names = await listDir(dir);
    for (const previousHome of new Set(input.previousHomes)) {
      if (previousHome === input.home) continue;
      for (const name of names) {
        if (!matchesSlugOf(name, previousHome)) continue;
        if (matchesSlugOf(name, input.home)) continue;
        found.push({ from: join(dir, name), name, previousHome });
      }
    }
  }
  return found;
}

/**
 * Copy transcripts filed under a previous home's slug to the current
 * home's slug. `projectsDir` is where the current Claude looks;
 * `extraSources` are other projects directories to read from (an old
 * `~/.claude` still mounted during a migration). Sources in `skip` were
 * carried over on an earlier boot. A directory that fails to copy is
 * reported through `onError` and left for the next boot.
 */
export async function relinkClaudeProjects(input: {
  home: string;
  projectsDir: string;
  previousHomes: readonly string[];
  extraSources?: readonly string[];
  skip?: ReadonlySet<string>;
  onError?: (from: string, err: unknown) => void;
}): Promise<RelinkResult[]> {
  const olds = await findOldSlugDirs({
    home: input.home,
    previousHomes: input.previousHomes,
    sources: [input.projectsDir, ...(input.extraSources ?? [])],
  });
  const results: RelinkResult[] = [];
  for (const { from, name, previousHome } of olds) {
    if (input.skip?.has(from)) continue;
    const to = join(
      input.projectsDir,
      relocateClaudeSlug(name, previousHome, input.home),
    );
    if (to === from) continue;
    try {
      results.push({ from, to, copied: await mergeCopy(from, to) });
    } catch (err) {
      input.onError?.(from, err);
    }
  }
  return results;
}
