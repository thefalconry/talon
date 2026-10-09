/**
 * Which Claude login a run uses.
 *
 * The default `claude` backend inherits the daemon's environment, so its
 * CLI reads `$CLAUDE_CONFIG_DIR` or `~/.claude` exactly as it always has.
 * An extra account (`claudeAccounts`, core/config/claude-accounts.ts)
 * carries its own config dir, and every SDK spawn for it gets
 * `CLAUDE_CONFIG_DIR=<configDir>` through the SDK's `env` option. The
 * daemon's own `process.env` is never written: two accounts run side by
 * side in one process, each spawn with its own environment.
 */

/** The account a Claude SDK backend instance runs as. */
export interface ClaudeRunAccount {
  /** Backend id: `"claude"` or a `claude-<name>` account id. */
  readonly backendId: string;
  readonly label: string;
  /** Absent for the default account, which inherits the daemon's env. */
  readonly configDir?: string;
}

export const DEFAULT_CLAUDE_ACCOUNT: ClaudeRunAccount = {
  backendId: "claude",
  label: "Anthropic",
};

/**
 * The `env` for one SDK spawn, or undefined to let the SDK inherit
 * `process.env` (the SDK *replaces* its child's environment with `env`, so
 * a non-empty answer always starts from a copy of the daemon's).
 *
 * `extra` (a sub-agent's private TMPDIR, …) layers over the daemon's env;
 * the account's `CLAUDE_CONFIG_DIR` layers over both, so nothing a caller
 * passes can point a run at another account's login.
 */
export function sdkEnvFor(
  account: ClaudeRunAccount,
  extra?: Readonly<Record<string, string | undefined>>,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> | undefined {
  if (!account.configDir && !extra) return undefined;
  return {
    ...base,
    ...extra,
    ...(account.configDir ? { CLAUDE_CONFIG_DIR: account.configDir } : {}),
  };
}
