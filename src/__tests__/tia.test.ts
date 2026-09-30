/**
 * scripts/tia.mjs — test-impact selection. Drives the real CLI against a
 * throwaway fixture repo (a map + a fake change set → expected selection).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TIA = resolve(import.meta.dirname, "../../scripts/tia.mjs");
const NOW = "2026-09-30T12:00:00.000Z";

const SMOKE = [
  "src/__tests__/boot-smoke.test.ts",
  "src/__tests__/config.test.ts",
  "src/__tests__/sql-embed.test.ts",
  "src/__tests__/prompts-embed.test.ts",
];

const TESTS: Record<string, string> = {
  ...Object.fromEntries(SMOKE.map((t) => [t, ""])),
  "src/__tests__/alpha.test.ts": "import '../core/alpha';",
  "src/__tests__/beta.test.ts": "import '../core/beta';",
  "src/__tests__/gamma-store.test.ts": "import '../storage/gamma';",
  "src/__tests__/delta.test.ts": "import '../core/delta';",
  "src/__tests__/spawner.test.ts":
    "spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts']);",
  "src/__tests__/tia.test.ts": "",
};

type Decision = {
  full: boolean;
  reason: string;
  selected: string[];
  total: number;
};

// Keep the child from writing annotations/summaries into a real CI job.
const CLEAN_ENV = {
  ...process.env,
  GITHUB_ACTIONS: "",
  GITHUB_STEP_SUMMARY: "",
};

let root: string;

function writeMap(generatedAt: string, file = "ci/test-impact-map.json") {
  const sources = [
    "src/core/alpha.ts",
    "src/core/beta.ts",
    "src/core/shared.ts",
    "src/storage/gamma.ts",
    "src/storage/sql/statements.generated.ts",
  ];
  const map = {
    version: 1,
    generatedAt,
    commit: "deadbeef",
    testCount: 4,
    sources,
    tests: {
      "src/__tests__/alpha.test.ts": [0, 2],
      "src/__tests__/beta.test.ts": [1, 2],
      "src/__tests__/gamma-store.test.ts": [3, 4],
      "src/__tests__/delta.test.ts": [],
    },
  };
  const p = join(root, file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(map));
}

function tia(changed: string[], extra: string[] = []): Decision {
  const list = join(root, "changed.txt");
  writeFileSync(list, changed.join("\n") + "\n");
  const out = execFileSync(
    process.execPath,
    [TIA, "--root", root, "--files", list, "--now", NOW, "--json", ...extra],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: CLEAN_ENV },
  );
  return JSON.parse(out) as Decision;
}

/** Default output mode: the file list on stdout. */
function plain(changed: string[]): string {
  const list = join(root, "changed.txt");
  writeFileSync(list, changed.join("\n") + "\n");
  return execFileSync(
    process.execPath,
    [TIA, "--root", root, "--files", list, "--now", NOW],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: CLEAN_ENV,
    },
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tia-fixture-"));
  for (const [t, body] of Object.entries(TESTS)) {
    mkdirSync(dirname(join(root, t)), { recursive: true });
    writeFileSync(join(root, t), body);
  }
  writeMap("2026-09-28T00:00:00.000Z");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("tia selection", () => {
  it("selects tests whose runtime graph contains a changed source, plus smoke and spawners", () => {
    const d = tia(["src/core/shared.ts"]);
    expect(d.full).toBe(false);
    expect(d.total).toBe(Object.keys(TESTS).length);
    expect(d.selected).toEqual(
      [
        ...SMOKE,
        "src/__tests__/alpha.test.ts",
        "src/__tests__/beta.test.ts",
        "src/__tests__/spawner.test.ts",
      ].sort(),
    );
  });

  it("selects a test whose name contains the changed file's basename even without a map edge", () => {
    const d = tia(["src/core/delta.ts"]);
    expect(d.selected).toContain("src/__tests__/delta.test.ts");
    expect(d.selected).not.toContain("src/__tests__/alpha.test.ts");
  });

  it("matches the basename inside a longer test name", () => {
    const d = tia(["src/storage/gamma.ts"]);
    expect(d.selected).toContain("src/__tests__/gamma-store.test.ts");
  });

  it("selects a changed test file itself, without the spawn-based tests", () => {
    const d = tia(["src/__tests__/beta.test.ts"]);
    expect(d.full).toBe(false);
    expect(d.selected).toEqual([...SMOKE, "src/__tests__/beta.test.ts"].sort());
  });

  it("drops deleted test files instead of passing them to vitest", () => {
    const d = tia(["src/__tests__/removed.test.ts"]);
    expect(d.selected).toEqual([...SMOKE].sort());
  });

  it("runs only the smoke set for ignorable changes", () => {
    const d = tia([
      "docs/guide.md",
      "README.md",
      "apps/companion/lib/main.dart",
      ".github/workflows/ci.yml",
    ]);
    expect(d.full).toBe(false);
    expect(d.selected).toEqual([...SMOKE].sort());
  });

  it("changes to the TIA tooling select only its own tests", () => {
    const d = tia(["scripts/tia.mjs", "ci/test-impact-map.json"]);
    expect(d.full).toBe(false);
    expect(d.selected).toEqual([...SMOKE, "src/__tests__/tia.test.ts"].sort());
  });

  it.each([
    ["package.json"],
    ["package-lock.json"],
    ["vitest.config.ts"],
    ["scripts/check-tree.mjs"],
    ["prompts/identity.md"],
    ["native/foo/src/lib.rs"],
  ])("falls back to the full suite when %s changes", (file) => {
    const d = tia(["src/core/alpha.ts", file]);
    expect(d.full).toBe(true);
    expect(d.reason).toContain(file);
    expect(d.selected).toHaveLength(d.total);
  });

  it("falls back to the full suite for a non-TS asset under src/", () => {
    const d = tia(["src/core/fixtures/table.json"]);
    expect(d.full).toBe(true);
  });

  it("treats a .sql change as a change to the generated statements module", () => {
    const d = tia(["src/storage/sql/cron.sql"]);
    expect(d.full).toBe(false);
    expect(d.selected).toContain("src/__tests__/gamma-store.test.ts");
    expect(d.selected).not.toContain("src/__tests__/alpha.test.ts");
  });

  it("ignores packaging, lint config and ratchet baselines", () => {
    const d = tia([
      "Dockerfile",
      "docker/entrypoint.sh",
      "knip.json",
      ".oxlintrc.json",
      "scripts/function-size-baseline.json",
      ".github/branch-protection.json",
      "src/storage/sql/README.md",
    ]);
    expect(d.full).toBe(false);
    expect(d.selected).toEqual([...SMOKE].sort());
  });

  it("falls back to the full suite when the map is stale", () => {
    writeMap("2026-09-01T00:00:00.000Z", "ci/stale-map.json");
    const d = tia(["src/core/alpha.ts"], ["--map", "ci/stale-map.json"]);
    expect(d.full).toBe(true);
    expect(d.reason).toMatch(/stale/);
    // …but a looser limit accepts the same map
    const ok = tia(
      ["src/core/alpha.ts"],
      ["--map", "ci/stale-map.json", "--max-age-days", "60"],
    );
    expect(ok.full).toBe(false);
  });

  it("falls back to the full suite when the map is missing", () => {
    const d = tia(["src/core/alpha.ts"], ["--map", "ci/nope.json"]);
    expect(d.full).toBe(true);
    expect(d.reason).toMatch(/no usable/);
  });

  it("prints the file list for xargs, and nothing at all for a full run", () => {
    const sel = plain(["src/core/alpha.ts"]).trim().split("\n");
    expect(sel).toContain("src/__tests__/alpha.test.ts");
    expect(sel.every((l) => l.endsWith(".test.ts"))).toBe(true);
    expect(plain(["package.json"])).toBe("");
  });
});
