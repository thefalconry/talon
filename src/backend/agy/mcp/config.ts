/**
 * Talon's MCP servers, as Antigravity's `mcp_config.json` wants them.
 *
 * agy has no per-process MCP flag and no runtime `mcp add` API a child
 * can be handed: servers are read from one shared file,
 * `~/.gemini/config/mcp_config.json`, when the process starts. That
 * file is the user's too — it can hold servers they added with
 * `agy mcp add` and know nothing about Talon.
 *
 * So the contract here is narrow and defensive:
 *
 *   - Talon only ever owns keys prefixed `__talon__` (see
 *     [AGY_MCP_PREFIX]); every other key is read, kept, and written
 *     back untouched.
 *   - A write is read-modify-write through a temp file + rename, so a
 *     crash mid-write cannot truncate the user's config.
 *   - Entries are scoped — `__talon__<scope>__<server>` — so a chat's
 *     servers, a second chat's servers and a one-shot's servers can
 *     coexist and be removed independently.
 *   - On `mcp add` agy snapshots each server's tool schemas into
 *     `~/.gemini/antigravity-cli/mcp/<name>/`. Removing the config
 *     entry does not remove that directory, so [removeAgyMcpServers]
 *     deletes it explicitly. Left alone they accumulate forever (this
 *     host had 17 orphans from a backend deleted months earlier).
 *
 * Both paths are injectable (`TALON_AGY_MCP_CONFIG`,
 * `TALON_AGY_MCP_SNAPSHOT_DIR`, or explicit options) so tests never
 * touch the real files.
 */

import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  talonHubUrl,
  pluginHubUrl,
  hubPluginServerNames,
} from "../../../core/mcp-hub/index.js";
import { frontendsForChat } from "../../runtime/frontends.js";
import { logWarn } from "../../../util/log.js";
import { gatewayAuthHeaders } from "../../../core/engine/gateway-auth.js";
import { AGY_MCP_PREFIX } from "../constants.js";
import { userHome } from "../../../util/fs-path.js";

// ── Paths ───────────────────────────────────────────────────────────────────

/** Where agy reads its MCP servers from. Env override for tests. */
function agyMcpConfigPath(override?: string): string {
  return (
    override ||
    process.env.TALON_AGY_MCP_CONFIG ||
    join(userHome(), ".gemini", "config", "mcp_config.json")
  );
}

/** Where agy snapshots each registered server's tool schemas. */
function agyMcpSnapshotDir(override?: string): string {
  return (
    override ||
    process.env.TALON_AGY_MCP_SNAPSHOT_DIR ||
    join(userHome(), ".gemini", "antigravity-cli", "mcp")
  );
}

// ── Shapes ──────────────────────────────────────────────────────────────────

/**
 * One http MCP entry, in the exact shape `agy mcp add --type http`
 * writes. `disabled` is written explicitly: agy treats a missing key
 * as enabled today, but the CLI's own writer always emits it and an
 * entry that silently flips off would be invisible to debug.
 */
export interface AgyMcpServer {
  disabled: boolean;
  /** Gateway bearer token (`agy mcp add --header` writes this shape). */
  headers: Record<string, string>;
  serverUrl: string;
}

interface AgyMcpConfigFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── Naming ──────────────────────────────────────────────────────────────────

/**
 * Chat ids contain characters (`-`, `@`, `:`) that also appear in
 * server names, so a raw join would make `__talon__a__b__c` ambiguous.
 * Normalise to a single safe token; the id only has to round-trip to
 * itself, not back to the chat id.
 */
export function agyScopeSlug(chatId: string): string {
  const slug = chatId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "chat";
}

/** Full config key for one Talon server inside one scope. */
export function agyServerKey(scope: string, server: string): string {
  return `${AGY_MCP_PREFIX}${scope}__${server}`;
}

/** True for a key Talon owns (and may therefore rewrite or delete). */
export function isTalonAgyKey(key: string): boolean {
  return key.startsWith(AGY_MCP_PREFIX);
}

// ── Building ────────────────────────────────────────────────────────────────

/**
 * Build the scoped server set for a chat: one frontend-tools server
 * per frontend that owns the chat, brave when configured, plus every
 * hub-served plugin. Identical membership to
 * `codex/mcp-config.ts: buildCodexMcpServers` — same hub URLs, same
 * `frontendsForChat` scoping — differing only in the wire shape and
 * the `__talon__<scope>__` key prefix agy needs.
 */
export function buildAgyMcpServers(args: {
  chatId: string;
  bridgeUrl: string;
  frontends: readonly string[];
  braveApiKey?: string;
  /** Key scope; defaults to the chat's slug. One-shots pass their own. */
  scope?: string;
}): Record<string, AgyMcpServer> {
  const { chatId, bridgeUrl, frontends, braveApiKey } = args;
  const scope = args.scope ?? agyScopeSlug(chatId);
  const servers: Record<string, AgyMcpServer> = {};
  const headers = gatewayAuthHeaders();
  const add = (name: string, url: string) => {
    servers[agyServerKey(scope, name)] = {
      disabled: false,
      headers,
      serverUrl: url,
    };
  };

  for (const frontend of frontendsForChat(chatId, frontends)) {
    add(`${frontend}-tools`, talonHubUrl(bridgeUrl, frontend, chatId));
  }
  if (braveApiKey) {
    add("brave-search", pluginHubUrl(bridgeUrl, "brave-search", chatId));
  }
  for (const name of hubPluginServerNames()) {
    add(name, pluginHubUrl(bridgeUrl, name, chatId));
  }
  return servers;
}

