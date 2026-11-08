/**
 * Centralized path resolution for all Talon directories and files.
 *
 * Location: ~/.talon/ (cross-platform: Linux, macOS, Windows),
 * relocatable via TALON_HOME.
 *
 * Layout:
 *   ~/.talon/
 *     config.json              Main configuration
 *     plugins/                 CLI-installed plugins (npm prefix / git clones)
 *     data/                    Internal state
 *       talon.db               SQLite — all structured state (sessions,
 *                              history, settings, media, goals, scripts,
 *                              cron, triggers, turn meta, kv)
 *       *.json[.imported]      Legacy JSON stores, renamed after import
 *       traces/                Per-chat message traces (JSONL)
 *       trigger-runs/          Trigger script bodies + run logs
 *     workspace/               User-facing workspace (memory, uploads, logs)
 *       memory/
 *         memory.md            Durable memory — the dream agent owns it
 *         state.md             Live operational status — the heartbeat owns
 *                              it, rewritten in full each run
 *         daily/               Per-day memory notes (YYYY-MM-DD.md)
 *         archive/             Pruned memory, kept for audit (YYYY-MM.md)
 *       scripts/               Agent script bodies
 *       skills/                Skill folders (SKILL.md + resources)
 *       uploads/
 *       stickers/
 *       logs/
 *     talon.log                Structured log file
 *     .user-session            Telegram userbot session
 */

import { resolve } from "node:path";
import { assertNotRealHome, userHome } from "./fs-path.js";

/**
 * Root of the Talon data directory: ~/.talon/, relocatable via the
 * TALON_HOME environment variable (containers, systemd units, tests).
 * Resolved once at import time — a mid-process override does nothing.
 * Under vitest, resolving to the real ~/.talon throws (util/fs-path.ts):
 * the check runs on every evaluation of this module, so a suite that
 * re-imports it after changing the env is checked again.
 */
const TALON_ROOT = resolve(
  process.env.TALON_HOME || resolve(userHome(), ".talon"),
);
assertNotRealHome(TALON_ROOT, "dirs.root (TALON_HOME / ~/.talon)");

// ── Directories ────────────────────────────────────────────────────────────

export const dirs = {
  /** Root: ~/.talon/ */
  root: TALON_ROOT,
  /** Internal data: ~/.talon/data/ */
  data: resolve(TALON_ROOT, "data"),
  /** User workspace: ~/.talon/workspace/ */
  workspace: resolve(TALON_ROOT, "workspace"),
  /** Upload files: ~/.talon/workspace/uploads/ */
  uploads: resolve(TALON_ROOT, "workspace", "uploads"),
  /** Daily logs: ~/.talon/workspace/logs/ */
  logs: resolve(TALON_ROOT, "workspace", "logs"),
  /** Baileys multi-file auth state: ~/.talon/whatsapp-auth/ */
  whatsappAuth: resolve(TALON_ROOT, "whatsapp-auth"),
  /** Memory: ~/.talon/workspace/memory/ */
  memory: resolve(TALON_ROOT, "workspace", "memory"),
  /** Daily memory notes: ~/.talon/workspace/memory/daily/ */
  dailyMemory: resolve(TALON_ROOT, "workspace", "memory", "daily"),
  /**
   * Pruned-memory archive: ~/.talon/workspace/memory/archive/
   * Monthly files the dream agent appends to when it drops an entry, so
   * forgetting stays auditable instead of silent.
   */
  memoryArchive: resolve(TALON_ROOT, "workspace", "memory", "archive"),
  /** Sticker packs: ~/.talon/workspace/stickers/ */
  stickers: resolve(TALON_ROOT, "workspace", "stickers"),
  /** Prompt files: ~/.talon/prompts/ */
  prompts: resolve(TALON_ROOT, "prompts"),
  /** Per-chat message traces: ~/.talon/data/traces/ */
  traces: resolve(TALON_ROOT, "data", "traces"),
  /** MemPalace palace: ~/.talon/workspace/palace/ */
  palace: resolve(TALON_ROOT, "workspace", "palace"),
  /** Trigger scripts and run logs: ~/.talon/data/trigger-runs/ */
  triggerRuns: resolve(TALON_ROOT, "data", "trigger-runs"),
  /** Agent script bodies: ~/.talon/workspace/scripts/ */
  scripts: resolve(TALON_ROOT, "workspace", "scripts"),
  /** Skill folders: ~/.talon/workspace/skills/ */
  skills: resolve(TALON_ROOT, "workspace", "skills"),
  /** Key material (bridge TLS identity, release keys): ~/.talon/keys/ */
  keys: resolve(TALON_ROOT, "keys"),
  /**
   * Operator secrets, one file per value (mode 600): ~/.talon/secrets/.
   * Written by the secret drop (`/secret <name>`, `request_secret`) so a
   * password never has to travel through a chat message.
   */
  secrets: resolve(TALON_ROOT, "secrets"),
  /**
   * The talon:// namespace on disk: ~/.talon/ns/. Holds one symlink per
   * file-backed mount (home → workspace/, skills/, …); while the daemon
   * runs with FUSE the synthetic mounts (proc/, plugins/) appear here too.
   * `talon://x` and `~/.talon/ns/x` are the same address in two spellings.
   */
  ns: resolve(TALON_ROOT, "ns"),
  /** CLI-installed plugins (`talon plugin install`): ~/.talon/plugins/ */
  plugins: resolve(TALON_ROOT, "plugins"),
  /** Helper binaries downloaded on first use (curl-impersonate): ~/.talon/bin/ */
  bin: resolve(TALON_ROOT, "bin"),
} as const;

