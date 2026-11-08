/**
 * Hub child manager — the single owner of external MCP server
 * subprocesses (plugins, brave-search).
 *
 * One child per key, reaped after an idle TTL, so resident cost tracks
 * *recently active* keys, not every chat ever seen.
 *
 * Keys: chat-scoped plugins get `name + chatId` (they read
 * `TALON_CHAT_ID` at boot, so instances cannot be shared across chats
 * without changing plugin semantics); chat-agnostic servers (brave)
 * use a shared key. Either way the spec factory decides — this module
 * only manages lifecycles.
 *
 * Each child is spawned directly by the daemon — stdout JSON filtering
 * happens in-process (child-transport.ts) and orphan cleanup if the
 * daemon is SIGKILLed is the child guard's job (one reaper per daemon,
 * child-guard.ts; per-child supervisor wrap as the fallback) — then
 * connected once over stdio and shared by every hub session that
 * proxies to it.
 *
 * Tool lists are cached per SERVER, not just per child: a chat-scoped
 * plugin serves the same tools to every chat, so a new session's
 * tools/list is answered from the cache and the chat's own child is only
 * spawned when a tool is actually called. Without this every session —
 * each chat, sub-agent and isolated cron/heartbeat run — spawned the
 * whole plugin fleet just to enumerate tools at session start. Plugin
 * reload restarts children and clears the cache.
 *
 * Every exit is accounted for: the child's exit code, signal and
 * stderr tail are logged when it goes away unasked (handshake death,
 * crash) and kept per key so a registration failure upstream can name
 * the cause instead of just "Connection closed" (see getLastChildExit).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { log, logError, logWarn } from "../../util/log.js";
import { HubChildTransport, type ChildExit } from "./child-transport.js";
import { raiseAlert, resolveAlert } from "../frontend-runtime/alerts.js";
import { faultText } from "../engine/fault-text.js";
import { guardChild, guardedSpec, releaseChild } from "./child-guard.js";

export type ChildSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** The daemon gateway's base URL — arms the reaper's bridge watchdog. */
  bridgeUrl?: string;
};

export type ChildHandle = {
  /** Cached tools/list result — fetched once per child lifetime. */
  listTools(): Promise<Tool[]>;
  /**
   * Forward one tool call; tracked so retirement can drain in-flight work.
   * Aborting `signal` cancels the call on the child too.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
};

type ChildEntry = {
  handle: ChildHandle;
  key: string;
  lastActivity: number;
  /** In-flight request count — retirement waits for this to hit zero. */
  pending: number;
  /**
   * Set when the child was replaced (plugin reload) but still has
   * in-flight calls. Closed as soon as `pending` drains (or by the
   * retire grace timer, whichever comes first).
   */
  retired: boolean;
  transport: HubChildTransport;
  close: () => Promise<void>;
};

const children = new Map<string, ChildEntry>();
const inflight = new Map<string, Promise<ChildHandle>>();

/** Server name → its tools, as last listed by any of its children. */
const toolListCache = new Map<string, Tool[]>();
/** Bumped on reload/shutdown so an old child can't refill the cache. */
let toolListGeneration = 0;

/**
 * Most recent exit per key, whether the child died during the
 * handshake (never registered) or later. Consulted by the backends'
 * registration path to explain a failure that surfaced upstream as a
 * bare "Connection closed".
 */
export type ChildExitRecord = ChildExit & {
  at: number;
  /** Last stderr lines before exit (bounded ring buffer). */
  stderr: string[];
};
const lastExits = new Map<string, ChildExitRecord>();

/** Last recorded exit for `key`, or null if it never exited. */
export function getLastChildExit(key: string): ChildExitRecord | null {
  return lastExits.get(key) ?? null;
}

/**
 * One-line exit summary: `code=1 signal=null 3s ago; stderr: a | b`.
 * `maxStderrLines` bounds the stderr part for compact callers.
 */
