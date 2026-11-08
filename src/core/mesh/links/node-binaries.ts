/**
 * Node-binary resolver — materializes a talon-node binary for any supported
 * platform/arch, whatever shape this daemon was installed in.
 *
 * The old flow required a source checkout plus a Go toolchain (`update_node`
 * only took a path the caller had built). This resolver keeps that path and
 * adds two more, tried in order:
 *
 *   1. source build — running from a git checkout with Go on PATH: cross-
 *      compile apps/node for the requested target (always rebuilt, so a dev
 *      daemon ships its working-tree code, stamped <version>+<sha>).
 *   2. cache — ~/.talon/node-bin/<talon-version>/talon-node-<os>-<arch>,
 *      re-verified against its recorded digest on every hit.
 *   3. release download — the GitHub release matching THIS daemon's version
 *      publishes the full binary matrix plus a talon-node-SHA256SUMS
 *      manifest (built by .github/workflows/node.yml); fetch, verify the
 *      digest, and cache. This is what makes prebuilt installs (npm, deb,
 *      standalone binary) able to provision nodes at all.
 *
 * Version lock is structural: cache keys and release URLs both derive from
 * `talonVersion()`, so a resolved binary always matches the daemon exactly.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { TalonError } from "../../errors.js";
import { getRepoRoot } from "../../update/self-update.js";
import { dirs } from "../../../util/paths.js";
import { talonVersion } from "../../../util/version.js";
import type { DevicePlatform } from "../types.js";

/** A cross-compile target, named exactly as Go (and the release assets) do. */
export type NodeTarget = {
  goos: "linux" | "darwin" | "windows";
  goarch: string;
};

/** The supported matrix — mirrors apps/node/tools/build/main.go. */
export const NODE_TARGETS: readonly NodeTarget[] = [
  { goos: "linux", goarch: "amd64" },
  { goos: "linux", goarch: "arm64" },
  { goos: "linux", goarch: "arm" },
  { goos: "darwin", goarch: "amd64" },
  { goos: "darwin", goarch: "arm64" },
  { goos: "windows", goarch: "amd64" },
];

const SUMS_ASSET = "talon-node-SHA256SUMS";
const RELEASE_BASE = "https://github.com/thefalconry/talon/releases/download";
const DOWNLOAD_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 300_000;

export type ResolvedNodeBinary = {
  path: string;
  /** Full stamp the binary reports (release: the semver; build: semver+sha). */
  version: string;
  sha256: string;
  size: number;
  /** Which tier produced it. */
  source: "source-build" | "cache" | "release";
};

export type ResolveNodeBinaryOptions = {
  /** Cache root (default ~/.talon/node-bin). */
  cacheRoot?: string;
  /** Source checkout root; null disables the build tier (default: detect). */
  repoRoot?: string | null;
  /** Release download (test seam). */
  fetchImpl?: typeof fetch;
  /** Daemon version override (test seam). */
  version?: string;
};

/** The resolver's function shape — the seam MeshService accepts in tests. */
export type NodeBinaryResolver = (
  goos: string,
  goarch: string,
  opts?: ResolveNodeBinaryOptions,
) => Promise<ResolvedNodeBinary>;

/** Release asset / on-disk name for one target. */
export function nodeAssetName(goos: string, goarch: string): string {
  return `talon-node-${goos}-${goarch}${goos === "windows" ? ".exe" : ""}`;
}

/**
 * Normalize a caller-supplied OS ("macos", "darwin", "Linux") to a matrix
 * GOOS, or undefined for anything outside it.
 */
export function normalizeGoos(value: unknown): NodeTarget["goos"] | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "macos" || v === "darwin" || v === "osx") return "darwin";
  if (v === "linux") return "linux";
  if (v === "windows" || v === "win32") return "windows";
  return undefined;
}

