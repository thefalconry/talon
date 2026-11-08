/**
 * Plugin registry singleton + shared module state: the reload timestamp
 * (injected into MCP subprocess env) and the `_deps` indirection that lets
 * tests swap the module importer.
 *
 * Every plugin submodule imports the SAME `registry` instance and the SAME
 * `reloadState` / `_deps` holders from here so state stays coherent.
 */

import { pathToFileURL } from "node:url";
import { logError, logWarn } from "../../util/log.js";
import type { LoadedPlugin, PluginMcpEntry } from "./types.js";

class PluginRegistry {
  private readonly plugins: LoadedPlugin[] = [];
  private readonly standaloneMcpServers: PluginMcpEntry[] = [];

  get all(): readonly LoadedPlugin[] {
    return this.plugins;
  }

  get mcpEntries(): readonly PluginMcpEntry[] {
    return this.standaloneMcpServers;
  }

  get count(): number {
    return this.plugins.length;
  }

  /** True when `name` is free; warns and returns false on a duplicate. */
  private isNameFree(name: string): boolean {
    const source =
      this.plugins.find((entry) => entry.plugin.name === name)?.path ??
      (this.standaloneMcpServers.some((entry) => entry.name === name)
        ? "standalone MCP entry"
        : undefined);
    if (!source) return true;
    logWarn(
      "plugin",
      `Duplicate plugin/MCP name "${name}" — skipping (already registered from ${source})`,
    );
    return false;
  }

  register(loaded: LoadedPlugin): boolean {
    if (!this.isNameFree(loaded.plugin.name)) return false;
    this.plugins.push(loaded);
    return true;
  }

  registerMcpEntry(entry: PluginMcpEntry): boolean {
    if (!this.isNameFree(entry.name)) return false;
    this.standaloneMcpServers.push(entry);
    return true;
  }

  getByName(name: string): LoadedPlugin | undefined {
    return this.plugins.find((p) => p.plugin.name === name);
  }

  async destroyAll(): Promise<void> {
    for (const { plugin } of this.plugins) {
      try {
        await plugin.destroy?.();
      } catch (err) {
        logError(
          "plugin",
          `${plugin.name} destroy error: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /** Destroy all plugins, clean up env vars, and clear the registry. Used by hot-reload. */
  async destroyAndClear(): Promise<void> {
    // Clean up env vars set by plugins before destroying
    for (const { envVars } of this.plugins) {
      for (const key of Object.keys(envVars)) {
        delete process.env[key];
      }
    }
    await this.destroyAll();
    this.plugins.length = 0;
    this.standaloneMcpServers.length = 0;
  }
}

export const registry = new PluginRegistry();

/**
 * The last plugin reload time: the module cache-bust key (see
 * `_deps.importModule`), also passed to every MCP child as TALON_RELOAD_AT.
 * On a holder object so other modules can read/update it.
 */
export const reloadState: { lastReloadAt: string } = {
  lastReloadAt: new Date().toISOString(),
};

/** Internal deps — exposed as an object so tests can replace properties.
 *  Direct function exports can't be mocked for internal callers in ESM. */
export const _deps = {
  importModule: async (path: string): Promise<Record<string, unknown>> => {
    // Convert absolute filesystem paths to file:// URLs on Windows where
    // dynamic import() rejects bare drive-letter paths (e.g. C:\...).
    // Leave node: specifiers, relative paths, and URLs unchanged.
    const isAbsFilePath = /^[a-zA-Z]:[/\\]/.test(path) || path.startsWith("/");
    if (!isAbsFilePath) return import(path);

    // Cache-bust with the reload timestamp. ESM caches modules by resolved
    // URL forever, so without a changing query a hot reload re-imports the
    // *old* module object and the plugin's own source edits are invisible
    // until a full restart — silently, since the stale module still loads
    // fine. The timestamp only moves per reload, so every module in one
    // load cycle shares a key.
    const url = pathToFileURL(path);
    url.searchParams.set("talonReloadAt", reloadState.lastReloadAt);
    return import(url.href);
  },
};
