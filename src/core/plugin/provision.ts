/**
 * Shared provisioning seam for built-in plugins with native runtimes.
 *
 * A "native" plugin (MemPalace's Python venv, Playwright's browser
 * binaries, GitHub's Docker image) depends on an artifact Talon does not
 * ship in its npm tarball. This module is the common ground those
 * provisioners stand on: a persisted state file with failure backoff so
 * a broken network can't turn boot into a retry storm, a never-throws
 * exec runner with hard timeouts, cross-OS Python discovery, and a
 * dependency-free semver compare.
 *
 * The contract every provisioner honors: an existing working install is
 * NEVER made worse. Upgrades that fail keep the current version running;
 * destructive healing (recreating a venv) is reserved for environments
 * that are already broken AND owned by Talon.
 */

import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** What a provisioning pass concluded — pure data, renderers decide presentation. */
export interface ProvisionOutcome {
  /**
   * ready    — the runtime is usable right now (possibly with warnings).
   * degraded — usable, but not at the pinned version (upgrade failed or deferred).
   * failed   — not usable; the plugin will not come up until resolved.
   * skipped  — provisioning disabled or not applicable (e.g. endpoint mode).
   */
  status: "ready" | "degraded" | "failed" | "skipped";
  /** Installed runtime version, when it could be determined. */
  version?: string;
  /** Install flavor (e.g. "managed-venv", "uv-tool", "pipx", "system"). */
  kind?: string;
  /** Mutations performed this pass ("created venv", "installed 3.8.0", …). */
  actions: string[];
  /** Advisory messages for the operator (upgrade hints, backoff notices). */
  warnings: string[];
  /** Terminal error detail when status is "failed". */
  error?: string;
  /**
   * A reconcile task the caller may run without blocking boot (e.g. a
   * version upgrade while a working older install keeps serving). The
   * caller decides whether to await it or fire-and-forget with logging.
   */
  background?: () => Promise<ProvisionOutcome>;
}

/** Persisted per-provisioner state (one small JSON file under ~/.talon/data/). */
export interface ProvisionState {
  /** The version target of the last attempt — a pin change resets backoff. */
  pin?: string;
  installedVersion?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  failureCount?: number;
  lastError?: string;
  /** One-time data migrations already applied, by name. */
  migrations?: Record<string, string>;
}

export function loadProvisionState(path: string): ProvisionState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object"
      ? (parsed as ProvisionState)
      : {};
  } catch {
    return {};
  }
}

export function saveProvisionState(path: string, state: ProvisionState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {
    /* state is an optimization (backoff, migration ledger) — never fatal */
  }
}

/** Base retry delay after the first failure. */
const BACKOFF_BASE_MS = 5 * 60_000;
/** Retry delay ceiling. */
const BACKOFF_MAX_MS = 6 * 60 * 60_000;

/** Exponential backoff: 5min, 10min, 20min … capped at 6h. */
export function provisionBackoffMs(failureCount: number): number {
  const exp = Math.max(0, Math.min(failureCount - 1, 30));
  return Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_MAX_MS);
}

/**
 * Whether a new install/upgrade attempt is due. A changed pin always
 * re-arms immediately — the operator (or a Talon upgrade) asked for a
 * different version, so stale failures shouldn't gate it.
 */
export function shouldAttempt(
  state: ProvisionState,
  pin: string,
  nowMs: number,
): boolean {
  if (!state.lastFailureAt) return true;
  if (state.pin !== pin) return true;
  const last = Date.parse(state.lastFailureAt);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= provisionBackoffMs(state.failureCount ?? 1);
}

export interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn-level failure (ENOENT, EACCES, timeout kill), when there was one. */
  error?: string;
}

export type ExecFn = (
  cmd: string,
  args: readonly string[],
  opts: { timeoutMs: number; env?: Record<string, string> },
) => Promise<ExecResult>;

