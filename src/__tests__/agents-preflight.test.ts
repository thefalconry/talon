/**
 * The pre-flight lane, as the agent system sees it: which spawns get the
 * standing "preflight before push" instruction, and what `run_preflight`
 * answers for a green lane, a red one and a checkout without the script.
 *
 * `run_preflight` is exercised against a throwaway git repo whose
 * scripts/preflight.sh is a stub writing a canned .preflight/last.json — the
 * real lane takes minutes and is covered by running it, not by unit tests.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentPrompt, wantsPreflight } from "../core/agents/prompt.js";
import { agentHandlers } from "../core/engine/gateway-actions/agents/index.js";
import type { ActionResult } from "../core/types.js";

describe("wantsPreflight", () => {
  it("defaults on for briefs that mention a PR", () => {
    expect(wantsPreflight("Open ONE PR [feat/x] that fixes y")).toBe(true);
    expect(wantsPreflight("push the branch and open a pull request")).toBe(
      true,
    );
    expect(wantsPreflight("review PRs #12 and #13")).toBe(true);
  });

  it("defaults off otherwise — no false hit inside words", () => {
    expect(wantsPreflight("research flight prices to Lisbon")).toBe(false);
    expect(wantsPreflight("summarise the SPRING release notes")).toBe(false);
  });

  it("lets an explicit choice win either way", () => {
    expect(wantsPreflight("open a PR", false)).toBe(false);
    expect(wantsPreflight("tidy the notes folder", true)).toBe(true);
  });
});

describe("buildAgentPrompt", () => {
  it("appends the standing instruction after the brief when asked", () => {
    const prompt = buildAgentPrompt("do the thing", { preflight: true });
    expect(prompt.indexOf("do the thing")).toBeLessThan(
      prompt.indexOf("npm run preflight"),
    );
    expect(prompt).toContain("git push");
  });

  it("leaves the brief alone by default", () => {
    expect(buildAgentPrompt("do the thing")).not.toContain("preflight");
  });
});

describe("run_preflight", () => {
  let repo: string;

  function stubLane(summary: Record<string, unknown>, exit: number): void {
    mkdirSync(join(repo, "scripts"), { recursive: true });
    const json = JSON.stringify(summary).replace(/'/g, "'\\''");
    writeFileSync(
      join(repo, "scripts", "preflight.sh"),
      [
        "mkdir -p .preflight",
        `printf '%s' '${json}' > .preflight/last.json`,
        "printf 'src/x.ts(3,1): error TS2304\\n' > .preflight/typecheck.log",
        `exit ${exit}`,
      ].join("\n"),
    );
  }

  async function run(cwd: string): Promise<ActionResult> {
    const handler = agentHandlers.run_preflight;
    if (!handler) throw new Error("run_preflight is not registered");
    return (await handler(
      { action: "run_preflight", cwd },
      1,
      undefined,
      "1",
    )) as ActionResult;
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "talon-preflight-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports a green lane with its step table", async () => {
    stubLane(
      {
        verdict: "green",
        ok: true,
        base: "origin/main",
        totalMs: 42_000,
        failed: [],
        steps: [
          { name: "typecheck", status: "pass", ms: 3000 },
          {
            name: "gitleaks",
            status: "skipped",
            ms: 0,
            note: "gitleaks binary not installed",
          },
        ],
      },
      0,
    );
    const result = await run(repo);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("GREEN in 42s");
    expect(result.text).toContain("✓ typecheck (3s)");
    expect(result.text).toContain("· gitleaks — gitleaks binary not installed");
  });

  it("reports a red lane as a verdict, with the failing step's log tail", async () => {
    stubLane(
      {
        verdict: "red",
        ok: false,
        base: "origin/main",
        totalMs: 9_000,
        failed: ["typecheck"],
        steps: [{ name: "typecheck", status: "fail", ms: 3000 }],
      },
      1,
    );
    // From a subdirectory: the lane runs at the checkout's git root.
    mkdirSync(join(repo, "src"));
    const result = await run(join(repo, "src"));
    expect(result.ok).toBe(true);
    expect(result.text).toContain("RED in 9s — failed: typecheck");
    expect(result.text).toContain("error TS2304");
  });

  it("refuses a checkout without the lane, and a missing directory", async () => {
    const bare = await run(repo);
    expect(bare.ok).toBe(false);
    expect(bare.error).toContain(join("scripts", "preflight.sh"));

    const missing = await run(join(repo, "nope"));
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("does not exist");
  });

  it("says so when the lane dies without a summary", async () => {
    mkdirSync(join(repo, "scripts"));
    writeFileSync(
      join(repo, "scripts", "preflight.sh"),
      "echo 'node_modules missing' >&2; exit 1",
    );
    const result = await run(repo);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("without writing .preflight/last.json");
    expect(result.error).toContain("node_modules missing");
  });
});
