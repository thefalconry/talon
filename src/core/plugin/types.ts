/**
 * Plugin system types + entry-shape type guards.
 */

import type { ActionResult } from "../types.js";

/** Path-based plugin entry (loaded as a Node module). */
export interface PluginPathEntry {
  path: string;
  config?: Record<string, unknown>;
  /** `false` keeps the entry in config but skips loading it. Default true. */
  enabled?: boolean;
}

/** Standalone MCP server entry (command + args, not a loadable module). */
export interface PluginMcpEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** `false` keeps the entry in config but skips registering it. Default true. */
  enabled?: boolean;
}

/** Configuration entry for a plugin in config.json. */
export type PluginEntry = PluginPathEntry | PluginMcpEntry;

/** Type guard: is this a path-based plugin? */
export function isPathPlugin(entry: PluginEntry): entry is PluginPathEntry {
  return "path" in entry;
}

/** Type guard: is this a standalone MCP server entry? */
export function isMcpPlugin(entry: PluginEntry): entry is PluginMcpEntry {
  return "command" in entry && "name" in entry && !("path" in entry);
}

/** Core plugin interface — only `name` is required. */
export interface TalonPlugin {
  /** Unique plugin identifier. Used as MCP server name prefix. */
  readonly name: string;

  /** Human-readable description for status/diagnostics. */
  readonly description?: string;

  /** Semver version string. */
  readonly version?: string;

  /**
   * Frontend whitelist — which frontends this plugin is active for.
   * If unset, the plugin is available on all frontends.
   * Example: ["telegram"] — only loads when Telegram frontend is active.
   */
  readonly frontends?: readonly string[];

  /**
   * Called once after the plugin is loaded and validated.
   * Use for one-time setup (connections, caches, etc).
   * Receives the resolved plugin config.
   */
  init?(config: Record<string, unknown>): Promise<void> | void;

  /**
   * Called during graceful shutdown. Clean up resources.
   */
  destroy?(): Promise<void> | void;

  /**
   * Absolute path to the MCP server script (spawned as subprocess via node/tsx).
   * Omit if the plugin only provides action handlers without MCP tools.
   * For non-Node MCP servers (Python, Go, etc.), use `mcpServer` instead.
   */
  mcpServerPath?: string;

  /**
   * Custom MCP server command and arguments (e.g. Python, Go, Rust servers).
   * Takes priority over `mcpServerPath` when both are set.
   * Example: { command: "/path/to/python", args: ["-m", "mempalace.mcp_server"] }
   */
  mcpServer?: {
    readonly command: string;
    readonly args: readonly string[];
  };

  /**
   * Materialize anything the MCP child needs on disk before it is spawned.
   *
   * MCP children are spawned lazily and respawned on demand for the lifetime
   * of the daemon, so state written once at load time can go missing long
   * before the last spawn. This hook runs every time the MCP server map is
   * built, making such state self-healing instead of broken-until-restart.
   * Must be synchronous, cheap, and idempotent; throwing is swallowed and
   * logged (a failed prepare must not take the whole server map down).
   */
  prepareMcpSpawn?(): void;

  /**
   * Map plugin config to env vars for the MCP subprocess and action handlers.
   * Called once at load time. Values are set on process.env for the main
   * process and passed to the MCP subprocess.
   */
  getEnvVars?(config: Record<string, unknown>): Record<string, string>;

  /**
   * Handle a gateway action. Return null if not recognized.
   * Actions are tried in plugin load order, first non-null wins.
   */
  handleAction?(
    body: Record<string, unknown>,
    chatId: string,
  ): Promise<ActionResult | null>;

  /**
   * Contribute additional context to the system prompt.
   * Called during config loading. Return text to append.
   */
  getSystemPromptAddition?(config: Record<string, unknown>): string;

  /**
   * Validate plugin config at load time.
   * Return an array of error messages, or empty/undefined if valid.
   */
  validateConfig?(config: Record<string, unknown>): string[] | undefined;
}

/** A loaded and validated plugin instance with its resolved config. */
export interface LoadedPlugin {
  readonly plugin: TalonPlugin;
  readonly config: Record<string, unknown>;
  readonly envVars: Record<string, string>;
  readonly path: string;
}

/** Stdio MCP server spec (command, args, env). */
export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}
