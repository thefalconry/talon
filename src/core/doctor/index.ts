/**
 * Doctor — structured environment and native-plane diagnostics.
 *
 * One collection pass shared by every surface that reports health:
 * `talon doctor` renders the report with terminal colors (src/cli.ts),
 * the Telegram /doctor command renders it as HTML (frontend/telegram).
 * Keeping the checks here means a new check shows up everywhere at
 * once instead of drifting per-frontend.
 *
 * Checks are pure data (label / status / detail) — no console output,
 * no process.exit. Renderers decide presentation.
 */

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { NATIVE_MODULES } from "../../native/registry.js";
import { dirs } from "../../util/paths.js";
import { getBackend, listBackends } from "../agent-runtime/backend-registry.js";
import { checkOpenAlerts, checkRecentErrors } from "./logs.js";
import type {
  DoctorCheck,
  DoctorConfigSlice,
  DoctorReport,
  NativeModuleCheck,
} from "./types.js";

export type {
  DoctorCheck,
  DoctorConfigSlice,
  DoctorReport,
  NativeModuleCheck,
} from "./types.js";

function errorNote(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Instantiate each embedded module and verify a known answer from it.
 * Catches a corrupted install — truncated artifact, engine without
 * wasm support — at check time instead of mid-message in a frontend.
 * The module list, provenance, and self-tests live in the native
 * registry (src/native/registry.ts) — a new native module shows up
 * here by registering there.
 */
export async function checkNativeModules(): Promise<NativeModuleCheck[]> {
  const results: NativeModuleCheck[] = [];
  for (const spec of NATIVE_MODULES) {
    const check: NativeModuleCheck = {
      name: spec.name,
      language: spec.language,
      target: spec.target,
      ok: false,
    };
    try {
      check.sizeBytes = await spec.sizeBytes?.();
      await spec.selfTest();
      check.ok = true;
    } catch (err) {
      check.note = errorNote(err);
    }
    results.push(check);
  }
  return results;
}

/**
 * The configured frontends that are missing their required credentials.
 * `terminal` (stdio) and `native` (the client bridge) carry none, so they
 * are always configured; a name doctor doesn't recognize stays a failure
 * (fail-closed) so a typo'd frontend is surfaced instead of blessed —
 * but it is *named* in the report either way, never a bare "not fully
 * configured" that leaves the operator guessing which entry is at fault.
 */
function unconfiguredFrontends(config: DoctorConfigSlice): string[] {
  const fes = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  return fes.filter((fe) => {
    if (fe === "telegram") return !config.botToken;
    if (fe === "teams") return !config.teamsWebhookUrl;
    if (fe === "discord") return !config.discord?.botToken;
    // WhatsApp needs no stored credential — pairing is interactive (QR /
    // pairing code at first start) — but the config block must exist so
    // the JID allowlists were consciously set.
    if (fe === "whatsapp") return !config.whatsapp;
    return fe !== "terminal" && fe !== "native";
  });
}

/** How long a namespace probe may take before the mount counts as wedged. */
const NS_PROBE_TIMEOUT_MS = 3_000;

/**
 * Probe one path without trusting it to answer: a healthy dir stats in
 * microseconds, a stale FUSE mount from a dead daemon answers ENOTCONN,
 * and a live-but-stuck daemon's mount HANGS the syscall — so the probe
 * races a timeout and a hang counts as wedged rather than wedging
 * doctor itself.
 */
async function probeNsPath(
  path: string,
): Promise<"ok" | "missing" | "hang" | string> {
  const result = await Promise.race([
    stat(path).then(
      () => "ok" as const,
      (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        return code === "ENOENT" ? ("missing" as const) : (code ?? "error");
      },
    ),
    new Promise<"hang">((resolve) => {
      setTimeout(() => resolve("hang"), NS_PROBE_TIMEOUT_MS).unref();
    }),
  ]);
  return result;
}

/**
 * The namespace mountpoint (~/.talon/ns) from the outside. Doctor runs
 * in its own process, so it can't read the daemon's in-memory FUSE
 * status — but every failure mode shows up in the filesystem itself:
 * missing means no daemon has booted yet, ENOTCONN or a hanging syscall
 * means a FUSE mount wedged by a dead or stuck daemon (every consumer
 * of the namespace is broken until it's detached), and a healthy root
 * either has live views (proc/ answers) or is the plain symlink farm.
 */
async function checkNamespaceDir(): Promise<DoctorCheck> {
  const root = await probeNsPath(dirs.ns);
  if (root === "missing") {
    return {
      label: "Namespace dir not built yet",
      status: "info",
      detail: `${dirs.ns} appears at first daemon boot`,
    };
  }
  if (root !== "ok") {
    return {
      label:
        root === "hang"
          ? "Namespace dir wedged (syscalls hang)"
          : `Namespace dir wedged (${root})`,
      status: "fail",
      detail: `stale FUSE mount at ${dirs.ns} — detach with: fusermount3 -uz ${dirs.ns} (or: umount -l ${dirs.ns})`,
    };
  }
  // Root answers. proc/ is served over the FUSE bridge, so it gets its
  // own hang-guarded probe: present = live views, absent = symlink farm.
  const proc = await probeNsPath(`${dirs.ns}/proc`);
  if (proc === "ok") {
    return {
      label: `Namespace dir: ${dirs.ns}`,
      status: "ok",
      detail: "live views mounted (proc/ answering)",
    };
  }
  if (proc === "missing") {
    return {
      label: `Namespace dir: ${dirs.ns}`,
      status: "ok",
      detail: "symlink farm (no live views — daemon off or FUSE not mounted)",
    };
  }
  return {
    label: `Namespace live views unhealthy (proc/ ${proc === "hang" ? "hangs" : proc})`,
    status: "warn",
    detail: `file mounts still work; detach the mount with: fusermount3 -uz ${dirs.ns}`,
    issue: true,
  };
}

/**
 * Native plugin runtimes (MemPalace's venv, Playwright's browser build,
 * GitHub's Docker image) — the artifacts the provisioners own. The
 * runtime list and each inspection live in the native-runtimes registry
 * (src/core/plugin/native-runtimes.ts); a new native plugin shows up
 * here by registering there. Doctor reads, never mutates: a drifted or
 * missing runtime reports what will fix it (usually "next talon start").
 */
async function checkPluginRuntimes(
  config: DoctorConfigSlice | undefined,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const { NATIVE_RUNTIMES } = await import("../plugin/native-runtimes.js");
  for (const runtime of NATIVE_RUNTIMES) {
    if (!runtime.enabled(config)) continue;
    try {
      checks.push(...(await runtime.inspect(config!)));
    } catch (err) {
      checks.push({
        label: `${runtime.id} runtime check errored`,
        status: "warn",
        detail: errorNote(err),
      });
    }
  }
  return checks;
}

/**
 * Binary / auth checks across every backend the config exposes, each
 * supplied by its own factory (`BackendFactory.doctor`) — doctor composes
 * whatever is registered and hardcodes nothing about any backend. The
 * caller must have loaded the factories (`loadBuiltinBackends`); an active
 * backend that is not registered is reported as such, loudly.
 *
 * Only the active one counts toward the issue total; the rest are reported
 * so a switch doesn't have to be the thing that discovers a backend can't
 * run. That distinction matters now that a chat can be rebound at runtime —
 * a report of all-green while two backends are one click from failing is
 * worse than no report.
 */
async function checkBackend(
  config: DoctorConfigSlice | undefined,
): Promise<DoctorCheck[]> {
  const active = config?.backend ?? "claude";
  const exposed = config?.enabledBackends?.length
    ? config.enabledBackends
    : listBackends().map((b) => b.id);

  const checks = await checkOneBackend(active, config, true);
  for (const id of exposed) {
    if (id === active || !getBackend(id)) continue;
    // An idle backend's missing binary is a heads-up, not a fault of this
    // deployment: downgrade it and keep it out of the issue count.
    for (const check of await checkOneBackend(id, config, false)) {
      checks.push({
        ...check,
        status: check.status === "fail" ? "warn" : check.status,
        issue: false,
        inactive: true,
      });
    }
  }
  return checks;
}

async function checkOneBackend(
  backend: string,
  config: DoctorConfigSlice | undefined,
  isActive: boolean,
): Promise<DoctorCheck[]> {
  const factory = getBackend(backend);
  if (!factory) {
    const known = listBackends().map((b) => b.id);
    return [
      {
        label: `Backend "${backend}" is not registered`,
        status: "fail",
        detail: known.length
          ? `known: ${known.join(", ")}`
          : "no backends loaded — call loadBuiltinBackends() first",
        issue: true,
      },
    ];
  }
  if (!factory.doctor) {
    return [{ label: `${factory.label}: no doctor checks`, status: "info" }];
  }
  try {
    return await factory.doctor(config, isActive);
  } catch (err) {
    return [
      {
        label: `${factory.label} doctor check errored`,
        status: "warn",
        detail: errorNote(err),
        issue: isActive,
      },
    ];
  }
}

/**
 * What the deployment is doing rather than what it is built from: the
 * provisioned plugin runtimes, the backends, and what the daemon's log
 * and alert table say went wrong lately (./logs.ts).
 */
async function checkRunningState(
  config: DoctorConfigSlice | undefined,
): Promise<DoctorCheck[]> {
  return [
    ...(await checkPluginRuntimes(config)),
    ...(await checkBackend(config)),
    checkRecentErrors(),
    ...checkOpenAlerts(),
  ];
}

/**
 * Run every check and return the structured report. `config` is
 * undefined when no config file exists yet (first run).
 */
export async function collectDoctorReport(opts: {
  config?: DoctorConfigSlice;
  hasConfigFile: boolean;
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  checks.push({
    label: `Node.js ${process.versions.node}`,
    status: nodeMajor >= 24 ? "ok" : "fail",
    detail: nodeMajor >= 24 ? undefined : "need >=24",
  });

  if (opts.hasConfigFile && opts.config) {
    const fes = Array.isArray(opts.config.frontend)
      ? opts.config.frontend
      : [opts.config.frontend];
    const missing = unconfiguredFrontends(opts.config);
    checks.push(
      missing.length === 0
        ? {
            label: `Frontend: ${fes.join(", ")}`,
            status: "ok",
            detail: "configured",
          }
        : {
            label: `Frontend not fully configured: ${missing.join(", ")}`,
            status: "fail",
            detail: "missing credentials in talon.json (or unknown frontend)",
          },
    );
  } else {
    checks.push({ label: "No config file", status: "fail" });
  }

  checks.push(
    existsSync(dirs.root)
      ? { label: "Workspace", status: "ok", detail: dirs.root }
      : { label: "Workspace missing", status: "warn" },
  );

  checks.push(await checkNamespaceDir());

  // The warden is optional by design (built per-arch, absent on plain
  // npm installs), so a missing binary is informational — triggers run
  // on the in-process TS path. When present, report the live version.
  {
    const { wardenBinaryPath, wardenVersion } =
      await import("../../native/warden.js");
    const wardenBin = wardenBinaryPath();
    if (wardenBin) {
      const version = wardenVersion();
      checks.push(
        version
          ? { label: `Trigger supervision: ${version}`, status: "ok" }
          : {
              label: "Trigger supervision: warden binary unresponsive",
              status: "warn",
              detail: wardenBin,
              issue: true,
            },
      );
    } else {
      checks.push({
        label: "Trigger supervision: TS fallback (no warden binary)",
        status: "info",
        detail: "npm run build:warden",
      });
    }
  }

  // Same optional contract for the hashing addon: absent means the
  // embedded wasm module is doing the hashing (correct, just slower
  // and on the event loop), so it's informational, not an issue. The
  // addon was digest-verified at load time by nativeBlake3().
  {
    const { nativeBlake3 } = await import("../../native/blake3.js");
    const addon = nativeBlake3();
    checks.push(
      addon
        ? {
            label: `Media hashing: blake3 native addon v${addon.version()}`,
            status: "ok",
          }
        : {
            label: "Media hashing: embedded wasm (no native addon)",
            status: "info",
            detail: "npm run build:napi",
          },
    );
  }

  // Same optional contract for the namespace FUSE addon: absent means
  // ~/.talon/ns is the symlink farm only (file mounts fine, no live
  // proc//plugins views), so it's informational, not an issue.
  {
    const { nativeFuseFs } = await import("../../native/fusefs.js");
    const addon = nativeFuseFs();
    checks.push(
      addon
        ? {
            label: `Namespace FUSE: talon-fusefs addon v${addon.version()}`,
            status: "ok",
          }
        : {
            label: "Namespace FUSE: symlink farm only (no addon)",
            status: "info",
            detail: "npm run build:fusefs",
          },
    );
  }

  // Package-owned prompt templates must be loadable. On a standalone
  // `bun build --compile` binary these are embedded file assets (no
  // source tree on disk); a failure here means the embed manifest is
  // stale or the package is incomplete — caught at check time, not
  // mid-message when a backend assembles its system prompt.
  {
    const { loadSystemTemplate } = await import("../prompt/index.js");
    try {
      const sample = loadSystemTemplate("workspace");
      checks.push(
        sample.trim().length > 0
          ? {
              label: "Prompt templates loaded",
              status: "ok",
            }
          : {
              label: "Prompt templates empty",
              status: "fail",
              issue: true,
            },
      );
    } catch (err) {
      checks.push({
        label: "Prompt templates unavailable",
        status: "fail",
        detail: errorNote(err),
        issue: true,
      });
    }
  }

  // Seeded prompt provenance — surfaces the upgrade-aware seeding
  // state (.seeded.json): files still tracking the package refresh on
  // upgrade; user-edited files are never touched again. Knowing which
  // is which is the difference between "why didn't my prompt update?"
  // and a one-line answer.
  {
    const { promptSeedReport } = await import("../vfs/workspace.js");
    try {
      const { tracking, edited } = promptSeedReport();
      if (tracking.length + edited.length > 0) {
        checks.push({
          label: `Prompts: ${tracking.length} tracking package upgrades, ${edited.length} user-edited`,
          status: "ok",
          detail:
            edited.length > 0 ? `edited: ${edited.join(", ")}` : undefined,
        });
      }
    } catch {
      /* diagnostics only — never block the report */
    }
  }

  const native = await checkNativeModules();
  checks.push(...(await checkRunningState(opts.config)));

  const issues =
    checks.filter((c) => c.status === "fail" || c.issue).length +
    native.filter((m) => !m.ok).length;

  return { checks, native, issues };
}
