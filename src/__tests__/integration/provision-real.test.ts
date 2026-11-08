/**
 * Real-environment provisioning suite — the teeth behind the
 * native-provision workflow (.github/workflows/native-provision.yml).
 *
 * Everything here hits the network and real interpreters, so the whole
 * file is gated behind env flags and skipped in the normal unit run:
 *
 *   TALON_PROVISION_REAL=1            mempalace venv scenarios (all OSes)
 *   TALON_PROVISION_TARGET=latest     canary: provision PyPI latest instead of the pin
 *   TALON_PROVISION_REAL_PLAYWRIGHT=1 real browser download scenario
 *   TALON_PROVISION_REAL_DOCKER=1     real image pull scenario (needs docker)
 *   TALON_PROVISION_GITHUB_TAG        canary override for the image tag
 *
 * Scenarios mirror the provisioner's real-life duties: fresh install →
 * live MCP handshake, self-heal from a gutted site-packages, and a
 * genuine 3.3.6 → pin upgrade with the palace migration wired through.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findBasePython,
  runStep,
  venvPython,
  type ProvisionOutcome,
} from "../../core/plugin/provision.js";
import {
  provisionMempalace,
  MEMPALACE_PINNED_VERSION,
} from "../../plugins/mempalace/provision.js";
import { createMempalacePlugin } from "../../plugins/mempalace/index.js";
import { provisionPlaywright } from "../../plugins/playwright/provision.js";
import { createPlaywrightPlugin } from "../../plugins/playwright/index.js";
import { createGitHubPlugin } from "../../plugins/github/index.js";
import {
  currentRuntime,
  talonSelfInvocation,
  withPluginMcp,
} from "./mcp-stdio-probe.js";
import {
  provisionGithubMcp,
  githubMcpImageRef,
} from "../../plugins/github/provision.js";

const REAL = process.env.TALON_PROVISION_REAL === "1";
const REAL_PLAYWRIGHT = process.env.TALON_PROVISION_REAL_PLAYWRIGHT === "1";
const REAL_DOCKER = process.env.TALON_PROVISION_REAL_DOCKER === "1";

const INSTALL_TIMEOUT = 20 * 60_000;

const detail = (o: ProvisionOutcome): string =>
  `status=${o.status} error=${o.error ?? "-"} warnings=[${o.warnings.join("; ")}] actions=[${o.actions.join("; ")}]`;

async function resolveTarget(): Promise<string> {
  if (process.env.TALON_PROVISION_TARGET !== "latest") {
    return process.env.TALON_PROVISION_TARGET ?? MEMPALACE_PINNED_VERSION;
  }
  const res = await fetch("https://pypi.org/pypi/mempalace/json");
  const data = (await res.json()) as { info: { version: string } };
  return data.info.version;
}

/** A memory stored through MCP and expected back from search, verbatim. */
const MEMORY = "The provisioning canary bumps pins only when green.";

/**
 * Every MCP session below runs under Talon's `_mcp-launch` supervisor on
 * the runtime executing this file — the production chain for a source
 * run, and the one piece that differs between node and bun.
 */
const SESSION = { supervise: true } as const;

describe("runtime under test", () => {
  it("is the runtime the CI job claims (TALON_EXPECT_RUNTIME)", () => {
    const expected = process.env.TALON_EXPECT_RUNTIME;
    if (expected) expect(currentRuntime()).toBe(expected);
    // The supervisor re-invocation must point at this repo's CLI on the
    // same runtime, never at the test runner.
    const [command, ...args] = talonSelfInvocation();
    expect(command).toBe(process.execPath);
    expect(args.at(-1)).toMatch(/src[\\/]cli\.ts$/);
  });
});

