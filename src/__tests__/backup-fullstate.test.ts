/**
 * Full-state snapshots — everything a 1:1 restore or a clone needs.
 *
 * A snapshot that carries the database but not the session transcripts
 * restores every chat to a session id that points at nothing. These cases
 * pin what now travels: backend session stores (Claude projects for the
 * Talon cwds, Codex rollouts, a live OpenCode SQLite store copied through
 * SQLite), traces, plugin checkouts without their build output, and a
 * plugins manifest a clone reinstalls from. Everything runs against a
 * scratch "user home" — the operator's real ~/.claude, ~/.codex and
 * ~/.talon are never looked at.
 */

import { describe, it, expect } from "vitest";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { buildSnapshot } from "../core/backup/snapshot.js";
import { restoreSnapshot } from "../core/backup/restore.js";
import { extractTar } from "../core/backup/archive/tar.js";
import { createDecompressor } from "../core/backup/archive/zstd.js";
import { resolveBackupSettings, excludeForRoot } from "../core/backup/plan.js";
import { partPath } from "../core/backup/store.js";
import {
  claudeProjectSlug,
  discoverSessionRoots,
} from "../core/backup/sources/sessions.js";
import {
  relocateClaudeSlug,
  relocateRoot,
  rewriteConfigForClone,
} from "../core/backup/sources/relocate.js";
import { snapshotSqliteFile } from "../storage/backup/index.js";
import type { Manifest } from "../core/backup/types.js";

const SETTINGS = resolveBackupSettings({ includePalace: false });
const copyDatabase = (dest: string) =>
  writeFileSync(dest, "SQLite format 3\0snapshot");

type Machine = { root: string; home: string; userHome: string };

