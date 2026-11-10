/**
 * Filesystem-path normalisation for model-supplied input.
 *
 * Models routinely emit `~/.talon/workspace/...` because that's the
 * canonical path Talon documents in prompts. Node's `fs` module
 * does NOT expand `~/` — `statSync('~/foo')` fails with ENOENT.
 * Tilde expansion is a shell concern, not a libc/Node one.
 *
 * Anywhere a path crosses from agent-land (tool args, MCP payloads,
 * gateway action bodies) into a `fs.*` or send-media API call, route
 * it through `expandFsPath` first so the leading `~/` is replaced
 * with the actual home directory.
 *
 * Also home to `userHome()` and the test-only home guard (below) that every
 * home-derived default path goes through.
 */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolve a model-supplied path to an absolute on-disk path.
 *
 *   - `~`                 → `$HOME`
 *   - `~/<rel>`           → `$HOME/<rel>`
 *   - already absolute    → returned unchanged
 *   - relative            → resolved against `process.cwd()`
 *   - empty string        → returned unchanged (caller decides what to do)
 */
export function expandFsPath(input: string): string {
  if (!input) return input;
  if (input === "~") return userHome();
  if (input.startsWith("~/")) return resolve(userHome(), input.slice(2));
  if (isAbsolute(input)) return input;
  return resolve(process.cwd(), input);
}

/*
 * ── Home guard ──────────────────────────────────────────────────────────
 *
 * Test-only tripwire: refuse to resolve a path into the real user home.
 *
 * The suite runs on developer machines and on the production host (the
 * pre-flight lane), where `~/.talon` is a live install. Every vitest worker
 * gets a throwaway HOME / TALON_HOME (src/__tests__/setup/home-isolation.ts),
 * but a test that resets the env, mocks `os.homedir()` or spawns a child
 * with a stripped environment can still land back on the real tree, and
 * functions such as backup prune/restore default to `dirs.root`. So the
 * resolvers themselves check: under vitest, a root that is the real home,
 * an ancestor of it, or anything inside the real `~/.talon` is an error
 * before a single byte is read or written.
 *
 * The real home comes from the password database (`os.userInfo()`), which
 * on Node ignores HOME/USERPROFILE, and `os` is fetched with
 * `process.getBuiltinModule` so a `vi.mock("node:os")` in the calling suite
 * cannot hide it. The global setup also records the pre-override home in
 * TALON_TEST_REAL_HOME, the fallback for hosts with no passwd entry.
 *
 * Outside vitest this is a no-op.
 */

/** Env var the vitest global setup fills with the home it replaced. */
export const REAL_HOME_ENV = "TALON_TEST_REAL_HOME";

function underVitest(): boolean {
  return Boolean(process.env.VITEST);
}

/** The homes this process must never resolve into (deduplicated). */
export function realHomes(): string[] {
  const homes = new Set<string>();
  // Bun's userInfo().homedir follows $HOME, so it would report the temp
  // home as the real one; under Bun only the recorded value is trusted.
  if (!process.versions.bun) {
    try {
      const os = process.getBuiltinModule("node:os");
      const home = os.userInfo().homedir;
      if (home) homes.add(resolve(home));
    } catch {
      // No passwd entry (arbitrary container uid) — fall back to the env.
    }
  }
  const recorded = process.env[REAL_HOME_ENV];
  if (recorded) homes.add(resolve(recorded));
  return [...homes];
}

function norm(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** True when `child` is `parent` or lies inside it. */
function within(child: string, parent: string): boolean {
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * True when `path` is a real home, an ancestor of one, or inside a real
 * `~/.talon`. A path elsewhere under the real home is allowed: on Windows the
 * temp dir itself lives in `%USERPROFILE%\AppData\Local\Temp`.
 */
export function touchesRealHome(path: string): boolean {
  const target = resolve(path);
  return realHomes().some(
    (home) => within(home, target) || within(target, resolve(home, ".talon")),
  );
}

/**
 * Throw when running under vitest and `path` resolves into the real home.
 * `what` names the resolver in the error.
 */
export function assertNotRealHome(path: string, what: string): void {
  if (!underVitest()) return;
  if (!touchesRealHome(path)) return;
  throw new Error(
    `[home-guard] ${what} resolved to ${resolve(path)}, which is the real ` +
      `user home or its ~/.talon. Tests must run against the per-worker ` +
      `temp home (src/__tests__/setup/home-isolation.ts); set TALON_HOME / ` +
      `HOME to a temp dir instead.`,
  );
}

/**
 * `os.homedir()`, guarded: under vitest it throws rather than hand back the
 * real home. Use it wherever a default path is built from the user home.
 */
export function userHome(): string {
  const home = homedir();
  assertNotRealHome(home, "os.homedir()");
  return home;
}
