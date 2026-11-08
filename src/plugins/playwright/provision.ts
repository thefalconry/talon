/**
 * Playwright provisioner — browser builds present before first use.
 *
 * @playwright/mcp launches its browser lazily, so a missing build used
 * to surface as a mid-conversation tool error. This makes it a boot
 * concern instead: when the configured engine's build is absent from
 * the Playwright cache, run the bundled playwright-core CLI's `install`
 * (idempotent, version-matched to the pinned @playwright/mcp — the cli
 * resolves from the same dependency tree the MCP server runs).
 *
 * Deliberately out of scope, in line with never mutating what Talon
 * doesn't own: system channels (chrome, msedge) — those belong to the
 * OS; endpoint mode — the browser lives on the remote end.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DoctorCheck } from "../../core/doctor/index.js";
import {
  failDetail,
  loadProvisionState,
  markProvisionFailure,
  markProvisionSuccess,
  runStep,
  shouldAttempt,
  type ExecFn,
  type ProvisionOutcome,
} from "../../core/plugin/provision.js";
import { logWarn } from "../../util/log.js";
import { dirs } from "../../util/paths.js";
import {
  ENDPOINT_PLAYWRIGHT_MINOR,
  bundledPlaywrightVersion,
  couplingError,
} from "./version-coupling.js";
import { userHome } from "../../util/fs-path.js";

/** Engines whose builds Playwright manages (vs system channels). */
const MANAGED_ENGINES = new Set(["chromium", "firefox", "webkit"]);

const INSTALL_TIMEOUT_MS = 600_000;

/** The `playwright` config section this module reads. */
export interface PlaywrightSection {
  browser?: string;
  endpoint?: string;
  endpointFile?: string;
  autoProvision?: boolean;
}

export interface PlaywrightProvisionDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  statePath?: string;
  cliPath?: string;
  pathExists?: (p: string) => boolean;
  listDir?: (p: string) => string[];
  /** playwright-core's browser registry (default: browsers.json beside the CLI). */
  registry?: BrowserDescriptor[];
  /** Bundled playwright-core version (default: read from node_modules). */
  bundledPlaywrightVersion?: string;
}

/** One entry of playwright-core's browsers.json. */
interface BrowserDescriptor {
  name: string;
  revision: string;
  /** Per-host-platform revisions (e.g. webkit on older macOS). */
  revisionOverrides?: Record<string, string>;
}

/**
 * Where Playwright keeps downloaded builds, per OS — the same defaults
 * playwright-core's registry uses, and the same override env var.
 */
export function browsersRoot(
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined>,
): string {
  const override = env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") return override;
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "ms-playwright");
  }
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      "ms-playwright",
    );
  }
  return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "ms-playwright");
}

/** The bundled playwright-core CLI (version-matched to @playwright/mcp). */
function defaultCliPath(): string {
  return resolve(
    import.meta.dirname ?? ".",
    "../../../node_modules/playwright-core/cli.js",
  );
}

const safeListDir = (p: string): string[] => {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
};

