/**
 * Built-in plugin loading (GitHub / MemPalace / mem0 / Playwright) + the hot-reload
 * path that re-reads config, tears down, and re-loads everything.
 */

import { log, logError, logWarn } from "../../util/log.js";
import { raiseAlert, resolveAlert } from "../frontend-runtime/alerts.js";
import { faultText } from "../engine/fault-text.js";
import type { TalonConfig } from "../config/index.js";
import type { TalonPlugin } from "./types.js";
import { registry, reloadState } from "./registry.js";
import type { ProvisionOutcome } from "./provision.js";
import { NATIVE_RUNTIMES, type NativePluginId } from "./native-runtimes.js";
import {
  recordProvisionEvents,
  trackBackgroundProvision,
} from "./provision-journal.js";
import {
  initPluginWithTimeout,
  loadPlugins,
  registerPlugin,
} from "./loader.js";

/**
 * Surface a provisioning outcome in the logs and the journal, and fire
 * its background reconcile task (fire-and-forget: the plugin is already
 * serving on whatever the outcome declared usable).
 */
function reportProvision(
  pluginName: NativePluginId,
  outcome: ProvisionOutcome,
): void {
  recordProvisionEvents(pluginName, outcome.actions);
  for (const action of outcome.actions) {
    log(pluginName, `provision: ${action}`);
  }
  for (const warning of outcome.warnings) {
    logWarn(pluginName, `provision: ${warning}`);
  }
  if (outcome.status === "failed" && outcome.error) {
    logError(pluginName, `provision failed: ${outcome.error}`);
  }
  alertOnProvision(pluginName, outcome.status, outcome.error);
  const background = outcome.background;
  if (background) {
    // Tracked so the post-update report waits for it to settle (its
    // actions are the changes worth reporting).
    void trackBackgroundProvision(
      background()
        .then((result) =>
          reportProvision(pluginName, { ...result, background: undefined }),
        )
        .catch((err) =>
          logError(
            pluginName,
            `background provision: ${err instanceof Error ? err.message : err}`,
          ),
        ),
    );
  }
}

/**
 * A native runtime that could not be provisioned leaves its plugin down
 * until a human looks (disk, network, a broken toolchain) — alert on the
 * failed pass, clear once a later pass leaves it usable.
 */
function alertOnProvision(
  pluginName: NativePluginId,
  status: ProvisionOutcome["status"] | "threw",
  error: unknown,
): void {
  const key = `provision.${pluginName}`;
  if (status === "failed" || status === "threw") {
    raiseAlert(
      key,
      `Installing the ${pluginName} runtime failed: ${faultText(error ?? "no detail")}. The ${pluginName} plugin will not work until it is fixed (see \`talon doctor\`).`,
    );
  } else if (status === "ready" || status === "degraded") {
    resolveAlert(key, `The ${pluginName} runtime is installed and usable.`);
  }
}

/**
 * Provision every enabled native runtime (see native-runtimes.ts) and
 * return the outcomes so plugin construction can read what it got
 * (e.g. the installed version). A provisioner that throws is treated
 * as a failed pass, never a failed boot.
 */
async function provisionNativeRuntimes(
  config: TalonConfig,
): Promise<Map<NativePluginId, ProvisionOutcome>> {
  const outcomes = new Map<NativePluginId, ProvisionOutcome>();
  for (const runtime of NATIVE_RUNTIMES) {
    if (!runtime.enabled(config)) continue;
    try {
      const outcome = await runtime.provision(config);
      outcomes.set(runtime.id, outcome);
      reportProvision(runtime.id, outcome);
    } catch (err) {
      logError(
        runtime.id,
        `provision: ${err instanceof Error ? err.message : err}`,
      );
      alertOnProvision(runtime.id, "threw", err);
    }
  }
  return outcomes;
}

/**
 * Register one built-in plugin from its config section and run its init.
 * A plugin that fails to build or init is logged, never fatal.
 */
