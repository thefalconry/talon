/**
 * Extra Claude accounts — `claudeAccounts` in config.json.
 *
 * The `claude` backend borrows the login of the `claude` CLI from one config
 * directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. An operator with more
 * than one Claude subscription lists the others here; each entry becomes a
 * backend of its own (`claude-2`, `claude-work`, …) that runs the same Claude
 * SDK driver with `CLAUDE_CONFIG_DIR` pointed at that account's directory.
 *
 * Choosing an account is always explicit — config (`backend`,
 * `heartbeatBackend`, …), a `/backend` switch, or a tool argument. Nothing in
 * Talon moves work from one Claude account to another on its own: the
 * backend router treats every account as one account group and never routes
 * between members (docs/claude-accounts.md).
 *
 * This module is the schema plus the resolved, process-wide account list
 * (`setClaudeAccounts`, populated by `loadConfig`) that the auth panel,
 * backups and the Claude backend read.
 */

import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { userHome } from "../../util/fs-path.js";

/**
 * `claude-<slug>`: lowercase letters, digits and inner hyphens, 2–40 chars
 * after the prefix rules. Short enough to sit in a 64-byte Telegram
 * callback payload with room to spare.
 */
const CLAUDE_ACCOUNT_ID_PATTERN =
  /^claude-[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** A configured extra Claude account's backend id. */
export type ClaudeAccountId = `claude-${string}`;

export function isClaudeAccountId(value: unknown): value is ClaudeAccountId {
  return typeof value === "string" && CLAUDE_ACCOUNT_ID_PATTERN.test(value);
}

/** One `claudeAccounts` entry as written in config.json. */
export const claudeAccountSchema = z
  .object({
    id: z
      .string()
      .regex(
        CLAUDE_ACCOUNT_ID_PATTERN,
        'must look like "claude-<name>" (lowercase letters, digits, hyphens)',
      ),
    label: z.string().trim().min(1).max(64).optional(),
    /** The account's Claude config dir. Absolute, or `~/`-relative. */
    configDir: z
      .string()
      .trim()
      .min(1)
      .refine(
        (dir) => dir === "~" || dir.startsWith("~/") || isAbsolute(dir),
        "must be an absolute path or start with ~/",
      ),
  })
  .strict();

export type ClaudeAccountConfig = z.infer<typeof claudeAccountSchema>;

/** A resolved account: absolute config dir, label filled in. */
export interface ClaudeAccount {
  readonly id: ClaudeAccountId;
  readonly label: string;
  readonly configDir: string;
}

/** Expand `~` against the user's home; absolute paths pass through. */
export function resolveAccountDir(dir: string, home = userHome()): string {
  if (dir === "~") return home;
  if (dir.startsWith("~/")) return resolve(home, dir.slice(2));
  return resolve(dir);
}

/** The default account's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function defaultClaudeConfigDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home?: string,
): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : join(home ?? userHome(), ".claude");
}

export function resolveClaudeAccounts(
  entries: readonly ClaudeAccountConfig[] | undefined,
  home?: string,
): ClaudeAccount[] {
  return (entries ?? []).map((entry) => ({
    id: entry.id as ClaudeAccountId,
    label: entry.label ?? `Claude (${entry.id})`,
    configDir: resolveAccountDir(entry.configDir, home),
  }));
}

/** The config fields that can name a backend, for cross-reference checks. */
export interface ClaudeAccountRefs {
  backend?: string;
  heartbeatBackend?: string;
  dreamBackend?: string;
  enabledBackends?: readonly string[];
  claudeAccounts?: readonly ClaudeAccountConfig[];
}

/**
 * Problems zod can't see on its own: duplicate ids, two accounts on one
 * directory (or on the default account's — that is the same login twice),
 * a reserved id, and backend fields naming an account that isn't declared.
 * Each line is `<path>: <message>`, the same shape as schema issues.
 */
export function claudeAccountConfigIssues(
  config: ClaudeAccountRefs,
  reservedIds: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  home?: string,
): string[] {
  const issues: string[] = [];
  const accounts = config.claudeAccounts ?? [];
  const seenIds = new Set<string>();
  const defaultDir = resolve(defaultClaudeConfigDir(env, home));
  const seenDirs = new Map<string, string>([[defaultDir, "claude"]]);
  accounts.forEach((entry, i) => {
    const at = `claudeAccounts.${i}`;
    if (reservedIds.includes(entry.id))
      issues.push(`${at}.id: "${entry.id}" is a built-in backend id`);
    if (seenIds.has(entry.id))
      issues.push(`${at}.id: "${entry.id}" is declared twice`);
    seenIds.add(entry.id);
    const dir = resolveAccountDir(entry.configDir, home);
    const owner = seenDirs.get(dir);
    if (owner)
      issues.push(
        `${at}.configDir: ${dir} is already the config dir of "${owner}" — each account needs its own`,
      );
    else seenDirs.set(dir, entry.id);
  });

  const refs: Array<[string, string | undefined]> = [
    ["backend", config.backend],
    ["heartbeatBackend", config.heartbeatBackend],
    ["dreamBackend", config.dreamBackend],
    ...(config.enabledBackends ?? []).map((id, i): [string, string] => [
      `enabledBackends.${i}`,
      id,
    ]),
  ];
  for (const [path, id] of refs) {
    if (isClaudeAccountId(id) && !seenIds.has(id))
      issues.push(
        `${path}: "${id}" is not a declared Claude account — add it to "claudeAccounts"`,
      );
  }
  return issues;
}

// ── Process-wide account list ─────────────────────────────────────────────

let configured: readonly ClaudeAccount[] = [];

/** Install the resolved account list. Called by `loadConfig`. */
export function setClaudeAccounts(accounts: readonly ClaudeAccount[]): void {
  configured = [...accounts];
}

export function listClaudeAccounts(): readonly ClaudeAccount[] {
  return configured;
}

export function getClaudeAccount(id: string): ClaudeAccount | undefined {
  return configured.find((a) => a.id === id);
}

/**
 * Config dir for `"claude"` (the default account) or a configured account
 * id; undefined for anything else.
 */
export function claudeConfigDirFor(
  id: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (id === "claude") return defaultClaudeConfigDir(env);
  return getClaudeAccount(id)?.configDir;
}

/**
 * The accounts an *unvalidated* config record declares — for readers that
 * take the raw config.json (backups, the container storage check). Entries
 * that don't parse are skipped: those readers describe, they don't judge.
 */
export function claudeAccountsFromRaw(
  config: Readonly<Record<string, unknown>>,
  home?: string,
): ClaudeAccount[] {
  const raw = config.claudeAccounts;
  if (!Array.isArray(raw)) return [];
  const valid = raw.flatMap((entry) => {
    const parsed = claudeAccountSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  return resolveClaudeAccounts(valid, home);
}
