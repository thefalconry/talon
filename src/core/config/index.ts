import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { dirs, files as pathFiles } from "../../util/paths.js";
import { hardenTalonPermissions } from "./harden.js";
import { setTimezone } from "../../util/time.js";
import { BACKEND_IDS } from "../agent-runtime/model-ref.js";
import { REASONING_LEVEL_ORDER } from "../models/reasoning-levels.js";
import { DEFAULT_BACKUP_SETTINGS } from "../backup/plan.js";
import {
  assembleSystemPrompt,
  joinSystemPromptParts,
  type SystemPromptParts,
} from "../prompt/assemble.js";

/**
 * Backend-id literal source.
 *
 * `BACKEND_IDS` lives in `core/agent-runtime/model-ref.ts` as the
 * source of truth for the typed `BackendId` union. Reusing it
 * here keeps the config zod enums in lockstep automatically —
 * adding a backend means updating one literal, not five.
 *
 * `z.enum` wants a non-empty readonly tuple; spread `BACKEND_IDS`
 * (declared `as const`) into a fresh array and assert the tuple
 * shape `[string, ...string[]]` so zod is happy at compile time.
 */
const BACKEND_ID_ENUM = [...BACKEND_IDS] as [
  (typeof BACKEND_IDS)[number],
  ...(typeof BACKEND_IDS)[number][],
];

/**
 * Reasoning-effort literal source for the background-agent knobs
 * (`heartbeatEffort` / `dreamEffort`). Same trick as `BACKEND_ID_ENUM`:
 * reuse the single source of truth (`REASONING_LEVEL_ORDER`) so adding a
 * level to the vocabulary doesn't need a second edit here.
 *
 * There is no `"adaptive"` member — leaving the field unset IS adaptive
 * (the backend/model default), matching how per-chat `effort` behaves.
 */
const REASONING_EFFORT_ENUM = [...REASONING_LEVEL_ORDER] as [
  (typeof REASONING_LEVEL_ORDER)[number],
  ...(typeof REASONING_LEVEL_ORDER)[number][],
];

// ── Config schema ───────────────────────────────────────────────────────────

/** Path-based Talon plugin (loaded as a Node module). */
const pluginPathSchema = z
  .object({
    path: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** Standalone MCP server (command + args, not a Talon plugin module). */
const pluginMcpSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const pluginEntrySchema = z
  .object({
    path: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    name: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    /**
     * `false` keeps the entry in config but skips loading it — the state
     * behind `talon plugin enable/disable`. Valid on both entry formats.
     */
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasPath = value.path !== undefined;
    const hasMcpFields =
      value.name !== undefined ||
      value.command !== undefined ||
      value.args !== undefined ||
      value.env !== undefined;

    if (hasPath && hasMcpFields) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Plugin entry must use exactly one format: either 'path' (with optional 'config') or MCP fields ('name', 'command', optional 'args'/'env'), but not both.",
      });
      return;
    }

    if (!hasPath && !hasMcpFields) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Plugin entry must provide either 'path' or both 'name' and 'command'.",
      });
      return;
    }

    if (hasMcpFields) {
      if (value.config !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["config"],
          message: "MCP plugin entries cannot include 'config'.",
        });
      }

      if (value.name === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["name"],
          message: "MCP plugin entries must include 'name'.",
        });
      }

      if (value.command === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["command"],
          message: "MCP plugin entries must include 'command'.",
        });
      }

      return;
    }
  })
  .pipe(z.union([pluginPathSchema, pluginMcpSchema]));

const frontendEnum = z.enum([
  "telegram",
  "terminal",
  "teams",
  "discord",
  "native",
  "whatsapp",
]);

/**
 * Native frontend — a client-agnostic bridge (HTTP + Server-Sent Events,
 * JSON) that GUI clients connect to: the bundled Electron companion app
 * (apps/desktop), and any future client (Android, web, …) speaking the
 * same versioned protocol against `host:port`.
 *
 * Defaults are loopback-only and unauthenticated (single-machine use). To
 * reach Talon remotely, set `host: "0.0.0.0"` and a `token` — the bridge
 * then requires `Authorization: Bearer <token>` (or `?token=` for SSE).
 * A non-loopback bind with no token auto-mints a persistent one
 * (~/.talon/keys/bridge-token) rather than serving the LAN open.
 */