function write(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function sqliteStore(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE session (id TEXT, body TEXT)");
  db.exec("INSERT INTO session VALUES ('s1', 'hello')");
  db.close();
}

/** A Talon home plus a fake user home holding every backend's store. */
function machine(): Machine {
  const root = mkdtempSync(join(tmpdir(), "talon-fullstate-"));
  const home = join(root, "user", ".talon");
  const userHome = join(root, "user");
  const plugin = join(userHome, "code", "local-plugin");
  write(
    join(home, "config.json"),
    JSON.stringify({
      enabledBackends: ["claude", "codex", "opencode"],
      plugins: [
        { path: join(plugin, "src") },
        { name: "pinned", command: "npx", args: ["-y", "@scope/pkg@1.2.3"] },
        { name: "floating", command: "npx", args: ["-y", "other-pkg"] },
        {
          name: "image",
          command: "docker",
          args: ["run", "-i", "--rm", "-e", "A=b", "ghcr.io/x/y:2.0"],
        },
        { name: "py", command: "uvx", args: ["mcp-server-fetch==0.6.2"] },
      ],
    }),
  );
  write(join(home, "workspace", "identity.md"), "I am Talon");
  write(join(home, "workspace", "media", "huge.mp4"), "x".repeat(4096));
  write(join(home, "workspace", "uploads", "photo.jpg"), "jpeg");
  write(join(home, "data", "traces", "chat-1.jsonl"), "trace line");

  write(
    join(plugin, "package.json"),
    '{"name":"local-plugin","version":"0.3.1"}',
  );
  write(join(plugin, "package-lock.json"), "{}");
  write(join(plugin, "src", "index.ts"), "export {}");
  write(join(plugin, "node_modules", "dep", "index.js"), "dep");
  write(join(plugin, "dist", "index.js"), "built");
  write(join(plugin, ".venv", "bin", "python"), "venv");
  write(
    join(
      userHome,
      ".npm",
      "_npx",
      "abc",
      "node_modules",
      "other-pkg",
      "package.json",
    ),
    '{"version":"4.5.6"}',
  );

  const projects = join(userHome, ".claude", "projects");
  const slug = claudeProjectSlug(join(home, "workspace"));
  write(join(projects, slug, "sess-1.jsonl"), '{"type":"user","text":"hi"}\n');
  write(join(projects, `${slug}-products-x`, "sess-2.jsonl"), "{}\n");
  write(join(projects, "-somewhere-else", "private.jsonl"), "not talon\n");
  write(
    join(userHome, ".codex", "sessions", "2026", "09", "24", "rollout-a.jsonl"),
    '{"type":"session_meta"}\n',
  );
  sqliteStore(join(userHome, ".local", "share", "opencode", "opencode.db"));
  // Mesh registry + the per-device credential store that authenticates it.
  // Both must survive a disaster-recovery restore, or restored devices are
  // present in the registry but rejected on their next heartbeat.
  write(join(home, "mesh-devices.json"), '{"devices":[]}');
  write(join(home, "mesh-credentials.json"), '{"credentials":[]}');
  return { root, home, userHome };
}

async function members(part: string): Promise<string[]> {
  const entries = await extractTar(
    createReadStream(part).pipe(createDecompressor()),
    mkdtempSync(join(tmpdir(), "talon-fullstate-x-")),
  );
  return entries.map((entry) => entry.path).sort();
}

async function snapshot(m: Machine): Promise<Manifest> {
  return buildSnapshot({
    kind: "backup",
    settings: SETTINGS,
    home: m.home,
    userHome: m.userHome,
    env: {},
    copyDatabase,
  });
}

describe("full-state snapshot contents", () => {
  it("captures session stores, traces, plugins and the manifest — and skips bulk", async () => {
    const m = machine();
    const manifest = await snapshot(m);
    const slug = claudeProjectSlug(join(m.home, "workspace"));

    expect(manifest.parts.map((p) => p.name)).toEqual([
      "state.tar.zst",
      "sessions.tar.zst",
    ]);
    const state = await members(partPath(manifest.id, "state.tar.zst", m.home));
    const sessions = await members(
      partPath(manifest.id, "sessions.tar.zst", m.home),
    );

    // Plugin checkout: code and lockfiles, no install/build output.
    expect(state).toContain("plugin-src/0-local-plugin/package.json");
    expect(state).toContain("plugin-src/0-local-plugin/package-lock.json");
    expect(state).toContain("plugin-src/0-local-plugin/src/index.ts");
    expect(state.some((p) => p.includes("node_modules"))).toBe(false);
    expect(state.some((p) => p.includes("/dist"))).toBe(false);
    expect(state.some((p) => p.includes(".venv"))).toBe(false);
    expect(state).toContain("plugins-manifest.json");

    // Mesh registry AND its credential store — restoring the registry without
    // the credentials would lock every paired device out after a restore.
    expect(state).toContain("mesh-devices.json");
    expect(state).toContain("mesh-credentials.json");

    // Bulk workspace directories stay out by default.
    expect(state.some((p) => p.startsWith("workspace/media"))).toBe(false);
    expect(state.some((p) => p.startsWith("workspace/uploads"))).toBe(false);
    expect(state).toContain("workspace/identity.md");

    // Sessions: the Talon cwds' Claude projects (and subdirectories),
    // not another project's; Codex rollouts; the OpenCode store; traces.
    expect(sessions).toContain(`sessions/claude/${slug}/sess-1.jsonl`);
    expect(sessions).toContain(
      `sessions/claude/${slug}-products-x/sess-2.jsonl`,
    );
    expect(sessions.some((p) => p.includes("somewhere-else"))).toBe(false);
    expect(sessions).toContain(
      "sessions/codex/sessions/2026/09/24/rollout-a.jsonl",
    );
    expect(sessions).toContain("sessions/opencode/opencode.db");
    expect(sessions).toContain("data/traces/chat-1.jsonl");
    expect(state.some((p) => p.startsWith("data/traces"))).toBe(false);

    expect(manifest.origin).toEqual({ userHome: m.userHome, home: m.home });
    expect(manifest.external?.map((r) => r.root)).toEqual([
      "plugin-src/0-local-plugin",
      `sessions/claude/${slug}`,
      `sessions/claude/${slug}-products-x`,
      "sessions/codex/sessions",
      "sessions/opencode/opencode.db",
    ]);
    // No scratch files are left beside the parts.
    expect(
      existsSync(
        join(m.home, "backups", manifest.id, "plugins-manifest.json.tmp"),
      ),
    ).toBe(false);
  });

  it("writes an exact reinstall manifest for fetched plugins", async () => {
    const m = machine();
    const manifest = await snapshot(m);
    const out = mkdtempSync(join(tmpdir(), "talon-fullstate-m-"));
    await extractTar(
      createReadStream(partPath(manifest.id, "state.tar.zst", m.home)).pipe(
        createDecompressor(),
      ),
      out,
    );
    const plugins = JSON.parse(
      readFileSync(join(out, "plugins-manifest.json"), "utf8"),
    ).plugins;
    expect(plugins.map((p: { source: unknown }) => p.source)).toEqual([
      {
        type: "local",
        path: join(m.userHome, "code", "local-plugin", "src"),
        version: "0.3.1",
        archiveRoot: "plugin-src/0-local-plugin",
      },
      { type: "npm", spec: "@scope/pkg@1.2.3", pinned: true },
      { type: "npm", spec: "other-pkg", pinned: false, version: "4.5.6" },
      { type: "docker", image: "ghcr.io/x/y:2.0", pinned: true },
      { type: "python", spec: "mcp-server-fetch==0.6.2", pinned: true },
    ]);
  });

  it("leaves session stores out when includeSessions is off, and of disabled backends", async () => {
    const m = machine();
    const off = await buildSnapshot({
      kind: "backup",
      settings: { ...SETTINGS, includeSessions: false },
      home: m.home,
      userHome: m.userHome,
      env: {},
      copyDatabase,
    });
    expect(off.parts.map((p) => p.name)).toEqual(["state.tar.zst"]);

    const roots = await discoverSessionRoots({
      home: m.home,
      userHome: m.userHome,
      env: {},
      config: { backend: "claude" },
    });
    expect(roots.every((r) => r.root.startsWith("sessions/claude/"))).toBe(
      true,
    );
  });

  it("never looks outside a scratch Talon home unless told which user home to use", async () => {
    const m = machine();
    const manifest = await buildSnapshot({
      kind: "backup",
      settings: SETTINGS,
      home: m.home,
      copyDatabase,
    });
    expect(manifest.external?.some((r) => r.root.startsWith("sessions/"))).toBe(
      false,
    );
    expect(manifest.origin).toBeUndefined();
  });
});

/** Resolves once another process has committed rows to `pair` in `db`. */
async function waitForRows(db: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const probe = new DatabaseSync(db, { readOnly: true });
    try {
      const has = probe
        .prepare("SELECT name FROM sqlite_master WHERE name = 'pair'")
        .get();
      if (has) {
        const row = probe.prepare("SELECT count(*) AS n FROM pair").get() as {
          n: number;
        };
        if (row.n > 0) return;
      }
    } finally {
      probe.close();
    }
    if (Date.now() > deadline) throw new Error("writer never committed");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("consistent copies of a live session database", () => {
  it("copies a WAL database that another process is writing to", async () => {
    const root = mkdtempSync(join(tmpdir(), "talon-fullstate-db-"));
    const db = join(root, "store.db");
    sqliteStore(db);
    // Every transaction inserts two rows, so any consistent copy holds an
    // even number of `pair` rows; a torn byte-wise copy would not be
    // guaranteed to.
    // The writer runs until the test drops a stop file, so the copies are
    // always taken mid-write however slow the runner is (a fixed run time
    // raced the snapshots on Windows).
    const stopFile = join(root, "stop");
    const writer = spawn(
      process.execPath,
      [
        "-e",
        `const { existsSync } = require("node:fs");
         const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(${JSON.stringify(db)});
         db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS pair (n)");
         let i = 0;
         while (!existsSync(${JSON.stringify(stopFile)})) {
           db.exec("BEGIN; INSERT INTO pair VALUES (" + i + "); INSERT INTO pair VALUES (" + i + "); COMMIT");
           i++;
         }
         db.close();`,
      ],
      { stdio: "ignore" },
    );
    // Listen before anything else can let the writer finish unobserved.
    const exited = new Promise((r) => writer.once("exit", r));
    try {
      await waitForRows(db);
      const copies: number[] = [];
      for (let n = 0; n < 5; n++) {
        const dest = join(root, `copy-${n}.db`);
        snapshotSqliteFile(db, dest);
        const copy = new DatabaseSync(dest, { readOnly: true });
        expect(
          (
            copy.prepare("PRAGMA integrity_check").get() as {
              integrity_check: string;
            }
          ).integrity_check,
        ).toBe("ok");
        const hasPair = copy
          .prepare("SELECT name FROM sqlite_master WHERE name = 'pair'")
          .get();
        const count = hasPair
          ? (
              copy.prepare("SELECT count(*) AS n FROM pair").get() as {
                n: number;
              }
            ).n
          : 0;
        copy.close();
        expect(count % 2).toBe(0);
        copies.push(count);
        await new Promise((r) => setTimeout(r, 50));
      }
      // The copies were taken while rows were landing.
      expect(copies.some((n) => n > 0)).toBe(true);
    } finally {
      writeFileSync(stopFile, "");
      await exited;
    }
    // The source database was only read: the writer's rows are all there.
    const source = new DatabaseSync(db, { readOnly: true });
    expect(
      (source.prepare("SELECT count(*) AS n FROM pair").get() as { n: number })
        .n % 2,
    ).toBe(0);
    source.close();
  });
});

describe("restore round-trip", () => {
  it("puts sessions, traces, plugins and the manifest back where they came from", async () => {
    const m = machine();
    const manifest = await snapshot(m);
    const slug = claudeProjectSlug(join(m.home, "workspace"));
    const transcript = join(
      m.userHome,
      ".claude",
      "projects",
      slug,
      "sess-1.jsonl",
    );
    const plugin = join(m.userHome, "code", "local-plugin");
    const opencode = join(
      m.userHome,
      ".local",
      "share",
      "opencode",
      "opencode.db",
    );

    // Drift after the snapshot.
    rmSync(transcript);
    write(join(m.home, "data", "traces", "chat-1.jsonl"), "rewritten");
    write(join(plugin, "src", "index.ts"), "broken edit");
    rmSync(opencode);
    write(`${opencode}-wal`, "stale wal");

    const report = await restoreSnapshot({
      id: manifest.id,
      settings: SETTINGS,
      home: m.home,
      userHome: m.userHome,
      env: {},
      skipCheckpoint: true,
    });

    expect(readFileSync(transcript, "utf8")).toContain('"text":"hi"');
    expect(
      readFileSync(join(m.home, "data", "traces", "chat-1.jsonl"), "utf8"),
    ).toBe("trace line");
    expect(readFileSync(join(plugin, "src", "index.ts"), "utf8")).toBe(
      "export {}",
    );
    // The plugin's install and build output survive a restore of its
    // source: the rules that kept them out also keep them from being
    // cleared.
    expect(existsSync(join(plugin, "node_modules", "dep", "index.js"))).toBe(
      true,
    );
    expect(existsSync(join(plugin, "dist", "index.js"))).toBe(true);
    expect(existsSync(`${opencode}-wal`)).toBe(false);
    const db = new DatabaseSync(opencode, { readOnly: true });
    expect(db.prepare("SELECT body FROM session").get()).toEqual({
      body: "hello",
    });
    db.close();
    expect(existsSync(join(m.home, "plugins-manifest.json"))).toBe(true);
    expect(report.written[`sessions/claude/${slug}`]).toBe(1);
  });

  it("refuses a snapshot from another home without --clone", async () => {
    const m = machine();
    const manifest = await snapshot(m);
    await expect(
      restoreSnapshot({
        id: manifest.id,
        settings: SETTINGS,
        home: m.home,
        userHome: join(m.root, "someone-else"),
        env: {},
        skipCheckpoint: true,
      }),
    ).rejects.toThrow(/--clone/);
  });

  it("clones onto a new user home: relocated stores, re-slugged transcripts, rewritten config", async () => {
    const m = machine();
    const manifest = await snapshot(m);
    // The new machine: a different user home and Talon home, holding
    // nothing but the copied snapshot directory.
    const newUser = join(m.root, "newuser");
    const newHome = join(newUser, ".talon");
    mkdirSync(join(newHome, "backups"), { recursive: true });
    const { cpSync } = await import("node:fs");
    cpSync(
      join(m.home, "backups", manifest.id),
      join(newHome, "backups", manifest.id),
      { recursive: true },
    );

    const report = await restoreSnapshot({
      id: manifest.id,
      settings: SETTINGS,
      home: newHome,
      userHome: newUser,
      env: {},
      clone: true,
      skipCheckpoint: true,
    });

    const newSlug = claudeProjectSlug(join(newHome, "workspace"));
    expect(
      readFileSync(
        join(newUser, ".claude", "projects", newSlug, "sess-1.jsonl"),
        "utf8",
      ),
    ).toContain('"text":"hi"');
    expect(
      existsSync(
        join(
          newUser,
          ".claude",
          "projects",
          `${newSlug}-products-x`,
          "sess-2.jsonl",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          newUser,
          ".codex",
          "sessions",
          "2026",
          "09",
          "24",
          "rollout-a.jsonl",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(join(newUser, "code", "local-plugin", "src", "index.ts")),
    ).toBe(true);
    expect(
      readFileSync(join(newHome, "workspace", "identity.md"), "utf8"),
    ).toBe("I am Talon");
    const config = JSON.parse(
      readFileSync(join(newHome, "config.json"), "utf8"),
    );
    expect(config.plugins[0].path).toBe(
      join(newUser, "code", "local-plugin", "src"),
    );
    expect(report.configRewritten).toBe(true);
  });
});

describe("relocation rules", () => {
  it("re-slugs Claude project names and moves home-relative paths", () => {
    expect(
      relocateClaudeSlug(
        "-a-b--talon-workspace-sub",
        "/a/b/.talon",
        "/c/.talon",
      ),
    ).toBe("-c--talon-workspace-sub");
    expect(relocateClaudeSlug("-unrelated", "/a/b/.talon", "/c/.talon")).toBe(
      "-unrelated",
    );
    const origin = { userHome: "/a/b", home: "/a/b/.talon" };
    const target = { userHome: "/c", home: "/c/.talon", env: {} };
    expect(
      relocateRoot(
        {
          root: "sessions/codex/sessions",
          source: "/a/b/.codex/sessions",
          kind: "session-store",
        },
        origin,
        target,
      ),
    ).toBe(join("/c", ".codex", "sessions"));
    // A path outside the old user home is left as recorded.
    expect(
      relocateRoot(
        { root: "plugin-src/0-x", source: "/opt/x", kind: "plugin" },
        origin,
        target,
      ),
    ).toBe("/opt/x");
  });

  it("rewrites config paths with this platform's absolute form", async () => {
    // Regression: the "is this a path?" gate used to be a leading "/",
    // so on Windows ("C:\\Users\\…") nothing was ever rewritten and a
    // clone silently kept the origin machine's plugin paths.
    const root = mkdtempSync(join(tmpdir(), "talon-reprefix-"));
    const oldUser = join(root, "olduser");
    const newUser = join(root, "newuser");
    const newHome = join(newUser, ".talon");
    mkdirSync(newHome, { recursive: true });
    writeFileSync(
      join(newHome, "config.json"),
      JSON.stringify({
        plugins: [{ path: join(oldUser, "code", "p", "src") }],
        note: "not-a-path",
      }),
    );
    const rewritten = await rewriteConfigForClone(
      { userHome: oldUser, home: join(oldUser, ".talon") },
      { userHome: newUser, home: newHome, env: {} },
    );
    expect(rewritten).toBe(true);
    const config = JSON.parse(
      readFileSync(join(newHome, "config.json"), "utf8"),
    );
    expect(config.plugins[0].path).toBe(join(newUser, "code", "p", "src"));
    expect(config.note).toBe("not-a-path");
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a part's own root exempt from the state-part rules", () => {
    expect(excludeForRoot("data/traces")("data/traces/a.jsonl")).toBe(false);
    expect(excludeForRoot("data")("data/traces/a.jsonl")).toBe(true);
    expect(excludeForRoot("workspace/palace")("workspace/palace/x")).toBe(
      false,
    );
  });
});
