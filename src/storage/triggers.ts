/**
 * Persistent trigger store, backed by the `triggers` table.
 *
 * Triggers are bot-authored scripts that run as supervised long-running
 * subprocesses and signal back to fire wake-up messages into a chat.
 * Supervision metadata lives in SQLite (transactional, so a crash
 * can't tear the store mid-status-flip); script bodies and run logs
 * stay next to each other on disk under `~/.talon/data/trigger-runs/`.
 * The one-shot legacy import accepts the JsonStore envelope, the
 * pre-envelope bare object, and the original bare-array triggers.json.
 */

import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { log, logError, logWarn } from "../util/log.js";
import { dirs, files } from "../util/paths.js";
import { importLegacyJson } from "./legacy-import.js";
import { inTransaction } from "./db.js";
import * as repo from "./repositories/triggers-repo.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type {
  Trigger,
  TriggerLanguage,
  TriggerStatus,
} from "./repositories/triggers-repo.js";
import type { Trigger, TriggerLanguage } from "./repositories/triggers-repo.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_SECONDS = 24 * 60 * 60; // 24h
export const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60; // 7d
/** Default per-chat cap on simultaneously active triggers (`config.triggers.maxActivePerChat`). */
export const MAX_ACTIVE_PER_CHAT = 5;
/** Truncate fire payloads at this many bytes to keep wake prompts sane. */
export const FIRE_PAYLOAD_MAX_BYTES = 4_096;

