/**
 * The environment that points a process at a throwaway home.
 *
 * Shared by the global setup (a run-wide fallback every worker inherits)
 * and the per-worker setup (a private home per test file). Everything a
 * Talon path resolver or a backend session locator reads is covered:
 * `os.homedir()` (HOME on POSIX, USERPROFILE on Windows), TALON_HOME
 * (util/paths.ts), CLAUDE_CONFIG_DIR and CODEX_HOME (the Claude/Codex
 * stores), and the XDG dirs (OpenCode/Kilo data, the Playwright cache).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const HOME_ENV_VARS = [
  "HOME",
  "USERPROFILE",
  "TALON_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const;

/**
 * The home the global setup replaced. Must equal `REAL_HOME_ENV` in
 * util/fs-path.ts (the canary test checks) — setup files import only node
 * builtins: a src module loaded here would be cached for the test file
 * before its `vi.mock("node:os")` could apply.
 */
export const REAL_HOME_ENV = "TALON_TEST_REAL_HOME";

/** Set by the per-worker setup: the temp home this worker runs in. */
export const ISOLATED_HOME_ENV = "TALON_TEST_ISOLATED_HOME";

function homeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    TALON_HOME: join(home, ".talon"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
}

/** Create `home` and point this process's env at it. */
export function applyHomeEnv(home: string): void {
  mkdirSync(home, { recursive: true });
  for (const [name, value] of Object.entries(homeEnv(home))) {
    process.env[name] = value;
  }
  process.env[ISOLATED_HOME_ENV] = home;
}
