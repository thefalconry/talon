/**
 * Kimi Code authentication.
 *
 * Kimi authenticates through providers configured in `~/.kimi-code/config.toml`
 * (e.g. OpenRouter or Moonshot AI API keys), or through `kimi login`.
 * Headless runs reuse this configuration.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/** Where the CLI stores its configuration. Env override for tests. */
export function kimiConfigPath(override?: string): string {
  return (
    override ||
    process.env.TALON_KIMI_CONFIG_FILE ||
    join(homedir(), ".kimi-code", "config.toml")
  );
}

export interface KimiAuthInfo {
  /** Config file was found and readable. */
  present: boolean;
  /** Configured providers found in config.toml. */
  providers: string[];
  /** Why config could not be read or has no valid providers. */
  problem?: string;
  path: string;
}

/** Read and check ~/.kimi-code/config.toml for configured providers. */
export function detectKimiAuth(configPath?: string): KimiAuthInfo {
  const path = kimiConfigPath(configPath);
  const base: KimiAuthInfo = {
    present: false,
    providers: [],
    path,
  };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { ...base, problem: "no config file found at " + path };
  }

  const providerMatches = raw.matchAll(/\[providers\.([^\]]+)\]/g);
  const providers: string[] = [];
  for (const m of providerMatches) {
    if (m[1]) providers.push(m[1].trim());
  }

  if (providers.length === 0) {
    return {
      ...base,
      problem: "no [providers] found in config.toml",
    };
  }

  return {
    present: true,
    providers,
    path,
  };
}

/** True for stderr or error text indicative of auth failure. */
export function isKimiAuthFailure(text: string): boolean {
  return /unauthorized|authentication (?:required|failed)|(?:invalid|no|missing) (?:api[ _]?key|credentials)|please (?:run kimi login|configure provider)|401 Unauthorized|403 Forbidden/i.test(
    text,
  );
}

/** Turn an auth failure into an actionable error. */
export function kimiAuthError(cause?: unknown): Error {
  const err = new Error(
    "Kimi Code CLI is not authenticated or has no configured providers. " +
      `Check ${kimiConfigPath()} or run \`kimi provider add\` or \`kimi login\`.`,
  );
  if (cause !== undefined) (err as Error & { cause?: unknown }).cause = cause;
  return err;
}
