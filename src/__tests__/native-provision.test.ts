import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  compareVersions,
  expandHome,
  failDetail,
  findBasePython,
  loadProvisionState,
  provisionBackoffMs,
  saveProvisionState,
  shouldAttempt,
  type ExecFn,
  type ExecResult,
} from "../core/plugin/provision.js";
import {
  classifyExternalInstall,
  inspectMempalace,
  provisionMempalace,
  resolveMempalacePaths,
  MEMPALACE_PINNED_VERSION,
} from "../plugins/mempalace/provision.js";
import {
  browsersRoot,
  inspectPlaywright,
  provisionPlaywright,
} from "../plugins/playwright/provision.js";
import {
  githubMcpImageRef,
  inspectGithub,
  provisionGithubMcp,
  GITHUB_MCP_PINNED_TAG,
} from "../plugins/github/provision.js";
import { NATIVE_RUNTIMES } from "../core/plugin/native-runtimes.js";

/** Scripted exec double: first matching rule wins, calls recorded. */
function fakeExec(
  rules: Array<{
    match: (cmd: string, args: readonly string[]) => boolean;
    result: Partial<ExecResult>;
  }>,
): ExecFn & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const rule = rules.find((r) => r.match(cmd, args));
    if (!rule) return { ok: false, code: 1, stdout: "", stderr: "no rule" };
    return {
      ok: false,
      code: rule.result.ok ? 0 : 1,
      stdout: "",
      stderr: "",
      ...rule.result,
    };
  };
  return Object.assign(exec, { calls });
}

const has = (args: readonly string[], token: string) => args.includes(token);
const probeRule = (version: string) => ({
  match: (_c: string, a: readonly string[]) =>
    has(a, "-c") && String(a[a.length - 1]).includes("importlib.metadata"),
  result: { ok: true, stdout: `${version}\n` },
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "talon-provision-"));
}

describe("provision seam", () => {
  it("compares dotted versions numerically", () => {
    expect(compareVersions("3.8.0", "3.10.1")).toBeLessThan(0);
    expect(compareVersions("3.10.1", "3.8.0")).toBeGreaterThan(0);
    expect(compareVersions("3.8.0", "3.8.0")).toBe(0);
    expect(compareVersions("3.8", "3.8.0")).toBe(0);
  });

  it("expands ~ against the given home", () => {
    expect(expandHome("~/x", "/home/u")).toBe(resolve("/home/u", "x"));
    expect(expandHome("/abs/x", "/home/u")).toBe("/abs/x");
    expect(expandHome("~", "/home/u")).toBe("/home/u");
  });

  it("grows backoff exponentially and caps it", () => {
    expect(provisionBackoffMs(1)).toBe(5 * 60_000);
    expect(provisionBackoffMs(2)).toBe(10 * 60_000);
    expect(provisionBackoffMs(99)).toBe(6 * 60 * 60_000);
  });

  it("re-arms attempts on pin change, gates on recent failure", () => {
    const now = Date.now();
    const state = {
      pin: "3.8.0",
      lastFailureAt: new Date(now - 60_000).toISOString(),
      failureCount: 1,
    };
    expect(shouldAttempt(state, "3.8.0", now)).toBe(false);
    expect(shouldAttempt(state, "3.9.0", now)).toBe(true);
    expect(shouldAttempt(state, "3.8.0", now + 10 * 60_000)).toBe(true);
    expect(shouldAttempt({}, "3.8.0", now)).toBe(true);
  });

  it("round-trips state and tolerates junk", () => {
    const dir = tmp();
    const path = join(dir, "state.json");
    saveProvisionState(path, { pin: "1.0.0", failureCount: 2 });
    expect(loadProvisionState(path)).toMatchObject({
      pin: "1.0.0",
      failureCount: 2,
    });
    writeFileSync(path, "not json");
    expect(loadProvisionState(path)).toEqual({});
  });

  it("finds a base python meeting the version floor, in per-OS order", async () => {
    const exec = fakeExec([
      {
        match: (c) => c === "py",
        result: { ok: true, stdout: "3.9\n" },
      },
      {
        match: (c) => c === "python",
        result: { ok: true, stdout: "3.12\n" },
      },
    ]);
    const found = await findBasePython(exec, "win32", { major: 3, minor: 10 });
    expect(found).toMatchObject({ command: "python", version: "3.12" });
    expect(exec.calls[0].cmd).toBe("py");
  });

  it("skips a default python above the cap for a versioned one", async () => {
    const exec = fakeExec([
      {
        match: (c, a) => c === "py" && a[0] === "-3",
        result: { ok: true, stdout: "3.15\n" },
      },
      {
        match: (c, a) => c === "py" && a[0] === "-3.14",
        result: { ok: false, code: 1, stdout: "", stderr: "not installed" },
      },
      {
        match: (c, a) => c === "py" && a[0] === "-3.13",
        result: { ok: true, stdout: "3.13\n" },
      },
    ]);
    const found = await findBasePython(
      exec,
      "win32",
      { major: 3, minor: 10 },
      { major: 3, minor: 14 },
    );
    expect(found).toMatchObject({
      command: "py",
      args: ["-3.13"],
      version: "3.13",
    });
  });

  it("finds a versioned posix python when python3 is above the cap", async () => {
    const exec = fakeExec([
      {
        match: (c) => c === "python3",
        result: { ok: true, stdout: "3.15\n" },
      },
      {
        match: (c) => c === "python3.14",
        result: { ok: true, stdout: "3.14\n" },
      },
    ]);
    const found = await findBasePython(
      exec,
      "linux",
      { major: 3, minor: 10 },
      { major: 3, minor: 14 },
    );
    expect(found).toMatchObject({ command: "python3.14", version: "3.14" });
  });

  it("failDetail prefers spawn error, then stderr tail, then exit code", () => {
    expect(
      failDetail({
        ok: false,
        code: 1,
        stdout: "",
        stderr: "",
        error: "ENOENT",
      }),
    ).toBe("ENOENT");
    expect(
      failDetail({ ok: false, code: 1, stdout: "", stderr: "a\nlast line" }),
    ).toBe("last line");
  });
});