const nativeConfigSchema = z
  .object({
    /** Port the bridge binds. Falls back +1..+5 on EADDRINUSE. */
    port: z.number().int().min(1024).max(65535).default(19880),
    /**
     * Interface to bind. `127.0.0.1` (default) is local-only; `0.0.0.0`
     * exposes the bridge on the LAN for remote clients — only do this with
     * a `token` set.
     */
    host: z.string().default("127.0.0.1"),
    /**
     * Optional shared secret. When set, every request must present it as a
     * bearer token (header) or `?token=` query param (SSE). When unset on a
     * non-loopback `host`, the bridge mints and persists one automatically
     * (~/.talon/keys/bridge-token) — the network never gets an open bridge.
     */
    token: z.string().optional(),
    /**
     * Start the bridge on a network-reachable `host` even though `token`
     * looks weak (under ~128 bits by a length × alphabet estimate, e.g.
     * `hunter2`). Off by default: a weak token on a non-loopback bind
     * refuses to start, with instructions to generate a strong one. With
     * this set the bridge starts and logs a security warning every time.
     * Loopback binds only ever warn.
     */
    allowWeakToken: z.boolean().optional(),
    /**
     * Maximum lifetime of one authenticated event stream (`GET /events`),
     * in ms. When set, each stream is closed after roughly this long
     * (±10% jitter) and the client reconnects, presenting its token again.
     * Unset (default) = streams live until the client leaves. The companion
     * and talon-node both reconnect on their own, but with their own
     * backoff, and a device command sent in that gap is dropped, so this is
     * opt-in. Minimum 60000.
     */
    sseMaxLifetimeMs: z.number().int().min(60_000).optional(),
    /**
     * Origins allowed to call the bridge from a BROWSER. Native clients
     * (Electron main, Flutter, curl, talon-node) send no Origin header and
     * never need an entry here. Anything listed gets a matching
     * Access-Control-Allow-Origin; everything else is refused 403, so a
     * random web page cannot drive the agent API on the user's machine.
     */
    allowedOrigins: z.array(z.string().min(1)).optional(),
    /**
     * Serve the bridge over TLS with a persistent self-signed certificate
     * (~/.talon/keys/); clients pin its SHA-256 fingerprint on first
     * connect. Defaults to true whenever `host` is not loopback, so remote
     * traffic is encrypted unless explicitly disabled; loopback defaults to
     * plain HTTP (nothing leaves the machine, and curl/local tools keep
     * working zero-config).
     */
    tls: z.boolean().optional(),
    /**
     * The URL other devices should dial, when it isn't the bind address —
     * a container (Docker, TrueNAS) or anything behind NAT or a proxy,
     * where the bridge only sees its internal IP. Used for pairing links,
     * node installers and `/mesh`. e.g. "https://truenas.lan:19880".
     */
    publicUrl: z
      .string()
      .regex(/^https?:\/\/\S+$/, "native.publicUrl must be an http(s) URL")
      .optional(),
    /**
     * Accept the shared `token` from remote (non-loopback, or proxied)
     * clients. Every device now gets its own credential when it pairs, and
     * devices still holding the shared token trade it for one in-band on
     * their next connect; the daemon log and `talon mesh` list the ones
     * that have not. Once none remain, set this to false and rotate
     * `token` — it then only works for same-machine clients (the desktop
     * app and CLI, via the 0600 discovery file). Default true for this
     * release; the default flips to false in a later one.
     */
    legacySharedToken: z.boolean().optional(),
    /**
     * Scopes a companion's per-device credential carries — at pairing and
     * on the in-band upgrade. Default ["device", "client", "operator"]:
     * the mesh, the chat UI and its settings (config writes, plugin
     * toggles, logs) — what the shared token allowed. Set ["device",
     * "client"] to keep paired phones out of config; `talon mesh scopes
     * <device> <list>` changes one device. Nodes always get ["device"].
     */
    companionScopes: z
      .array(z.enum(["device", "client", "operator"]))
      .min(1)
      .optional(),
  })
  .strict();

const discordConfigSchema = z
  .object({
    /** Discord bot token (from https://discord.com/developers/applications). */
    botToken: z.string(),
    /**
     * Discord application (client) ID. Found on the same Developer Portal
     * page as the bot token. Required for slash-command registration via
     * `Routes.applicationCommands(...)`.
     */
    applicationId: z.string(),
    /** User IDs allowed to DM the bot. Empty array disables DM access. */
    allowedUsers: z.array(z.string()).default([]),
    /** Guild IDs the bot is permitted to operate in. */
    allowedGuilds: z.array(z.string()).default([]),
    /** Optional channel ID allowlist within `allowedGuilds`. Empty = all channels. */
    allowedChannels: z.array(z.string()).default([]),
    /** User IDs with /admin command access. */
    adminUserIds: z.array(z.string()).default([]),
    /**
     * In guilds, when does the bot reply?
     *   - "mention"  reply only when @mentioned or in a reply chain (default)
     *   - "channel"  reply to every message in allowedChannels
     */
    respondMode: z.enum(["mention", "channel"]).default("mention"),
    /** Auto-leave guilds not on `allowedGuilds`. */
    leaveUnauthorizedGuilds: z.boolean().default(true),
    /** Custom status text shown under the bot's name. */
    presence: z.string().optional(),
    /** Enable global slash command + DM command registration. */
    enableDmCommands: z.boolean().default(true),
  })
  .strict();

const whatsappConfigSchema = z
  .object({
    /**
     * JIDs or bare phone numbers (digits only, country code included)
     * allowed to DM the bot. Empty array disables DM access.
     */
    allowedJids: z.array(z.string()).default([]),
    /** Group JIDs (…@g.us) the bot may always respond in. */
    allowedGroups: z.array(z.string()).default([]),
    /**
     * Which groups the bot serves beyond `allowedGroups`:
     *   - "listed"            only the groups named above (default)
     *   - "with-allowed-user" any group containing someone from
     *                         `allowedJids` — "the groups I'm in"
     *   - "all"               every group the account belongs to
     */
    groupPolicy: z
      .enum(["listed", "with-allowed-user", "all"])
      .default("listed"),
    /**
     * In groups, when does the bot reply?
     *   - "mention"  reply only when @mentioned or quoted (default)
     *   - "all"      reply to every message in allowedGroups
     */
    respondMode: z.enum(["mention", "all"]).default("mention"),
    /**
     * The account's own number in E.164 digits without the plus (e.g.
     * "353871234567"). When set, on-demand pairing (/whatsapp pair)
     * offers a phone-number code alongside the QR.
     */
    pairingNumber: z.string().optional(),
    /** Mark handled inbound messages as read (blue ticks). */
    sendReadReceipts: z.boolean().default(true),
  })
  .strict();

const playwrightConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Browser engine: chromium (default), chrome, firefox, webkit, msedge */
  browser: z.string().optional(),
  /**
   * Download the browser build automatically when missing (default
   * true). Applies to Playwright-managed engines (chromium, firefox,
   * webkit); system channels (chrome, msedge) and endpoint mode are
   * never touched.
   */
  autoProvision: z.boolean().optional(),
  /** Run headless (default: true) */
  headless: z.boolean().default(true),
  /** Connect to an existing browser websocket endpoint. */
  endpoint: z.string().optional(),
  /** Read the browser websocket endpoint from a file. */
  endpointFile: z.string().optional(),
});

