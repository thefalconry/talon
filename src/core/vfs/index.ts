/**
 * VFS — public surface and default namespace.
 *
 * `getVfs()` serves the process-wide namespace, built on first use rather
 * than at module load: the file mounts capture `dirs.*` when constructed,
 * and eager construction would freeze those paths into whichever process
 * (or test mock) happened to import this barrel first. Mounts project
 * live singletons, so there is nothing to inject at bootstrap:
 *
 *   talon://
 *     home/       workspace (writable)
 *     skills/     SKILL.md bundles (writable)
 *     scripts/    agent script bodies (writable)
 *     logs/       daily logs (read-only — the daemon writes these)
 *     proc/       task table, event bus ring, and the daemon's own
 *                 log/errors/alerts views (synthetic, read-only)
 *     plugins/    plugin registry view (synthetic, read-only)
 *
 * The namespace IS the filesystem: it lives at ~/.talon/ns (symlink
 * farm via nsdir.ts, live synthetic mounts via fusefs.ts when FUSE is
 * available), and every consumer — native tools, shell commands, the
 * user's own terminal, other backends' shells (Codex), spawned
 * processes — reaches it through the same real paths. There is no
 * tool-facing address scheme to translate: `~/.talon/ns/home/…` is the
 * address. (`talon://` survives only as the VFS's internal mount
 * grammar in vfs.ts / fusefs.ts; consumers never see it.)
 */

import { dirs, files } from "../../util/paths.js";
import { bus } from "../bus/index.js";
import { activeAlerts } from "../frontend-runtime/alerts.js";
import { registry } from "../plugin/registry.js";
import { taskTable } from "../tasks/index.js";
import { createDiagnosticViews } from "./mounts/diagnostics.js";
import { createFileMount } from "./mounts/files.js";
import { createPluginsMount, type PluginView } from "./mounts/plugins.js";
import { createProcMount } from "./mounts/proc.js";
import { Vfs } from "./vfs.js";

export { Vfs } from "./vfs.js";

export { mountNamespaceFs, unmountNamespaceFs } from "./fusefs.js";

function pluginViews(): PluginView[] {
  const modules: PluginView[] = registry.all.map(({ plugin, path }) => ({
    name: plugin.name,
    kind: "module",
    ...(plugin.description !== undefined
      ? { description: plugin.description }
      : {}),
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    source: path,
  }));
  const mcp: PluginView[] = registry.mcpEntries.map((entry) => ({
    name: entry.name,
    kind: "mcp",
    source: `${entry.command}${entry.args ? ` ${entry.args.join(" ")}` : ""}`,
  }));
  return [...modules, ...mcp];
}

function buildDefaultNamespace(): Vfs {
  const vfs = new Vfs();
  vfs.mount(
    "home",
    createFileMount({
      root: dirs.workspace,
      description: "The workspace — the agent's home directory",
      writable: true,
    }),
  );
  vfs.mount(
    "skills",
    createFileMount({
      root: dirs.skills,
      description: "SKILL.md workflow bundles",
      writable: true,
    }),
  );
  vfs.mount(
    "scripts",
    createFileMount({
      root: dirs.scripts,
      description: "Agent-authored script bodies",
      writable: true,
    }),
  );
  vfs.mount(
    "logs",
    createFileMount({
      root: dirs.logs,
      description: "Daily interaction logs (daemon-written)",
      writable: false,
    }),
  );
  vfs.mount(
    "proc",
    createProcMount({
      tasks: () => taskTable.list(),
      events: () => bus.recent(0),
      views: createDiagnosticViews({
        logPath: files.log,
        alerts: activeAlerts,
      }),
    }),
  );
  vfs.mount("plugins", createPluginsMount(pluginViews));
  return vfs;
}

let defaultVfs: Vfs | undefined;

/** The process-wide namespace, built on first use. */
export function getVfs(): Vfs {
  defaultVfs ??= buildDefaultNamespace();
  return defaultVfs;
}