describe("mempalace provisioner", () => {
  const dir = () => {
    const d = tmp();
    return {
      root: d,
      venv: join(d, "mempalace-venv"),
      python: join(d, "mempalace-venv", "bin", "python"),
      palace: join(d, "palace"),
      state: join(d, "state.json"),
    };
  };

  it("classifies external install flavors from the interpreter path", () => {
    expect(
      classifyExternalInstall(
        "/home/u/.local/share/uv/tools/mempalace/bin/python",
      ),
    ).toBe("uv-tool");
    expect(
      classifyExternalInstall("/home/u/.local/pipx/venvs/mp/bin/python"),
    ).toBe("pipx");
    expect(classifyExternalInstall("/opt/miniconda3/envs/mp/bin/python")).toBe(
      "conda",
    );
    expect(classifyExternalInstall("/srv/venv/bin/python")).toBe("external");
  });

  it("never mutates an operator-managed install — advises instead", async () => {
    const p = dir();
    const uvPython = join(p.root, "uv", "tools", "mempalace", "bin", "python");
    const exec = fakeExec([probeRule("3.3.5")]);
    const outcome = await provisionMempalace(
      { pythonPath: uvPython, palacePath: p.palace },
      {
        exec,
        defaultManagedPython: p.python,
        statePath: p.state,
        pathExists: (x) => x === uvPython,
      },
    );
    expect(outcome.status).toBe("ready");
    expect(outcome.kind).toBe("uv-tool");
    expect(outcome.version).toBe("3.3.5");
    expect(outcome.warnings.join(" ")).toContain("uv tool install --force");
    // Only the probe ran — no pip, no venv.
    expect(exec.calls).toHaveLength(1);

    // Newer than the pin is drift too — same advisory, neutral wording.
    const ahead = await provisionMempalace(
      { pythonPath: uvPython, palacePath: p.palace },
      {
        exec: fakeExec([probeRule("99.0.0")]),
        defaultManagedPython: p.python,
        statePath: p.state,
        pathExists: (x) => x === uvPython,
      },
    );
    expect(ahead.status).toBe("ready");
    expect(ahead.warnings.join(" ")).toContain("reconcile with: uv tool");
  });

  it("fails an external install with a missing interpreter, with an install hint", async () => {
    const p = dir();
    const outcome = await provisionMempalace(
      { pythonPath: "/nope/python", palacePath: p.palace },
      {
        exec: fakeExec([]),
        defaultManagedPython: p.python,
        statePath: p.state,
        pathExists: () => false,
      },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.warnings.join(" ")).toContain("pip install");
  });

  it("managed venv healthy at pin: ready, no mutations, migration ledger honored", async () => {
    const p = dir();
    mkdirSync(p.palace, { recursive: true });
    writeFileSync(join(p.palace, "chroma.sqlite3"), "");
    const exec = fakeExec([
      probeRule(MEMPALACE_PINNED_VERSION),
      {
        match: (_c, a) => has(a, "migrate-wings"),
        result: {
          ok: true,
          stdout:
            "All wing names are already normalized -- nothing to migrate.\n",
        },
      },
    ]);
    const deps = {
      exec,
      defaultManagedPython: p.python,
      statePath: p.state,
      pathExists: (x: string) => x === p.python || x.endsWith("chroma.sqlite3"),
    };
    const first = await provisionMempalace(
      { pythonPath: p.python, palacePath: p.palace },
      deps,
    );
    expect(first.status).toBe("ready");
    expect(first.version).toBe(MEMPALACE_PINNED_VERSION);
    expect(first.actions.join(" ")).toContain("wing-name migration");

    // Second pass: ledger recorded, migration not re-run.
    const before = exec.calls.length;
    const second = await provisionMempalace(
      { pythonPath: p.python, palacePath: p.palace },
      deps,
    );
    expect(second.actions).toHaveLength(0);
    const newCalls = exec.calls.slice(before);
    expect(newCalls.some((c) => has(c.args, "migrate-wings"))).toBe(false);
  });

  it("healthy-but-behind upgrades in the background and keeps serving", async () => {
    const p = dir();
    let probeVersion = "3.3.5";
    const exec = fakeExec([
      {
        match: (_c, a) =>
          has(a, "-c") &&
          String(a[a.length - 1]).includes("importlib.metadata"),
        get result() {
          return { ok: true, stdout: `${probeVersion}\n` };
        },
      },
      {
        match: (_c, a) => has(a, "pip") && has(a, "install"),
        result: { ok: true },
      },
    ]);
    const outcome = await provisionMempalace(
      { pythonPath: p.python, palacePath: p.palace },
      {
        exec,
        defaultManagedPython: p.python,
        statePath: p.state,
        pathExists: (x) => x === p.python,
      },
    );
    expect(outcome.status).toBe("ready");
    expect(outcome.version).toBe("3.3.5");
    expect(outcome.background).toBeDefined();
    // Nothing installed yet — boot did not block on pip.
    expect(exec.calls.some((c) => has(c.args, "pip"))).toBe(false);

    probeVersion = MEMPALACE_PINNED_VERSION;
    const upgraded = await outcome.background!();
    expect(upgraded.status).toBe("ready");
    expect(upgraded.actions.join(" ")).toContain(
      `upgraded mempalace 3.3.5 → ${MEMPALACE_PINNED_VERSION}`,
    );
    const pip = exec.calls.find((c) => has(c.args, "pip"));
    expect(pip?.args).toContain(`mempalace==${MEMPALACE_PINNED_VERSION}`);
    expect(pip?.args).not.toContain("--force-reinstall");
  });

  it("broken install heals with --force-reinstall, blocking", async () => {
    const p = dir();
    let healed = false;
    const exec = fakeExec([
      {
        match: (_c, a) =>
          has(a, "-c") &&
          String(a[a.length - 1]).includes("importlib.metadata"),
        get result() {
          return healed
            ? { ok: true, stdout: `${MEMPALACE_PINNED_VERSION}\n` }
            : { ok: false, stderr: "ModuleNotFoundError: mempalace" };
        },
      },
      {
        match: (_c, a) => has(a, "pip") && has(a, "install"),
        get result() {
          healed = true;
          return { ok: true };
        },
      },
    ]);
    const outcome = await provisionMempalace(
      { pythonPath: p.python, palacePath: p.palace },
      {
        exec,
        defaultManagedPython: p.python,
        statePath: p.state,
        pathExists: (x) => x === p.python,
      },
    );
    expect(outcome.status).toBe("ready");
    const pip = exec.calls.find((c) => has(c.args, "pip"));
    expect(pip?.args).toContain("--force-reinstall");
  });

  it("missing venv: creates it with a base python, then installs (win32 shape too)", async () => {
    const p = dir();
    const winPython = join(p.root, "mempalace-venv", "Scripts", "python.exe");
    let venvCreated = false;
    const exec = fakeExec([
      {
        match: (c, a) => c === "py" && has(a, "venv"),
        get result() {
          venvCreated = true;
          return { ok: true };
        },
      },
      {
        match: (c) => c === "py",
        result: { ok: true, stdout: "3.12\n" },
      },
      {
        match: (_c, a) => has(a, "pip") && has(a, "install"),
        result: { ok: true },
      },
      probeRule(MEMPALACE_PINNED_VERSION),
    ]);
    const outcome = await provisionMempalace(
      { pythonPath: winPython, palacePath: p.palace },
      {
        exec,
        platform: "win32",
        defaultManagedPython: winPython,
        statePath: p.state,
        pathExists: (x) => (x === winPython ? venvCreated : false),
      },
    );
    expect(outcome.status).toBe("ready");
    expect(outcome.actions.join(" ")).toContain("created venv");
    expect(outcome.actions.join(" ")).toContain(
      `installed mempalace ${MEMPALACE_PINNED_VERSION}`,
    );
    const venvCall = exec.calls.find((c) => has(c.args, "venv"));
    expect(venvCall?.cmd).toBe("py");
    expect(venvCall?.args).toContain("--clear");
  });

  it("failed upgrade keeps the working install and records backoff", async () => {
    const p = dir();
    const exec = fakeExec([
      probeRule("3.3.5"),
      {
        match: (_c, a) => has(a, "pip") || has(a, "ensurepip"),
        result: { ok: false, stderr: "network unreachable" },
      },
    ]);
    const deps = {
      exec,
      defaultManagedPython: p.python,
      statePath: p.state,
      pathExists: (x: string) => x === p.python || x === p.venv,
    };
    const outcome = await provisionMempalace(
      { pythonPath: p.python, palacePath: p.palace },
      deps,
    );
    const settled = await outcome.background!();
    expect(settled.status).toBe("degraded");
    expect(settled.version).toBe("3.3.5");
    expect(settled.warnings.join(" ")).toContain("staying on working 3.3.5");
    expect(loadProvisionState(p.state).failureCount).toBe(1);

    // Next pass inside the backoff window: no new pip attempt.
    const before = exec.calls.length;
    const gated = await provisionMempalace(
      { pythonPath: p.python, palacePath: p.palace },
      deps,
    );
    expect(gated.status).toBe("degraded");
    expect(gated.background).toBeUndefined();
    expect(exec.calls.slice(before).some((c) => has(c.args, "pip"))).toBe(
      false,
    );
  });

  it("autoProvision:false still reconciles a healthy drifted venv (autoUpdate is independent)", async () => {
    const p = dir();
    const exec = fakeExec([
      probeRule("3.3.5"),
      { match: (_c, a) => has(a, "pip"), result: { ok: true } },
    ]);
    const outcome = await provisionMempalace(
      { pythonPath: p.python, palacePath: p.palace, autoProvision: false },
      {
        exec,
        defaultManagedPython: p.python,
        statePath: p.state,
        pathExists: (x) => x === p.python,
      },
    );
    expect(outcome.status).toBe("ready");
    expect(outcome.background).toBeDefined();

    // …but never creates or heals: a broken venv stays broken, reported.
    const broken = await provisionMempalace(
      { pythonPath: p.python, palacePath: p.palace, autoProvision: false },
      {
        exec: fakeExec([]),
        defaultManagedPython: p.python,
        statePath: p.state,
        pathExists: () => false,
      },
    );
    expect(broken.status).toBe("failed");
    expect(broken.warnings.join(" ")).toContain("autoProvision is off");
  });

  it("rolls back when a failed upgrade leaves the venv broken", async () => {
    const p = dir();
    let installed = "3.3.5";
    let upgradeAttempts = 0;
    const exec = fakeExec([
      {
        match: (_c, a) =>
          has(a, "-c") &&
          String(a[a.length - 1]).includes("importlib.metadata"),
        get result() {
          return installed
            ? { ok: true, stdout: `${installed}\n` }
            : { ok: false, stderr: "ModuleNotFoundError: mempalace" };
        },
      },
    ]);
    // Script pip by hand: the upgrade dies mid-mutation (install gone),
    // the rollback reinstalls the previous version.
    const scripted: ExecFn = async (cmd, args, opts) => {
      if (has(args, "pip") && has(args, "install")) {
        const spec = String(args[args.length - 1]);
        if (spec === "mempalace==3.3.5" && has(args, "--force-reinstall")) {
          installed = "3.3.5";
          return { ok: true, code: 0, stdout: "", stderr: "" };
        }
        upgradeAttempts++;
        installed = "";
        return { ok: false, code: 1, stdout: "", stderr: "killed" };
      }
      if (has(args, "ensurepip")) {
        return { ok: true, code: 0, stdout: "", stderr: "" };
      }
      return exec(cmd, args, opts);
    };
    const outcome = await provisionMempalace(
      { pythonPath: p.python, palacePath: p.palace },
      {
        exec: scripted,
        defaultManagedPython: p.python,
        statePath: p.state,
        pathExists: (x) => x === p.python || x === p.venv,
      },
    );
    const settled = await outcome.background!();
    expect(settled.status).toBe("degraded");
    expect(settled.version).toBe("3.3.5");
    expect(settled.warnings.join(" ")).toContain("rolled back");
    expect(upgradeAttempts).toBeGreaterThan(0);
    expect(installed).toBe("3.3.5");
  });

  it("skips the wing-name migration when the serving version predates it", async () => {
    const p = dir();
    mkdirSync(p.palace, { recursive: true });
    writeFileSync(join(p.palace, "chroma.sqlite3"), "");
    const exec = fakeExec([probeRule("3.3.6")]);
    const outcome = await provisionMempalace(
      { pythonPath: p.python, palacePath: p.palace, version: "3.3.6" },
      {
        exec,
        defaultManagedPython: p.python,
        statePath: p.state,
        pathExists: (x) => x === p.python || x.endsWith("chroma.sqlite3"),
      },
    );
    expect(outcome.status).toBe("ready");
    expect(exec.calls.some((c) => has(c.args, "migrate-wings"))).toBe(false);
    expect(outcome.warnings).toHaveLength(0);
  });

  it("autoUpdate:false reports drift without reconciling", async () => {
    const p = dir();
    const exec = fakeExec([probeRule("3.3.5")]);
    const outcome = await provisionMempalace(
      { pythonPath: p.python, palacePath: p.palace, autoUpdate: false },
      {
        exec,
        defaultManagedPython: p.python,
        statePath: p.state,
        pathExists: (x) => x === p.python,
      },
    );
    expect(outcome.status).toBe("ready");
    expect(outcome.background).toBeUndefined();
    expect(outcome.warnings.join(" ")).toContain("autoUpdate is off");
  });

  it("resolveMempalacePaths applies defaults and expands ~", () => {
    const { pythonPath, palacePath } = resolveMempalacePaths(
      { pythonPath: "~/venv/bin/python" },
      "/home/u",
    );
    expect(pythonPath).toBe(resolve("/home/u", "venv/bin/python"));
    expect(palacePath).toContain(`${sep}palace`);
  });

  it("inspect reports drift as reconciling for managed, advisory for external", async () => {
    const p = dir();
    const exec = fakeExec([probeRule("3.3.5")]);
    const managed = await inspectMempalace(
      { pythonPath: p.python },
      {
        exec,
        defaultManagedPython: p.python,
        pathExists: (x) => x === p.python,
      },
    );
    expect(managed[0].status).toBe("warn");
    expect(managed[0].detail).toContain("next talon start");

    const external = await inspectMempalace(
      { pythonPath: "/srv/venv/bin/python" },
      {
        exec: fakeExec([probeRule("3.3.5")]),
        defaultManagedPython: p.python,
        pathExists: () => true,
      },
    );
    expect(external[0].issue).toBeFalsy();
    expect(external[0].detail).toContain("pip install --upgrade");

    // Disabled automation is reported as such — never a promised restart fix.
    const updateOff = await inspectMempalace(
      { pythonPath: p.python, autoUpdate: false },
      {
        exec: fakeExec([probeRule("3.3.5")]),
        defaultManagedPython: p.python,
        pathExists: (x) => x === p.python,
      },
    );
    expect(updateOff[0].detail).toContain("autoUpdate: false");
    expect(updateOff[0].detail).toContain("pip install");

    const missingOff = await inspectMempalace(
      { pythonPath: p.python, autoProvision: false },
      {
        exec: fakeExec([]),
        defaultManagedPython: p.python,
        pathExists: () => false,
      },
    );
    expect(missingOff[0].status).toBe("fail");
    expect(missingOff[0].detail).toContain("autoProvision: false");

    const brokenOff = await inspectMempalace(
      { pythonPath: p.python, autoProvision: false },
      {
        exec: fakeExec([]),
        defaultManagedPython: p.python,
        pathExists: (x) => x === p.python,
      },
    );
    expect(brokenOff[0].status).toBe("fail");
    expect(brokenOff[0].detail).toContain("repair manually");
  });
});

