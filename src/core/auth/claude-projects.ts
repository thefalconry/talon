/**
 * One transcript store for every Claude account.
 *
 * The Claude CLI keeps session transcripts in `<config dir>/projects`, and
 * resumes a session by looking its id up there. Talon stores one session
 * id per chat, so for a chat to keep its conversation when it is switched
 * from `claude` to `claude-2` (or back), both accounts must read the same
 * `projects` directory. Each extra account's `projects` is therefore a
 * symlink to the default account's; everything else in its config dir —
 * above all `.credentials.json` — stays its own.
 *
 * The link is made when it is absent. A real directory already sitting
 * there (the account was used directly, outside Talon) is left alone with a
 * warning: moving someone's transcripts is not this module's call, and
 * `talon doctor` keeps reporting it until the operator decides.
 */

import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { log, logWarn } from "../../util/log.js";

type ProjectsLinkState =
  /** `projects` is a symlink to the default account's store. */
  | "linked"
  /** Nothing there yet — init will create the link. */
  | "missing"
  /** A symlink, but to somewhere else. */
  | "foreign-link"
  /** A real directory: this account keeps transcripts of its own. */
  | "separate";

export interface ProjectsLinkReport {
  state: ProjectsLinkState;
  /** `<account dir>/projects`. */
  path: string;
  /** The default account's `projects`, which the link should point at. */
  target: string;
  /** Where a foreign link points. */
  pointsAt?: string;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Read-only: what `<accountDir>/projects` is right now. */
export async function inspectProjectsLink(
  accountDir: string,
  defaultDir: string,
): Promise<ProjectsLinkReport> {
  const path = join(accountDir, "projects");
  const target = join(defaultDir, "projects");
  let stats;
  try {
    stats = await lstat(path);
  } catch (err) {
    if (errCode(err) === "ENOENT") return { state: "missing", path, target };
    throw err;
  }
  if (!stats.isSymbolicLink()) return { state: "separate", path, target };
  const raw = await readlink(path);
  const pointsAt = resolve(dirname(path), raw);
  return pointsAt === resolve(target)
    ? { state: "linked", path, target }
    : { state: "foreign-link", path, target, pointsAt };
}

/**
 * Make sure `<accountDir>/projects` resolves to the default account's
 * transcript store, creating the account dir, the default store and the
 * link as needed. Never replaces anything that already exists.
 */
export async function ensureSharedProjects(
  accountDir: string,
  defaultDir: string,
  label = accountDir,
): Promise<ProjectsLinkReport> {
  // Credentials land in here: keep it private like ~/.claude.
  await mkdir(accountDir, { recursive: true, mode: 0o700 });
  const report = await inspectProjectsLink(accountDir, defaultDir);
  if (report.state === "missing") {
    await mkdir(report.target, { recursive: true, mode: 0o700 });
    await symlink(
      report.target,
      report.path,
      process.platform === "win32" ? "junction" : "dir",
    );
    log("bot", `${label}: projects → ${report.target} (shared transcripts)`);
    return { ...report, state: "linked" };
  }
  if (report.state === "separate") {
    logWarn(
      "bot",
      `${label}: ${report.path} is a real directory, not a link to ${report.target} — ` +
        `left alone, but chats switched to this account start fresh sessions. ` +
        `Move its contents into ${report.target} and remove it to share sessions.`,
    );
  } else if (report.state === "foreign-link") {
    logWarn(
      "bot",
      `${label}: ${report.path} links to ${report.pointsAt}, not ${report.target} — ` +
        `left alone; sessions won't carry across accounts until it points there.`,
    );
  }
  return report;
}