/** MemPalace backend settings, shared by `memory.mempalace` and the legacy top-level `mempalace` section. */
const mempalaceSettingsSchema = z.object({
  /** Palace directory path (default: ~/.talon/workspace/palace/) */
  palacePath: z.string().min(1).optional(),
  /** Python binary path (default: ~/.talon/mempalace-venv/bin/python) */
  pythonPath: z.string().min(1).optional(),
  /**
   * BCP 47 language codes for entity detection (mempalace >= 3.3).
   * Supported: en, es, fr, de, ja, ko, zh-CN, zh-TW, pt-br, ru, it, hi, id.
   * Sets MEMPALACE_ENTITY_LANGUAGES for the MCP server.
   */
  entityLanguages: z.array(z.string().min(2)).nonempty().optional(),
  /** Enable mempalace diagnostic diaries (sets MEMPAL_VERBOSE=1). */
  verbose: z.boolean().optional(),
  /**
   * Exact mempalace version for the Talon-managed venv (default: the
   * built-in pin). Ignored for operator-managed installs (custom
   * pythonPath) — those only get an advisory when they drift.
   */
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, "exact version, e.g. 3.8.0")
    .optional(),
  /** Reconcile the managed venv to the pinned version (default true). */
  autoUpdate: z.boolean().optional(),
  /** Create/heal the managed venv automatically (default true). */
  autoProvision: z.boolean().optional(),
});

/** mem0 backend settings, shared by `memory.mem0` and the top-level `mem0` section. */
const mem0SettingsSchema = z.object({
  /** Platform API key (default: MEM0_API_KEY env var). */
  apiKey: z.string().min(1).optional(),
  /** Self-hosted mem0 server URL; when set, apiKey may be omitted. */
  host: z.string().min(1).optional(),
  /** Entity id memories are filed under (default "talon"). */
  userId: z.string().min(1).optional(),
});

