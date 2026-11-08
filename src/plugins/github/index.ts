/**
 * GitHub plugin — GitHub API access via the official GitHub MCP server.
 *
 * Registers the GitHub MCP server (Docker image: ghcr.io/github/github-mcp-server),
 * giving the agent access to repository management, issues, PRs, code search, etc.
 *
 * Configuration in ~/.talon/config.json:
 *   "github": {
 *     "enabled": true,
 *     "token": "ghp_..."      // optional, defaults to `gh auth token` output
 *   }
 */

import { execFileSync } from "node:child_process";
import type { TalonPlugin } from "../../core/plugin/types.js";
import { log, logWarn } from "../../util/log.js";
import { githubMcpImageRef } from "./provision.js";

/**
 * Resolve a GitHub personal access token.
 * Priority: explicit config > `gh auth token` CLI.
 */
function resolveToken(configToken?: string): string | undefined {
  const trimmed = configToken?.trim();
  if (trimmed) return trimmed;
  try {
    return execFileSync("gh", ["auth", "token"], {
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString("utf-8")
      .trim();
  } catch {
    return undefined;
  }
}

export function createGitHubPlugin(config: {
  token?: string;
  imageTag?: string;
}): TalonPlugin {
  const token = resolveToken(config.token);
  const image = githubMcpImageRef(config.imageTag);

  return {
    name: "github",
    description: "GitHub API access via the official GitHub MCP server",
    version: "1.0.0",

    mcpServer: {
      command: "docker",
      args: ["run", "--rm", "-i", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", image],
    },

    validateConfig() {
      const errors: string[] = [];

      if (!token) {
        errors.push(
          'No GitHub token found. Set "token" in github config or run `gh auth login`.',
        );
      }

      try {
        execFileSync("docker", ["info"], {
          timeout: 10_000,
          stdio: "pipe",
        });
      } catch {
        errors.push(
          "Docker is not available or not running. The GitHub MCP server requires Docker.",
        );
      }

      return errors.length > 0 ? errors : undefined;
    },

    async init() {
      // Verify the pinned Docker image exists locally (the provisioner
      // pulls it in the background when absent).
      try {
        execFileSync("docker", ["image", "inspect", image], {
          timeout: 10_000,
          stdio: "pipe",
        });
        log("github", `Docker image verified (${image})`);
      } catch {
        logWarn(
          "github",
          `Docker image ${image} not present yet — pulling in background; docker pulls on first use as fallback`,
        );
      }

      log("github", "Ready");
    },

    getEnvVars() {
      const vars: Record<string, string> = {};
      if (token) vars.GITHUB_PERSONAL_ACCESS_TOKEN = token;
      return vars;
    },
  };
}