export function formatChildExit(
  exit: ChildExitRecord,
  maxStderrLines = exit.stderr.length,
): string {
  const age = Math.round((Date.now() - exit.at) / 1000);
  const head = `code=${exit.code} signal=${exit.signal} ${age}s ago`;
  const lines = exit.stderr.slice(-maxStderrLines);
  return lines.length > 0 ? `${head}; stderr: ${lines.join(" | ")}` : head;
}

/**
 * Human-readable form of a child key for log lines. Keys join server name
 * and chat id with a NUL byte (see `childKey` in index.ts) — unambiguous
 * as a Map key, but it renders as `\u0000` in the JSON log.
 */
function describeKey(key: string): string {
  const nul = key.indexOf("\u0000");
  return nul === -1 ? key : `${key.slice(0, nul)} chat=${key.slice(nul + 1)}`;
}

/**
 * Bookkeeping for a child process that has gone away, asked or not.
 * Wired as the transport's `onclose` BEFORE `client.connect` so the SDK
 * chains it ahead of its own close handling — set afterwards it would
 * replace the SDK's handler and every in-flight request on a dead
 * child would hang instead of rejecting with "Connection closed".
 */
function onChildClosed(key: string, transport: HubChildTransport): void {
  const exit = transport.exit ?? { code: null, signal: null };
  const record: ChildExitRecord = {
    ...exit,
    at: Date.now(),
    stderr: transport.stderrLines,
  };
  lastExits.set(key, record);
  const entry = children.get(key);
  if (entry?.transport === transport) children.delete(key);
  // Hub-initiated closes (reap/retire/shutdown) are logged by their
  // callers; only an unasked exit is news.
  if (transport.closedByHub) return;
  const phase = entry
    ? "exited — will respawn on demand"
    : "died before registration";
  logWarn(
    "gateway",
    `hub child ${describeKey(key)} ${phase} (pid ${transport.pid ?? "?"}): ${formatChildExit(record)}`,
  );
}

/**
 * Negative cache for spawn failures. A child whose backing service is down
 * (e.g. playwright-tools with its browser endpoint offline) dies at the
 * connect handshake, and without this every single turn re-paid the
 * spawn+handshake (~600ms) and re-logged the failure for the whole outage.
 * Failures back off exponentially; the first attempt after the window
 * clears the entry on success, so recovery costs one turn.
 */
type SpawnFailure = { at: number; count: number; error: unknown };
const spawnFailures = new Map<string, SpawnFailure>();
const FAILURE_BACKOFF_BASE_MS = 30_000;
const FAILURE_BACKOFF_MAX_MS = 10 * 60_000;
/** Consecutive spawn failures of one child before the operator hears. */
const SPAWN_FAILURE_ALERT_THRESHOLD = 3;

function failureBackoffMs(count: number): number {
  return Math.min(
    FAILURE_BACKOFF_BASE_MS * 2 ** (count - 1),
    FAILURE_BACKOFF_MAX_MS,
  );
}

/** The MCP server name of a child key (keys are `server\0chat`). */
function serverOf(key: string): string {
  const nul = key.indexOf("\u0000");
  return nul === -1 ? key : key.slice(0, nul);
}

/**
 * Count a failed spawn into the negative cache, log it with the child's
 * last words, and alert once the same child has failed
 * SPAWN_FAILURE_ALERT_THRESHOLD times running — its tools are gone for
 * every turn until whatever backs it comes back.
 */
function noteSpawnFailure(key: string, err: unknown): void {
  const count = (spawnFailures.get(key)?.count ?? 0) + 1;
  spawnFailures.set(key, { at: Date.now(), count, error: err });
  const backoffMs = failureBackoffMs(count);
  // The exit record is this attempt's only when it is fresh — an older
  // one belongs to a child that ran and was reaped long ago.
  const exit = lastExits.get(key);
  const stderr =
    exit && Date.now() - exit.at < 60_000 ? exit.stderr.at(-1) : undefined;
  const detail = faultText(err);
  logWarn(
    "gateway",
    `hub child spawn failed ${describeKey(key)} attempt=${count} backoff_ms=${backoffMs} ` +
      `error="${detail}"${stderr ? ` stderr="${faultText(stderr)}"` : ""}`,
  );
  if (count < SPAWN_FAILURE_ALERT_THRESHOLD) return;
  const server = serverOf(key);
  raiseAlert(
    `mcp.child.${server}`,
    `MCP server "${server}" has failed to start ${count} times in a row: ${detail}` +
      `${stderr ? ` (stderr: ${faultText(stderr, 120)})` : ""}. Its tools are unavailable until it starts.`,
  );
}