/** Normalize a caller-supplied arch ("x86_64", "aarch64") to a Go arch. */
export function normalizeGoarch(value: unknown): string | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "amd64" || v === "x86_64" || v === "x64") return "amd64";
  if (v === "arm64" || v === "aarch64") return "arm64";
  if (v === "arm" || v === "armv7" || v === "armv7l") return "arm";
  return undefined;
}

/** Map a mesh platform onto a node GOOS (mobile platforms have no node). */
export function platformToGoos(
  platform: DevicePlatform,
): NodeTarget["goos"] | undefined {
  return normalizeGoos(platform === "macos" ? "darwin" : platform);
}

function isSupported(goos: string, goarch: string): boolean {
  return NODE_TARGETS.some((t) => t.goos === goos && t.goarch === goarch);
}

/**
 * Resolve a node binary for `goos`/`goarch`. Throws with an operator-facing
 * message when every tier fails — callers surface it verbatim.
 */
export async function resolveNodeBinary(
  goos: string,
  goarch: string,
  opts: ResolveNodeBinaryOptions = {},
): Promise<ResolvedNodeBinary> {
  if (!isSupported(goos, goarch)) {
    throw new TalonError(
      `No talon-node target for ${goos}/${goarch}. Supported: ${NODE_TARGETS.map(
        (t) => `${t.goos}/${t.goarch}`,
      ).join(", ")}.`,
      { reason: "bad_request" },
    );
  }
  const version = opts.version ?? talonVersion();
  const cacheRoot = opts.cacheRoot ?? resolve(dirs.root, "node-bin");
  const repoRoot = opts.repoRoot === undefined ? getRepoRoot() : opts.repoRoot;

  const errors: string[] = [];

  if (repoRoot) {
    try {
      return await buildFromSource(repoRoot, goos, goarch, version, cacheRoot);
    } catch (err) {
      errors.push(`source build: ${(err as Error).message}`);
    }
  }

  const cached = await fromCache(cacheRoot, version, goos, goarch);
  if (cached) return cached;

  try {
    return await downloadFromRelease(
      version,
      goos,
      goarch,
      cacheRoot,
      opts.fetchImpl ?? fetch,
    );
  } catch (err) {
    errors.push(`release download: ${(err as Error).message}`);
  }

  throw new TalonError(
    `Could not obtain talon-node ${goos}/${goarch} for Talon ${version} — ${errors.join("; ")}`,
    { reason: "unknown" },
  );
}

// ── Tier 1: source build ────────────────────────────────────────────────────

async function buildFromSource(
  repoRoot: string,
  goos: string,
  goarch: string,
  version: string,
  cacheRoot: string,
): Promise<ResolvedNodeBinary> {
  const nodeDir = join(repoRoot, "apps", "node");
  await stat(join(nodeDir, "go.mod"));
  // Dev builds land under their own key: they track the working tree, not a
  // release, and are rebuilt on every resolve so they can never go stale.
  const outDir = join(cacheRoot, "dev");
  await mkdir(outDir, { recursive: true });
  const dest = join(outDir, nodeAssetName(goos, goarch));
  const stamp = `${version}+${await gitShortSha(repoRoot)}`;
  await run(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags",
      `-s -w -X main.ldflagsVersion=${stamp}`,
      "-o",
      dest,
      ".",
    ],
    nodeDir,
    { CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
    BUILD_TIMEOUT_MS,
  );
  const { sha256, size } = await hashFile(dest);
  return { path: dest, version: stamp, sha256, size, source: "source-build" };
}

async function gitShortSha(repoRoot: string): Promise<string> {
  try {
    return (
      await run("git", ["rev-parse", "--short", "HEAD"], repoRoot, {}, 10_000)
    ).trim();
  } catch {
    return "dev";
  }
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      cmd,
      args,
      { cwd, env: { ...process.env, ...env }, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          rej(
            new Error(
              `${cmd} ${args[0]} failed: ${String(stderr || err.message)
                .trim()
                .slice(0, 500)}`,
            ),
          );
        } else {
          res(String(stdout));
        }
      },
    );
  });
}