const configSchema = z.object({
  frontend: z.union([frontendEnum, z.array(frontendEnum)]).default("telegram"),
  botToken: z.string().optional(),
  backend: z.enum(BACKEND_ID_ENUM).default("claude"),
  /**
   * Backend used by the heartbeat agent. Falls back to `backend` when
   * unset. Pair with `heartbeatModel` — the heartbeat agent reads the
   * model field against the heartbeat backend's catalog. Useful for
   * keeping heartbeats on Claude Sonnet for quality while chat runs
   * on a cheaper / free backend.
   */
  heartbeatBackend: z.enum(BACKEND_ID_ENUM).optional(),
  /**
   * Backend used by the dream / memory-consolidation agent. Falls
   * back to `backend` when unset. Pair with `dreamModel`.
   */
  dreamBackend: z.enum(BACKEND_ID_ENUM).optional(),
  /**
   * Whitelist of backends surfaced in the `/model` picker's backend
   * submenu. Unset → every registered backend is offered. Set →
   * only the listed ids appear (useful when you want to hide
   * kilo / opencode in favour of openai-agents + claude).
   *
   * NOTE: persisted per-chat backend overrides are reconciled against this
   * list on restart. If a chat was pinned to a backend that is no longer
   * enabled, Talon clears that chat's backend/model override and starts a
   * fresh default session.
   */
  enabledBackends: z.array(z.enum(BACKEND_ID_ENUM)).optional(),
  claudeBinary: z.string().optional(),
  /**
   * Override the path to the `codex` executable the Codex backend spawns
   * (passed through to the codex-sdk's `codexPathOverride`). Mirrors
   * `claudeBinary`. Primarily for functional tests that point Codex at a
   * stub binary; also accepts the `TALON_CODEX_BINARY` env var. When
   * unset, the codex-sdk resolves `codex` from its package / PATH.
   */
  codexBinary: z.string().optional(),
  agyBinary: z.string().optional(),
  model: z.string().default("default"),
  /**
   * Per-backend default model overrides. Keyed by backend id
   * (`"claude"`, `"codex"`, `"openai-agents"`, etc). When a chat has no
   * per-chat model picked for backend X and X has no canonical default
   * (catalog-driven backends like OpenAI Agents pointed at OpenRouter,
   * Kilo, OpenCode), Talon falls through to `backendDefaults[X]` before
   * surfacing "no model selected" to the user.
   *
   * Example:
   *   "backendDefaults": {
   *     "openai-agents": "meta-llama/llama-3.3-70b-instruct:free",
   *     "kilo": "kilo/deepseek/deepseek-v4-flash:free"
   *   }
   *
   * Operator-controlled escape hatch for first-message-on-a-fresh-backend
   * UX — backends with a canonical `getDefaultModel()` (Claude SDK, Codex,
   * stock OpenAI Agents) don't need an entry here.
   */
  backendDefaults: z.record(z.string(), z.string()).optional(),
  dreamModel: z.string().optional(), // Model used for background memory consolidation (defaults to main model)
  /**
   * Reasoning effort for the dream / memory-consolidation agent. Unset =
   * the backend/model default. Pair with `dreamModel` when you want a
   * cheap model that still thinks hard (or an expensive one that doesn't).
   *
   * Honoured by backends with a reasoning knob (Claude SDK, Codex);
   * silently ignored by Kilo / OpenCode, which have none.
   */
  dreamEffort: z.enum(REASONING_EFFORT_ENUM).optional(),
  maxMessageLength: z.number().int().min(100).default(4000),
  concurrency: z.number().int().min(1).max(20).default(1),
  apiId: z.number().int().optional(),
  apiHash: z.string().optional(),
  adminUserId: z.number().int().optional(),
  allowedUsers: z.array(z.number().int()).optional(), // Whitelist of user IDs allowed to DM the bot
  /**
   * Telegram groups the bot serves. When unset, groups are admitted by the
   * admin's membership (legacy, warned at startup). Only the operator's own
   * messages get the full tool set in any group.
   */
  allowedGroups: z.array(z.number().int()).optional(),
  /**
   * Further operator identities, beyond `adminUserId`: messages from these
   * senders get the full tool set; everyone else is guest-scoped. Forms:
   * Telegram user id ("123"), WhatsApp "wa_dm_<number>", "discord:<userId>",
   * "teams:<userId>". Discord `adminUserIds` are included automatically.
   */
  operatorIds: z.array(z.string()).optional(),
  // Denylist of user IDs dropped in silence — no warning reply, no admin
  // notification. For spam and prompt-injection senders, where the warning
  // itself is the reward: it confirms a live bot is reading.
  blockedUsers: z.array(z.number().int()).optional(),
  pulse: z.boolean().default(true),
  pulseIntervalMs: z.number().int().min(60000).default(300000),
  /**
   * Warn the admin chat when a subscription rate-limit window crosses
   * `planAlertThreshold`. Off by default. Needs a backend that reports plan
   * limits (Claude on a subscription); one message per window per reset
   * cycle.
   */
  planAlerts: z.boolean().default(false),
  planAlertThreshold: z.number().int().min(1).max(100).default(80),
  /** Chat that receives plan warnings. Defaults to `adminUserId`. */
  planAlertChatId: z.string().optional(),
  /**
   * Operator alerts (core/frontend-runtime/alerts.ts): faults that need a
   * human — a full disk, a crash, an error spike, a dead frontend — sent
   * to the admin chat, once per fault per `cooldownMinutes`, with a
   * recovery notice when it clears. `enabled: false` keeps them in the
   * log and in `talon status` only.
   */
  alerts: z
    .object({
      enabled: z.boolean().default(true),
      cooldownMinutes: z.number().int().min(0).max(1440).default(30),
    })
    .strict()
    .optional(),
  /** Background memory-consolidation (dream) runs. Mirrors `pulse`/`heartbeat`. */
  dream: z.boolean().default(true),
  /**
   * Periodic background agent (default: on, hourly). Advances open
   * goals, runs user-defined maintenance, and proactively messages
   * chats when something worth knowing comes up. Disable with
   * `"heartbeat": false`; requires a backend with the background
   * capability.
   */
  heartbeat: z.boolean().default(true),
  heartbeatIntervalMinutes: z.number().int().min(5).default(60),
  heartbeatModel: z.string().optional(), // Model for heartbeat agent (defaults to main model)
  /**
   * Reasoning effort for the heartbeat agent. Unset = the backend/model
   * default. Pair with `heartbeatModel` — e.g. `"high"` so unattended
   * goal work reasons harder than a chat turn, or `"low"` to keep hourly
   * runs cheap.
   *
   * Honoured by backends with a reasoning knob (Claude SDK, Codex);
   * silently ignored by Kilo / OpenCode, which have none.
   */
  heartbeatEffort: z.enum(REASONING_EFFORT_ENUM).optional(),
  /**
   * Plan-aware backend routing for background work (docs/backends.md,
   * "Plan-aware routing"). When nothing is pinned, `spawn_agent`, cron
   * `query` jobs and the heartbeat pick the backend with the most plan
   * headroom instead of always inheriting the chat's.
   *
   *   - `enabled` — off returns byte-identical behaviour to pre-router
   *     Talon (the caller's own backend, every time).
   *   - `ceilingPercent` — a backend whose tightest window is at or above
   *     this is skipped, unless every candidate is (then the least-bad one
   *     runs rather than nothing running).
   */
  router: z
    .object({
      enabled: z.boolean().default(true),
      ceilingPercent: z.number().int().min(1).max(100).default(85),
    })
    .optional(),
  /**
   * Soft token budgets for backends with no account usage API
   * (openai-agents). Talon keeps a local rolling ledger of every turn and
   * one-shot it runs on a backend and derives headroom from it, so a
   * provider that cannot report a plan still has a load-balancing signal.
   * A backend's own plan windows always win; for agy (which reads its
   * quota from `agy -p /usage`) a budget is only the fallback for when
   * that read fails. Keyed by backend id; a backend with no entry
   * contributes no signal (headroom 1, ranked below any backend with real
   * telemetry on a tie).
   *
   * Example:
   *   "backendBudgets": { "openai-agents": { "tokensPer5h": 2000000, "tokensPerDay": 8000000 } }
   */
  backendBudgets: z
    .record(
      z.string(),
      z.object({
        tokensPer5h: z.number().int().min(1).optional(),
        tokensPerDay: z.number().int().min(1).optional(),
      }),
    )
    .optional(),
  /**
   * Sub-agents — the caps on Talon's own delegation mechanism (see
   * `docs/agents.md`). There is no on/off switch: the tools are always
   * present, and a deployment that doesn't want fan-out sets
   * `maxConcurrent: 1` / `maxDepth: 0`.
   *
   *   - `maxConcurrent` — live agents daemon-wide. Each one is a real
   *     backend run, so this is the token-spend lever.
   *   - `maxDepth` — how far delegation may nest. 0 = chats only, 2 (the
   *     default) = chat → agent → agent.
   *   - `defaultTimeoutMs` — hard wall-clock cap when a spawn doesn't pass
   *     its own. Per-spawn values are clamped to [30s, 60min].
   */
  agents: z
    .object({
      maxConcurrent: z.number().int().min(1).max(64).default(6),
      maxDepth: z.number().int().min(0).max(5).default(2),
      defaultTimeoutMs: z
        .number()
        .int()
        .min(30_000)
        .max(3_600_000)
        .default(15 * 60 * 1000),
    })
    .optional(),
  /**
   * Triggers — per-chat caps on active watcher scripts (running or
   * pending). Checked when `trigger_create` runs; triggers already running
   * are never killed when a cap is lowered.
   *
   *   - `maxActivePerChat` — active triggers per chat (default 5). When
   *     `maxPersistentPerChat` is unset this counts persistent and ad-hoc
   *     triggers together, exactly as before.
   *   - `maxPersistentPerChat` — optional separate budget for persistent
   *     triggers. When set, persistent triggers count only against it and
   *     `maxActivePerChat` bounds ad-hoc (non-persistent) triggers only, so
   *     long-lived watchers can't starve short ad-hoc ones.
   */
  triggers: z
    .object({
      maxActivePerChat: z.number().int().min(1).max(50).default(5),
      maxPersistentPerChat: z.number().int().min(1).max(50).optional(),
    })
    .optional(),
  /**
   * Backups & checkpoints (docs/backups.md). Talon's only safety net, so
   * it is on by default: every `intervalHours` it writes a snapshot of
   * the identity, state, database and memory under ~/.talon/backups/,
   * keeps `keepLocal` of them, and uploads to whatever remote targets
   * are registered (`targets: []` keeps everything local).
   *
   *   - `workspaceInclude` — the workspace is mostly bulk that can be
   *     refetched; this is the subset that IS the agent.
   *   - `includeSessions` — backend session transcripts (Claude Code
   *     projects for the workspace, Codex/OpenCode/Kilo/Antigravity
   *     stores for enabled backends) and data/traces, in their own part.
   *   - `extraPaths` — absolute or `~/…` paths outside ~/.talon worth
   *     carrying along (a Claude Code memory directory, say).
   *   - `checkpointBeforeUpdate` — pinned checkpoint before `/update`,
   *     so a bad update is one restore away from undone.
   *   - `notifyChatId` — where failures are reported; falls back to the
   *     admin chat.
   *   - `encryption` / `loginSessions` — see docs/backup-security.md.
   */
  backup: z
    .object({
      enabled: z.boolean().default(DEFAULT_BACKUP_SETTINGS.enabled),
      intervalHours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .default(DEFAULT_BACKUP_SETTINGS.intervalHours),
      keepLocal: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(DEFAULT_BACKUP_SETTINGS.keepLocal),
      keepRemote: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(DEFAULT_BACKUP_SETTINGS.keepRemote),
      includePalace: z.boolean().default(DEFAULT_BACKUP_SETTINGS.includePalace),
      /**
       * WhatsApp auth + the userbot's Telegram login. "local" (default)
       * keeps them in local snapshots only; "remote" also uploads them
       * (encrypted); "off" leaves them out entirely.
       */
      loginSessions: z
        .enum(["off", "local", "remote"])
        .default(DEFAULT_BACKUP_SETTINGS.loginSessions),
      includeSessions: z
        .boolean()
        .default(DEFAULT_BACKUP_SETTINGS.includeSessions),
      workspaceInclude: z
        .array(z.string().min(1))
        .default([...DEFAULT_BACKUP_SETTINGS.workspaceInclude]),
      extraPaths: z.array(z.string().min(1)).default([]),
      /** Unset = every registered target; `[]` = local only. */
      targets: z.array(z.string().min(1)).optional(),
      checkpointBeforeUpdate: z
        .boolean()
        .default(DEFAULT_BACKUP_SETTINGS.checkpointBeforeUpdate),
      notifyChatId: z.string().optional(),
      /**
       * Encrypt every part (AES-256-GCM, scrypt-derived key). The
       * passphrase comes from TALON_BACKUP_PASSPHRASE or this file —
       * never inline, since config.json is itself inside the backup.
       * Without a passphrase, remote targets refuse the upload.
       */
      encryption: z
        .object({ passphraseFile: z.string().trim().min(1).optional() })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  braveApiKey: z.string().optional(),
  /**
   * `fetch_url` reaches any address by default, local services included (a
   * home lab, a dev server, the LAN). Set `allowPrivateNetworks: false` to
   * opt into the SSRF guard: it then refuses hosts that resolve to
   * loopback, private (RFC 1918, CGNAT, ULA), link-local (incl. the
   * 169.254.169.254 metadata endpoint) or reserved addresses, re-checking
   * every redirect hop — worth it on a cloud VM.
   */
  fetchUrl: z
    .object({ allowPrivateNetworks: z.boolean().default(true) })
    .strict()
    .optional(),
  /**
   * Codex-specific OpenAI API key. Prefer this, CODEX_API_KEY, or
   * TALON_CODEX_KEY when the Codex backend should use API-key billing
   * instead of `codex login` ChatGPT OAuth. This key is passed only to
   * Codex.
   */
  codexApiKey: z.string().optional(),
  /**
   * OpenAI API key — used by the OpenAI Agents backend and accepted by
   * Codex only as a last-resort legacy fallback when no Codex-specific
   * key and no `codex login` auth file are available. Falls back to
   * OPENAI_API_KEY env. For OpenAI-compatible endpoints used by the
   * OpenAI Agents backend (OpenRouter, Azure, Ollama, custom proxy),
   * set this to the endpoint's key and configure `openaiBaseUrl` below.
   */
  openaiApiKey: z.string().optional(),
  /**
   * Base URL for an OpenAI-compatible API endpoint, used by the
   * `openai-agents` backend. When unset, the SDK targets OpenAI's
   * production API. Set this to redirect at any OpenAI-compatible
   * service — examples:
   *   - OpenRouter:  https://openrouter.ai/api/v1
   *   - Azure:       https://<resource>.openai.azure.com/openai/v1
   *   - Ollama:      http://localhost:11434/v1
   *   - LiteLLM/etc: http://localhost:4000/v1
   *
   * Falls back to OPENAI_BASE_URL env. Most third-party endpoints
   * implement Chat Completions but not Responses — see `openaiApiMode`.
   */
  openaiBaseUrl: z.string().url().optional(),
  /**
   * Which OpenAI API surface the `openai-agents` backend should target.
   *   - "responses"        — Responses API (default; OpenAI native)
   *   - "chat_completions" — Chat Completions API (most third parties)
   *
   * When `openaiBaseUrl` is set and this is unset, defaults to
   * "chat_completions" automatically (broadest compatibility). Set
   * explicitly to "responses" only if your proxy supports it.
   */
  openaiApiMode: z.enum(["responses", "chat_completions"]).optional(),
  timezone: z.string().optional(),
  plugins: z.array(pluginEntrySchema).default([]),

  /**
   * Tool-surface trimming. Every registered MCP tool costs context
   * tokens in every session (name + description + schema), so
   * deployments that never use a tool group can reclaim that budget:
   *
   *   - `disabledToolTags` — hide whole groups by tag, e.g.
   *     ["stickers", "web", "triggers"]. See ToolTag in core/tools.
   *   - `disabledTools` — hide individual tools by name.
   *
   * `end_turn` can never be disabled: tool-only backends need it to
   * close every turn.
   */
  disabledTools: z.array(z.string()).optional(),
  disabledToolTags: z.array(z.string()).optional(),

  /**
   * Conversation-only ("guest") tool surface for anyone who isn't an
   * operator (`adminUserId`, `operatorIds`, `operatorChats`): reply/react/
   * history/stickers plus the `guestPlugins` servers — no shell, files,
   * mail, devices, cron, memory, agents or cross-chat sends. Always applied
   * to non-operator senders in groups; applied to non-operator DMs unless
   * `enabled: false` (legacy opt-out). See core/mcp-hub/guest-scope.ts.
   */
  guestDmScope: z
    .object({
      enabled: z.boolean().default(true),
      operatorChats: z.array(z.string()).default([]),
      guestPlugins: z.array(z.string()).optional(),
      /**
       * Groups the operator is a member of give EVERY member the full
       * surface (shell, files, mail, devices…). Off by default; only for
       * groups whose members the operator trusts with the host.
       */
      operatorGroups: z.boolean().default(false),
    })
    .optional(),

  /**
   * Developer build flag. Gates dev-only affordances such as the
   * `/update` self-update command. Off by default so packaged /
   * end-user deployments never expose them.
   */
  devBuild: z.boolean().default(false),

  /**
   * Self-update settings for the `/update` command. Only takes effect
   * when `devBuild` is true AND the process runs from a git checkout.
   * Pulls `remote/branch` (fast-forward only), reinstalls deps, runs
   * any `setup` commands, then restarts.
   */
  update: z
    .object({
      remote: z.string().min(1).default("origin"),
      branch: z.string().min(1).default("main"),
      /** Extra shell commands run in the repo root after `npm install`. */
      setup: z.array(z.string()).optional(),
    })
    .optional(),

  // GitHub — GitHub API access via official MCP server
  github: z
    .object({
      enabled: z.boolean().default(false),
      /** GitHub personal access token (default: from `gh auth token`) */
      token: z.string().min(1).optional(),
      /**
       * github-mcp-server image tag (default: the built-in pin).
       * "latest" opts out of pinning.
       */
      imageTag: z.string().min(1).optional(),
      /** Pull the pinned Docker image automatically (default true). */
      autoProvision: z.boolean().optional(),
    })
    .optional(),

  // Long-term memory — unified backend selection. Preferred over the
  // legacy top-level "mempalace"/"mem0" sections; when enabled it wins
  // over them (loadConfig mirrors it onto the section the loaders read).
  memory: z
    .object({
      enabled: z.boolean().default(false),
      backend: z.enum(["mempalace", "mem0"]).default("mempalace"),
      mempalace: mempalaceSettingsSchema.optional(),
      mem0: mem0SettingsSchema.optional(),
    })
    .optional(),

  // MemPalace — structured long-term memory with vector search
  // (legacy section; prefer "memory": { "backend": "mempalace", ... })
  mempalace: mempalaceSettingsSchema
    .extend({ enabled: z.boolean().default(false) })
    .optional(),

  // mem0 — long-term memory layer, hosted platform or self-hosted
  // (legacy-style section; prefer "memory": { "backend": "mem0", ... })
  mem0: mem0SettingsSchema
    .extend({ enabled: z.boolean().default(false) })
    .optional(),

  // Playwright — headless browser automation via MCP
  playwright: playwrightConfigSchema.optional(),

  // Soul — the compiled identity kernel, removed in #953. The root schema
  // is `.strict()`, so a key that simply disappeared would make every
  // existing config.json fail to parse; accepted and ignored instead, with
  // one warning at load so the operator knows to drop it.
  soul: z.unknown().optional(),

  // Discord — discord.js v14-based frontend
  discord: discordConfigSchema.optional(),
  whatsapp: whatsappConfigSchema.optional(),

  // Native — local bridge for the Electron companion app (apps/desktop)
  native: nativeConfigSchema.optional(),

  // Native tools — replace the SDK's built-in Read/Write/Edit/Bash/Glob/Grep
  // with Talon's own MCP equivalents (bash/read/write/edit/glob/search). The
  // native tools additionally route to the active `teleport` node, so file
  // and shell operations can transparently run on a companion device. When
  // true, the built-ins are dropped from the model's tool whitelist and the
  // native tools take their place. Off by default: enabling swaps the model's
  // own hands, so the cutover should be deliberate and observed (flip to true
  // and restart), with an instant rollback by flipping back to false.
  nativeTools: z.boolean().default(false),

  // FUSE layer for the talon:// namespace (~/.talon/ns). "auto" mounts the
  // live views (proc/, plugins/) when the host can (Linux, /dev/fuse, the
  // talon-fusefs addon present) and degrades to the plain symlink farm with a
  // logged reason when it can't — fuseless hosts get the identical namespace
  // minus live views. "off" never mounts. There is no "force": a mount that
  // can't come up healthy is always rolled back rather than half-served.
  fuse: z.enum(["auto", "off"]).default("auto"),

  // Display name shown in terminal UI (defaults to "Talon")
  botDisplayName: z.string().default("Talon"),

  // Teams frontend (Power Automate webhooks)
  teamsWebhookUrl: z.string().url().optional(),
  teamsWebhookSecret: z.string().optional(),
  teamsWebhookPort: z.number().int().min(1024).max(65535).default(19878),
  teamsBotDisplayName: z.string().optional(),
  teamsTeamName: z.string().optional(),
  teamsChannelName: z.string().optional(),
  teamsChatTopic: z.string().optional(),
  teamsGraphPollMs: z.number().int().min(5000).default(10000),
});

// System-prompt assembly lives in core/prompt/ (section pipeline,
// templates, workspace listing). Re-exported here so existing
// consumers keep importing from core/config.
export {
  joinSystemPromptParts,
  type SystemPromptParts,
} from "../prompt/assemble.js";

export type TalonConfig = z.infer<typeof configSchema> & {
  systemPrompt: string;
  /**
   * Static/dynamic split of `systemPrompt`. Optional so hand-built test
   * configs stay valid; consumers fall back to treating `systemPrompt`
   * as all-static when absent. Always set by `loadConfig` and
   * `rebuildSystemPrompt`.
   */
  systemPromptParts?: SystemPromptParts;
  workspace: string;
};

/** Normalize frontend config to always be an array. */
export function getFrontends(config: TalonConfig): string[] {
  return Array.isArray(config.frontend) ? config.frontend : [config.frontend];
}

// ── Config file ─────────────────────────────────────────────────────────────

const CONFIG_FILE = pathFiles.config;

const DEFAULT_CONFIG = {
  botToken: "",
  model: "default",
  maxMessageLength: 4000,
  concurrency: 1,
  pulse: true,
  pulseIntervalMs: 300000,
};

/**
 * A config.json that exists but cannot be used — unreadable, not JSON, or
 * rejected by the schema. Thrown instead of falling back to defaults: a
 * daemon that silently boots on defaults (e.g. the telegram frontend) is
 * far more surprising than one that refuses to start. The file on disk is
 * never touched. `issues` carries one line per problem for callers that
 * want to render them individually.
 */
export class ConfigFileError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = "ConfigFileError";
  }
}

