#!/usr/bin/env node
/**
 * scripts/worktree.mjs — git worktrees whose node_modules cost ~0 extra disk.
 *
 * A plain `git worktree add` + `npm ci` costs ~1.2 GB per checkout (half of it
 * the bundled claude and codex binaries). Several agents doing that at once
 * filled the host disk. This script gives every worktree a node_modules made
 * of HARDLINKS (or reflinks, where the filesystem has them) into one shared,
 * read-only store per lockfile:
 *
 *   ~/.cache/talon-node-modules/<lockhash>/node_modules   (built once)
 *   <worktree>/node_modules                               (cp -al of it)
 *
 * Usage:
 *   node scripts/worktree.mjs add <path> <branch> [--base <ref>]
 *       Create the worktree (new branch from --base, default origin/main, or
 *       check out an existing branch) and link its node_modules.
 *   node scripts/worktree.mjs link [dir] [--force]
 *       Materialise <dir>/node_modules (default: cwd's checkout) from the store.
 *   node scripts/worktree.mjs remove <path> [--max-age-days N]
 *       Remove the worktree, then prune the store.
 *   node scripts/worktree.mjs prune [--max-age-days N] [--dry-run]
 *       Drop store entries no worktree uses and not linked for N days (def. 3).
 *   node scripts/worktree.mjs hash [lockfile]
 *       Print the store key for a lockfile.
 *
 * Env: TALON_NM_STORE (store root), TALON_NM_REFERENCE (a checkout whose
 * node_modules may seed the store instead of `npm ci`; default: any worktree
 * of the repo with the same lockfile, main first).
 *
 * Safety. A hardlink shares the inode, so an in-place write through any link
 * changes every copy. Three rules keep the store intact:
 *   1. Store files are chmod a-w: an in-place write fails loudly (EACCES)
 *      instead of silently corrupting other worktrees. Unlinking, renaming
 *      and `rm -rf node_modules` (what `npm ci` does first) still work, as
 *      the directories in each worktree are its own, writable ones.
 *   2. Mutable state is not shared: node_modules/.cache and .vite (vitest,
 *      prettier, babel caches) are never put in the store, and npm's hidden
 *      lockfile node_modules/.package-lock.json is copied, not linked.
 *   3. The store never shares inodes with the reference checkout (prod): it
 *      is seeded by a real copy (reflink when possible), so nothing done in
 *      a worktree can reach the running daemon's dependencies.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** node_modules entries that hold mutable caches — never stored or linked. */
export const MUTABLE_DIRS = [".cache", ".vite", ".vite-temp", ".vitest"];
/** Files copied (not linked) into each worktree because npm rewrites them. */
export const COPIED_FILES = [".package-lock.json"];
const META = "talon-store.json";
const DAY_MS = 86_400_000;

/**
 * Store key: the lockfile plus what makes installed trees differ (native
 * addons and prebuilt binaries depend on platform, arch and Node's major).
 */
export function lockHash(lockText, env = {}) {
  const major = env.nodeMajor ?? process.versions.node.split(".")[0];
  const platform = env.platform ?? process.platform;
  const arch = env.arch ?? process.arch;
  return createHash("sha256")
    .update(`${platform}-${arch}-node${major}\n`)
    .update(lockText)
    .digest("hex")
    .slice(0, 16);
}

export function storeRoot(env = process.env) {
  return env.TALON_NM_STORE || join(homedir(), ".cache", "talon-node-modules");
}

/**
 * Which store entries to delete: those no live worktree uses whose last link
 * is older than maxAgeMs. Pure — the CLI feeds it the filesystem.
 */
export function planPrune(entries, inUse, now, maxAgeMs) {
  return entries
    .filter((e) => !inUse.has(e.hash) && now - e.lastUsedMs >= maxAgeMs)
    .map((e) => e.hash);
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function log(msg) {
  process.stderr.write(`worktree: ${msg}\n`);
}

/** Worktree paths of the repo containing cwd (main worktree first). */
function listWorktrees(cwd) {
  try {
    return git(["worktree", "list", "--porcelain"], cwd)
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
  } catch {
    return [];
  }
}

function hashOfCheckout(dir) {
  const lock = join(dir, "package-lock.json");
  return existsSync(lock) ? lockHash(readFileSync(lock, "utf8")) : null;
}

/** chmod a-w every regular file under dir (dirs stay writable for pruning). */
function makeReadOnly(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) makeReadOnly(p);
    else chmodSync(p, st.mode & ~0o222);
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  return r.status === 0;
}

/** Copy a tree; try a reflink (CoW) first, then a plain copy. */
function deepCopy(src, dest) {
  if (process.platform === "darwin") return run("cp", ["-cR", src, dest]);
  return run("cp", ["-a", "--reflink=auto", src, dest]);
}

/**
 * Build the store entry for `checkout`'s lockfile if missing. Seeds from the
 * reference checkout when its lockfile hashes the same, else runs `npm ci`.
 */
