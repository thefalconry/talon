// Vitest reporter that records the test-impact map: for every test file,
// the src/ modules it actually evaluated at runtime.
//
// Source of truth is vitest's own per-file import diagnostics
// (`testModule.diagnostic().importDurations`), which lists every
// non-externalized module the worker evaluated for that file — the same
// file-level set v8 coverage would mark as touched (a module that is
// evaluated always has its top level covered), but collected for free
// during a normal run instead of 400 isolated coverage runs.
//
// Usage (the flag lifts vitest's default cap of 0 collected imports):
//   npx vitest run --reporter=default --reporter=./scripts/tia-reporter.mjs \
//     --experimental.importDurations.limit=1000000
// Output: $TIA_MAP_OUT (default ci/test-impact-map.json).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const toPosix = (p) => p.split(sep).join("/");

function gitCommit(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

export default class TiaReporter {
  onInit(vitest) {
    this.root = vitest.config.root;
  }

  onTestRunEnd(testModules) {
    const root = this.root ?? process.cwd();
    const out = resolve(
      root,
      process.env.TIA_MAP_OUT ?? "ci/test-impact-map.json",
    );
    /** @type {Map<string, Set<string>>} */
    const perTest = new Map();
    let withoutImports = 0;
    for (const mod of testModules) {
      const test = toPosix(relative(root, mod.moduleId));
      const imports = Object.keys(mod.diagnostic().importDurations ?? {});
      if (imports.length === 0) withoutImports++;
      const srcs = new Set();
      for (const id of imports) {
        const rel = toPosix(relative(root, id.split("?")[0]));
        if (rel.startsWith("src/") && rel !== test) srcs.add(rel);
      }
      perTest.set(test, srcs);
    }
    if (perTest.size > 0 && withoutImports === perTest.size) {
      console.warn(
        "[tia] no import diagnostics were collected — run with --experimental.importDurations.limit=1000000; map NOT written",
      );
      return;
    }
    // Compact form: one shared source table, tests reference it by index.
    const sources = [
      ...new Set([...perTest.values()].flatMap((s) => [...s])),
    ].sort();
    const index = new Map(sources.map((s, i) => [s, i]));
    const tests = {};
    for (const test of [...perTest.keys()].sort()) {
      tests[test] = [...perTest.get(test)]
        .map((s) => index.get(s))
        .sort((a, b) => a - b);
    }
    const map = {
      version: 1,
      generatedAt: new Date().toISOString(),
      commit: gitCommit(root),
      testCount: perTest.size,
      sources,
      tests,
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(map) + "\n");
    console.log(
      `[tia] wrote ${out}: ${perTest.size} test files, ${sources.length} sources`,
    );
  }
}