async function loadBuiltin(
  label: string,
  section: object,
  initTimeoutMs: number,
  build: () => Promise<TalonPlugin>,
): Promise<void> {
  try {
    const loaded = registerPlugin(
      await build(),
      section as Record<string, unknown>,
    );
    if (loaded) {
      await initPluginWithTimeout(
        loaded.plugin,
        loaded.config,
        initTimeoutMs,
        `${label} init`,
        `${label} init`,
      );
    }
  } catch (err) {
    logError(
      "plugin",
      `${label} init: ${err instanceof Error ? err.message : err}`,
    );
    raiseAlert(
      `plugin.${label.toLowerCase()}`,
      `Built-in plugin ${label} failed to load: ${faultText(err)}. Its tools are unavailable until the next reload or restart.`,
    );
  }
}

/**
 * Load built-in plugins (GitHub, MemPalace, mem0, Playwright) based on config flags.
 * Shared by both bootstrap and hot-reload.
 */
export async function loadBuiltinPlugins(config: TalonConfig): Promise<void> {
  const provisioned = await provisionNativeRuntimes(config);

  const github = config.github;
  if (github?.enabled) {
    await loadBuiltin("GitHub", github, 15_000, async () => {
      const { createGitHubPlugin } =
        await import("../../plugins/github/index.js");
      return createGitHubPlugin({
        token: github.token,
        imageTag: github.imageTag,
      });
    });
  }

  const mempalace = config.mempalace;
  if (mempalace?.enabled) {
    await loadBuiltin("MemPalace", mempalace, 30_000, async () => {
      const { createMempalacePlugin } =
        await import("../../plugins/mempalace/index.js");
      const { resolveMempalacePaths } =
        await import("../../plugins/mempalace/provision.js");
      const { pythonPath, palacePath } = resolveMempalacePaths(mempalace);
      return createMempalacePlugin({
        pythonPath,
        palacePath,
        entityLanguages: mempalace.entityLanguages,
        verbose: mempalace.verbose,
        installedVersion: provisioned.get("mempalace")?.version,
      });
    });
  }

  const mem0 = config.mem0;
  if (mem0?.enabled) {
    await loadBuiltin("mem0", mem0, 15_000, async () => {
      const { createMem0Plugin } = await import("../../plugins/mem0/index.js");
      return createMem0Plugin({
        apiKey: mem0.apiKey,
        host: mem0.host,
        userId: mem0.userId,
      });
    });
  }

  const playwright = config.playwright;
  if (playwright?.enabled) {
    await loadBuiltin("Playwright", playwright, 15_000, async () => {
      const { createPlaywrightPlugin } =
        await import("../../plugins/playwright/index.js");
      return createPlaywrightPlugin({
        browser: playwright.browser,
        headless: playwright.headless,
        endpoint: playwright.endpoint,
        endpointFile: playwright.endpointFile,
      });
    });
  }
}

/**
 * Hot-reload all plugins: destroy current plugins, re-read config via the
 * validated loadConfig() path, re-load everything (external + built-in).
 * Returns the loaded plugin names and the config that was used.
 *
 * Throws on config parse/validation failure so the gateway can report an error.
 *
 * Does NOT restart the main process, backend session, or bot connection.
 * Active conversations continue uninterrupted — new MCP servers spawn
 * automatically on the next tool call.
 */
export async function reloadPlugins(
  activeFrontends?: string[],
): Promise<{ names: string[]; config: TalonConfig }> {
  // Validate config BEFORE tearing down existing plugins. If the config is
  // malformed the error propagates and current plugins stay intact.
  const { loadConfig, getFrontends } = await import("../config/index.js");
  const config = loadConfig();

  const frontends = activeFrontends ?? getFrontends(config);

  // New cache-bust key: the re-import below must load edited plugin source.
  reloadState.lastReloadAt = new Date().toISOString();

  log("plugin", "Hot-reload: destroying current plugins...");
  await registry.destroyAndClear();

  if (config.plugins.length > 0) {
    await loadPlugins(config.plugins, frontends);
  }
  await loadBuiltinPlugins(config);

  // Retire the hub's MCP children: the next tool call (any chat) spawns
  // fresh processes from the reloaded registry, while in-flight calls
  // drain on the old ones.
  const { reloadHubChildren } = await import("../mcp-hub/index.js");
  reloadHubChildren();

  const names = registry.all.map((p) => p.plugin.name);
  log(
    "plugin",
    `Hot-reload complete: ${names.length} plugins loaded [${names.join(", ")}]`,
  );

  return { names, config };
}