describe.skipIf(!REAL)("mempalace real provisioning", () => {
  it(
    "fresh install → pinned version → live MCP handshake → self-heal",
    { timeout: 2 * INSTALL_TIMEOUT },
    async () => {
      const target = await resolveTarget();
      const home = mkdtempSync(join(tmpdir(), "talon-prov-fresh-"));
      const venvDir = join(home, "mempalace-venv");
      const python = venvPython(venvDir, process.platform);
      const palace = join(home, "palace");
      const statePath = join(home, "state.json");
      const opts = {
        pythonPath: python,
        palacePath: palace,
        version: target,
      };
      const deps = { defaultManagedPython: python, statePath };

      // Fresh: no venv at all → created, installed, verified.
      const fresh = await provisionMempalace(opts, deps);
      expect(fresh.status, detail(fresh)).toBe("ready");
      expect(fresh.version).toBe(target);
      expect(fresh.actions.join(" ")).toContain("created venv");

      // Idempotent second pass: nothing to do.
      const again = await provisionMempalace(opts, deps);
      expect(again.status, detail(again)).toBe("ready");
      expect(again.actions).toHaveLength(0);

      // The runtime actually serves MCP, driven exactly as Talon drives
      // it (the plugin's own command/args/env): store a memory, search it
      // back. The first search loads the embedder, so the timeout is wide.
      await withPluginMcp(
        createMempalacePlugin({ pythonPath: python, palacePath: palace }),
        async (mcp) => {
          expect(mcp.tools).toEqual(
            expect.arrayContaining([
              "mempalace_add_drawer",
              "mempalace_search",
            ]),
          );
          const added = await mcp.callText("mempalace_add_drawer", {
            wing: "talon-ci",
            room: "decisions",
            content: MEMORY,
          });
          expect(added).toContain('"success": true');
          const found = await mcp.callText("mempalace_search", {
            query: "when does the canary bump pins",
            limit: 3,
          });
          expect(found).toContain(MEMORY);
        },
        { ...SESSION, timeoutMs: 10 * 60_000 },
      );

      // The palace now holds data, so the next pass applies the one-time
      // wing-name migration — and only once (ledgered), never again.
      const migrated = await provisionMempalace(opts, deps);
      expect(migrated.status, detail(migrated)).toBe("ready");
      expect(migrated.actions.join(" ")).toContain("wing-name migration");
      const ledgered = await provisionMempalace(opts, deps);
      expect(ledgered.actions, detail(ledgered)).toHaveLength(0);

      // Self-heal: gut site-packages and expect a working reinstall.
      const purelib = await runStep(
        python,
        ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
        { timeoutMs: 30_000 },
      );
      expect(purelib.ok).toBe(true);
      rmSync(join(purelib.stdout.trim(), "mempalace"), {
        recursive: true,
        force: true,
      });
      const healed = await provisionMempalace(opts, deps);
      expect(healed.status, detail(healed)).toBe("ready");
      expect(healed.version).toBe(target);
      expect(healed.actions.join(" ")).toContain(
        `installed mempalace ${target}`,
      );

      rmSync(home, { recursive: true, force: true });
    },
  );

  it(
    "3.3.6 → pin upgrade migrates the palace exactly once",
    { timeout: 2 * INSTALL_TIMEOUT },
    async () => {
      const target = await resolveTarget();
      const home = mkdtempSync(join(tmpdir(), "talon-prov-upgrade-"));
      const venvDir = join(home, "mempalace-venv");
      const python = venvPython(venvDir, process.platform);
      const palace = join(home, "palace");
      const statePath = join(home, "state.json");

      // Seed a genuine old install the way a pre-provisioner deployment had it.
      const base = await findBasePython(runStep, process.platform, {
        major: 3,
        minor: 10,
      });
      expect(base).toBeDefined();
      const venv = await runStep(
        base!.command,
        [...base!.args, "-m", "venv", venvDir],
        { timeoutMs: 120_000 },
      );
      expect(venv.ok).toBe(true);
      const old = await runStep(
        python,
        ["-m", "pip", "install", "mempalace==3.3.6"],
        { timeoutMs: INSTALL_TIMEOUT },
      );
      expect(old.ok).toBe(true);

      // A palace with a store present arms the one-time wing migration.
      mkdirSync(palace, { recursive: true });
      writeFileSync(join(palace, "chroma.sqlite3"), "");

      const outcome = await provisionMempalace(
        { pythonPath: python, palacePath: palace, version: target },
        { defaultManagedPython: python, statePath },
      );
      // A healthy-but-behind install reconciles in the background.
      expect(outcome.status, detail(outcome)).toBe("ready");
      expect(outcome.version).toBe("3.3.6");
      expect(outcome.background).toBeDefined();
      const settled = await outcome.background!();
      expect(settled.status, detail(settled)).toBe("ready");
      expect(settled.version).toBe(target);
      expect(settled.actions.join(" ")).toContain(
        `upgraded mempalace 3.3.6 → ${target}`,
      );
      expect(settled.actions.join(" ")).toContain("wing-name migration");

      rmSync(home, { recursive: true, force: true });
    },
  );
});

