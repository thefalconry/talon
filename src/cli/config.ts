/**
 * CLI config model + load/save/format helpers, plus the banner.
 *
 * This is the on-disk `talon.json` shape as the CLI sees it; the runtime has
 * its own richer config type in core/config/index.ts.
 */

import pc from "picocolors";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { dirs } from "../util/paths.js";
import { CONFIG_FILE } from "./context.js";
import type {
  ClaudeAccountConfig,
  ClaudeAccountId,
} from "../core/config/claude-accounts.js";

export function printBanner(): void {
  console.log();
  console.log(`  ${pc.bold(pc.cyan("🦅 Talon"))}`);
  console.log(`  ${pc.dim("Agentic AI harness")}`);
  console.log();
}

/**
 * The subset of ~/.talon/config.json the CLI reads or prompts for — a
 * partial view, not the whole schema (that lives in core/config/index.ts).
 * Anything absent here is still present at runtime on a loaded config and
 * MUST be carried through on save: `talon setup` used to rebuild the file
 * from its own named fields alone and silently dropped every other key.
 */
export type Config = {
  frontend: string | string[];
  /** Active backend (`claude` / `kilo` / `opencode` / `codex` / `agy` / `openai-agents`). */
  backend?:
    | "claude"
    | "kilo"
    | "opencode"
    | "codex"
    | "agy"
    | "openai-agents"
    | ClaudeAccountId;
  /** Extra Claude accounts, one backend each (docs/claude-accounts.md). */
  claudeAccounts?: ClaudeAccountConfig[];
  botToken?: string;
  claudeBinary?: string;
  /** Path to the Antigravity `agy` executable. */
  agyBinary?: string;
  /** Codex-specific OpenAI API key. */
  codexApiKey?: string;
  /** OpenAI API key — used by OpenAI Agents and legacy Codex config. */
  openaiApiKey?: string;
  /** OpenAI-compatible base URL — OpenRouter, Azure, Ollama, LiteLLM, etc. */
  openaiBaseUrl?: string;
  /** OpenAI API surface — "responses" (default) or "chat_completions" (most third parties). */
  openaiApiMode?: "responses" | "chat_completions";
  model: string;
  concurrency: number;
  pulse: boolean;
  pulseIntervalMs: number;
  adminUserId?: number;
  /** Telegram DM allowlist; defaults to `[adminUserId]` when set up. */
  allowedUsers?: number[];
  apiId?: number;
  apiHash?: string;
  maxMessageLength: number;
  plugins?: unknown[];
  // Teams
  teamsWebhookUrl?: string;
  teamsWebhookSecret?: string;
  teamsWebhookPort?: number;
  teamsBotDisplayName?: string;
  // Discord
  discord?: {
    botToken: string;
    applicationId: string;
    allowedUsers?: string[];
    allowedGuilds?: string[];
    allowedChannels?: string[];
    adminUserIds?: string[];
    [key: string]: unknown;
  };
  // WhatsApp — pairing + allowlists. Session credentials are not here;
  // they live in ~/.talon/whatsapp-auth/.
  whatsapp?: {
    allowedJids?: string[];
    allowedGroups?: string[];
    groupPolicy?: "listed" | "with-allowed-user" | "all";
    respondMode?: "mention" | "all";
    pairingNumber?: string;
    sendReadReceipts?: boolean;
    [key: string]: unknown;
  };
};

export const DEFAULTS: Config = {
  frontend: "telegram",
  model: "default",
  concurrency: 1,
  pulse: true,
  pulseIntervalMs: 300000,
  maxMessageLength: 4000,
};

/**
 * A config.json that exists but can't be used — unreadable, not valid
 * JSON, or not a JSON object. Thrown instead of silently falling back to
 * defaults: `loadConfig` backs both read-only commands (`status`,
 * `config`, `doctor`, the main menu's "is this configured?" check) and
 * load → edit → save commands (`setup`, `plugin`), so treating a broken
 * file as `{}` used to let the latter write those empty defaults straight
 * back over — destroying — the user's real config. Mirrors
 * core/config/index.ts's `ConfigFileError` in shape and wording (#1031)
 * without importing across the CLI/daemon boundary; unlike that one, the
 * CLI's `Config` type has no runtime schema, so there's no per-key
 * validation to report here, only "can this be read as a JSON object".
 */
