/**
 * Global test setup — give the run a private temp root and delete it after.
 *
 * Most suites tear down their own temp dirs, but a dozen or so create one in
 * `beforeAll` and never remove it (native-tools, native-frontend, mesh-service,
 * node-binaries, native-tls, harden, protocol-conformance …), and
 * `native-tools.test.ts` alone writes ~33 MB of fixtures per run. On a dev box
 * that runs the suite repeatedly this filled several GB of root in an
 * afternoon.
 *
 * Rather than patch every suite, the run gets its own `talon-run-*` directory
 * and TMPDIR/TMP/TEMP point at it before any worker starts, so every
 * `os.tmpdir()` / `mkdtemp` lands inside it; teardown removes the whole tree.
 * Scoping by directory (not by "appeared during the run") keeps concurrent
 * runs — two worktrees, or CI shards on one box — from reaping each other's
 * live fixtures. Set `TALON_TEST_KEEP_TMP=1` to keep it when debugging a
 * suite's fixtures; the path is printed.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_VARS = ["TMPDIR", "TMP", "TEMP"] as const;

export async function setup(): Promise<() => Promise<void>> {
  const root = await mkdtemp(join(tmpdir(), "talon-run-"));
  const saved = TMP_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of TMP_VARS) process.env[name] = root;

  return async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (process.env.TALON_TEST_KEEP_TMP === "1") {
      console.log(`[tmp-reaper] kept ${root}`);
      return;
    }
    // Best-effort: a permission quirk must never fail the run.
    await rm(root, { recursive: true, force: true }).catch(() => {});
  };
}