// ── Tier 2: cache ───────────────────────────────────────────────────────────

async function fromCache(
  cacheRoot: string,
  version: string,
  goos: string,
  goarch: string,
): Promise<ResolvedNodeBinary | null> {
  const path = join(cacheRoot, version, nodeAssetName(goos, goarch));
  let recorded: string;
  try {
    recorded = (await readFile(`${path}.sha256`, "utf8")).trim();
  } catch {
    return null;
  }
  try {
    const { sha256, size } = await hashFile(path);
    if (size > 0 && sha256 === recorded) {
      return { path, version, sha256, size, source: "cache" };
    }
  } catch {
    // Fall through — a corrupt entry is re-downloaded, not fatal.
  }
  await rm(path, { force: true }).catch(() => {});
  await rm(`${path}.sha256`, { force: true }).catch(() => {});
  return null;
}

// ── Tier 3: release download ────────────────────────────────────────────────

async function downloadFromRelease(
  version: string,
  goos: string,
  goarch: string,
  cacheRoot: string,
  fetchImpl: typeof fetch,
): Promise<ResolvedNodeBinary> {
  const asset = nodeAssetName(goos, goarch);
  const base = `${RELEASE_BASE}/v${version}`;
  const sums = parseSums(await fetchText(fetchImpl, `${base}/${SUMS_ASSET}`));
  const expected = sums.get(asset);
  if (!expected) {
    throw new TalonError(
      `${SUMS_ASSET} for v${version} has no entry for ${asset}`,
      { reason: "bad_request" },
    );
  }
  const body = await fetchBytes(fetchImpl, `${base}/${asset}`);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== expected) {
    throw new TalonError(
      `digest mismatch for ${asset} (expected ${expected.slice(0, 12)}…, got ${sha256.slice(0, 12)}…) — refusing to cache`,
      { reason: "unknown" },
    );
  }
  const dir = join(cacheRoot, version);
  await mkdir(dir, { recursive: true });
  const dest = join(dir, asset);
  const tmp = `${dest}.tmp-${process.pid}`;
  await writeFile(tmp, body);
  await chmod(tmp, 0o755);
  await rename(tmp, dest);
  await writeFile(`${dest}.sha256`, `${sha256}\n`);
  await pruneStaleVersions(cacheRoot, version);
  return { path: dest, version, sha256, size: body.length, source: "release" };
}

/** Parse "<hex>  <name>" manifest lines (the `sha256sum` format). */
function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m) out.set(m[2]!, m[1]!);
  }
  return out;
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
): Promise<string> {
  const res = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new TalonError(`GET ${url}: HTTP ${res.status}`, {
      reason: "network",
      retryable: true,
      status: res.status,
    });
  }
  return res.text();
}

async function fetchBytes(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Buffer> {
  const res = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new TalonError(`GET ${url}: HTTP ${res.status}`, {
      reason: "network",
      retryable: true,
      status: res.status,
    });
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Drop cached matrices for other Talon versions — they can never be used
 *  again (the resolver only serves version-exact binaries). Best-effort. */
async function pruneStaleVersions(
  cacheRoot: string,
  keep: string,
): Promise<void> {
  try {
    for (const entry of await readdir(cacheRoot)) {
      if (entry === keep || entry === "dev") continue;
      await rm(join(cacheRoot, entry), { recursive: true, force: true });
    }
  } catch {
    // Cache hygiene only — never fail a resolve over it.
  }
}

/** Stream a file through SHA-256 without loading it into memory (APKs are big
 *  and Buffer has a hard ceiling). Returns the hex digest and byte size. */
export async function hashFile(
  path: string,
): Promise<{ sha256: string; size: number }> {
  const { size } = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return { sha256: hash.digest("hex"), size };
}