/** browsers.json shipped beside the CLI — the revisions this playwright-core needs. */
function readRegistry(cli: string): BrowserDescriptor[] {
  const path = join(dirname(cli), "browsers.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      browsers?: BrowserDescriptor[];
    };
    return Array.isArray(parsed.browsers) ? parsed.browsers : [];
  } catch (err) {
    // It ships with playwright-core, so this is unexpected — and without
    // it any build directory counts, stale revisions included.
    logWarn(
      "playwright",
      `browsers.json unreadable, falling back to any-build check path=${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * The build directories the registry requires for an engine: the engine
 * itself plus its headless-shell companion (chromium runs headless via
 * chromium-headless-shell; `install chromium` fetches both). Named the
 * way playwright-core's registry names them — `<name with _>-<revision>`,
 * or `<name>_<platform>_special-<revision>` for a per-platform override
 * — and complete only once the registry's INSTALLATION_COMPLETE marker
 * is present, so a stale revision from an older playwright-core or a
 * half-downloaded build never passes for ready.
 */
function requiredBuildDirs(
  browser: string,
  registry: BrowserDescriptor[],
): string[][] {
  return registry
    .filter((d) => d.name === browser || d.name === `${browser}-headless-shell`)
    .map((d) => {
      const prefix = d.name.replaceAll("-", "_");
      return [
        `${prefix}-${d.revision}`,
        ...Object.entries(d.revisionOverrides ?? {}).map(
          ([platform, revision]) => `${prefix}_${platform}_special-${revision}`,
        ),
      ];
    });
}

/**
 * Whether the engine's required builds are present and complete. Pure
 * filesystem inspection, no subprocess. Without a readable registry
 * (unexpected — it ships with playwright-core) any build directory for
 * the engine counts, which is the pre-registry behavior.
 */
function browserPresent(
  browser: string,
  cli: string,
  deps: Pick<
    PlaywrightProvisionDeps,
    "platform" | "home" | "env" | "listDir" | "pathExists" | "registry"
  > = {},
): boolean {
  const root = browsersRoot(
    deps.platform ?? process.platform,
    deps.home ?? userHome(),
    deps.env ?? process.env,
  );
  const present = new Set((deps.listDir ?? safeListDir)(root));
  const pathExists = deps.pathExists ?? existsSync;
  const required = requiredBuildDirs(
    browser,
    deps.registry ?? readRegistry(cli),
  );
  if (required.length === 0) {
    return [...present].some((name) => name.startsWith(browser));
  }
  return required.every((candidates) =>
    candidates.some(
      (dir) =>
        present.has(dir) &&
        pathExists(join(root, dir, "INSTALLATION_COMPLETE")),
    ),
  );
}

/** Forward the injected environment (e.g. PLAYWRIGHT_BROWSERS_PATH) to the CLI. */
function execEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );
}

export async function provisionPlaywright(
  section: PlaywrightSection,
  deps: PlaywrightProvisionDeps = {},
): Promise<ProvisionOutcome> {
  const exec = deps.exec ?? runStep;
  const now = deps.now ?? Date.now;
  const pathExists = deps.pathExists ?? existsSync;
  const browser = section.browser ?? "chromium";

  if (section.endpoint ?? section.endpointFile) {
    return { status: "skipped", kind: "endpoint", actions: [], warnings: [] };
  }
  if (!MANAGED_ENGINES.has(browser)) {
    return {
      status: "skipped",
      kind: "system-channel",
      actions: [],
      warnings: [],
    };
  }
  if (section.autoProvision === false) {
    return { status: "skipped", kind: "managed", actions: [], warnings: [] };
  }

  const cli = deps.cliPath ?? defaultCliPath();
  if (browserPresent(browser, cli, deps)) {
    return { status: "ready", kind: "managed", actions: [], warnings: [] };
  }

  if (!pathExists(cli)) {
    return {
      status: "failed",
      kind: "managed",
      actions: [],
      warnings: [
        `playwright-core CLI not found at ${cli} — reinstall dependencies (npm ci)`,
      ],
      error: "playwright-core missing",
    };
  }

  const statePath =
    deps.statePath ?? join(dirs.data, "playwright-provision.json");
  const state = loadProvisionState(statePath);
  // The pin key is the browser name: switching engines re-arms retries.
  if (!shouldAttempt(state, browser, now())) {
    return {
      status: "degraded",
      kind: "managed",
      actions: [],
      warnings: [
        `last ${browser} download failed (${state.lastError ?? "unknown"}); retrying with backoff`,
      ],
    };
  }

  const installed = await exec(process.execPath, [cli, "install", browser], {
    timeoutMs: INSTALL_TIMEOUT_MS,
    env: execEnv(deps.env),
  });
  if (!installed.ok) {
    const detail = failDetail(installed);
    // Linux-only failure class: the build downloaded but shared system
    // libraries are missing — that fix needs root, so it stays advisory.
    const depsHint = /missing dependencies|install-deps|apt-get/i.test(
      installed.stderr,
    )
      ? ` — system libraries are missing; run: sudo npx playwright install-deps ${browser}`
      : "";
    markProvisionFailure(statePath, state, browser, detail, now());
    return {
      status: "degraded",
      kind: "managed",
      actions: [],
      warnings: [
        `${browser} download failed (${detail})${depsHint} — browser tools will error until resolved`,
      ],
      error: detail,
    };
  }

  markProvisionSuccess(statePath, state, browser, now());
  return {
    status: "ready",
    kind: "managed",
    actions: [`downloaded ${browser} browser build`],
    warnings: [],
  };
}

/** Read-only doctor inspection: build present / endpoint mode. */
export function inspectPlaywright(
  section: PlaywrightSection,
  deps: PlaywrightProvisionDeps = {},
): DoctorCheck[] {
  if (section.endpoint ?? section.endpointFile) {
    const bundled = deps.bundledPlaywrightVersion ?? bundledPlaywrightVersion();
    const coupling = couplingError(bundled);
    return [
      {
        label: "Playwright: remote endpoint mode",
        status: "info",
        detail: "browser lives on the remote end",
      },
      coupling
        ? {
            label: "Playwright: client/endpoint version mismatch",
            status: "fail",
            detail: coupling,
            issue: true,
          }
        : {
            label: `Playwright: client on endpoint minor ${ENDPOINT_PLAYWRIGHT_MINOR}`,
            status: "ok",
            detail: bundled ? `playwright-core ${bundled}` : undefined,
          },
    ];
  }
  const browser = section.browser ?? "chromium";
  if (!MANAGED_ENGINES.has(browser)) {
    return [
      {
        label: `Playwright: system channel (${browser})`,
        status: "info",
        detail: "browser managed by the OS",
      },
    ];
  }
  const cli = deps.cliPath ?? defaultCliPath();
  return [
    browserPresent(browser, cli, deps)
      ? { label: `Playwright ${browser} build present`, status: "ok" }
      : {
          label: `Playwright ${browser} build missing`,
          status: "warn",
          detail:
            section.autoProvision === false
              ? `automatic download disabled (playwright.autoProvision: false) — run: npx playwright install ${browser}`
              : "downloads automatically at next talon start",
          issue: true,
        },
  ];
}
