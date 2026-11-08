#!/usr/bin/env node
/**
 * Ratchet gates — metrics that may only improve.
 *
 * Each ratchet counts something we want less of and fails CI when the
 * count RISES above the committed baseline. When a change lowers a
 * count, the script says so and the baseline here should be lowered in
 * the same PR — that's the ratchet clicking one tooth tighter. Deleting
 * a ratchet requires reaching zero first (then promote the invariant to
 * a real lint/type rule if one exists).
 *
 * Deliberately dependency-free and dumb: plain recursive grep, exact
 * string match, no AST. A false positive in a comment is acceptable
 * noise for a gate this cheap.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @type {{name: string, dir: string, needle: string, baseline: number, why: string}[]} */
const RATCHETS = [
  {
    name: "naked-throw-in-core",
    dir: "src/core",
    needle: "throw new Error(",
    // 40 before the soul kernel was removed (#949), which took four of
    // its own throws with it.
    //
    // 36 → 38 when docs/structure.md worklist item 4 moved
    // util/mcp-launcher.ts to core/mcp-hub/launcher.ts. Both added hits
    // (`SUPERVISOR_CMD_ENV must be a non-empty JSON string array` and
    // `wrapMcpCommand: command array must not be empty`) are argument
    // guards that predate the move and were not rewritten — the count of
    // naked throws in the repo is unchanged; two of them are now inside
    // `src/core/`, which is what this ratchet measures. No engine code
    // gained a throw.
    //
    // 38 → 35 with the stability sweep: dead code that carried three
    // throws was deleted (the backend-controller legacy alias layer and the
    // agent-runtime event helpers).
    baseline: 35,
    why:
      "core/ should throw classified errors (core/errors.ts) so retry and " +
      "interrupt behaviour stays well-defined at the engine boundary. " +
      "Guard-style programmer-error throws are tolerated at the current " +
      "baseline; new engine code classifies.",
  },
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      yield* walk(path);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      yield path;
    }
  }
}

let failed = false;
for (const ratchet of RATCHETS) {
  let count = 0;
  const hits = [];
  for (const file of walk(ratchet.dir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(ratchet.needle)) {
        count++;
        hits.push(`${file}:${i + 1}`);
      }
    }
  }
  if (count > ratchet.baseline) {
    failed = true;
    console.error(
      `✖ ratchet "${ratchet.name}": ${count} > baseline ${ratchet.baseline}`,
    );
    console.error(`  ${ratchet.why}`);
    for (const hit of hits) console.error(`  ${hit}`);
  } else if (count < ratchet.baseline) {
    console.log(
      `→ ratchet "${ratchet.name}": ${count} < baseline ${ratchet.baseline} — lower the baseline in scripts/check-ratchets.mjs to lock it in`,
    );
  } else {
    console.log(`✔ ratchet "${ratchet.name}": ${count} (at baseline)`);
  }
}

process.exit(failed ? 1 : 0);
