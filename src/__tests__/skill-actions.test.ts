/**
 * Script + skill gateway actions — save/list/run/delete through
 * handleSharedAction, with run_script executing REAL subprocesses
 * (bash + node) against a tmpdir workspace. Validation and store
 * internals are covered by storage-scripts.test.ts / storage-skills.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// Real writes inside the tmp workspace (skills/scripts save through
// write-file-atomic); anything else — config, the real ~/.talon — is a no-op.
vi.mock("write-file-atomic", async () => {
  const real = (await vi.importActual("write-file-atomic")) as {
    default: { sync: (...args: unknown[]) => void };
  };
  return {
    default: {
      sync: vi.fn((path: string, ...rest: unknown[]) => {
        if (!String(path).startsWith(workspaceDir)) return;
        real.default.sync(path, ...rest);
      }),
    },
  };
});

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
        // skills/scripts no longer derive from dirs.workspace at call
        // time — a workspace-only override would silently hit the real
        // ~/.talon/workspace/{skills,scripts}.
        if (prop === "skills") return join(workspaceDir, "skills");
        if (prop === "scripts") return join(workspaceDir, "scripts");
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import { handleSharedAction } from "../core/engine/gateway-actions/index.js";
import type { ActionResult } from "../core/types.js";

const CHAT = 424242;

async function act(body: Record<string, unknown>): Promise<ActionResult> {
  const result = await handleSharedAction(body, CHAT);
  expect(result).not.toBeNull();
  return result!;
}

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "talon-skill-actions-"));
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("save_script", () => {
  it("saves and reports update-vs-create", async () => {
    const first = await act({
      action: "save_script",
      name: "echo-args",
      description: "echoes its args",
      language: "bash",
      script: 'echo "args: $@"',
    });
    expect(first.ok).toBe(true);
    expect(first.text).toContain('Saved script "echo-args"');

    const second = await act({
      action: "save_script",
      name: "echo-args",
      description: "echoes its args (v2)",
      language: "bash",
      script: 'echo "args: $@"',
    });
    expect(second.ok).toBe(true);
    expect(second.text).toContain('Updated script "echo-args"');
  });

  it("rejects bad names, languages, and empty scripts", async () => {
    expect(
      (
        await act({
          action: "save_script",
          name: "bad name",
          description: "x",
          language: "bash",
          script: "true",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await act({
          action: "save_script",
          name: "lua-script",
          description: "x",
          language: "lua",
          script: "print(1)",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await act({
          action: "save_script",
          name: "empty",
          description: "x",
          language: "bash",
          script: "   ",
        })
      ).ok,
    ).toBe(false);
  });
});

describe("run_script", () => {
  it("runs a bash script with args and returns stdout", async () => {
    const result = await act({
      action: "run_script",
      name: "echo-args",
      args: ["alpha", "beta"],
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("exit 0");
    expect(result.text).toContain("args: alpha beta");
  });

  it("runs a node script with cwd set to the workspace", async () => {
    await act({
      action: "save_script",
      name: "node-cwd",
      description: "prints cwd",
      language: "node",
      script: "console.log(process.cwd())",
    });
    const result = await act({ action: "run_script", name: "node-cwd" });
    expect(result.ok).toBe(true);
    // realpath vs symlinked tmpdir (macOS /var → /private/var): match the leaf
    expect(result.text).toContain("talon-skill-actions-");
  });

  it("surfaces non-zero exits as errors with stderr", async () => {
    await act({
      action: "save_script",
      name: "fails",
      description: "always fails",
      language: "bash",
      script: 'echo "boom" >&2; exit 3',
    });
    const result = await act({ action: "run_script", name: "fails" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exit 3");
    expect(result.error).toContain("boom");
  });

  it("kills runaway scripts at the timeout", async () => {
    await act({
      action: "save_script",
      name: "sleeper",
      description: "sleeps forever",
      language: "bash",
      script: "sleep 60",
    });
    const result = await act({
      action: "run_script",
      name: "sleeper",
      timeout_seconds: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("TIMED OUT");
  }, 15_000);

  it("rejects unknown scripts and bad timeouts", async () => {
    const missing = await act({ action: "run_script", name: "nope" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("list_scripts");

    const badTimeout = await act({
      action: "run_script",
      name: "echo-args",
      timeout_seconds: 9999,
    });
    expect(badTimeout.ok).toBe(false);
    expect(badTimeout.error).toContain("max");
  });
});

describe("list_scripts / delete_script", () => {
  it("lists saved scripts with descriptions", async () => {
    const result = await act({ action: "list_scripts" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("echo-args");
    expect(result.text).toContain("echoes its args (v2)");
  });

  it("deletes and refuses unknowns", async () => {
    expect((await act({ action: "delete_script", name: "fails" })).ok).toBe(
      true,
    );
    expect((await act({ action: "delete_script", name: "fails" })).ok).toBe(
      false,
    );
  });
});

describe("skills", () => {
  it("saves, lists, reads, updates, and deletes markdown workflow skills", async () => {
    const saved = await act({
      action: "save_skill",
      name: "review-flow",
      description: "review pull requests carefully",
      body: "## Steps\n\n1. Read the diff.\n2. Check tests.",
    });
    expect(saved.ok).toBe(true);
    expect(saved.text).toContain('Saved skill "review-flow"');

    const listed = await act({ action: "list_skills" });
    expect(listed.ok).toBe(true);
    expect(listed.text).toContain("review-flow");
    expect(listed.text).toContain("review pull requests carefully");

    const found = await act({
      action: "find_skills",
      query: "pull request tests",
    });
    expect(found.ok).toBe(true);
    expect(found.text).toContain("review-flow");
    expect(found.text).toContain("score");

    const read = await act({
      action: "read_skill",
      name: "review-flow",
    });
    expect(read.ok).toBe(true);
    expect(read.text).toContain("# review-flow");
    expect(read.text).toContain("Check tests");

    const updated = await act({
      action: "save_skill",
      name: "review-flow",
      description: "review pull requests with tests",
      body: "## Steps\n\nUse the review skill.",
    });
    expect(updated.ok).toBe(true);
    expect(updated.text).toContain('Updated skill "review-flow"');

    expect(
      (await act({ action: "delete_skill", name: "review-flow" })).ok,
    ).toBe(true);
    const missing = await act({
      action: "read_skill",
      name: "review-flow",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("list_skills");
  });

  it("rejects invalid skill inputs", async () => {
    expect(
      (
        await act({
          action: "save_skill",
          name: "bad name",
          description: "x",
          body: "## Body",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await act({
          action: "save_skill",
          name: "empty-body",
          description: "x",
          body: "   ",
        })
      ).ok,
    ).toBe(false);
    expect((await act({ action: "find_skills", query: "" })).ok).toBe(false);
  });
});