/** A playwright-core registry fixture: chromium ships with its headless shell. */
const REGISTRY = [
  { name: "chromium", revision: "1181" },
  { name: "chromium-headless-shell", revision: "1181" },
  { name: "firefox", revision: "1500" },
  {
    name: "webkit",
    revision: "2342",
    revisionOverrides: { mac14: "2251" },
  },
];
const COMPLETE = (p: string) => p.endsWith("INSTALLATION_COMPLETE");

describe("playwright provisioner", () => {
  it("skips endpoint mode and system channels", async () => {
    expect(
      (await provisionPlaywright({ browser: "chromium", endpoint: "ws://x" }))
        .status,
    ).toBe("skipped");
    expect((await provisionPlaywright({ browser: "msedge" })).status).toBe(
      "skipped",
    );
    expect(
      (await provisionPlaywright({ browser: "chromium", autoProvision: false }))
        .status,
    ).toBe("skipped");
  });

  it("is a no-op when the required revisions are present and complete", async () => {
    const exec = fakeExec([]);
    const outcome = await provisionPlaywright(
      { browser: "chromium" },
      {
        exec,
        registry: REGISTRY,
        listDir: () => [
          "chromium-1181",
          "chromium_headless_shell-1181",
          "ffmpeg-1010",
        ],
        pathExists: COMPLETE,
      },
    );
    expect(outcome.status).toBe("ready");
    expect(exec.calls).toHaveLength(0);
  });

  it("treats a stale revision, a missing headless shell, or an incomplete download as absent", async () => {
    const d = tmp();
    const run = (listDir: () => string[], pathExists = COMPLETE) =>
      provisionPlaywright(
        { browser: "chromium" },
        {
          exec: fakeExec([
            { match: (_c, a) => has(a, "install"), result: { ok: true } },
          ]),
          registry: REGISTRY,
          listDir,
          pathExists: (p) => p.endsWith("cli.js") || pathExists(p),
          cliPath: "/repo/node_modules/playwright-core/cli.js",
          statePath: join(d, "state.json"),
        },
      );
    // Older playwright-core's build only.
    expect(
      (await run(() => ["chromium-1100", "chromium_headless_shell-1100"]))
        .actions,
    ).toHaveLength(1);
    // Headed build present, headless shell missing.
    expect((await run(() => ["chromium-1181"])).actions).toHaveLength(1);
    // Both dirs exist but one download never finished.
    expect(
      (
        await run(
          () => ["chromium-1181", "chromium_headless_shell-1181"],
          (p) => COMPLETE(p) && !p.includes("headless"),
        )
      ).actions,
    ).toHaveLength(1);
  });

  it("accepts a per-platform revision override build", async () => {
    const outcome = await provisionPlaywright(
      { browser: "webkit" },
      {
        exec: fakeExec([]),
        registry: REGISTRY,
        listDir: () => ["webkit_mac14_special-2251"],
        pathExists: COMPLETE,
      },
    );
    expect(outcome.status).toBe("ready");
  });

  it("forwards the injected environment to the CLI", async () => {
    const d = tmp();
    const seen: Array<Record<string, string> | undefined> = [];
    const exec: ExecFn = async (_c, _a, opts) => {
      seen.push(opts.env);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    };
    await provisionPlaywright(
      { browser: "chromium" },
      {
        exec,
        registry: REGISTRY,
        listDir: () => [],
        cliPath: "/x/cli.js",
        pathExists: () => true,
        statePath: join(d, "state.json"),
        env: { PLAYWRIGHT_BROWSERS_PATH: "/isolated", DROPPED: undefined },
      },
    );
    expect(seen[0]).toEqual({ PLAYWRIGHT_BROWSERS_PATH: "/isolated" });
  });

  it("downloads a missing build via the bundled CLI", async () => {
    const d = tmp();
    const state = join(d, "state.json");
    const exec = fakeExec([
      { match: (_c, a) => has(a, "install"), result: { ok: true } },
    ]);
    const outcome = await provisionPlaywright(
      { browser: "firefox" },
      {
        exec,
        listDir: () => [],
        cliPath: "/repo/node_modules/playwright-core/cli.js",
        pathExists: () => true,
        statePath: state,
      },
    );
    expect(outcome.status).toBe("ready");
    expect(outcome.actions.join(" ")).toContain("firefox");
    expect(exec.calls[0].args).toEqual([
      "/repo/node_modules/playwright-core/cli.js",
      "install",
      "firefox",
    ]);
  });

  it("degrades with a root-needing hint when system libraries are missing", async () => {
    const d = tmp();
    const state = join(d, "state.json");
    const exec = fakeExec([
      {
        match: (_c, a) => has(a, "install"),
        result: {
          ok: false,
          stderr: "Host system is missing dependencies to run browsers",
        },
      },
    ]);
    const outcome = await provisionPlaywright(
      { browser: "chromium" },
      {
        exec,
        listDir: () => [],
        cliPath: "/x/cli.js",
        pathExists: () => true,
        statePath: state,
      },
    );
    expect(outcome.status).toBe("degraded");
    expect(outcome.warnings.join(" ")).toContain("install-deps");
    expect(loadProvisionState(state).failureCount).toBe(1);
  });

  it("resolves the browsers root per OS with env overrides", () => {
    expect(browsersRoot("linux", "/h", {})).toBe(
      join("/h", ".cache", "ms-playwright"),
    );
    expect(browsersRoot("darwin", "/h", {})).toBe(
      join("/h", "Library", "Caches", "ms-playwright"),
    );
    expect(
      browsersRoot("linux", "/h", { PLAYWRIGHT_BROWSERS_PATH: "/custom" }),
    ).toBe("/custom");
  });

  it("inspect mirrors presence without executing anything", () => {
    expect(
      inspectPlaywright(
        { browser: "chromium" },
        {
          registry: REGISTRY,
          listDir: () => ["chromium-1181", "chromium_headless_shell-1181"],
          pathExists: COMPLETE,
        },
      )[0].status,
    ).toBe("ok");
    const missing = inspectPlaywright(
      { browser: "chromium" },
      { registry: REGISTRY, listDir: () => [] },
    )[0];
    expect(missing.status).toBe("warn");
    expect(missing.detail).toContain("next talon start");
    const off = inspectPlaywright(
      { browser: "chromium", autoProvision: false },
      { registry: REGISTRY, listDir: () => [] },
    )[0];
    expect(off.detail).toContain("autoProvision: false");
    expect(off.detail).toContain("npx playwright install chromium");
    expect(inspectPlaywright({ endpoint: "ws://x" })[0].status).toBe("info");
  });
});