/**
 * Append a line/column hint to a JSON.parse error message. Recent V8
 * already includes "(line L column C)"; older runtimes only report
 * "at position N", so derive it from the raw text in that case.
 */
function describeJsonError(err: unknown, raw: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/\(line \d+ column \d+\)/.test(message)) return message;
  const match = /at position (\d+)/.exec(message);
  if (!match) return message;
  const before = raw.slice(0, Number(match[1]));
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  return `${message} (line ${line} column ${column})`;
}

/** Render zod issues as `path: message` lines (`(root)` for top-level). */
function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".") || "(root)";
    return `${path}: ${issue.message}`;
  });
}

/**
 * Read config.json. A missing file is `{}` (first run — defaults apply);
 * a present file that cannot be read or parsed throws ConfigFileError.
 */
function loadConfigFile(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) return {};
  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, "utf-8");
  } catch (err) {
    throw new ConfigFileError(
      `Cannot read ${CONFIG_FILE}: ${err instanceof Error ? err.message : err}`,
      CONFIG_FILE,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const detail = describeJsonError(err, raw);
    throw new ConfigFileError(
      `Invalid JSON in ${CONFIG_FILE}: ${detail}. ` +
        `The file was left untouched — fix it and start Talon again.`,
      CONFIG_FILE,
      [detail],
    );
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigFileError(
      `Invalid config in ${CONFIG_FILE}: the top level must be a JSON object.`,
      CONFIG_FILE,
      ["(root): expected a JSON object"],
    );
  }
  return data as Record<string, unknown>;
}

