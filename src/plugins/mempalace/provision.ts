/**
 * MemPalace provisioner — self-installing, self-healing Python runtime.
 *
 * Talon owns exactly one environment: the venv at ~/.talon/mempalace-venv
 * (the default `pythonPath`). That env is created on first boot, kept on
 * the pinned mempalace version, healed when broken, and carried through
 * one-time palace migrations. Any other `pythonPath` — a uv tool, pipx,
 * conda, or hand-rolled venv — is respected as operator-managed: probed
 * and advised on (exact upgrade command for its flavor), never mutated.
 *
 * Ordering guarantees, in priority order:
 *   1. A working install keeps working. Upgrade failures (network down,
 *      PyPI outage) leave the current version serving and retry later
 *      with backoff; pip downloads everything before it touches the
 *      environment, and if a failure does land mid-mutation the pass
 *      rolls back to the previous version before reporting.
 *   2. Version drift reconciles in the background — boot never blocks on
 *      pip when a usable install exists.
 *   3. Destructive healing (venv --clear) only ever targets the
 *      Talon-owned venv, and only when it is already unusable.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DoctorCheck } from "../../core/doctor/index.js";
import {
  compareVersions,
  expandHome,
  failDetail,
  findBasePython,
  loadProvisionState,
  markProvisionFailure,
  markProvisionSuccess,
  provisionBackoffMs,
  runStep,
  saveProvisionState,
  shouldAttempt,
  type ExecFn,
  type ProvisionOutcome,
  type ProvisionState,
} from "../../core/plugin/provision.js";
import { dirs, files } from "../../util/paths.js";
import { userHome } from "../../util/fs-path.js";

/**
 * The mempalace version Talon installs and reconciles the managed venv
 * to. Bump deliberately, with the canary workflow green — see
 * .github/workflows/native-provision.yml.
 */
export const MEMPALACE_PINNED_VERSION = "3.10.0";

/** Minimum python for the managed venv (matches mempalace's supported floor). */
const PYTHON_MIN = { major: 3, minor: 10 };

/** One-time palace migration ledger key (mempalace >= 3.4 wing renames). */
const WING_MIGRATION = "wing-names";
/** First mempalace release that ships `migrate-wings`. */
const WING_MIGRATION_MIN_VERSION = "3.4.0";

/**
 * One subprocess proves both facts that matter: the dist is installed
 * (metadata resolves) and the MCP server module actually imports. The
 * version is printed and flushed BEFORE the import: mempalace's
 * mcp_server rebinds sys.stdout to stderr at import time to protect the
 * JSON-RPC channel from stray prints, so anything printed after it
 * lands on the wrong stream.
 */
const HEALTH_SNIPPET =
  "import importlib.metadata as m, sys; print(m.version('mempalace')); sys.stdout.flush(); import mempalace.mcp_server";

const PROBE_TIMEOUT_MS = 60_000;
const VENV_TIMEOUT_MS = 120_000;
const PIP_TIMEOUT_MS = 900_000;
const MIGRATE_TIMEOUT_MS = 600_000;

/** The `mempalace`/`memory.mempalace` config section this module reads. */
export interface MempalaceSection {
  pythonPath?: string;
  palacePath?: string;
  version?: string;
  autoUpdate?: boolean;
  autoProvision?: boolean;
}

/**
 * Single source of truth for path resolution (builtins, bootstrap's
 * dream integration, and doctor all go through here): defaults applied,
 * `~` expanded, made absolute.
 */
export function resolveMempalacePaths(
  section: MempalaceSection | undefined,
  home = userHome(),
): { pythonPath: string; palacePath: string } {
  return {
    pythonPath: resolve(
      expandHome(section?.pythonPath ?? files.mempalacePython, home),
    ),
    palacePath: resolve(expandHome(section?.palacePath ?? dirs.palace, home)),
  };
}

/** Injectable seams so unit tests can cover every OS and failure branch. */
export interface MempalaceProvisionDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  now?: () => number;
  home?: string;
  /** The Talon-owned interpreter path (default: files.mempalacePython). */
  defaultManagedPython?: string;
  statePath?: string;
  pathExists?: (p: string) => boolean;
}

interface HealthProbe {
  healthy: boolean;
  version?: string;
  error?: string;
}

