#!/usr/bin/env node
// Test-impact analysis: pick the vitest files a change set can affect.
//
//   node scripts/tia.mjs | xargs npx vitest run
//
// stdout: the selected test files, one per line. EMPTY stdout means "run
// the full suite" (xargs then runs a bare `npx vitest run`). The decision,
// its reason and the "TIA: ran N/M test files" line go to stderr, to
// $GITHUB_STEP_SUMMARY and (on Actions) to a ::notice annotation.
//
// A test file is selected when
//   - it changed itself, or
//   - one of the src/ modules it evaluates at runtime changed
//     (ci/test-impact-map.json, recorded by scripts/tia-reporter.mjs), or
//   - its name contains the basename of a changed src file
//     (src/core/foo-bar.ts → *foo-bar*.test.ts), or
//   - it spawns a real talon entry point (src/cli.ts, src/index.ts,
//     bin/talon.js, tsx) and any src/ module changed — a child process's
//     imports are invisible to the in-process map, or
//   - it is in the SMOKE set (always).
//
// Full suite instead when
//   - the map is missing, unreadable, or older than --max-age-days, or
//   - anything outside src/ changed that is not on the IGNORE list
//     (config, package.json, lockfile, scripts/, native/, prompts/, …), or
//   - a non-.ts file under src/ changed (fixtures/assets read from disk
//     have no import edge in the map).
//
// Options:
//   --base <ref>          diff base (default: origin/main); the change set is
//                         `git diff --name-only <base>...HEAD` plus
//                         uncommitted and untracked files
//   --files <path|->      read the change set (one path per line) from a file
//                         or stdin instead of git
//   --map <path>          map file (default: ci/test-impact-map.json)
//   --root <dir>          repo root (default: this script's repo)
//   --max-age-days <n>    map staleness limit (default: 14)
//   --now <iso>           override "now" (tests)
//   --json                print the whole decision as JSON instead of the list
//   --refresh             download the newest map artifact from the latest
//                         successful main CI run (needs gh) and exit

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_MAP = "ci/test-impact-map.json";

/** Always run: cheap, broad tests that catch import-time and wiring breakage. */
export const SMOKE = [
  "src/__tests__/boot-smoke.test.ts",
  "src/__tests__/config.test.ts",
  "src/__tests__/sql-embed.test.ts",
  "src/__tests__/prompts-embed.test.ts",
];

/** Changes here cannot affect a unit-test result. */
const IGNORE = [
  /^docs\//,
  /^apps\/companion\//,
  /^\.github\/(workflows|ISSUE_TEMPLATE)\//,
  /^\.github\/[^/]+\.(md|ya?ml)$/,
  /^[^/]+\.md$/,
  /^(LICENSE|LICENSE-MIT|NOTICE)$/,
  /^release-please-config\.json$/,
  /^\.release-please-manifest\.json$/,
];

/** The TIA tooling itself: selects only its own tests instead of the full suite. */
const TIA_OWN = /^(scripts\/tia(-reporter)?\.mjs|ci\/test-impact-map\.json)$/;
const TIA_TESTS = ["src/__tests__/tia.test.ts"];

/** Tests that spawn a real talon entry point in a child process. */
const SPAWNS_ENTRY = /src\/(cli|index)\.ts|bin\/talon\.js|["']tsx["']/;

const toPosix = (p) => p.split(sep).join("/");
const isTest = (f) => /^src\/.*\.test\.ts$/.test(f);

/** Every test file vitest would run (vitest.config.ts: include src/**\/*.test.ts). */
export function listTestFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".test.ts"))
        out.push(toPosix(relative(root, p)));
    }
  };
  walk(join(root, "src"));
  return out.sort();
}

function stemOf(file) {
  return posix.basename(file).replace(/\.(test\.)?[cm]?[jt]sx?$/, "");
}

/**
 * Pure selection. Returns { full, reason, selected, total, changed }.
 * `selected` lists test files to run; when `full` it is every test file.
 */
export function selectTests({
  changed,
  map,
  allTests,
  now = new Date(),
  maxAgeDays = 14,
  readTest,
}) {
  const total = allTests.length;
  const all = new Set(allTests);
  const full = (reason) => ({
    full: true,
    reason,
    selected: [...allTests],
    total,
    changed,
  });

  if (!map || map.version !== 1 || !map.tests || !Array.isArray(map.sources)) {
    return full("no usable test-impact map");
  }
  const ageDays = (now.getTime() - Date.parse(map.generatedAt)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > maxAgeDays) {
    return full(
      `test-impact map is stale (${Number.isFinite(ageDays) ? ageDays.toFixed(1) : "?"}d old, limit ${maxAgeDays}d)`,
    );
  }

  const unmapped = [];
  const srcChanged = new Set();
  const picked = new Set(SMOKE);
  let ownTooling = false;
  for (const f of changed) {
    if (IGNORE.some((re) => re.test(f))) continue;
    if (TIA_OWN.test(f)) {
      ownTooling = true;
      continue;
    }
    if (!f.startsWith("src/")) {
      unmapped.push(f);
      continue;
    }
    if (isTest(f)) {
      picked.add(f);
      continue;
    }
    if (/\.[cm]?tsx?$/.test(f)) srcChanged.add(f);
    else unmapped.push(f);
  }
  if (unmapped.length > 0) {
    const shown =
      unmapped.slice(0, 5).join(", ") + (unmapped.length > 5 ? ", …" : "");
    return full(`change outside the mapped src/ graph: ${shown}`);
  }
  if (ownTooling) for (const t of TIA_TESTS) picked.add(t);

  if (srcChanged.size > 0) {
    // 1. runtime import graph
    const changedIdx = new Set();
    map.sources.forEach((s, i) => srcChanged.has(s) && changedIdx.add(i));
    for (const [test, idxs] of Object.entries(map.tests)) {
      if (idxs.some((i) => changedIdx.has(i))) picked.add(test);
    }
    // 2. basename match
    const stems = [...srcChanged]
      .map(stemOf)
      .filter((s) => s.length >= 3 && s !== "index" && s !== "types");
    for (const t of allTests) {
      const ts = stemOf(t);
      if (stems.some((s) => ts.includes(s))) picked.add(t);
    }
    // 3. tests whose child processes run src/ code
    for (const t of allTests) {
      const text = readTest(t);
      if (text && SPAWNS_ENTRY.test(text)) picked.add(t);
    }
  }

  // Deleted / renamed-away tests must not reach vitest ("No test files found").
  const selected = [...picked].filter((t) => all.has(t)).sort();
  if (selected.length >= total) return full("every test file is affected");
  const why = [];
  if (srcChanged.size) why.push(`${srcChanged.size} src file(s)`);
  const testsChanged = changed.filter(isTest).length;
  if (testsChanged) why.push(`${testsChanged} test file(s)`);
  if (ownTooling) why.push("TIA tooling");
  return {
    full: false,
    reason: why.length
      ? `changed: ${why.join(", ")}`
      : "no test-relevant change (smoke set only)",
    selected,
    total,
    changed,
  };
}