/** Idle TTL for hub children; tunable for tests / tight deployments. */
function idleTtlMs(): number {
  const raw = Number(process.env.TALON_MCP_HUB_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000;
}

const REAP_INTERVAL_MS = 60_000;

/**
 * Backstop for one forwarded tool call. The SDK's default (60s) would cut
 * any longer plugin call, though the upstream client allows far more —
 * its own timeout or cancel reaches the child through the forwarded
 * signal. This only bounds a call nobody is waiting on any more.
 */
const CHILD_CALL_TIMEOUT_MS = 65 * 60_000;
let reaper: ReturnType<typeof setInterval> | null = null;

async function spawnChild(key: string, spec: ChildSpec): Promise<ChildHandle> {
  const run = guardedSpec(spec);
  const generation = toolListGeneration;
  const transport = new HubChildTransport({
    command: run.command,
    args: run.args,
    // Merge over the daemon env — same visibility the SDK-spawned
    // subprocesses had (PATH, HOME, proxy vars, …).
    env: { ...(process.env as Record<string, string>), ...run.env },
    onSpawned: (pid) => guardChild(pid, spec.bridgeUrl),
    onExited: releaseChild,
  });
  transport.onclose = () => onChildClosed(key, transport);
  const client = new Client(
    { name: "talon-mcp-hub", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  let toolsCache: Tool[] | null = null;
  const track = async <T>(fn: () => Promise<T>): Promise<T> => {
    entry.pending++;
    try {
      return await fn();
    } finally {
      entry.pending--;
      if (entry.retired && entry.pending === 0) {
        void entry.close();
      }
    }
  };
  const entry: ChildEntry = {
    key,
    lastActivity: Date.now(),
    pending: 0,
    retired: false,
    transport,
    // Idempotent: retirement can race its own grace timer.
    close: (() => {
      let closing: Promise<void> | null = null;
      return () =>
        (closing ??= (async () => {
          try {
            await client.close();
          } catch (err) {
            logWarn(
              "gateway",
              `hub child ${describeKey(key)} close failed: ${String(err)}`,
            );
          }
        })());
    })(),
    handle: {
      listTools: () =>
        track(async () => {
          if (toolsCache) return toolsCache;
          const result = await client.listTools();
          toolsCache = result.tools;
          if (generation === toolListGeneration) {
            toolListCache.set(serverOf(key), result.tools);
          }
          return toolsCache;
        }),
      callTool: (name, args, signal) =>
        track(
          () =>
            client.callTool({ name, arguments: args }, undefined, {
              signal,
              timeout: CHILD_CALL_TIMEOUT_MS,
            }) as Promise<CallToolResult>,
        ),
    },
  };

  children.set(key, entry);
  log(
    "gateway",
    `hub child started: ${describeKey(key)} (pid ${transport.pid ?? "?"})`,
  );
  return entry.handle;
}

/**
 * Return the live child for `key`, or spawn it from `spec()`. Concurrent
 * callers share one spawn. The spec factory is called only on spawn, so
 * it always reflects the current plugin registry (reload-safe).
 */
export function acquireChild(
  key: string,
  spec: () => ChildSpec,
): Promise<ChildHandle> {
  const existing = children.get(key);
  if (existing) {
    existing.lastActivity = Date.now();
    return Promise.resolve(existing.handle);
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const failure = spawnFailures.get(key);
  if (failure && inSpawnBackoff(key)) {
    return Promise.reject(
      failure.error instanceof Error
        ? failure.error
        : new Error(String(failure.error)),
    );
  }

  const spawn = async (): Promise<ChildHandle> => {
    try {
      const handle = await spawnChild(key, spec());
      if (spawnFailures.delete(key)) {
        const server = serverOf(key);
        resolveAlert(
          `mcp.child.${server}`,
          `MCP server "${server}" is starting normally again.`,
        );
      }
      return handle;
    } catch (err) {
      noteSpawnFailure(key, err);
      throw err;
    }
  };
  // `.finally` always runs after the `set` below. A `finally` block inside
  // `spawn` would not: when `spec()` throws synchronously it runs before
  // the set, leaving the rejected promise in `inflight` for good.
  const promise = spawn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/**
 * tools/list for `key` without spawning when avoidable: served from the
 * per-server cache once any child of that server has listed its tools
 * (see header). Falls through to the chat's own child when nothing is
 * cached yet, or when this key is inside its spawn-failure backoff —
 * a server that cannot start keeps failing its listing, as before,
 * rather than advertising tools every call to which would fail.
 */
export async function listChildTools(
  key: string,
  spec: () => ChildSpec,
): Promise<Tool[]> {
  const live = children.get(key);
  const cached = toolListCache.get(serverOf(key));
  if (!live && cached && !inSpawnBackoff(key)) return cached;
  const child = await acquireChild(key, spec);
  return child.listTools();
}

function inSpawnBackoff(key: string): boolean {
  const failure = spawnFailures.get(key);
  return (
    failure !== undefined &&
    Date.now() - failure.at < failureBackoffMs(failure.count)
  );
}

/** Close every child immediately. Daemon shutdown path. */
export async function closeAllChildren(): Promise<void> {
  const entries = [...children.values()];
  children.clear();
  toolListCache.clear();
  toolListGeneration++;
  await Promise.allSettled(entries.map((entry) => entry.close()));
  if (entries.length > 0) {
    log("gateway", `hub: closed ${entries.length} MCP child(ren)`);
  }
}

/**
 * Grace window for retired children: an in-flight tool call gets this
 * long to finish on the old process before it's closed under it.
 */
const RETIRE_GRACE_MS = 60_000;

/**
 * Retire every child: remove from the registry so the NEXT acquire
 * spawns fresh (reloaded plugin code), but let in-flight calls finish
 * on the old process. A chat mid-tool-call during `/reload-plugins`
 * sees its call complete normally; the old child closes once its last
 * call drains (or after the grace window, whichever comes first).
 */
export function retireAllChildren(): void {
  const entries = [...children.values()];
  children.clear();
  // Reloaded plugin code may expose different tools.
  toolListCache.clear();
  toolListGeneration++;
  for (const entry of entries) {
    entry.retired = true;
    if (entry.pending === 0) {
      void entry.close();
      continue;
    }
    log(
      "gateway",
      `hub child ${entry.key} retired with ${entry.pending} in-flight call(s) — draining`,
    );
    const force = setTimeout(() => void entry.close(), RETIRE_GRACE_MS);
    force.unref?.();
  }
  if (entries.length > 0) {
    log("gateway", `hub: retired ${entries.length} MCP child(ren)`);
  }
}

function reapIdle(): void {
  const cutoff = Date.now() - idleTtlMs();
  for (const [key, entry] of children) {
    // A call outliving the TTL is work, not idleness — closing the child
    // would fail it mid-flight. The first sweep after it drains reaps.
    if (entry.lastActivity >= cutoff || entry.pending > 0) continue;
    children.delete(key);
    entry.close().catch((err) => {
      logError("gateway", `hub reap of ${describeKey(key)} failed`, err);
    });
    log("gateway", `hub child reaped (idle): ${describeKey(key)}`);
  }
}

export function startChildReaper(): void {
  if (reaper) return;
  reaper = setInterval(reapIdle, REAP_INTERVAL_MS);
  reaper.unref?.();
}

export function stopChildReaper(): void {
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}

/** Diagnostic: live child keys (tests, /status introspection). */
export function getActiveChildKeys(): string[] {
  return [...children.keys()];
}
