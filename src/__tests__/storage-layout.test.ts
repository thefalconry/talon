/**
 * Storage layout at boot (core/layout): the container persistence check
 * and the Claude transcript relink after a Talon-home move. Mount tables
 * are fed in as text; the relink runs against real tmpdir trees.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  classifyMount,
  mountFor,
  parseMountInfo,
  persistenceOf,
  type MountEntry,
} from "../core/layout/mounts.js";
import {
  describeFindings,
  findEphemeralStores,
  inContainer,
} from "../core/layout/persistence.js";
import {
  mergeCopy,
  relinkClaudeProjects,
} from "../core/layout/claude-relink.js";
import {
  checkContainerStorage,
  relinkAfterHomeMove,
} from "../core/layout/index.js";
import { claudeProjectSlug } from "../core/backup/sources/sessions.js";

// POSIX-only: Windows has no signals/mountinfo semantics these tests rely on.
const isWin = process.platform === "win32";

// Paths under a root that does not exist, so resolveExisting never
// follows a real directory on the test host.
const R = "/nonexistent-talon-layout-test";

function mountinfo(
  lines: [mountPoint: string, root: string, fsType: string][],
): string {
  return lines
    .map(
      ([mp, root, fs], i) =>
        `${100 + i} 1 0:${i} ${root} ${mp} rw,relatime shared:1 - ${fs} src${i} rw`,
    )
    .join("\n");
}

const ROOT_OVERLAY: [string, string, string] = ["/", "/", "overlay"];

describe("parseMountInfo", () => {
  it("reads root, mount point and fstype past the optional fields", () => {
    const [m] = parseMountInfo(
      "36 35 98:0 /mnt1 /mnt/parent rw,noatime master:1 shared:2 - ext3 /dev/root rw\n",
    );
    expect(m).toEqual({
      root: "/mnt1",
      mountPoint: "/mnt/parent",
      fsType: "ext3",
      source: "/dev/root",
    });
  });

  it("decodes octal escapes and skips malformed lines", () => {
    const mounts = parseMountInfo(
      "garbage\n1 0 0:1 / /my\\040data rw - ext4 /dev/sda rw\n",
    );
    expect(mounts).toHaveLength(1);
    expect(mounts[0].mountPoint).toBe("/my data");
  });
});

describe("mountFor / classifyMount", () => {
  const mounts = parseMountInfo(
    mountinfo([
      ROOT_OVERLAY,
      [`${R}/data`, "/srv/talon", "ext4"],
      [`${R}/data/tmp`, "/", "tmpfs"],
      [`${R}/anon`, `/var/lib/docker/volumes/${"a".repeat(64)}/_data`, "ext4"],
      [`${R}/named`, "/var/lib/docker/volumes/talon-data/_data", "ext4"],
    ]),
  );

  it("picks the longest covering mount point", () => {
    expect(mountFor(`${R}/data/.claude`, mounts)?.root).toBe("/srv/talon");
    expect(mountFor(`${R}/data/tmp/x`, mounts)?.fsType).toBe("tmpfs");
    expect(mountFor(`${R}/database`, mounts)?.mountPoint).toBe("/");
  });

  it("lets a later mount on the same point shadow an earlier one", () => {
    const shadowed = parseMountInfo(
      mountinfo([
        ROOT_OVERLAY,
        [`${R}/x`, "/first", "ext4"],
        [`${R}/x`, "/second", "ext4"],
      ]),
    );
    expect(mountFor(`${R}/x/y`, shadowed)?.root).toBe("/second");
  });

  it("classifies root, tmpfs, anonymous and named volumes", () => {
    const at = (p: string) => classifyMount(mountFor(p, mounts));
    expect(at(`${R}/home/bun/.claude`)).toBe("ephemeral");
    expect(at(`${R}/data/tmp/x`)).toBe("ephemeral");
    expect(at(`${R}/anon/x`)).toBe("anonymous");
    expect(at(`${R}/named/x`)).toBe("persistent");
    expect(at(`${R}/data/.codex`)).toBe("persistent");
    expect(classifyMount(undefined)).toBe("ephemeral");
  });
});

describe("persistenceOf", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "talon-layout-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(isWin)("follows a symlink onto a volume", () => {
    mkdirSync(join(dir, "vol", ".claude"), { recursive: true });
    mkdirSync(join(dir, "home"));
    symlinkSync(join(dir, "vol", ".claude"), join(dir, "home", ".claude"));
    const mounts = parseMountInfo(
      mountinfo([ROOT_OVERLAY, [join(dir, "vol"), "/host/vol", "ext4"]]),
    );
    expect(persistenceOf(join(dir, "home", ".claude"), mounts)).toBe(
      "persistent",
    );
    expect(persistenceOf(join(dir, "home", ".codex"), mounts)).toBe(
      "ephemeral",
    );
  });
});

describe("findEphemeralStores", () => {
  const config = { backend: "claude", enabledBackends: ["codex"] };

  it.skipIf(isWin)("is clean when HOME is the single data volume", () => {
    const mounts = parseMountInfo(
      mountinfo([ROOT_OVERLAY, [`${R}/data`, "/mnt/tank/talon", "zfs"]]),
    );
    expect(
      findEphemeralStores({
        talonHome: `${R}/data/.talon`,
        userHome: `${R}/data`,
        env: {},
        config,
        mounts,
      }),
    ).toEqual([]);
  });

  it.skipIf(isWin)(
    "lists every unmapped store of the old layout, and only enabled backends",
    () => {
      // Old compose: ~/.talon and ~/.claude mapped, nothing else.
      const mounts = parseMountInfo(
        mountinfo([
          ROOT_OVERLAY,
          [`${R}/home/bun/.talon`, "/host/.talon", "ext4"],
          [`${R}/home/bun/.claude`, "/host/.claude", "ext4"],
        ]),
      );
      const findings = findEphemeralStores({
        talonHome: `${R}/home/bun/.talon`,
        userHome: `${R}/home/bun`,
        env: {},
        config,
        mounts,
      });
      expect(findings.map((f) => f.path)).toEqual([
        `${R}/home/bun/.codex`,
        `${R}/home/bun/.claude.json`,
      ]);
      expect(findings.every((f) => f.persistence === "ephemeral")).toBe(true);
    },
  );

  it.skipIf(isWin)(
    "flags a Talon-home-only mapping: the NAS custom-app case",
    () => {
      const mounts = parseMountInfo(
        mountinfo([ROOT_OVERLAY, [`${R}/data/.talon`, "/mnt/talon", "zfs"]]),
      );
      const findings = findEphemeralStores({
        talonHome: `${R}/data/.talon`,
        userHome: `${R}/data`,
        env: {},
        config: { backend: "opencode" },
        mounts,
      });
      expect(findings.map((f) => f.path)).toEqual([
        `${R}/data/.claude`,
        `${R}/data/.local/share/opencode`,
        `${R}/data/.claude.json`,
      ]);
      const text = describeFindings(findings, { TALON_LAYOUT: "legacy" });
      expect(text).toContain(`${R}/data/.claude: Claude Code transcripts`);
      expect(text).toContain("HOME=/data");
      expect(text).toContain("old /home/bun layout");
    },
  );

  it("claims nothing without a mount table", () => {
    expect(
      findEphemeralStores({
        talonHome: "/x/.talon",
        userHome: "/x",
        env: {},
        config: {},
        mounts: [],
      }),
    ).toEqual([]);
  });
});

describe("inContainer / checkContainerStorage", () => {
  const legacyMounts: MountEntry[] = parseMountInfo(
    mountinfo([ROOT_OVERLAY, [`${R}/home/bun/.talon`, "/host/.talon", "ext4"]]),
  );
  const base = {
    talonHome: `${R}/home/bun/.talon`,
    userHome: `${R}/home/bun`,
    config: {},
    mounts: legacyMounts,
  };

  it("detects a container by env or marker file", () => {
    expect(inContainer({ TALON_CONTAINER: "1" }, () => false)).toBe(true);
    expect(inContainer({}, (p) => p === "/.dockerenv")).toBe(true);
    expect(inContainer({}, (p) => p === "/run/.containerenv")).toBe(true);
    expect(inContainer({}, () => false)).toBe(false);
  });

  it.skipIf(isWin)("raises one error alert naming each path", () => {
    const raise = vi.fn();
    const findings = checkContainerStorage({
      ...base,
      env: {},
      container: true,
      raise,
    });
    expect(findings.map((f) => f.path)).toEqual([
      `${R}/home/bun/.claude`,
      `${R}/home/bun/.claude.json`,
    ]);
    expect(raise).toHaveBeenCalledTimes(1);
    const [key, text, opts] = raise.mock.calls[0];
    expect(key).toBe("storage.ephemeral");
    expect(text).toContain(`${R}/home/bun/.claude:`);
    expect(opts).toEqual({ severity: "error" });
  });

  it.skipIf(isWin)(
    "only warns when Claude's account file is all that's at risk",
    () => {
      const raise = vi.fn();
      checkContainerStorage({
        ...base,
        mounts: parseMountInfo(
          mountinfo([
            ROOT_OVERLAY,
            [`${R}/home/bun/.talon`, "/h/.talon", "ext4"],
            [`${R}/home/bun/.claude`, "/h/.claude", "ext4"],
          ]),
        ),
        env: {},
        container: true,
        raise,
      });
      expect(raise.mock.calls[0][2]).toEqual({ severity: "warn" });
    },
  );

  it("does nothing outside a container or when switched off", () => {
    const raise = vi.fn();
    expect(
      checkContainerStorage({ ...base, env: {}, container: false, raise }),
    ).toEqual([]);
    expect(
      checkContainerStorage({
        ...base,
        env: { TALON_STORAGE_CHECK: "0" },
        container: true,
        raise,
      }),
    ).toEqual([]);
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("Claude transcript relink", () => {
  let dir: string;
  let projects: string;
  const OLD = "/home/bun/.talon";
  const NEW = "/data/.talon";
  const oldSlug = claudeProjectSlug(`${OLD}/workspace`);
  const newSlug = claudeProjectSlug(`${NEW}/workspace`);

  function write(rel: string, body: string): void {
    const path = join(projects, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "talon-relink-"));
    projects = join(dir, ".claude", "projects");
    mkdirSync(projects, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("slugs differ between the layouts (the bug this guards)", () => {
    expect(oldSlug).toBe("-home-bun--talon-workspace");
    expect(newSlug).toBe("-data--talon-workspace");
  });

  it("copies old-slug transcripts under the new slug and keeps the originals", async () => {
    write(`${oldSlug}/s1.jsonl`, "old-1");
    write(`${oldSlug}/s1/subagents/a.jsonl`, "sub");
    write(`${oldSlug}-sub/s2.jsonl`, "subdir-cwd");
    write(`${claudeProjectSlug(OLD)}-agent-workspace/s3.jsonl`, "agent");
    write(`-home-alice-project/other.jsonl`, "unrelated");
    // Already present under the new slug: must not be overwritten.
    write(`${newSlug}/s1.jsonl`, "new-1");

    const results = await relinkClaudeProjects({
      home: NEW,
      projectsDir: projects,
      previousHomes: [OLD],
    });

    expect(results.map((r) => r.to).sort()).toEqual(
      [
        join(projects, newSlug),
        join(projects, `${newSlug}-sub`),
        join(projects, `${claudeProjectSlug(NEW)}-agent-workspace`),
      ].sort(),
    );
    const read = (rel: string) => readFileSync(join(projects, rel), "utf8");
    expect(read(`${newSlug}/s1.jsonl`)).toBe("new-1");
    expect(read(`${newSlug}/s1/subagents/a.jsonl`)).toBe("sub");
    expect(read(`${newSlug}-sub/s2.jsonl`)).toBe("subdir-cwd");
    expect(read(`${claudeProjectSlug(NEW)}-agent-workspace/s3.jsonl`)).toBe(
      "agent",
    );
    // Originals untouched; unrelated projects untouched.
    expect(read(`${oldSlug}/s1.jsonl`)).toBe("old-1");
    expect(existsSync(join(projects, "-home-alice-project"))).toBe(true);
    // 4 old + the pre-existing new slug + 2 created.
    expect(readdirSync(projects)).toHaveLength(7);
  });

  it("mergeCopy never replaces an existing file", async () => {
    write("a/x", "src");
    write("b/x", "dst");
    write("a/y", "new");
    expect(await mergeCopy(join(projects, "a"), join(projects, "b"))).toBe(1);
    expect(readFileSync(join(projects, "b", "x"), "utf8")).toBe("dst");
    expect(readFileSync(join(projects, "b", "y"), "utf8")).toBe("new");
  });

  it("does nothing when the home has not moved", async () => {
    write(`${newSlug}/s1.jsonl`, "x");
    expect(
      await relinkClaudeProjects({
        home: NEW,
        projectsDir: projects,
        previousHomes: [NEW],
      }),
    ).toEqual([]);
  });

  it("reads the previous home from the state file a copied .talon carries", async () => {
    const stateFile = join(dir, "state.json");
    const home = join(dir, "new-home", ".talon");
    const prev = join(dir, "old-home", ".talon");
    writeFileSync(stateFile, JSON.stringify({ home: prev, merged: [] }));
    const prevSlug = claudeProjectSlug(join(prev, "workspace"));
    write(`${prevSlug}/s.jsonl`, "t");

    const first = await relinkAfterHomeMove({
      home,
      userHome: dir,
      env: {},
      container: false,
      stateFile,
    });
    expect(first).toHaveLength(1);
    expect(first[0].copied).toBe(1);
    const newDir = join(projects, claudeProjectSlug(join(home, "workspace")));
    expect(readFileSync(join(newDir, "s.jsonl"), "utf8")).toBe("t");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state).toEqual({ home, merged: [join(projects, prevSlug)] });

    // Next boot: same home, the old dir is already merged.
    const second = await relinkAfterHomeMove({
      home,
      userHome: dir,
      env: {},
      container: false,
      stateFile,
    });
    expect(second).toEqual([]);
  });

  it("in a container, picks up the image's old /home/bun slug with no state file", async () => {
    write(`${oldSlug}/s.jsonl`, "legacy");
    const stateFile = join(dir, "data", "claude-relink.json");
    const results = await relinkAfterHomeMove({
      home: NEW,
      userHome: dir,
      env: {},
      container: true,
      stateFile,
    });
    expect(results.map((r) => r.to)).toEqual([join(projects, newSlug)]);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).home).toBe(NEW);
    // Outside a container, no guessing: nothing without a recorded home.
    rmSync(stateFile);
    rmSync(join(projects, newSlug), { recursive: true });
    expect(
      await relinkAfterHomeMove({
        home: NEW,
        userHome: dir,
        env: {},
        container: false,
        stateFile,
      }),
    ).toEqual([]);
  });

  it("honours CLAUDE_CONFIG_DIR", async () => {
    const cfg = join(dir, "cfgdir");
    mkdirSync(join(cfg, "projects", oldSlug), { recursive: true });
    writeFileSync(join(cfg, "projects", oldSlug, "s.jsonl"), "c");
    const results = await relinkAfterHomeMove({
      home: NEW,
      userHome: dir,
      env: { CLAUDE_CONFIG_DIR: cfg },
      container: true,
      stateFile: join(dir, "st.json"),
    });
    expect(results.map((r) => r.to)).toEqual([join(cfg, "projects", newSlug)]);
  });
});
