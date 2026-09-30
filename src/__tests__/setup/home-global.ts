/**
 * Global test setup — record the real home, then hide it from every worker.
 *
 * Runs in the vitest main process after tmp-reaper.ts has pointed TMPDIR at
 * the run's private temp root, and before any worker starts. It records the
 * home it is about to replace in TALON_TEST_REAL_HOME (the fallback the
 * home guard in util/fs-path.ts compares against when the password
 * database has no entry), then points HOME, USERPROFILE, TALON_HOME and the
 * backend store dirs at `<run root>/home`. Workers inherit that as a
 * fallback; setup/home-isolation.ts then gives each one a private home.
 * The run root — and every home in it — is removed by tmp-reaper.ts.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOME_ENV_VARS,
  ISOLATED_HOME_ENV,
  REAL_HOME_ENV,
  applyHomeEnv,
} from "./home-env.js";

export function setup(): () => void {
  const saved = [...HOME_ENV_VARS, REAL_HOME_ENV, ISOLATED_HOME_ENV].map(
    (name) => [name, process.env[name]] as const,
  );
  // A nested run (a suite that launches vitest) keeps the outermost value.
  process.env[REAL_HOME_ENV] ??= homedir();
  applyHomeEnv(join(tmpdir(), "home"));

  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