// ── Reading / writing ───────────────────────────────────────────────────────

function readConfigFile(path: string): AgyMcpConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as AgyMcpConfigFile;
  } catch (err) {
    // A corrupt file is the user's, not ours to silently replace.
    logWarn(
      "agent",
      `agy mcp_config.json at ${path} is not valid JSON (${
        err instanceof Error ? err.message : String(err)
      }); starting from an empty server map — existing content will be replaced`,
    );
    return {};
  }
}

/** Read the file's current `mcpServers` map (empty when absent). */
export function readAgyMcpServers(
  configPath?: string,
): Record<string, unknown> {
  const file = readConfigFile(agyMcpConfigPath(configPath));
  const servers = file.mcpServers;
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
}

/**
 * Atomically persist a new `mcpServers` map, preserving every other
 * top-level key of the file. Temp file in the same directory (so
 * `rename` stays on one filesystem and is therefore atomic) then
 * rename over the target.
 */
function writeConfigAtomic(
  path: string,
  servers: Record<string, unknown>,
): void {
  const file = readConfigFile(path);
  file.mcpServers = servers;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.talon-${randomBytes(6).toString("hex")}.tmp`;
  try {
    // Owner-only: Talon's entries carry the gateway token.
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

export interface AgyMcpWriteOptions {
  configPath?: string;
  snapshotDir?: string;
}

/**
 * Install `servers` as the complete set of Talon entries for `scope`.
 *
 * Entries under other scopes and every non-Talon entry survive
 * untouched; stale entries of THIS scope that are no longer in
 * `servers` are dropped (and their schema snapshots with them).
 * Returns the added / removed key names so `refreshTools` can report
 * a diff.
 */
export function writeAgyMcpServers(
  scope: string,
  servers: Record<string, AgyMcpServer>,
  options: AgyMcpWriteOptions = {},
): { added: string[]; removed: string[] } {
  const path = agyMcpConfigPath(options.configPath);
  const current = readAgyMcpServers(path);
  const scopePrefix = `${AGY_MCP_PREFIX}${scope}__`;

  const next: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(current)) {
    if (key.startsWith(scopePrefix) && !(key in servers)) {
      removed.push(key);
      continue;
    }
    next[key] = value;
  }
  const added = Object.keys(servers).filter((key) => !(key in current));
  Object.assign(next, servers);

  writeConfigAtomic(path, next);
  removeSnapshotDirs(removed, options.snapshotDir);
  return { added, removed };
}

/**
 * Drop every Talon entry belonging to `scope`, plus the schema
 * snapshot directories agy left behind for them. Returns the removed
 * key names.
 */
export function removeAgyMcpServers(
  scope: string,
  options: AgyMcpWriteOptions = {},
): string[] {
  const path = agyMcpConfigPath(options.configPath);
  const current = readAgyMcpServers(path);
  const scopePrefix = `${AGY_MCP_PREFIX}${scope}__`;
  const removed = Object.keys(current).filter((key) =>
    key.startsWith(scopePrefix),
  );
  if (removed.length === 0) return [];

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!removed.includes(key)) next[key] = value;
  }
  writeConfigAtomic(path, next);
  removeSnapshotDirs(removed, options.snapshotDir);
  return removed;
}

/**
 * Drop every `__talon__*` entry this process did not write.
 *
 * Run once at init. Talon's entries are per-boot state — a daemon that
 * died without cleaning up, or (as on this host) a backend deleted
 * months ago, leaves keys pointing at hub URLs on ports nothing is
 * listening on, and agy fails every tool call against them. Keys in
 * `keep` are ours and survive; nothing outside the Talon prefix is
 * ever touched.
 */
export function pruneStaleTalonEntries(
  keep: readonly string[] = [],
  options: AgyMcpWriteOptions = {},
): string[] {
  const path = agyMcpConfigPath(options.configPath);
  const current = readAgyMcpServers(path);
  const kept = new Set(keep);
  const stale = Object.keys(current).filter(
    (key) => isTalonAgyKey(key) && !kept.has(key),
  );
  if (stale.length === 0) return [];

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!stale.includes(key)) next[key] = value;
  }
  writeConfigAtomic(path, next);
  removeSnapshotDirs(stale, options.snapshotDir);
  return stale;
}

/**
 * Delete the tool-schema snapshot directories agy wrote for the given
 * server names. Best-effort: a missing directory is the normal case
 * for a server that never successfully registered.
 */
export function removeSnapshotDirs(
  names: readonly string[],
  snapshotDir?: string,
): void {
  if (names.length === 0) return;
  const root = agyMcpSnapshotDir(snapshotDir);
  for (const name of names) {
    // Defence in depth: only ever recurse into a directory whose name
    // is a Talon key with no path separators in it.
    if (!isTalonAgyKey(name) || /[\\/]/.test(name)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
    } catch (err) {
      logWarn(
        "agent",
        `agy: could not remove MCP snapshot dir ${name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