// ── Files ──────────────────────────────────────────────────────────────────

export const files = {
  /** Main config: ~/.talon/config.json */
  config: resolve(TALON_ROOT, "config.json"),
  /** Structured log: ~/.talon/talon.log */
  log: resolve(TALON_ROOT, "talon.log"),
  /**
   * Successor stdout+stderr during a `/restart` or `/update` handoff:
   * ~/.talon/respawn.log. See core/daemon/respawn.ts.
   */
  respawnLog: resolve(TALON_ROOT, "respawn.log"),
  /** Legacy JSON session store (imported into talon.db on first boot) */
  sessions: resolve(TALON_ROOT, "data", "sessions.json"),
  /** SQLite database (history, sessions, chat settings, media index): ~/.talon/data/talon.db */
  database: resolve(TALON_ROOT, "data", "talon.db"),
  /** Legacy JSON chat history (imported into talon.db on first boot) */
  history: resolve(TALON_ROOT, "data", "history.json"),
  /** Legacy JSON per-chat settings (imported into talon.db on first boot) */
  chatSettings: resolve(TALON_ROOT, "data", "chat-settings.json"),
  /** Legacy JSON cron jobs (imported into talon.db on first boot) */
  cron: resolve(TALON_ROOT, "data", "cron.json"),
  /** Legacy JSON triggers metadata (imported into talon.db on first boot) */
  triggers: resolve(TALON_ROOT, "data", "triggers.json"),
  /** Legacy JSON native turn meta (imported into talon.db on first boot) */
  nativeTurnMeta: resolve(TALON_ROOT, "data", "native-turn-meta.json"),
  /** Legacy JSON media index (imported into talon.db on first boot) */
  mediaIndex: resolve(TALON_ROOT, "data", "media-index.json"),
  /** Persistent memory: ~/.talon/workspace/memory/memory.md */
  memory: resolve(TALON_ROOT, "workspace", "memory", "memory.md"),
  /**
   * Live operational state: ~/.talon/workspace/memory/state.md
   *
   * Separate from `memory.md` on purpose. The heartbeat rewrites this file
   * whole on every run; nothing appends to it. Keeping status snapshots out
   * of the durable store is what stops "as of Run #N" sections accreting
   * there — on the live deployment three of them had grown to 15.8k chars,
   * pushing the actual knowledge past the prompt's injection cap.
   */
  state: resolve(TALON_ROOT, "workspace", "memory", "state.md"),
  /** Self-bootstrapping identity: ~/.talon/workspace/identity.md */
  identity: resolve(TALON_ROOT, "workspace", "identity.md"),
  /** Telegram userbot session: ~/.talon/.user-session */
  userSession: resolve(TALON_ROOT, ".user-session"),
  /** PID file for daemon mode: ~/.talon/talon.pid */
  pid: resolve(TALON_ROOT, "talon.pid"),
  /** Native bridge discovery file for same-machine clients: ~/.talon/native-bridge.json */
  nativeBridge: resolve(TALON_ROOT, "native-bridge.json"),
  /** MemPalace venv python binary (platform-dependent: bin/python on Unix, Scripts/python.exe on Windows) */
  mempalacePython: resolve(
    TALON_ROOT,
    "mempalace-venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  ),
  /** Legacy dream state JSON (imported into the talon.db kv store on first read) */
  dreamState: resolve(TALON_ROOT, "workspace", "memory", "dream_state.json"),
  /** Legacy heartbeat state JSON (imported into the talon.db kv store on first read) */
  heartbeatState: resolve(
    TALON_ROOT,
    "workspace",
    "memory",
    "heartbeat_state.json",
  ),
  /**
   * Legacy Codex OAuth-incompat model store (imported into the
   * talon.db kv store on first read) — see backend/codex/oauth-incompat.ts
   * for what the data means.
   */
  codexOauthIncompat: resolve(TALON_ROOT, "data", "codex-oauth-incompat.json"),
  /**
   * Generated @playwright/mcp config (endpoint mode): ~/.talon/data/playwright-mcp.json
   *
   * Deliberately NOT in os.tmpdir(): the MCP child re-reads this file on every
   * spawn, hours or days after the daemon wrote it, and a /tmp sweeper
   * deleting it takes every browser tool down until the daemon restarts
   * (2026-09-15: an hourly disk cleaner removed 676 `/tmp/talon-*` entries,
   * and browser tools failed with ENOENT for the next 24h). The name is
   * pid-free so each run overwrites the last instead of orphaning a file.
   */
  playwrightMcpConfig: resolve(TALON_ROOT, "data", "playwright-mcp.json"),
} as const;