async function probeHealth(exec: ExecFn, python: string): Promise<HealthProbe> {
  const result = await exec(python, ["-c", HEALTH_SNIPPET], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (result.ok) {
    const version = result.stdout.trim().split(/\s+/).pop();
    if (version) return { healthy: true, version };
  }
  return { healthy: false, error: failDetail(result) };
}

/** Classify an operator-managed install by its interpreter path. */
export function classifyExternalInstall(pythonPath: string): string {
  const p = pythonPath.replaceAll("\\", "/").toLowerCase();
  if (p.includes("/uv/tools/")) return "uv-tool";
  if (p.includes("/pipx/")) return "pipx";
  if (
    p.includes("conda") ||
    p.includes("miniforge") ||
    p.includes("mambaforge")
  ) {
    return "conda";
  }
  return "external";
}

/**
 * The exact command that puts an operator-managed install on the pinned
 * version, per flavor. Works in both directions (a newer-than-pin
 * install reconciles down), hence the neutral name.
 */
function reconcileHint(kind: string, python: string, target: string): string {
  if (kind === "uv-tool") {
    return `uv tool install --force 'mempalace==${target}'`;
  }
  if (kind === "pipx") return `pipx install --force 'mempalace==${target}'`;
  return `${python} -m pip install --upgrade 'mempalace==${target}'`;
}

/** Single-flight guard: hot-reload must not stack concurrent pip runs. */
let reconcileInFlight = false;

export async function provisionMempalace(
  section: MempalaceSection,
  deps: MempalaceProvisionDeps = {},
): Promise<ProvisionOutcome> {
  const exec = deps.exec ?? runStep;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const home = deps.home ?? userHome();
  const pathExists = deps.pathExists ?? existsSync;
  const target = section.version ?? MEMPALACE_PINNED_VERSION;

  const { pythonPath: python, palacePath: palace } = resolveMempalacePaths(
    section,
    home,
  );
  const managedPython = resolve(
    deps.defaultManagedPython ?? files.mempalacePython,
  );
  const managed = python === managedPython;

  const probe = pathExists(python)
    ? await probeHealth(exec, python)
    : { healthy: false, error: "interpreter not found" };

  if (!managed) {
    return externalOutcome(python, target, probe, pathExists);
  }

  // ── Talon-owned venv from here on ──
  const statePath =
    deps.statePath ?? join(dirs.data, "mempalace-provision.json");
  const state = loadProvisionState(statePath);
  const venvDir = dirname(dirname(python));

  const ctx: ReconcileContext = {
    exec,
    platform,
    now,
    python,
    palace,
    venvDir,
    target,
    statePath,
    state,
    pathExists,
    previous: probe.healthy ? { version: probe.version! } : undefined,
  };

  if (probe.healthy && probe.version === target) {
    state.installedVersion = probe.version;
    markProvisionSuccess(statePath, state, target, now());
    const outcome: ProvisionOutcome = {
      status: "ready",
      version: probe.version,
      kind: "managed-venv",
      actions: [],
      warnings: [],
    };
    await maybeMigratePalace(ctx, outcome);
    return outcome;
  }

  // autoProvision governs creating/healing an unusable venv; autoUpdate
  // governs reconciling a working one. Independent settings, so a
  // healthy-but-drifted venv with autoProvision off still reaches the
  // update path below (which never rebuilds a working install).
  if (!probe.healthy && section.autoProvision === false) {
    return {
      status: "failed",
      kind: "managed-venv",
      actions: [],
      warnings: [
        `mempalace not usable (${probe.error}) and autoProvision is off — create the venv manually (see README) or re-enable autoProvision`,
      ],
      error: probe.error,
    };
  }

  if (probe.healthy && section.autoUpdate === false) {
    return {
      status: "ready",
      version: probe.version,
      kind: "managed-venv",
      actions: [],
      warnings: [
        `installed ${probe.version}, pinned ${target} — autoUpdate is off, upgrade manually when ready`,
      ],
    };
  }

  if (!shouldAttempt(state, target, now())) {
    const wait = Math.round(
      provisionBackoffMs(state.failureCount ?? 1) / 60_000,
    );
    const notice = `last provision attempt failed (${state.lastError ?? "unknown"}); retrying with backoff (≤${wait}min) or at next pin change`;
    return probe.healthy
      ? {
          status: "degraded",
          version: probe.version,
          kind: "managed-venv",
          actions: [],
          warnings: [notice],
        }
      : {
          status: "failed",
          kind: "managed-venv",
          actions: [],
          warnings: [notice],
          error: state.lastError,
        };
  }

  if (probe.healthy) {
    // Usable install at the wrong version: boot on it now, reconcile in
    // the background — the venv path is stable, so the next MCP spawn
    // picks the new version up without any further coordination.
    return {
      status: "ready",
      version: probe.version,
      kind: "managed-venv",
      actions: [],
      warnings: [
        `installed ${probe.version}, pinned ${target} — upgrading in the background`,
      ],
      background: () => runReconcileSingleFlight(ctx),
    };
  }

  // Broken or absent: provisioning is the only way to a working plugin,
  // so this path blocks (first boot pays the install once).
  return runReconcileSingleFlight(ctx);
}

function externalOutcome(
  python: string,
  target: string,
  probe: HealthProbe,
  pathExists: (p: string) => boolean,
): ProvisionOutcome {
  const kind = classifyExternalInstall(python);
  const hint = reconcileHint(kind, python, target);
  if (!pathExists(python)) {
    return {
      status: "failed",
      kind,
      actions: [],
      warnings: [
        `python not found at ${python} — this install is operator-managed (${kind}); fix the path or install with: ${hint}`,
      ],
      error: "interpreter not found",
    };
  }
  if (!probe.healthy) {
    return {
      status: "failed",
      kind,
      actions: [],
      warnings: [
        `mempalace not importable from ${python} (${probe.error}) — operator-managed (${kind}); install with: ${hint}`,
      ],
      error: probe.error,
    };
  }
  const warnings: string[] = [];
  if (compareVersions(probe.version!, target) !== 0) {
    warnings.push(
      `installed ${probe.version}, Talon pins ${target} — operator-managed (${kind}), reconcile with: ${hint}`,
    );
  }
  return {
    status: "ready",
    version: probe.version,
    kind,
    actions: [],
    warnings,
  };
}

interface ReconcileContext {
  exec: ExecFn;
  platform: NodeJS.Platform;
  now: () => number;
  python: string;
  palace: string;
  venvDir: string;
  target: string;
  statePath: string;
  state: ProvisionState;
  pathExists: (p: string) => boolean;
  /** A working install that existed before this pass, if any. */
  previous?: { version: string };
}

async function runReconcileSingleFlight(
  ctx: ReconcileContext,
): Promise<ProvisionOutcome> {
  if (reconcileInFlight) {
    return {
      status: ctx.previous ? "degraded" : "failed",
      version: ctx.previous?.version,
      kind: "managed-venv",
      actions: [],
      warnings: ["a provisioning pass is already running — skipped"],
    };
  }
  reconcileInFlight = true;
  try {
    return await reconcile(ctx);
  } finally {
    reconcileInFlight = false;
  }
}

async function reconcile(ctx: ReconcileContext): Promise<ProvisionOutcome> {
  const { exec, platform, python, venvDir, target, pathExists } = ctx;
  const actions: string[] = [];
  const warnings: string[] = [];
  let recreatedThisPass = false;

  const fail = async (error: string): Promise<ProvisionOutcome> => {
    markProvisionFailure(ctx.statePath, ctx.state, target, error, ctx.now());
    if (ctx.previous) {
      // Trust nothing: the upgrade may have died mid-mutation. Re-probe
      // the venv and, if the previous install is gone, put it back before
      // reporting — "staying on X" must be true, not assumed.
      const kept = await ensurePrevious(ctx, ctx.previous.version);
      if (kept) {
        warnings.push(
          `upgrade to ${target} failed (${error}) — staying on working ${kept.version}${kept.restored ? " (rolled back)" : ""}, will retry with backoff`,
        );
        return {
          status: "degraded",
          version: kept.version,
          kind: "managed-venv",
          actions,
          warnings,
        };
      }
      warnings.push(
        `upgrade to ${target} failed (${error}) and the previous ${ctx.previous.version} could not be restored — self-heals at the next provision pass`,
      );
    }
    return {
      status: "failed",
      kind: "managed-venv",
      actions,
      warnings,
      error,
    };
  };

  const recreateVenv = async (): Promise<string | undefined> => {
    const existedBefore = pathExists(venvDir);
    const base = await findBasePython(exec, platform, PYTHON_MIN);
    if (!base) {
      return `no python >=${PYTHON_MIN.major}.${PYTHON_MIN.minor} found on PATH — install one, or point mempalace.pythonPath at an environment you manage`;
    }
    // --clear empties a broken venv in place; no recursive delete needed.
    const created = await exec(
      base.command,
      [...base.args, "-m", "venv", "--clear", venvDir],
      { timeoutMs: VENV_TIMEOUT_MS },
    );
    if (!created.ok) {
      // Debian/Ubuntu ship python3 without the venv module; the failure
      // names ensurepip and the fix is a distro package, not pip.
      const hint = /ensurepip|venv/i.test(created.stderr)
        ? " — on Debian/Ubuntu: sudo apt install python3-venv"
        : "";
      return `venv creation failed: ${failDetail(created)}${hint}`;
    }
    recreatedThisPass = true;
    actions.push(
      `${existedBefore ? "recreated" : "created"} venv at ${venvDir} (python ${base.version})`,
    );
    return undefined;
  };

  const pipInstall = async (forceReinstall: boolean) =>
    exec(
      python,
      [
        "-m",
        "pip",
        "install",
        "--upgrade",
        ...(forceReinstall ? ["--force-reinstall"] : []),
        `mempalace==${target}`,
      ],
      {
        timeoutMs: PIP_TIMEOUT_MS,
        env: { PIP_DISABLE_PIP_VERSION_CHECK: "1" },
      },
    );

  // Step 1 — ensure an interpreter exists at all.
  if (!pathExists(python)) {
    const err = await recreateVenv();
    if (err) return await fail(err);
  }

  // Step 2 — install/upgrade. A pass that started from a broken-but-present
  // install force-reinstalls, which repairs half-written site-packages.
  const brokenInstall = !ctx.previous && !recreatedThisPass;
  let installed = await pipInstall(brokenInstall);

  // Step 3 — heal ladder. First rung: pip itself may be missing/broken.
  if (!installed.ok) {
    await exec(python, ["-m", "ensurepip", "--upgrade"], {
      timeoutMs: VENV_TIMEOUT_MS,
    });
    await exec(python, ["-m", "pip", "install", "--upgrade", "pip"], {
      timeoutMs: VENV_TIMEOUT_MS,
      env: { PIP_DISABLE_PIP_VERSION_CHECK: "1" },
    });
    installed = await pipInstall(brokenInstall);
  }

  // Second rung: rebuild the whole venv — but never sacrifice a working
  // install to do it; a failed upgrade keeps serving the old version.
  if (!installed.ok && !recreatedThisPass && !ctx.previous) {
    const err = await recreateVenv();
    if (!err) installed = await pipInstall(false);
  }

  if (!installed.ok) return await fail(failDetail(installed));

  // Step 4 — trust nothing: verify the interpreter now serves the target.
  const verify = await probeHealth(exec, python);
  if (!verify.healthy) {
    return await fail(`installed but not importable: ${verify.error}`);
  }
  if (verify.version !== target) {
    return await fail(
      `expected ${target} after install, found ${verify.version ?? "nothing"}`,
    );
  }

  actions.push(
    ctx.previous
      ? `upgraded mempalace ${ctx.previous.version} → ${target}`
      : `installed mempalace ${target}`,
  );
  ctx.state.installedVersion = target;
  markProvisionSuccess(ctx.statePath, ctx.state, target, ctx.now());

  const outcome: ProvisionOutcome = {
    status: "ready",
    version: target,
    kind: "managed-venv",
    actions,
    warnings,
  };
  await maybeMigratePalace(ctx, outcome);
  return outcome;
}

/**
 * After a failed upgrade: confirm the previous install still serves, or
 * reinstall it. Returns what is serving now, or undefined when the venv
 * is broken beyond a one-shot rollback (the next pass's heal ladder
 * takes over from there).
 */
async function ensurePrevious(
  ctx: ReconcileContext,
  previous: string,
): Promise<{ version: string; restored: boolean } | undefined> {
  const still = await probeHealth(ctx.exec, ctx.python);
  if (still.healthy) return { version: still.version!, restored: false };
  const rollback = await ctx.exec(
    ctx.python,
    [
      "-m",
      "pip",
      "install",
      "--force-reinstall",
      "--no-deps",
      `mempalace==${previous}`,
    ],
    { timeoutMs: PIP_TIMEOUT_MS, env: { PIP_DISABLE_PIP_VERSION_CHECK: "1" } },
  );
  if (!rollback.ok) return undefined;
  const after = await probeHealth(ctx.exec, ctx.python);
  return after.healthy
    ? { version: after.version!, restored: true }
    : undefined;
}

/**
 * One-time palace data migrations, applied only to palaces that already
 * hold data (a chroma store) and recorded in the state ledger so they
 * run exactly once per deployment. `migrate-wings` itself is idempotent,
 * so a lost ledger costs one harmless re-run, never data. Gated on the
 * serving version actually shipping the command — a pin below 3.4 has
 * nothing to migrate to.
 */
async function maybeMigratePalace(
  ctx: ReconcileContext,
  outcome: ProvisionOutcome,
): Promise<void> {
  if (ctx.state.migrations?.[WING_MIGRATION]) return;
  if (
    compareVersions(outcome.version ?? ctx.target, WING_MIGRATION_MIN_VERSION) <
    0
  ) {
    return;
  }
  if (!ctx.pathExists(join(ctx.palace, "chroma.sqlite3"))) return;

  const result = await ctx.exec(
    ctx.python,
    ["-m", "mempalace", "--palace", ctx.palace, "migrate-wings", "--yes"],
    { timeoutMs: MIGRATE_TIMEOUT_MS },
  );
  if (result.ok) {
    ctx.state.migrations = {
      ...ctx.state.migrations,
      [WING_MIGRATION]: new Date(ctx.now()).toISOString(),
    };
    saveProvisionState(ctx.statePath, ctx.state);
    const summary =
      result.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(
          (l) => l.startsWith("Migrated") || l.includes("nothing to migrate"),
        )
        .pop() ?? "done";
    outcome.actions.push(`palace wing-name migration: ${summary}`);
  } else {
    outcome.warnings.push(
      `palace wing-name migration failed (${failDetail(result)}) — data untouched, will retry next provision pass`,
    );
  }
}

/**
 * Read-only doctor inspection: version vs pin, flavor, importability.
 * Never mutates — a drifted managed venv reports "reconciles at next
 * talon start", which is the provisioner's job, not doctor's.
 */
export async function inspectMempalace(
  section: MempalaceSection,
  deps: MempalaceProvisionDeps = {},
): Promise<DoctorCheck[]> {
  const exec = deps.exec ?? runStep;
  const pathExists = deps.pathExists ?? existsSync;
  const home = deps.home ?? userHome();
  const { pythonPath: python } = resolveMempalacePaths(section, home);
  const pin = section.version ?? MEMPALACE_PINNED_VERSION;
  const managed =
    python === resolve(deps.defaultManagedPython ?? files.mempalacePython);
  const flavor = managed ? "managed venv" : classifyExternalInstall(python);
  const hint = reconcileHint(flavor, python, pin);
  const provisionOff = section.autoProvision === false;
  const updateOff = section.autoUpdate === false;

  if (!pathExists(python)) {
    return [
      {
        label: `MemPalace runtime missing (${flavor})`,
        status: managed && !provisionOff ? "warn" : "fail",
        detail: managed
          ? provisionOff
            ? `automatic provisioning disabled (mempalace.autoProvision: false) — create the venv manually (see README) or re-enable it`
            : `provisions automatically at next talon start (pin ${pin})`
          : `python not found at ${python} — fix the path or install with: ${hint}`,
        issue: true,
      },
    ];
  }
  const probe = await probeHealth(exec, python);
  if (!probe.healthy) {
    return [
      {
        label: `MemPalace broken (${flavor})`,
        status: managed && !provisionOff ? "warn" : "fail",
        detail: managed
          ? provisionOff
            ? `not importable (${probe.error}); automatic healing disabled (mempalace.autoProvision: false) — repair manually or re-enable it`
            : "self-heals at next talon start"
          : `mempalace not importable from ${python} (${probe.error}) — install with: ${hint}`,
        issue: true,
      },
    ];
  }
  if (probe.version === pin) {
    return [{ label: `MemPalace ${probe.version} (${flavor})`, status: "ok" }];
  }
  return [
    {
      label: `MemPalace ${probe.version}, pinned ${pin} (${flavor})`,
      status: "warn",
      detail: managed
        ? updateOff
          ? `automatic update disabled (mempalace.autoUpdate: false) — run: ${hint}`
          : "reconciles at next talon start"
        : `operator-managed install — reconcile when ready with: ${hint}`,
      issue: managed,
    },
  ];
}