function normalizeDeprecatedFrontendConfig(
  fileConfig: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...fileConfig };
  let usedAlias = false;

  const normalizeFrontendValue = (value: unknown): unknown => {
    if (value === "desktop") {
      usedAlias = true;
      return "native";
    }
    if (Array.isArray(value) && value.some((item) => item === "desktop")) {
      usedAlias = true;
      return value.map((item) => (item === "desktop" ? "native" : item));
    }
    return value;
  };

  if ("frontend" in normalized) {
    normalized.frontend = normalizeFrontendValue(normalized.frontend);
  }
  if ("desktop" in normalized) {
    usedAlias = true;
    if (!("native" in normalized)) {
      normalized.native = normalized.desktop;
    }
    delete normalized.desktop;
  }

  if (usedAlias) {
    console.warn(
      'Deprecated "desktop" frontend config detected; use "native" instead.',
    );
  }

  return normalized;
}

/**
 * First-run onboarding: creates workspace/talon.json with defaults.
 * Returns true if this is a fresh install.
 */
function ensureConfigFile(): boolean {
  if (!existsSync(dirs.root)) mkdirSync(dirs.root, { recursive: true });
  if (!existsSync(dirs.data)) mkdirSync(dirs.data, { recursive: true });
  if (!existsSync(CONFIG_FILE)) {
    // Owner-only from birth: the config accumulates bot tokens and API keys.
    writeFileAtomic.sync(
      CONFIG_FILE,
      JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
      { mode: 0o600 },
    );
    return true;
  }
  return false;
}

