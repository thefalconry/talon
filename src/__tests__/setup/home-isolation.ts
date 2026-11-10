/**
 * Vitest worker setup: give this worker a private, throwaway home.
 *
 * Runs before the test file imports anything, so util/paths.ts (resolved
 * once at import), `os.homedir()` and the Claude/Codex/XDG store locators
 * all see a fresh temp dir instead of the developer's live ~/.talon —
 * which on the production host is the real install. Child processes the
 * suite spawns inherit the same env. The home lives in the run's temp root
 * (setup/tmp-reaper.ts), which is deleted when the run ends.
 *
 * If the override did not take, fail here, before any suite can touch the
 * real home. (The full guard lives in util/fs-path.ts and runs whenever
 * util/paths.ts loads; it is not imported here — see home-env.ts.)
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REAL_HOME_ENV, applyHomeEnv } from "./home-env.js";

const home = mkdtempSync(join(tmpdir(), `talon-home-${process.pid}-`));
applyHomeEnv(home);

const real = process.env[REAL_HOME_ENV];
if (
  resolve(homedir()) !== resolve(home) ||
  (real && resolve(real) === resolve(home))
) {
  throw new Error(
    `[home-isolation] worker home override failed: os.homedir() is ` +
      `${homedir()}, expected ${home} (real home ${real ?? "unknown"})`,
  );
}