describe("github provisioner", () => {
  it("pins the image tag by default", () => {
    expect(githubMcpImageRef()).toBe(
      `ghcr.io/github/github-mcp-server:${GITHUB_MCP_PINNED_TAG}`,
    );
    expect(githubMcpImageRef("latest")).toBe(
      "ghcr.io/github/github-mcp-server:latest",
    );
  });

  it("is ready when the image is present, fails hard without docker", async () => {
    const ready = await provisionGithubMcp(
      {},
      {
        exec: fakeExec([
          { match: (_c, a) => has(a, "inspect"), result: { ok: true } },
        ]),
      },
    );
    expect(ready.status).toBe("ready");

    const noDocker = await provisionGithubMcp(
      {},
      {
        exec: fakeExec([
          { match: () => true, result: { ok: false, error: "ENOENT" } },
        ]),
      },
    );
    expect(noDocker.status).toBe("failed");
  });

  it("pulls a missing image in the background and records failures for backoff", async () => {
    const d = tmp();
    const state = join(d, "state.json");
    const exec = fakeExec([
      { match: (_c, a) => has(a, "inspect"), result: { ok: false } },
      {
        match: (_c, a) => has(a, "pull"),
        result: { ok: false, stderr: "TLS handshake timeout" },
      },
    ]);
    const outcome = await provisionGithubMcp({}, { exec, statePath: state });
    expect(outcome.status).toBe("degraded");
    expect(outcome.background).toBeDefined();
    const settled = await outcome.background!();
    expect(settled.status).toBe("degraded");
    expect(loadProvisionState(state).failureCount).toBe(1);
  });
});