export function ensureStore(checkout, opts = {}) {
  const hash = hashOfCheckout(checkout);
  if (!hash) throw new Error(`no package-lock.json in ${checkout}`);
  const root = opts.store ?? storeRoot();
  const entry = join(root, hash);
  if (existsSync(join(entry, META))) return { hash, entry, built: false };

  mkdirSync(root, { recursive: true });
  const tmp = `${entry}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  try {
    const ref = opts.reference ?? process.env.TALON_NM_REFERENCE;
    // Any worktree of this repo with the same lockfile will do (main first).
    const refs = ref ? [ref] : listWorktrees(checkout);
    const seed = refs.find(
      (r) =>
        resolve(r) !== resolve(checkout) &&
        hashOfCheckout(r) === hash &&
        existsSync(join(r, "node_modules", ".package-lock.json")),
    );
    let source;
    if (seed) {
      log(`seeding store ${hash} from ${seed}/node_modules (one-time copy)`);
      if (!deepCopy(join(seed, "node_modules"), join(tmp, "node_modules"))) {
        throw new Error("copy from reference failed");
      }
      source = seed;
    } else {
      log(`building store ${hash} with npm ci (one-time)`);
      copyFileSync(join(checkout, "package.json"), join(tmp, "package.json"));
      copyFileSync(
        join(checkout, "package-lock.json"),
        join(tmp, "package-lock.json"),
      );
      if (!run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: tmp })) {
        throw new Error("npm ci failed");
      }
      source = "npm ci";
    }
    for (const d of MUTABLE_DIRS) {
      rmSync(join(tmp, "node_modules", d), { recursive: true, force: true });
    }
    makeReadOnly(join(tmp, "node_modules"));
    writeFileSync(
      join(tmp, META),
      JSON.stringify({ hash, source, createdAt: new Date().toISOString() }),
    );
    try {
      renameSync(tmp, entry);
    } catch (err) {
      // A concurrent builder won the race; theirs is as good as ours.
      if (!existsSync(join(entry, META))) throw err;
      dropTree(tmp);
    }
    return { hash, entry, built: true };
  } catch (err) {
    dropTree(tmp);
    throw err;
  }
}

/**
 * rm -rf. Read-only files need no chmod: unlinking only needs the parent
 * directory writable, and every directory here is. Never chmod a tree that
 * may hold links: the mode lives on the shared inode, so `chmod u+w` on a
 * worktree's node_modules would re-arm in-place writes into the store.
 */
function dropTree(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Hardlink (or reflink) the store's node_modules into `checkout`. */
export function linkNodeModules(checkout, opts = {}) {
  const target = join(checkout, "node_modules");
  if (existsSync(target)) {
    if (!opts.force) {
      log(`${target} exists — leaving it (use --force to replace)`);
      return { linked: false };
    }
    dropTree(target);
  }
  const { hash, entry, built } = ensureStore(checkout, opts);
  const src = join(entry, "node_modules");
  const linkArgs =
    process.platform === "darwin" ? ["-cR", src, target] : ["-al", src, target];
  if (!run("cp", linkArgs)) throw new Error(`linking ${src} failed`);
  for (const f of COPIED_FILES) {
    const p = join(target, f);
    if (!existsSync(p)) continue;
    const data = readFileSync(p);
    unlinkSync(p);
    writeFileSync(p, data);
  }
  const now = new Date();
  utimesSync(join(entry, META), now, now);
  log(`node_modules → store ${hash}${built ? " (new)" : ""}`);
  return { linked: true, hash, entry };
}

/** Store entries on disk with their last-link time. */
function readEntries(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => existsSync(join(root, n, META)))
    .map((hash) => ({
      hash,
      lastUsedMs: statSync(join(root, hash, META)).mtimeMs,
    }));
}

export function prune(cwd, opts = {}) {
  const root = opts.store ?? storeRoot();
  const maxAgeMs = (opts.maxAgeDays ?? 3) * DAY_MS;
  const inUse = new Set(
    listWorktrees(cwd)
      .filter((w) => existsSync(join(w, "node_modules")))
      .map(hashOfCheckout)
      .filter(Boolean),
  );
  const doomed = planPrune(readEntries(root), inUse, Date.now(), maxAgeMs);
  // Half-built entries left by a killed builder.
  const stale = existsSync(root)
    ? readdirSync(root).filter((n) => n.includes(".tmp-"))
    : [];
  for (const h of [...doomed, ...stale]) {
    log(`${opts.dryRun ? "would prune" : "pruning"} store ${h}`);
    if (!opts.dryRun) dropTree(join(root, h));
  }
  return doomed;
}

function addWorktree(path, branch, base) {
  const cwd = process.cwd();
  const exists = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd },
  ).status;
  const args =
    exists === 0
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, base];
  if (!run("git", args, { cwd })) throw new Error("git worktree add failed");
  return linkNodeModules(resolve(path));
}

function removeWorktree(path, maxAgeDays) {
  const abs = resolve(path);
  // The main worktree's cwd keeps git commands valid after the removal.
  const main = listWorktrees(abs)[0] ?? process.cwd();
  dropTree(join(abs, "node_modules"));
  if (!run("git", ["worktree", "remove", "--force", abs], { cwd: main })) {
    throw new Error("git worktree remove failed");
  }
  prune(main, { maxAgeDays });
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function main(argv) {
  const args = argv.slice();
  const cmd = args.shift();
  const maxAge = flag(args, "--max-age-days");
  const maxAgeDays = maxAge === undefined ? undefined : Number(maxAge);
  const base = flag(args, "--base") ?? "origin/main";
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const pos = args.filter((a) => !a.startsWith("--"));
  switch (cmd) {
    case "add":
      if (pos.length < 2) throw new Error("usage: add <path> <branch>");
      addWorktree(pos[0], pos[1], base);
      return;
    case "link":
      linkNodeModules(
        pos[0] ? resolve(pos[0]) : git(["rev-parse", "--show-toplevel"]),
        { force },
      );
      return;
    case "remove":
      if (!pos[0]) throw new Error("usage: remove <path>");
      removeWorktree(pos[0], maxAgeDays);
      return;
    case "prune":
      prune(process.cwd(), { maxAgeDays, dryRun });
      return;
    case "hash":
      process.stdout.write(
        `${lockHash(readFileSync(pos[0] ?? "package-lock.json", "utf8"))}\n`,
      );
      return;
    default:
      process.stderr.write(
        "usage: worktree.mjs add|link|remove|prune|hash (see file header)\n",
      );
      process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