function parseArgs(argv) {
  const o = {
    root: ROOT,
    base: "origin/main",
    map: DEFAULT_MAP,
    maxAgeDays: 14,
    json: false,
    files: null,
    now: null,
    refresh: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--base") o.base = next();
    else if (a === "--root") o.root = resolve(next());
    else if (a === "--map") o.map = next();
    else if (a === "--files") o.files = next();
    else if (a === "--max-age-days") o.maxAgeDays = Number(next());
    else if (a === "--now") o.now = new Date(next());
    else if (a === "--json") o.json = true;
    else if (a === "--refresh") o.refresh = true;
    else if (a === "-h" || a === "--help") {
      const src = readFileSync(new URL(import.meta.url), "utf8");
      process.stdout.write(
        src
          .split("\n")
          .filter((l) => l.startsWith("//"))
          .map((l) => l.slice(3))
          .join("\n") + "\n",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function changedFromGit(root, base) {
  const lines = [
    git(root, ["diff", "--name-only", "--no-renames", `${base}...HEAD`]),
    git(root, ["diff", "--name-only", "--no-renames", "HEAD"]),
    git(root, ["ls-files", "--others", "--exclude-standard"]),
  ].join("\n");
  return [
    ...new Set(
      lines
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

function readChanged(files) {
  const text =
    files === "-" ? readFileSync(0, "utf8") : readFileSync(files, "utf8");
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((l) => toPosix(l.trim()))
        .filter(Boolean),
    ),
  ];
}

function loadMap(root, path) {
  try {
    return JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch {
    return null;
  }
}

function refresh(mapPath) {
  const run = execFileSync(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "CI",
      "--branch",
      "main",
      "--event",
      "push",
      "--status",
      "success",
      "--limit",
      "1",
      "--json",
      "databaseId",
      "--jq",
      ".[0].databaseId",
    ],
    { cwd: ROOT, encoding: "utf8" },
  ).trim();
  if (!run) throw new Error("no successful main CI run found");
  const dir = mkdtempSync(join(tmpdir(), "tia-"));
  try {
    execFileSync(
      "gh",
      ["run", "download", run, "-n", "test-impact-map", "-D", dir],
      { cwd: ROOT, stdio: "inherit" },
    );
    const body = readFileSync(join(dir, "test-impact-map.json"), "utf8");
    writeFileSync(resolve(ROOT, mapPath), body);
    const m = JSON.parse(body);
    process.stderr.write(
      `TIA: refreshed ${mapPath} from run ${run} (${m.testCount} tests, generated ${m.generatedAt})\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function report(decision) {
  const ran = decision.full ? decision.total : decision.selected.length;
  const line = `TIA: ran ${ran}/${decision.total} test files`;
  const detail = decision.full
    ? `full suite — ${decision.reason}`
    : decision.reason;
  process.stderr.write(`${line} (${detail})\n`);
  if (process.env.GITHUB_ACTIONS === "true") {
    const esc = (s) =>
      s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    process.stderr.write(
      `::notice title=Test impact analysis::${esc(`${line} (${detail})`)}\n`,
    );
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const body = [`### ${line}`, "", detail, ""];
    if (!decision.full) {
      body.push(
        "<details><summary>Selected test files</summary>",
        "",
        ...decision.selected.map((t) => `- \`${t}\``),
        "",
        "</details>",
        "",
      );
    }
    appendFileSync(summary, body.join("\n") + "\n");
  }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.refresh) return refresh(o.map);
  let changed;
  let decision;
  const allTests = listTestFiles(o.root);
  try {
    changed = o.files ? readChanged(o.files) : changedFromGit(o.root, o.base);
  } catch (err) {
    decision = {
      full: true,
      reason: `could not compute the change set (${String(err.message ?? err).split("\n")[0]})`,
      selected: allTests,
      total: allTests.length,
      changed: [],
    };
  }
  decision ??= selectTests({
    changed,
    map: loadMap(o.root, o.map),
    allTests,
    now: o.now ?? new Date(),
    maxAgeDays: o.maxAgeDays,
    readTest: (t) => {
      const p = resolve(o.root, t);
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    },
  });
  report(decision);
  if (o.json) process.stdout.write(JSON.stringify(decision, null, 2) + "\n");
  else if (!decision.full)
    process.stdout.write(decision.selected.join("\n") + "\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`tia: ${err.message ?? err}\n`);
    process.exit(2);
  }
}