describe("github doctor", () => {
  it("counts a missing image as an issue and reflects disabled auto-pull", async () => {
    const exec = fakeExec([
      { match: (_c, a) => has(a, "inspect"), result: { ok: false } },
    ]);
    const auto = (await inspectGithub({}, { exec }))[0];
    expect(auto.issue).toBe(true);
    expect(auto.detail).toContain("next talon start");
    const off = (await inspectGithub({ autoProvision: false }, { exec }))[0];
    expect(off.issue).toBe(true);
    expect(off.detail).toContain("docker pull");
  });
});

describe("native runtime registry", () => {
  it("gates each runtime on its enabled flag", () => {
    const ids = NATIVE_RUNTIMES.map((r) => r.id);
    expect(ids).toEqual(["mempalace", "playwright", "github"]);
    for (const rt of NATIVE_RUNTIMES) {
      expect(rt.enabled(undefined)).toBe(false);
      expect(rt.enabled({})).toBe(false);
      expect(rt.enabled({ [rt.id]: { enabled: true } })).toBe(true);
    }
  });
});

describe("provision journal", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function freshJournal() {
    const home = tmp();
    process.env.TALON_HOME = home;
    mkdirSync(join(home, "data"), { recursive: true });
    const journal = await import("../core/plugin/provision-journal.js");
    return { home, journal };
  }

  it("records events, arms a report, and delivers only when something changed", async () => {
    const { journal } = await freshJournal();
    journal.armProvisionReport("telegram", "42");
    journal.recordProvisionEvents("mempalace", [
      "upgraded mempalace 3.3.5 → 3.8.0",
    ]);

    const sent: string[] = [];
    await journal.deliverPendingProvisionReport(
      async (frontend, target, text) => {
        sent.push(`${frontend}:${target}:${text}`);
        return true;
      },
      async () => {},
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("telegram:42:");
    expect(sent[0]).toContain("upgraded mempalace 3.3.5 → 3.8.0");

    // Marker consumed — a second delivery is a no-op.
    await journal.deliverPendingProvisionReport(async () => {
      throw new Error("should not send");
    });
  });

  it("waits for tracked background provisioning before reporting", async () => {
    const { journal } = await freshJournal();
    journal.armProvisionReport("telegram", "9");
    let finish!: () => void;
    const upgrade = new Promise<void>((r) => {
      finish = r;
    });
    void journal.trackBackgroundProvision(
      upgrade.then(() =>
        journal.recordProvisionEvents("mempalace", ["upgraded 3.3.5 → 3.8.0"]),
      ),
    );

    const sent: string[] = [];
    let ticks = 0;
    const delivery = journal.deliverPendingProvisionReport(
      async (_f, _t, text) => {
        sent.push(text);
        return true;
      },
      async () => {
        // The first sleep is the "still running" wait; let the task land.
        if (ticks++ === 0) {
          finish();
          await upgrade;
          await new Promise((r) => setImmediate(r));
        }
      },
    );
    await delivery;
    expect(journal.backgroundProvisionInFlight()).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("upgraded 3.3.5 → 3.8.0");
  });

  it("stays silent when nothing changed and retries a busy frontend", async () => {
    const { journal } = await freshJournal();
    journal.armProvisionReport("discord", "7");
    // No events → no message.
    let sends = 0;
    await journal.deliverPendingProvisionReport(async () => {
      sends++;
      return true;
    });
    expect(sends).toBe(0);

    journal.armProvisionReport("discord", "7");
    journal.recordProvisionEvents("github", ["pulled image"]);
    const attempts: number[] = [];
    await journal.deliverPendingProvisionReport(
      async () => {
        attempts.push(1);
        return attempts.length >= 3;
      },
      async () => {},
    );
    expect(attempts.length).toBe(3);
  });
});

describe("provision state file locations", () => {
  it("does not exist until a provisioner persists something", () => {
    expect(existsSync(join(tmp(), "data", "mempalace-provision.json"))).toBe(
      false,
    );
  });
});