export class ConfigFileError extends Error {
  constructor(
    message: string,
    readonly path: string,
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

/** Parse `raw` as a config object, or describe in one phrase why it isn't one. */
function parseConfigJson(
  raw: string,
):
  { ok: true; data: Record<string, unknown> } | { ok: false; problem: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      problem: `invalid JSON — ${describeJsonError(err, raw)}`,
    };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, problem: "the top level must be a JSON object" };
  }
  return { ok: true, data: data as Record<string, unknown> };
}

/**
 * Load ~/.talon/config.json. A missing file is first run: defaults apply.
 * A present file that can't be read or isn't a valid JSON object throws
 * `ConfigFileError` — see the class comment for why this must not fall
 * back to defaults instead.
 */
export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, "utf-8");
  } catch (err) {
    throw new ConfigFileError(
      `Cannot read ${CONFIG_FILE}: ${err instanceof Error ? err.message : err}`,
      CONFIG_FILE,
    );
  }
  const result = parseConfigJson(raw);
  if (!result.ok) {
    throw new ConfigFileError(
      `Invalid config in ${CONFIG_FILE}: ${result.problem}. ` +
        `The file was left untouched — fix it and try again.`,
      CONFIG_FILE,
    );
  }
  return { ...DEFAULTS, ...result.data };
}

/**
 * Save ~/.talon/config.json. Refuses to overwrite an existing file that
 * isn't valid JSON. The normal caller shape is load → edit → save, and
 * `loadConfig` above already throws before such a caller ever reaches
 * this point — this check is the backstop for any caller that saves
 * without a fresh load, or for the file changing under us between the
 * two calls: writing `config` in either case would silently replace
 * whatever is actually on disk with the caller's best guess.
 */
export function saveConfig(config: Config): void {
  if (existsSync(CONFIG_FILE)) {
    let raw: string;
    try {
      raw = readFileSync(CONFIG_FILE, "utf-8");
    } catch (err) {
      throw new ConfigFileError(
        `Refusing to write ${CONFIG_FILE}: cannot read the existing file ` +
          `(${err instanceof Error ? err.message : err}). It was left untouched.`,
        CONFIG_FILE,
      );
    }
    const result = parseConfigJson(raw);
    if (!result.ok) {
      throw new ConfigFileError(
        `Refusing to write ${CONFIG_FILE}: the existing file is invalid ` +
          `(${result.problem}). It was left untouched — fix it manually, ` +
          `or delete it to start over.`,
        CONFIG_FILE,
      );
    }
  }
  if (!existsSync(dirs.root)) mkdirSync(dirs.root, { recursive: true });
  const clean = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined),
  );
  writeFileAtomic.sync(CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n");
}

export function maskToken(token: string | undefined): string {
  if (!token || token.length < 10) return pc.red("not set");
  return pc.green(token.slice(0, 8) + "..." + token.slice(-4));
}

export function isConfigured(config: Config): boolean {
  const fes = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  return fes.every((fe) => {
    if (fe === "telegram") return !!config.botToken && !!config.adminUserId;
    if (fe === "teams") return !!config.teamsWebhookUrl;
    if (fe === "discord") return !!config.discord?.botToken;
    // WhatsApp's credentials live in ~/.talon/whatsapp-auth/, not the
    // config — but the loader hard-requires the block, so its presence is
    // what "configured" means here. Omitting this case sent every
    // WhatsApp user through the fail-closed branch below and straight
    // into the setup wizard on a plain `talon`.
    if (fe === "whatsapp") return !!config.whatsapp;
    // terminal (stdio) and native (the client bridge) carry no
    // credentials; unknown names fail closed so a typo'd frontend sends
    // the user to setup instead of a daemon that can't start.
    return fe === "terminal" || fe === "native";
  });
}