// ── System prompt assembly ──────────────────────────────────────────────────
// Delegated to core/prompt/assemble.ts — see that module for the
// section pipeline, file ownership rules, and the static/dynamic split.

// ── Main loader ─────────────────────────────────────────────────────────────

export function loadConfig(): TalonConfig {
  ensureConfigFile();
  hardenTalonPermissions();
  const fileConfig = normalizeDeprecatedFrontendConfig(loadConfigFile());

  // Runtime frontend override (TALON_FRONTEND_OVERRIDE). Lets the native
  // companion app spawn a daemon on the `native` frontend without rewriting
  // the user's saved config (which may target Telegram/Discord). Validated
  // against the same enum, so a bogus value fails fast like any other.
  const frontendOverride = process.env.TALON_FRONTEND_OVERRIDE?.trim();
  if (frontendOverride) {
    fileConfig.frontend =
      frontendOverride === "desktop" ? "native" : frontendOverride;
    if (frontendOverride === "desktop") {
      console.warn(
        'Deprecated TALON_FRONTEND_OVERRIDE="desktop"; use "native" instead.',
      );
    }
  }

  const result = configSchema.safeParse(fileConfig);
  if (!result.success) {
    const issues = formatSchemaIssues(result.error);
    throw new ConfigFileError(
      `Invalid config in ${CONFIG_FILE}:\n` +
        issues.map((line) => `  - ${line}`).join("\n") +
        `\nThe file was left untouched — fix it and start Talon again.`,
      CONFIG_FILE,
      issues,
    );
  }
  const parsed = result.data;

  // The soul kernel is gone (#953). Its config block still parses so an
  // existing config.json keeps loading, but it no longer does anything —
  // say so once rather than silently ignoring it.
  if (parsed.soul !== undefined) {
    console.warn(
      `Ignoring "soul" in ${CONFIG_FILE}: the soul kernel was removed; its message taps now write to the memory store. Remove the key.`,
    );
  }

  // Unified memory section: mirror the selected backend onto the per-plugin
  // section the loaders consume (builtins.ts reads config.mempalace /
  // config.mem0). The memory section wins over a legacy section when both
  // are present; the unselected backend is disabled so exactly one memory
  // plugin loads.
  if (parsed.memory?.enabled) {
    if (parsed.memory.backend === "mempalace") {
      parsed.mempalace = {
        ...parsed.mempalace,
        ...parsed.memory.mempalace,
        enabled: true,
      };
      if (parsed.mem0) parsed.mem0.enabled = false;
    } else {
      parsed.mem0 = { ...parsed.mem0, ...parsed.memory.mem0, enabled: true };
      if (parsed.mempalace) parsed.mempalace.enabled = false;
    }
  }

  // Apply timezone globally before building the system prompt
  setTimezone(parsed.timezone);

  // Validate per-frontend requirements
  const frontends = Array.isArray(parsed.frontend)
    ? parsed.frontend
    : [parsed.frontend];
  for (const fe of frontends) {
    if (fe === "telegram" && (!parsed.botToken || !parsed.adminUserId)) {
      throw new Error(
        parsed.botToken
          ? TELEGRAM_ADMIN_REQUIRED
          : `Telegram frontend requires "botToken" in ${CONFIG_FILE}. Run "talon setup" to configure.`,
      );
    }
    if (fe === "teams" && !parsed.teamsWebhookUrl) {
      throw new Error(
        `Teams frontend requires "teamsWebhookUrl" in ${CONFIG_FILE}. Run "talon setup" to configure.`,
      );
    }
    if (fe === "whatsapp" && !parsed.whatsapp) {
      throw new Error(
        `WhatsApp frontend requires a "whatsapp" config block in ${CONFIG_FILE} ` +
          `(set allowedJids / allowedGroups; pairing happens interactively on first start).`,
      );
    }
  }

  const activeFrontend = frontends[0];

  const promptParts = assembleSystemPrompt({ frontend: activeFrontend });
  return {
    ...parsed,
    workspace: dirs.workspace,
    systemPrompt: joinSystemPromptParts(promptParts),
    systemPromptParts: promptParts,
  };
}