function isTrigger(value: unknown): value is Trigger {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

// ── Startup ──────────────────────────────────────────────────────────────────

/**
 * One-shot legacy import + restart recovery. Any trigger that was
 * "running"/"pending" when the previous process died needs handling:
 * non-persistent ones are marked "terminated" so the bot gets a wake
 * fire about what happened — the child was either killed on clean
 * shutdown, or torn down with a Docker/systemd cgroup on crash.
 * (Outside a cgroup, a crash could leave the child orphaned and alive,
 * but we don't try to recover non-persistent triggers — that's what
 * persistent is for.) Persistent triggers are parked in "pending" with
 * their pid preserved so resumeAfterRestart can probe the stored pid,
 * SIGKILL any surviving orphan, and re-spawn.
 */
/**
 * The lastError recoverInterrupted stamps on non-persistent triggers
 * that were alive when the previous process died. MUST match the
 * literal in sql/triggers.sql (terminateInterrupted) — resume.ts keys
 * its late-wake decision on it.
 */
export const RESTART_KILL_ERROR = "Talon restarted while trigger was running";

/**
 * The lastError shutdownTriggers stamps on non-persistent triggers it kills
 * during a clean shutdown. Their terminal wake is deliberately not dispatched
 * while the daemon is tearing down — resume.ts keys the next boot's late-wake
 * decision on this marker, exactly as it does for RESTART_KILL_ERROR.
 */
export const SHUTDOWN_KILL_ERROR = "Killed by Talon shutdown";

export function loadTriggers(): void {
  try {
    importLegacyJson({
      path: files.triggers,
      category: "triggers",
      what: "trigger(s)",
      ingest: (data) => {
        const triggers = Array.isArray(data)
          ? data
          : data && typeof data === "object"
            ? Object.values(data)
            : [];
        let imported = 0;
        inTransaction(() => {
          for (const t of triggers) {
            if (!isTrigger(t)) continue;
            repo.upsert(t);
            imported++;
          }
        });
        return imported;
      },
    });

    const { terminated, parked } = repo.recoverInterrupted(Date.now());

    const count = repo.count();
    if (count > 0) {
      const notes: string[] = [];
      if (terminated > 0) notes.push(`${terminated} terminated by restart`);
      if (parked > 0) notes.push(`${parked} persistent → will respawn`);
      log(
        "triggers",
        `Loaded ${count} trigger(s)${notes.length ? ` (${notes.join(", ")})` : ""}`,
      );
    }
  } catch (err) {
    logError("triggers", "Failed to load triggers", err);
  }
}

// ── ID + path helpers ────────────────────────────────────────────────────────

export function generateTriggerId(): string {
  return `trig_${randomUUID()}`;
}

export function languageExtension(lang: TriggerLanguage): string {
  switch (lang) {
    case "bash":
      return "sh";
    case "python":
      return "py";
    case "node":
      return "js";
    case "lua":
      return "lua";
  }
}

export function triggerScriptPath(
  chatId: string,
  id: string,
  lang: TriggerLanguage,
): string {
  return resolve(
    dirs.triggerRuns,
    sanitizeChatId(chatId),
    `${id}.${languageExtension(lang)}`,
  );
}

export function triggerLogPath(chatId: string, id: string): string {
  return resolve(dirs.triggerRuns, sanitizeChatId(chatId), `${id}.log`);
}

/** Restrict chatId to filesystem-safe characters for path use. */
export function sanitizeChatId(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ── Validation ───────────────────────────────────────────────────────────────

const NAME_RE = /^[a-zA-Z0-9 _.-]{1,64}$/;
const SUPPORTED_LANGUAGES: readonly TriggerLanguage[] = [
  "bash",
  "python",
  "node",
  "lua",
];
const SCRIPT_MAX_BYTES = 64 * 1024;

export function validateLanguage(value: unknown): value is TriggerLanguage {
  return (
    typeof value === "string" &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
  );
}

export function validateName(name: string): string | null {
  if (!name) return "Missing name";
  if (!NAME_RE.test(name))
    return "Name must be 1-64 chars of letters, digits, spaces, dot, dash, underscore";
  return null;
}

export function validateScript(script: string): string | null {
  if (!script || !script.trim()) return "Missing script body";
  if (Buffer.byteLength(script, "utf-8") > SCRIPT_MAX_BYTES)
    return `Script too large (max ${SCRIPT_MAX_BYTES} bytes)`;
  return null;
}

export function validateTimeout(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0)
    return "Timeout must be a positive number";
  if (seconds > MAX_TIMEOUT_SECONDS)
    return `Timeout exceeds max (${MAX_TIMEOUT_SECONDS}s = 7d)`;
  return null;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function addTrigger(t: Trigger): void {
  repo.upsert(t);
}

export function getTrigger(id: string): Trigger | undefined {
  return repo.get(id);
}

export function getTriggerByName(
  chatId: string,
  name: string,
): Trigger | undefined {
  return repo.getByName(chatId, name);
}

export function getTriggersForChat(chatId: string): Trigger[] {
  return repo.listByChat(chatId);
}

export function getActiveTriggersForChat(chatId: string): Trigger[] {
  return getTriggersForChat(chatId).filter(
    (t) => t.status === "running" || t.status === "pending",
  );
}

export function getAllTriggers(): Trigger[] {
  return repo.listAll();
}

/**
 * Merge `updates` into the stored trigger. A key present with value
 * `undefined` clears that field (Object.assign semantics, matching the
 * in-memory era — the supervisor relies on it to drop e.g. a dead pid).
 */
export function updateTrigger(
  id: string,
  updates: Partial<Trigger>,
): Trigger | undefined {
  return inTransaction(() => {
    const existing = repo.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...updates };
    repo.upsert(merged);
    return merged;
  });
}

/**
 * How long a settled trigger (fired/errored/cancelled/timed_out/terminated)
 * is kept for post-mortem inspection before the daily sweep removes it.
 * Without a sweep the trigger list accumulates corpses forever — a live
 * audit found 12 of 14 listed triggers dead, some over a week old.
 */
export const SETTLED_TRIGGER_TTL_MS = 72 * 60 * 60_000; // 3 days

/**
 * Delete settled triggers whose terminal state is older than `ttlMs`
 * (script + log files included, via deleteTrigger). Running/pending
 * triggers are never touched. Returns how many were pruned.
 */
export function pruneSettledTriggers(
  nowMs = Date.now(),
  ttlMs = SETTLED_TRIGGER_TTL_MS,
): number {
  let pruned = 0;
  for (const t of getAllTriggers()) {
    if (t.status === "running" || t.status === "pending") continue;
    const settledAt = t.endedAt ?? t.lastFireAt ?? t.startedAt ?? t.createdAt;
    if (nowMs - settledAt < ttlMs) continue;
    if (deleteTrigger(t.id)) pruned++;
  }
  return pruned;
}

/** Delete a trigger and best-effort clean up its on-disk script + log. */
export function deleteTrigger(id: string): boolean {
  const t = repo.get(id);
  if (!t) return false;
  repo.remove(id);
  for (const path of [t.scriptPath, t.logPath]) {
    try {
      rmSync(path, { force: true });
    } catch (err) {
      // Best effort; `force` already absorbs a missing file, so this is
      // a real fault that leaves an orphan on disk.
      logWarn(
        "triggers",
        `Could not remove trigger file id=${id} path=${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return true;
}

/** Write a script body for a trigger, creating directories as needed. */
export function writeScriptFile(
  chatId: string,
  id: string,
  lang: TriggerLanguage,
  body: string,
): string {
  const path = triggerScriptPath(chatId, id, lang);
  mkdirSync(dirname(path), { recursive: true });
  // 0o700: only the user running Talon should be able to read/exec scripts
  writeFileSync(path, body, { encoding: "utf-8", mode: 0o700 });
  return path;
}

/** Read a trigger's run log, returning the last `lines` lines. */
export function readTriggerLogTail(
  logPath: string,
  lines: number,
): { tail: string; truncated: boolean } {
  try {
    if (!existsSync(logPath)) return { tail: "", truncated: false };
    const raw = readFileSync(logPath, "utf-8");
    const all = raw.split(/\r?\n/);
    if (all.length <= lines) return { tail: all.join("\n"), truncated: false };
    return { tail: all.slice(-lines).join("\n"), truncated: true };
  } catch (err) {
    return {
      tail: `Failed to read log: ${err instanceof Error ? err.message : err}`,
      truncated: false,
    };
  }
}

/** Test-only: wipe the table between suites sharing a worker DB. */
export function _resetTriggersForTesting(): void {
  repo.removeAll();
}
