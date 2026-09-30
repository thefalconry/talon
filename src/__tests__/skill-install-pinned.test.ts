/**
 * `talon skill install <repo>#<sha>` / `--commit <sha>` (#1049): the skill
 * comes from the requested commit, and its folder records where from.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

let workspaceDir: string;
vi.mock("../util/paths.js", async () => {
  const real =
    await vi.importActual<typeof import("../util/paths.js")>(
      "../util/paths.js",
    );
  return {
    ...real,
    dirs: new Proxy(real.dirs, {
      get(target, prop: string) {
        if (prop === "workspace") return workspaceDir;
        if (prop === "skills") return join(workspaceDir, "skills");
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import { runSkillCommand } from "../cli/skill.js";
import { readSkill } from "../storage/skills.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function skillFile(description: string): string {
  return `---\nname: pinme\ndescription: ${description}\n---\n\nDo the thing.\n`;
}

/** A bare `.git` repo whose skill changed between two commits. */
function repoWithHistory(): { url: string; first: string } {
  const repo = mkdtempSync(join(tmpdir(), "skill-pin-src-"));
  git(repo, "init", "-q");
  writeFileSync(join(repo, "SKILL.md"), skillFile("The first version"));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  const first = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "SKILL.md"), skillFile("The second version"));
  git(repo, "commit", "-q", "-am", "second");
  const bare = `${repo}-bare.git`;
  git(tmpdir(), "clone", "-q", "--bare", repo, bare);
  return { url: `file://${bare}`, first };
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "skill-pin-ws-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function installRecord(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(workspaceDir, "skills", "pinme", ".talon-install.json"),
      "utf8",
    ),
  );
}

describe("talon skill install at a commit", () => {
  it("installs <url>#<sha> from that commit and records it", async () => {
    const { url, first } = repoWithHistory();
    await runSkillCommand(["install", `${url}#${first.slice(0, 10)}`]);
    expect(process.exitCode).toBeUndefined();
    const skill = readSkill("pinme");
    expect(skill?.description).toBe("The first version");
    expect(installRecord()).toMatchObject({
      source: url,
      commit: first,
      pinned: true,
    });
    // Provenance is metadata, not a resource the skill offers.
    expect(JSON.stringify(skill)).not.toContain(".talon-install.json");
  });

  it("takes --commit before or after the source", async () => {
    const { url, first } = repoWithHistory();
    await runSkillCommand(["install", "--commit", first, url]);
    expect(readSkill("pinme")?.description).toBe("The first version");
    await runSkillCommand(["install", url, "--force"]);
    expect(readSkill("pinme")?.description).toBe("The second version");
    expect(installRecord().pinned).toBeUndefined();
  });

  it("refuses a malformed commit without cloning", async () => {
    const { url } = repoWithHistory();
    await runSkillCommand(["install", url, "--commit", "main"]);
    expect(process.exitCode).toBe(1);
    expect(readSkill("pinme")).toBeUndefined();
  });
});
