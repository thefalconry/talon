/**
 * GitHub MCP provisioner — pinned Docker image, pulled ahead of use.
 *
 * `docker run` on an absent image blocks the first tool call on a
 * network pull; a floating `latest` means the server silently changes
 * under a deployment. Pin a known-good tag and front-load the pull at
 * boot (in the background — docker itself remains the fallback path,
 * so a slow or failed pull degrades to today's behavior, never worse).
 */

import { join } from "node:path";
import type { DoctorCheck } from "../../core/doctor/index.js";
import {
  failDetail,
  loadProvisionState,
  markProvisionFailure,
  markProvisionSuccess,
  runStep,
  shouldAttempt,
  type ExecFn,
  type ProvisionOutcome,
} from "../../core/plugin/provision.js";
import { dirs } from "../../util/paths.js";

/**
 * The github-mcp-server image tag Talon runs. Bump deliberately, with
 * the canary workflow green — see .github/workflows/native-provision.yml.
 */
export const GITHUB_MCP_PINNED_TAG = "v2.0.2";

const GITHUB_MCP_IMAGE = "ghcr.io/github/github-mcp-server";

const PULL_TIMEOUT_MS = 600_000;
const INSPECT_TIMEOUT_MS = 20_000;

export function githubMcpImageRef(imageTag?: string): string {
  return `${GITHUB_MCP_IMAGE}:${imageTag ?? GITHUB_MCP_PINNED_TAG}`;
}

/** The `github` config section this module reads. */
export interface GithubSection {
  imageTag?: string;
  autoProvision?: boolean;
}

export interface GithubProvisionDeps {
  exec?: ExecFn;
  now?: () => number;
  statePath?: string;
}

export async function provisionGithubMcp(
  section: GithubSection,
  deps: GithubProvisionDeps = {},
): Promise<ProvisionOutcome> {
  const exec = deps.exec ?? runStep;
  const now = deps.now ?? Date.now;
  const image = githubMcpImageRef(section.imageTag);

  if (section.autoProvision === false) {
    return { status: "skipped", kind: "docker", actions: [], warnings: [] };
  }

  const inspected = await exec("docker", ["image", "inspect", image], {
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  if (inspected.ok) {
    return {
      status: "ready",
      version: image,
      kind: "docker",
      actions: [],
      warnings: [],
    };
  }
  if (inspected.error === "ENOENT") {
    // No docker at all — validateConfig already reports this as the
    // blocking error; provisioning has nothing to add.
    return {
      status: "failed",
      kind: "docker",
      actions: [],
      warnings: [],
      error: "docker not found",
    };
  }

  const statePath = deps.statePath ?? join(dirs.data, "github-provision.json");
  const state = loadProvisionState(statePath);
  if (!shouldAttempt(state, image, now())) {
    return {
      status: "degraded",
      version: image,
      kind: "docker",
      actions: [],
      warnings: [
        `image pull previously failed (${state.lastError ?? "unknown"}); docker will pull on first use — retrying with backoff`,
      ],
    };
  }

  return {
    status: "degraded",
    version: image,
    kind: "docker",
    actions: [],
    warnings: [`pulling ${image} in the background`],
    background: async () => {
      const pulled = await exec("docker", ["pull", image], {
        timeoutMs: PULL_TIMEOUT_MS,
      });
      if (pulled.ok) {
        markProvisionSuccess(statePath, state, image, now());
        return {
          status: "ready",
          version: image,
          kind: "docker",
          actions: [`pulled ${image}`],
          warnings: [],
        };
      }
      const detail = failDetail(pulled);
      markProvisionFailure(statePath, state, image, detail, now());
      return {
        status: "degraded",
        version: image,
        kind: "docker",
        actions: [],
        warnings: [
          `image pull failed (${detail}) — docker will pull on first use`,
        ],
        error: detail,
      };
    },
  };
}

/** Read-only doctor inspection: docker reachable, pinned image present. */
export async function inspectGithub(
  section: GithubSection,
  deps: GithubProvisionDeps = {},
): Promise<DoctorCheck[]> {
  const exec = deps.exec ?? runStep;
  const image = githubMcpImageRef(section.imageTag);
  const inspected = await exec("docker", ["image", "inspect", image], {
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  if (inspected.ok) {
    return [{ label: `GitHub MCP image ${image}`, status: "ok" }];
  }
  if (inspected.error === "ENOENT") {
    return [
      {
        label: "GitHub MCP: docker not found",
        status: "fail",
        detail: "the GitHub MCP server runs as a Docker image",
        issue: true,
      },
    ];
  }
  return [
    {
      label: `GitHub MCP image not pulled (${image})`,
      status: "warn",
      detail:
        section.autoProvision === false
          ? `automatic pull disabled (github.autoProvision: false) — run: docker pull ${image}`
          : "pulls in the background at next talon start",
      issue: true,
    },
  ];
}
