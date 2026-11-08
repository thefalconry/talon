/**
 * Replacing a skill or script on a full disk must fail without losing the
 * version already saved. Each write primitive is given its real ENOSPC
 * behaviour: a plain write truncates the target and leaves the bytes it
 * got out; an atomic write leaves the target alone (its temp file is
 * never renamed into place).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
        if (prop === "scripts") return join(workspaceDir, "scripts");
        return target[prop as keyof typeof target];
      },
    }),
  };
});

const disk = vi.hoisted(() => ({ full: false }));
const enospc = () =>
  Object.assign(new Error("ENOSPC: no space left on device"), {
    code: "ENOSPC",
  });

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFileSync = ((p: string, data: string, ...rest: unknown[]) => {
    if (!disk.full) {
      return (actual.writeFileSync as (...a: unknown[]) => void)(
        p,
        data,
        ...rest,
      );
    }
    actual.writeFileSync(p, String(data).slice(0, 8));
    throw enospc();
  }) as typeof actual.writeFileSync;
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

vi.mock("write-file-atomic", async (importOriginal) => {
  const { default: real } = await importOriginal<{
    default: typeof import("write-file-atomic");
  }>();
  const sync = ((...a: Parameters<typeof real.sync>) => {
    if (disk.full) throw enospc();
    return real.sync(...a);
  }) as typeof real.sync;
  return {
    default: Object.assign(
      (...a: Parameters<typeof real>) => real(...a),
      real,
      { sync },
    ),
  };
});

import { readSkill, saveSkill } from "../storage/skills.js";
import { getScript, saveScript } from "../storage/scripts.js";

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "talon-overwrite-enospc-"));
});

afterEach(() => {
  disk.full = false;
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("overwrite on a full disk", () => {
  it("keeps the previous SKILL.md when the replacement cannot be written", () => {
    const v1 = "## Steps\n\n1. The original, working workflow.";
    saveSkill({ name: "deploy", description: "ship it", body: v1 });

    disk.full = true;
    expect(() =>
      saveSkill({ name: "deploy", description: "ship it", body: "## v2" }),
    ).toThrow(/ENOSPC/);
    disk.full = false;

    expect(readSkill("deploy")?.body.trim()).toBe(v1);
  });

  it("keeps the previous script body when the replacement cannot be written", () => {
    const v1 = "#!/bin/sh\necho the original, working script\n";
    saveScript({
      name: "backup-db",
      description: "nightly dump",
      language: "bash",
      script: v1,
    });

    disk.full = true;
    expect(() =>
      saveScript({
        name: "backup-db",
        description: "nightly dump",
        language: "bash",
        script: "#!/bin/sh\necho v2\n",
      }),
    ).toThrow(/ENOSPC/);
    disk.full = false;

    const saved = getScript("backup-db");
    expect(saved).toBeDefined();
    expect(readFileSync(saved!.scriptPath, "utf-8")).toBe(v1);
  });
});