describe.skipIf(!REAL_PLAYWRIGHT)("playwright real provisioning", () => {
  it(
    "downloads the chromium build into an isolated cache",
    { timeout: INSTALL_TIMEOUT },
    async () => {
      const home = mkdtempSync(join(tmpdir(), "talon-prov-pw-"));
      const browsers = join(home, "browsers");
      const outcome = await provisionPlaywright(
        { browser: "chromium" },
        {
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
          statePath: join(home, "state.json"),
        },
      );
      expect(outcome.status, detail(outcome)).toBe("ready");
      expect(outcome.actions.join(" ")).toContain("chromium");

      // Second pass sees the build and does nothing.
      const again = await provisionPlaywright(
        { browser: "chromium" },
        {
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
          statePath: join(home, "state.json"),
        },
      );
      expect(again.status, detail(again)).toBe("ready");
      expect(again.actions).toHaveLength(0);

      // The build actually launches under @playwright/mcp with the
      // plugin's own args (headless, no-sandbox): navigate, read the page.
      await withPluginMcp(
        createPlaywrightPlugin({ browser: "chromium", headless: true }),
        async (mcp) => {
          expect(mcp.tools).toEqual(
            expect.arrayContaining(["browser_navigate", "browser_snapshot"]),
          );
          await mcp.callText("browser_navigate", {
            url: "data:text/html,<title>Talon Probe</title><h1>talon-provision-ci</h1>",
          });
          const snapshot = await mcp.callText("browser_snapshot", {});
          expect(snapshot).toContain("talon-provision-ci");
        },
        { ...SESSION, extraEnv: { PLAYWRIGHT_BROWSERS_PATH: browsers } },
      );

      rmSync(home, { recursive: true, force: true });
    },
  );
});

describe.skipIf(!REAL_DOCKER)("github mcp real provisioning", () => {
  it(
    "pulls the pinned image and the binary answers",
    { timeout: INSTALL_TIMEOUT },
    async () => {
      const home = mkdtempSync(join(tmpdir(), "talon-prov-gh-"));
      const imageTag = process.env.TALON_PROVISION_GITHUB_TAG;
      const outcome = await provisionGithubMcp(
        { imageTag },
        { statePath: join(home, "state.json") },
      );
      // Either already present (ready) or pulled by the background task.
      const settled = outcome.background ? await outcome.background() : outcome;
      expect(settled.status, detail(settled)).toBe("ready");

      const help = await runStep(
        "docker",
        ["run", "--rm", githubMcpImageRef(imageTag), "--help"],
        { timeoutMs: 120_000 },
      );
      expect(help.ok).toBe(true);

      // A real stdio session through the plugin's docker command line;
      // with a token (CI's GITHUB_TOKEN) a read-only call round-trips to
      // the API for the repository under test.
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      await withPluginMcp(
        createGitHubPlugin({ token, imageTag }),
        async (mcp) => {
          expect(mcp.tools).toContain("get_file_contents");
          if (!token) return;
          const [owner, repo] = (
            process.env.GITHUB_REPOSITORY ?? "thefalconry/talon"
          ).split("/");
          const pkg = await mcp.callText("get_file_contents", {
            owner,
            repo,
            path: "package.json",
          });
          expect(pkg).toContain('"name"');
        },
        SESSION,
      );

      rmSync(home, { recursive: true, force: true });
    },
  );
});