/**
 * Why a Telegram frontend without `adminUserId` refuses to start: the admin
 * is who may run operator commands and who the DM allowlist defaults to, so
 * without one the bot would have no owner at all.
 */
export const TELEGRAM_ADMIN_REQUIRED =
  `Telegram frontend requires "adminUserId" (your numeric Telegram user id) in ${CONFIG_FILE}. ` +
  `It decides who may run admin commands and, unless "allowedUsers" lists more people, who may DM the bot. ` +
  `Find your id by messaging @userinfobot, then run "talon setup" or add "adminUserId": <id> to the config.`;

/**
 * Only the `backup` block, validated — without writing a default config
 * or checking frontend requirements. `talon backup restore` on a fresh
 * host has no real config yet (it is inside the snapshot), and the
 * default one would fail on its empty botToken before anything restored.
 */
export function loadBackupConfig(): TalonConfig["backup"] {
  const fileConfig = loadConfigFile();
  const result = configSchema.shape.backup.safeParse(fileConfig.backup);
  if (!result.success) {
    const issues = formatSchemaIssues(result.error).map(
      (line) => `backup.${line}`,
    );
    throw new ConfigFileError(
      `Invalid backup config in ${CONFIG_FILE}:\n` +
        issues.map((line) => `  - ${line}`).join("\n"),
      CONFIG_FILE,
      issues,
    );
  }
  return result.data;
}

/**
 * Rebuild the system prompt with plugin additions.
 * Called after plugins are loaded to inject their prompt contributions.
 */
export function rebuildSystemPrompt(
  config: TalonConfig,
  pluginAdditions: string[],
): void {
  const promptParts = buildSystemPromptPartsFor(
    config,
    pluginAdditions,
    primaryFrontend(config),
  );
  config.systemPromptParts = promptParts;
  config.systemPrompt = joinSystemPromptParts(promptParts);
}

/** The first configured frontend — the default prompt flavour. */
export function primaryFrontend(config: TalonConfig): string {
  const frontends = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  return frontends[0];
}

/**
 * Build system-prompt parts for a specific frontend WITHOUT mutating
 * the config. Multi-frontend deployments need per-chat prompt
 * flavours (a native-app chat must get native.md guidance, not the
 * telegram.md that `frontends[0]` happens to be) — the per-session
 * snapshot layer (backend/runtime/prompt/system-prompt.ts) calls this with the
 * chat's owning frontend and freezes the result per session.
 */
export function buildSystemPromptPartsFor(
  config: TalonConfig,
  pluginAdditions: string[],
  frontend: string,
): SystemPromptParts {
  return assembleSystemPrompt({
    frontend,
    pluginPromptAdditions:
      pluginAdditions.length > 0 ? pluginAdditions : undefined,
  });
}