/** Default exec: never throws, hard-kills on timeout, captures both streams. */
export const runStep: ExecFn = (cmd, args, opts) =>
  new Promise((resolvePromise) => {
    execFileCb(
      cmd,
      [...args],
      {
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const out = stdout?.toString() ?? "";
        const errOut = stderr?.toString() ?? "";
        if (!err) {
          resolvePromise({ ok: true, code: 0, stdout: out, stderr: errOut });
          return;
        }
        const spawnErr = err as NodeJS.ErrnoException & {
          killed?: boolean;
          code?: number | string;
        };
        const code = typeof spawnErr.code === "number" ? spawnErr.code : null;
        const error =
          typeof spawnErr.code === "string"
            ? spawnErr.code
            : spawnErr.killed
              ? `timed out after ${Math.round(opts.timeoutMs / 1000)}s`
              : undefined;
        resolvePromise({ ok: false, code, stdout: out, stderr: errOut, error });
      },
    );
  });

/**
 * Numeric dotted-version compare ("3.8.0" vs "3.10.1"): negative when a < b,
 * 0 when equal, positive when a > b. Non-numeric segments compare as 0,
 * which is the safe reading for pre-release suffixes here — a fuzzy match
 * triggers at worst a no-op reinstall, never a skipped one.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Venv interpreter path for a venv root (bin/python vs Scripts/python.exe). */
export function venvPython(venvDir: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? resolve(venvDir, "Scripts", "python.exe")
    : resolve(venvDir, "bin", "python");
}

export interface BasePython {
  command: string;
  args: string[];
  version: string;
}

/**
 * Find a base interpreter able to seed a venv. Order matters per OS: the
 * `py` launcher is the canonical entry on Windows (PATH pythons there are
 * often the Store stub), python3 the canonical one elsewhere.
 *
 * `max` caps the version for packages whose native wheels lag new Python
 * releases. When the default interpreter is newer than the cap, versioned
 * commands (`py -3.14`, `python3.14`) are tried from the cap down to the floor.
 */
export async function findBasePython(
  exec: ExecFn,
  platform: NodeJS.Platform,
  min: { major: number; minor: number },
  max?: { major: number; minor: number },
): Promise<BasePython | undefined> {
  const candidates: Array<[string, string[]]> =
    platform === "win32"
      ? [
          ["py", ["-3"]],
          ["python", []],
          ["python3", []],
        ]
      : [
          ["python3", []],
          ["python", []],
        ];
  if (max && max.major === min.major) {
    for (let minor = max.minor; minor >= min.minor; minor--) {
      candidates.push(
        platform === "win32"
          ? ["py", [`-${max.major}.${minor}`]]
          : [`python${max.major}.${minor}`, []],
      );
    }
  }
  for (const [command, args] of candidates) {
    const probe = await exec(
      command,
      [...args, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
      { timeoutMs: 20_000 },
    );
    if (!probe.ok) continue;
    const version = probe.stdout.trim();
    const [major, minor] = version.split(".").map((s) => parseInt(s, 10));
    if (!Number.isFinite(major)) continue;
    const m = minor ?? 0;
    const aboveFloor =
      major > min.major || (major === min.major && m >= min.minor);
    const belowCap =
      !max || major < max.major || (major === max.major && m <= max.minor);
    if (aboveFloor && belowCap) {
      return { command, args, version };
    }
  }
  return undefined;
}

/** Expand a leading `~/` (or bare `~`) to the home directory. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(home, path.slice(2));
  }
  return path;
}

/** Human-readable failure detail from an exec result (spawn error, last stderr line, or exit code). */
export function failDetail(result: ExecResult): string {
  // An empty stderr yields "" from pop(), which is not nullish — treat
  // it as absent so the exit-code fallback actually fires.
  const tail = result.stderr.trim().split("\n").pop()?.slice(0, 300);
  return result.error ?? (tail || `exit ${result.code ?? "?"}`);
}

/** Record a successful pass: clears the failure streak, persists. */
export function markProvisionSuccess(
  statePath: string,
  state: ProvisionState,
  pin: string,
  nowMs: number,
): void {
  state.pin = pin;
  state.lastSuccessAt = new Date(nowMs).toISOString();
  state.failureCount = 0;
  state.lastFailureAt = undefined;
  state.lastError = undefined;
  saveProvisionState(statePath, state);
}

/** Record a failed pass: bumps the failure streak for backoff, persists. */
export function markProvisionFailure(
  statePath: string,
  state: ProvisionState,
  pin: string,
  error: string,
  nowMs: number,
): void {
  state.pin = pin;
  state.lastFailureAt = new Date(nowMs).toISOString();
  state.failureCount = (state.failureCount ?? 0) + 1;
  state.lastError = error;
  saveProvisionState(statePath, state);
}
